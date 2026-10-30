// Package manager: discovers, activates and deactivates packages, and builds the
// scoped API object each package receives. Everything a package registers through
// its API is tracked and disposed automatically when it is deactivated.
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as cmLanguage from '@codemirror/language';
import * as cmCommands from '@codemirror/commands';
import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmSearch from '@codemirror/search';
import * as cmLint from '@codemirror/lint';
import * as lezerHighlight from '@lezer/highlight';
import { Emitter, Disposable } from './events.js';
import { h, icon, fileIcon, registerIcon, basename, dirname } from './dom.js';
import { fuzzyFilter, fuzzyMatch, highlightMatches } from './fuzzy.js';
import { registerLanguage, detectLanguage, createPreviewView, richHighlighter } from './editor.js';
import { packageUrl } from './urls.js';
import { prettyBinding, normalizeBinding } from './keymap.js';
import { parseJSONC } from './config.js';
import { convertTheme } from './vscode-theme.js';
import { aiClient } from './ai-client.js';
import { convertSnippet } from './snippet.js';
import { SandboxedPackage, loadSandboxedStyles } from './sandbox.js';

// Popular CodeMirror add-ons, bundled against the editor's own CodeMirror (two copies
// don't mix) and loaded only when a package asks for them.
const extras = Object.freeze({
  vim: () => import('@replit/codemirror-vim'),
  minimap: () => import('@replit/codemirror-minimap'),
  indentationMarkers: () => import('@replit/codemirror-indentation-markers'),
  merge: () => import('@codemirror/merge'),
  emmet: () => import('@emmetio/codemirror6-plugin'),
});

const cm = Object.freeze({
  state: cmState, view: cmView, language: cmLanguage, commands: cmCommands,
  autocomplete: cmAutocomplete, search: cmSearch, lint: cmLint, highlight: lezerHighlight,
  extras,
});

export class Services extends Emitter {
  constructor() { super(); this.providers = new Map(); }
  provide(name, value) {
    this.providers.set(name, value);
    this.emit(`provided:${name}`, value);
    return new Disposable(() => { if (this.providers.get(name) === value) this.providers.delete(name); });
  }
  consume(name, fn) {
    if (this.providers.has(name)) fn(this.providers.get(name));
    return this.on(`provided:${name}`, fn);
  }
  get(name) { return this.providers.get(name); }
}

export class PackageManager extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.packages = new Map(); // name -> { meta, active, module, subscriptions, styleEls, error }
    this.justInstalled = new Map(); // name -> time until which hot reload leaves it alone
    this.services = new Services();
  }

  async discover() {
    const list = await window.native.packages.list();
    for (const meta of list) {
      const existing = this.packages.get(meta.name);
      if (existing) existing.meta = meta;
      else this.packages.set(meta.name, { meta, active: false, subscriptions: [], styleEls: [] });
    }
    return [...this.packages.values()];
  }

  isTheme(pkg) { return !!pkg.meta.manifest.theme; }
  /** Packages with "enabledByDefault": false stay off until the user turns them on. */
  isDisabled(name) {
    if ((this.app.config.get('core.disabledPackages') || []).includes(name)) return true;
    if (this.packages.get(name)?.meta.manifest.enabledByDefault === false) {
      return !(this.app.config.get('core.enabledPackages') || []).includes(name);
    }
    return false;
  }

  async activateAll() {
    const theme = this.app.config.get('core.theme');
    const ordered = [...this.packages.values()].sort((a, b) => (b.meta.builtin - a.meta.builtin) || ((a.meta.manifest.priority ?? 100) - (b.meta.manifest.priority ?? 100)));
    for (const pkg of ordered) {
      if (this.isTheme(pkg)) { if (pkg.meta.name === theme) await this.activate(pkg.meta.name); continue; }
      if (!this.isDisabled(pkg.meta.name)) await this.activate(pkg.meta.name);
    }
    if (![...this.packages.values()].some((p) => this.isTheme(p) && p.active)) {
      const fallback = [...this.packages.values()].find((p) => this.isTheme(p));
      if (fallback) await this.activate(fallback.meta.name);
    }
  }

  /**
   * Built-in packages and folders you made yourself are trusted like the rest of your code.
   * Packages installed with the package manager run sandboxed unless you granted full access;
   * a local package can opt in with "access": "sandboxed" (handy for testing one).
   */
  isSandboxed(pkg) {
    const { meta } = pkg;
    if (meta.builtin) return false;
    if (meta.install) return meta.install.access !== 'full';
    return meta.manifest.access === 'sandboxed';
  }

  /** The permissions a sandboxed package may use: what it asks for, limited to what you granted. */
  async sandboxPermissions(pkg) {
    const { manifest, install } = pkg.meta;
    const asked = (Array.isArray(manifest.permissions) ? manifest.permissions : []).filter((p) => typeof p === 'string');
    if (!install) return asked;
    if (manifest.access === 'full') {
      throw new Error('Its latest version asks for full access to your computer. Reinstall it from Settings → Packages to review and allow that.');
    }
    const extra = asked.filter((p) => !install.permissions.includes(p));
    if (!extra.length) return asked;
    const labels = await window.native.pkgmgr.permissions();
    const choice = await window.native.dialog.confirm({
      type: 'warning',
      message: `"${manifest.displayName || pkg.meta.name}" wants new permissions`,
      detail: `Since you installed it, it has started asking to:\n\n${extra.map((p) => `• ${labels[p] || p}`).join('\n')}\n\nIf you don't allow this, it keeps running with the permissions you already gave it.`,
      buttons: ['Allow', "Don't Allow"],
    });
    if (choice === 0) {
      pkg.meta.install = await window.native.pkgmgr.grant(pkg.meta.name, asked);
      return asked;
    }
    return asked.filter((p) => install.permissions.includes(p));
  }

  async activate(name) {
    const pkg = this.packages.get(name);
    if (!pkg || pkg.active) return;
    // Installing also triggers the hot-reload watcher; make concurrent activations share one attempt.
    if (pkg.activating) return pkg.activating;
    pkg.activating = this.activateNow(pkg).finally(() => { pkg.activating = null; });
    return pkg.activating;
  }

  async activateNow(pkg) {
    const name = pkg.meta.name;
    const { manifest } = pkg.meta;
    const url = packageUrl(name);
    pkg.error = null;
    if (this.isSandboxed(pkg)) return this.activateSandboxed(pkg, url);
    const api = this.createApi(pkg);
    try {
      if (manifest.configSchema) pkg.subscriptions.push(this.app.config.register(prefixSchema(manifest.configSchema, name), name));
      if (manifest.keymap) pkg.subscriptions.push(this.app.keymap.add(manifest.keymap, name));
      for (const style of manifest.styles || []) pkg.styleEls.push(await loadStylesheet(url + style, name));
      if (manifest.main !== false && (manifest.main || !this.isTheme(pkg))) {
        pkg.module = await import(/* @vite-ignore */ url + (manifest.main || 'index.js'));
        const result = await pkg.module.activate?.(api);
        if (result) pkg.subscriptions.push(typeof result === 'function' ? new Disposable(result) : result);
      }
      pkg.active = true;
      this.emit('activated', name);
    } catch (err) {
      console.error(`[packages] failed to activate ${name}`, err);
      pkg.error = err;
      this.app.ui.notify.error(`Package "${name}" failed to activate`, err.message);
      this.cleanup(pkg);
    }
    this.emit('changed');
  }

  async activateSandboxed(pkg, url) {
    const { manifest, name } = pkg.meta;
    try {
      const permissions = await this.sandboxPermissions(pkg);
      // Settings and keybindings are limited to the package's own namespace.
      if (manifest.configSchema) {
        const own = Object.fromEntries(Object.entries(manifest.configSchema).filter(([k]) => !k.includes('.') || k.startsWith(`${name}.`)));
        pkg.subscriptions.push(this.app.config.register(prefixSchema(own, name), name));
      }
      if (manifest.keymap) {
        const own = Object.fromEntries(Object.entries(manifest.keymap).filter(([, cmd]) => typeof cmd === 'string' && cmd.startsWith(`${name}:`)));
        pkg.subscriptions.push(this.app.keymap.add(own, name));
      }
      for (const style of manifest.styles || []) pkg.styleEls.push(await loadSandboxedStyles(url, style, name));
      if (manifest.main !== false && (manifest.main || !this.isTheme(pkg))) {
        const sandbox = new SandboxedPackage(this.app, pkg, permissions);
        pkg.subscriptions.push(sandbox);
        await sandbox.start(url + (manifest.main || 'index.js'));
      }
      pkg.active = true;
      pkg.sandboxed = true;
      this.emit('activated', name);
    } catch (err) {
      console.error(`[packages] failed to activate ${name}`, err);
      pkg.error = err;
      this.app.ui.notify.error(`Package "${name}" failed to activate`, err.message);
      this.cleanup(pkg);
    }
    this.emit('changed');
  }

  // --- installing ----------------------------------------------------------
  /**
   * Download, show what it asks for, and install. Returns the package name, or null if cancelled.
   * With `update` (an installed package's newer version) the dialog is skipped when the new version
   * asks for nothing it wasn't already allowed: no new permission and no jump to full access.
   */
  async install(source, { update = false } = {}) {
    const { notify } = this.app.ui;
    const failed = update ? 'Couldn\'t update the package' : 'Couldn\'t install the package';
    const progress = notify.info(update ? 'Downloading update…' : 'Downloading package…', String(source), { timeout: 0 });
    let staged;
    try { staged = await window.native.pkgmgr.stage(source); } catch (err) { progress.close(); notify.error(failed, cleanIpcError(err)); return null; }
    progress.close();
    const existing = staged.existing;
    const sameSource = existing?.source === staged.source;
    const newPermissions = existing ? staged.permissions.filter((p) => !(existing.permissions || []).includes(p)) : [];
    const moreAccess = !!existing && staged.access === 'full' && existing.access !== 'full';
    if (!(update && sameSource && !moreAccess && !newPermissions.length)) {
      const labels = await window.native.pkgmgr.permissions();
      const from = staged.source.replace(/^github:/, 'github.com/').replace(/^folder:/, '');
      let detail;
      let buttons;
      if (staged.access === 'full') {
        detail = `From ${from}\n\nThis package asks for FULL ACCESS. It would run with the same rights as Minimide: it could read and change any file, run any program and use the internet.\n\nOnly install it if you trust the author.`;
        buttons = [sameSource ? 'Update with Full Access' : 'Install with Full Access', 'Cancel'];
      } else {
        const perms = staged.permissions.map((p) => `• ${labels[p]}`);
        detail = `From ${from}\n\nIt runs in a sandbox. ${!staged.hasCode ? 'It contains no code (styles and settings only).'
          : perms.length ? `Besides editing the open file and adding commands, it asks to:\n\n${perms.join('\n')}` : 'It can add commands and status bar items and work with the open file, but it can\'t see your other files, run programs or use the internet.'}`;
        if (staged.unknownPermissions.length) detail += `\n\nIgnored unknown permissions: ${staged.unknownPermissions.join(', ')}`;
        buttons = [sameSource ? 'Update' : 'Install', 'Cancel'];
      }
      if (sameSource) {
        if (moreAccess) detail += '\n\nThe version you have runs in a sandbox. This one would not.';
        else if (newPermissions.length) detail += `\n\nNew since the version you have:\n${newPermissions.map((p) => `• ${labels[p]}`).join('\n')}`;
      }
      const change = sameSource && existing.version && staged.version && existing.version !== staged.version ? ` from ${existing.version} to ${staged.version}` : staged.version ? ` ${staged.version}` : '';
      const choice = await window.native.dialog.confirm({ type: staged.access === 'full' ? 'warning' : 'question', message: `${sameSource ? 'Update' : 'Install'} "${staged.displayName}"${change}?`, detail, buttons });
      if (choice !== 0) { window.native.pkgmgr.discard(staged.id); return null; }
    }
    try {
      if (this.packages.get(staged.name)?.active) await this.deactivate(staged.name);
      this.justInstalled.set(staged.name, Date.now() + 3000);
      await window.native.pkgmgr.install(staged.id, { permissions: staged.permissions });
      await this.discover();
      this.packages.get(staged.name).meta.install ??= { access: staged.access, permissions: staged.permissions };
      await this.activate(staged.name);
      const pkg = this.packages.get(staged.name);
      if (pkg?.active) notify.success(`${sameSource ? 'Updated' : 'Installed'} ${staged.displayName}${sameSource && staged.version ? ` to ${staged.version}` : ''}`, pkg.sandboxed ? 'Running in a sandbox.' : 'Running with full access.');
      this.emit('changed');
      return staged.name;
    } catch (err) {
      notify.error(failed, cleanIpcError(err));
      return null;
    }
  }

  /** Install the newest version of a package that came from GitHub. Returns its name, or null if it didn't happen. */
  async update(name) {
    const record = this.packages.get(name)?.meta.install;
    if (!record?.source?.startsWith('github:')) throw new Error(`${name} wasn't installed from GitHub.`);
    return this.install(record.source.slice('github:'.length) + (record.branch ? `#${record.branch}` : ''), { update: true });
  }

  /** Update every GitHub package that has a newer version (by the last check, or a new one if that is a day old). */
  async updateAll() {
    const { updates } = await window.native.pkgmgr.checkUpdates();
    let done = 0;
    for (const u of updates) if (await this.update(u.name).catch(() => null)) done++;
    return done;
  }

  async uninstall(name) {
    await this.deactivate(name);
    await window.native.pkgmgr.uninstall(name);
    this.packages.delete(name);
    await this.discover();
    // A user package can shadow a built-in one; bring the built-in back.
    if (this.packages.get(name)?.meta.builtin && !this.isDisabled(name)) await this.activate(name);
    this.emit('changed');
  }

  async deactivate(name) {
    const pkg = this.packages.get(name);
    if (!pkg?.active) return;
    try { await pkg.module?.deactivate?.(); } catch (err) { console.error(`[packages] ${name} deactivate`, err); }
    this.cleanup(pkg);
    pkg.active = false;
    this.emit('deactivated', name);
    this.emit('changed');
  }

  cleanup(pkg) {
    for (const d of pkg.subscriptions.splice(0).reverse()) {
      try { d.dispose(); } catch (err) { console.error(err); }
    }
    for (const el of pkg.styleEls.splice(0)) el.remove();
    pkg.module = null;
  }

  async setEnabled(name, enabled) {
    const disabled = new Set(this.app.config.get('core.disabledPackages') || []);
    const optIn = new Set(this.app.config.get('core.enabledPackages') || []);
    const offByDefault = this.packages.get(name)?.meta.manifest.enabledByDefault === false;
    if (enabled) { disabled.delete(name); if (offByDefault) optIn.add(name); }
    else { disabled.add(name); optIn.delete(name); }
    await this.app.config.set('core.disabledPackages', [...disabled]);
    await this.app.config.set('core.enabledPackages', [...optIn]);
    if (enabled) await this.activate(name); else await this.deactivate(name);
  }

  async reload(name) {
    await this.deactivate(name);
    await this.discover();
    await this.activate(name);
  }

  async setTheme(name) {
    for (const pkg of this.packages.values()) if (this.isTheme(pkg) && pkg.active && pkg.meta.name !== name) await this.deactivate(pkg.meta.name);
    await this.activate(name);
  }

  themes() { return [...this.packages.values()].filter((p) => this.isTheme(p)); }

  /** The API surface handed to every package (and to ~/.minimide/init.js). */
  createApi(pkg) {
    const app = this.app;
    const subs = pkg.subscriptions;
    const track = (d) => { if (d) subs.push(d); return d; };
    const ws = app.workspace;
    const name = pkg.meta.name;

    return {
      version: app.version,
      package: { name, dir: pkg.meta.dir, url: pkg.meta.url, manifest: pkg.meta.manifest },
      subscriptions: { add: (...ds) => ds.forEach(track) },
      Disposable,

      commands: {
        add: (...args) => track(app.commands.add(...args)),
        run: (id, ...args) => app.commands.run(id, ...args),
        list: () => app.commands.list(),
        has: (id) => app.commands.has(id),
      },
      keymap: {
        add: (bindings) => track(app.keymap.add(bindings, name)),
        bindingsFor: (id) => app.keymap.bindingsFor(id),
        pretty: prettyBinding,
        /** "mod-shift-P" -> the canonical "Shift-Cmd-p" form the keymap uses. */
        normalize: normalizeBinding,
        onDidChangePending: (fn) => track(app.keymap.on('pending', fn)),
        allowInPassthrough: (...ids) => track(app.keymap.allowInPassthrough(...ids)),
        list: () => [...app.keymap.resolved()].map(([binding, command]) => ({ binding, command })),
        onDidChange: (fn) => track(app.keymap.on('changed', fn)),
      },
      config: {
        register: (schema) => track(app.config.register(prefixSchema(schema, name), name)),
        get: (key, fallback) => app.config.get(key, fallback),
        /** Parse JSON with comments and trailing commas (what config.json and keymap.json allow). */
        parseJSONC,
        set: (key, value) => app.config.set(key, value),
        observe: (key, fn) => track(app.config.observe(key, fn)),
        onDidChange: (key, fn) => track(app.config.onDidChange(key, fn)),
        onDidChangeAny: (fn) => track(app.config.on('change', fn)),
        getSchema: () => [...app.config.schema.values()],
      },
      workspace: {
        get project() { return ws.project; },
        /** Every project folder, the project first. */
        get folders() { return [...ws.folders]; },
        folderFor: (path) => ws.folderFor(path),
        getActiveFolder: () => ws.getActiveFolder(),
        addFolder: (path) => app.addFolder(path),
        removeFolder: (path) => app.removeFolder(path),
        resolvePath: (rel) => ws.resolvePath(rel),
        open: (path, opts) => ws.open(path, opts),
        openItem: (item, opts) => ws.openItem(item, opts),
        closeItem: (item) => ws.closeItem(item),
        newFile: () => ws.newFile(),
        save: (item) => ws.save(item),
        getActiveItem: () => ws.getActiveItem(),
        getActiveEditor: () => ws.getActiveEditor(),
        getItems: () => ws.allItems(),
        getPanes: () => ws.panes,
        relativePath: (p) => ws.relativePath(p),
        setProject: (p) => app.openProject(p),
        addPaneAction: (action) => track(ws.addPaneAction(action)),
        renamePath: (from, to) => ws.renamePath(from, to),
        refreshPaneActions: () => ws.refreshPaneActions(),
        splitRight: (opts = {}) => ws.splitRight(ws.activePane, opts.empty ? null : ws.activePane.active),
        splitDown: (opts = {}) => ws.splitDown(ws.activePane, opts.empty ? null : ws.activePane.active),
        addOpener: (fn) => track(ws.addOpener(fn)),
        onWillSave: (fn) => track(ws.onWillSave(fn)),
        /** (item, { auto }): `auto` is true for a save made by Auto Save. */
        onDidSave: (fn) => track(ws.on('did-save', fn)),
        onDidChangeActiveItem: (fn) => track(ws.on('active-item-changed', fn)),
        observeActiveItem: (fn) => { fn(ws.getActiveItem()); return track(ws.on('active-item-changed', fn)); },
        onDidChangeProject: (fn) => track(ws.on('project-changed', fn)),
        onDidChangeFolders: (fn) => track(ws.on('folders-changed', fn)),
        /** Whether tools may run for this path (default: the project). See core/trust.js. */
        isTrusted: (path) => app.trust.isTrusted(path),
        onDidChangeTrust: (fn) => track(app.trust.on('changed', fn)),
        /** Asks to trust the folder of `path` (default: the first folder that isn't trusted). */
        requestTrust: (path) => app.trust.prompt(path ? ws.folderFor(path) || path : undefined),
        onDidChangeFiles: (fn) => track(ws.on('files-changed', fn)),
        /** A file or folder was moved: (from, to). */
        onDidRenamePath: (fn) => track(ws.on('path-renamed', fn)),
        /** A document is about to be replaced by what is on disk (reason 'disk' or 'revert'): the last chance to keep its text. */
        onWillReload: (fn) => track(ws.on('will-reload', fn)),
        onDidUpdateEditor: (fn) => track(ws.on('editor-updated', fn)),
        onDidOpenItem: (fn) => track(ws.on('item-added', fn)),
        onDidCloseItem: (fn) => track(ws.on('item-removed', fn)),
        onDidOpenDocument: (fn) => track(ws.on('document-opened', fn)),
        onDidCloseDocument: (fn) => track(ws.on('document-closed', fn)),
        getDocuments: () => [...ws.documents.values()],
      },
      editor: {
        addExtension: (ext) => track(ws.addEditorExtension(ext)),
        registerLanguage: (desc) => track(registerLanguage(desc)),
        /** LanguageSupport for a file path (loads the grammar), or null. */
        languageFor: async (path) => { const d = detectLanguage(path); return d ? d.support || d.load() : null; },
        /** Add a completion source that runs alongside the language's own (and the LSP's). */
        addCompletionSource: (source) => track(ws.addCompletionSource(source)),
        extraCompletionSource: ws.extraCompletionSource,
        /** The highlighters that give tokens their tok-* classes, for highlightTree() to match what the editor shows. */
        highlighters: [lezerHighlight.classHighlighter, richHighlighter],
        /** LSP/VS Code snippet text -> CodeMirror snippet template (escapes handled). */
        convertSnippet: (text, resolveVariable) => convertSnippet(text, resolveVariable),
        /** A small read-only, highlighted EditorView of `text`, scrolled to `line`. Destroy it when done. */
        createPreview: ({ text, path, line, parent, extensions }) => createPreviewView({ text, path, line, parent, extensions, config: app.config }),
      },
      cm,
      ui: {
        h, icon, fileIcon, registerIcon,
        selectList: (o) => app.ui.selectList(o),
        /** Open the one search box, optionally on a mode's prefix ('>' commands, '@' symbols…). */
        quickOpen: (prefix) => app.quickOpen.open(prefix),
        /** A new kind of search in that box: { prefix, title, short?, description?, order?, ...selectList options }. */
        addQuickOpenMode: (mode) => track(app.quickOpen.addMode(mode)),
        prompt: (o) => app.ui.prompt(o),
        confirm: (o) => window.native.dialog.confirm(o),
        contextMenu: (items) => window.native.menu.popup(items),
        fuzzyFilter, fuzzyMatch, highlightMatches,
        setWelcomeTip: (tip) => track(app.addWelcomeTip(tip)),
        /** PNG data URL of the app icon drawn in the current theme's colors. */
        renderAppIcon: () => app.renderAppIcon?.() ?? null,
        /** Whether the OS reports a screen reader (or other assistive technology) in use. */
        isScreenReaderActive: () => app.screenReader.active,
        onDidChangeScreenReader: (fn) => track(app.screenReader.onDidChange(fn)),
      },
      notify: app.ui.notify,
      sidebar: {
        addView: (v) => track(app.sidebar.addView(v)),
        show: (id, o) => app.sidebar.show(id, o),
        hide: () => app.sidebar.hide(),
        toggle: (id) => app.sidebar.toggle(id),
        isActive: (id) => app.sidebar.isActive(id),
      },
      panel: {
        addView: (v) => track(app.panel.addView(v)),
        show: (id, o) => app.panel.show(id, o),
        hide: () => app.panel.hide(),
        toggle: (id) => app.panel.toggle(id),
        isActive: (id) => app.panel.isActive(id),
      },
      statusBar: { addItem: (o) => track(app.statusBar.addItem(o)) },
      styles: {
        add: (css) => { const el = h('style', { dataset: { pkg: name } }, css); document.head.append(el); return track(new Disposable(() => el.remove())); },
      },
      /** Small JSON values saved with the open folder's session (breakpoints, watch lists…). */
      state: {
        get: (key) => app.packageState(name)[key],
        set: (key, value) => app.setPackageState(name, key, value),
      },
      services: {
        provide: (svc, value) => track(this.services.provide(svc, value)),
        consume: (svc, fn) => track(this.services.consume(svc, fn)),
        /** The current provider, without subscribing (for one-off lookups). */
        get: (svc) => this.services.get(svc),
      },
      packages: {
        list: () => [...this.packages.values()].map((p) => ({ name: p.meta.name, manifest: p.meta.manifest, builtin: p.meta.builtin, active: p.active, disabled: this.isDisabled(p.meta.name), theme: this.isTheme(p), error: p.error?.message, install: p.meta.install || null, sandboxed: this.isSandboxed(p) })),
        setEnabled: (n, e) => this.setEnabled(n, e),
        reload: (n) => this.reload(n),
        setTheme: (n) => app.config.set('core.theme', n),
        onDidChange: (fn) => track(this.on('changed', fn)),
        install: (source) => this.install(source),
        uninstall: (n) => this.uninstall(n),
        update: (n) => this.update(n),
        updateAll: () => this.updateAll(),
        search: (q, opts) => window.native.pkgmgr.search(q, opts),
        details: (fullName) => window.native.pkgmgr.details(fullName),
        /** { checkedAt, updates: [{ name, fullName, source }], errors }. A check made today is reused unless { force: true }. */
        checkUpdates: (opts) => window.native.pkgmgr.checkUpdates(opts),
        permissionLabels: () => window.native.pkgmgr.permissions(),
      },
      fs: {
        ...window.native.fs,
        // Listeners and watchers are owned by the package, so they go away when it deactivates;
        // watch keys are namespaced so a package can't replace the workspace's project watcher.
        onChange: (fn) => { const off = window.native.fs.onChange(fn); track({ dispose: off }); return { dispose: off }; },
        watch: (dir, key = 'default') => {
          const k = `pkg:${name}:${key}`;
          window.native.fs.watch(dir, k);
          track({ dispose: () => window.native.fs.watch(null, k) });
        },
      },
      project: {
        /** Files in `folder` (default: the project), relative to it. */
        files: (folder) => app.projectFiles(folder),
        /** Searches `opts.root`, or every project folder. */
        search: async (query, opts = {}) => {
          const run = (root) => window.native.project.search(root, query, { ignored: app.config.get('core.ignoredNames'), ...opts, root: undefined });
          if (opts.root || ws.folders.length < 2) return run(opts.root || ws.project);
          // A folder inside another one is searched with it.
          const roots = ws.folders.filter((f) => !ws.folders.some((o) => o !== f && f.startsWith(o + '/')));
          const all = await Promise.all(roots.map(run));
          return all.find((r) => r.error) || {
            results: all.flatMap((r) => r.results), truncated: all.some((r) => r.truncated),
            timedOut: all.some((r) => r.timedOut) || undefined, notice: all.find((r) => r.notice)?.notice,
          };
        },
      },
      process: {
        exec: (cmd, args, opts) => window.native.proc.exec(cmd, args, { cwd: ws.project || undefined, ...opts }),
        spawn: (command, { cwd, env, onData, onExit } = {}) => app.spawn(command, { cwd: cwd || ws.project, env, onData, onExit }, track),
        spawnPty: (opts = {}) => app.spawnPty({ ...opts, cwd: opts.cwd || ws.project || undefined }, track),
        ptyAvailable: () => window.native.term.available(),
        spawnRpc: (argv, opts = {}) => app.spawnRpc(argv, { ...opts, cwd: opts.cwd || ws.project || undefined }, track),
      },
      shell: {
        openExternal: (u) => window.native.shell.openExternal(u),
        reveal: (p) => window.native.shell.reveal(p),
        openPath: (p) => window.native.shell.openPath(p),
      },
      /** AI requests run by the main process, which keeps the API key. See src/renderer/core/ai-client.js. */
      ai: aiClient,
      clipboard: window.native.clipboard,
      /** Read-only access to the user folder of VS Code (and Cursor, VSCodium, Insiders). Desktop app only. */
      vscode: {
        scan: () => window.native.vscode.scan(),
        read: (id) => window.native.vscode.read(id),
        theme: (id, name) => window.native.vscode.theme(id, name),
        /** A VS Code theme (parsed JSON) -> { slug, packageJson, themeCss } with faint text made readable. */
        convertTheme: (theme) => convertTheme(theme, { readable: true }),
      },
      /** Settings sync through a private GitHub gist. The token stays in the main process. Desktop app only. */
      sync: {
        status: () => window.native.gist.status(),
        setToken: (token) => window.native.secrets.set('github-gist-token', token),
        cliAvailable: () => window.native.gist.cliAvailable(),
        useGitHubCli: () => window.native.gist.cliLogin(),
        upload: (files) => window.native.gist.upload(files),
        download: () => window.native.gist.download(),
        signOut: () => window.native.gist.forget(),
      },
      path: { basename, dirname, join: (...p) => p.join('/').replace(/\/+/g, '/') },
      user: app.userInfo,
    };
  }
}

const cleanIpcError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function prefixSchema(schema, pkgName) {
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k.includes('.') ? k : `${pkgName}.${k}`] = v;
  return out;
}

export function loadStylesheet(href, owner) {
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: /^blob:|\?/.test(href) ? href : `${href}?v=${Date.now()}`, dataset: { pkg: owner || '' } });
    link.onload = () => resolve(link);
    link.onerror = () => { console.warn(`[styles] failed to load ${href}`); resolve(link); };
    const userStyles = document.getElementById('user-styles');
    if (userStyles) document.head.insertBefore(link, userStyles); else document.head.append(link);
  });
}
