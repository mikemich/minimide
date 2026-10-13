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
import { registerLanguage } from './editor.js';
import { prettyBinding } from './keymap.js';

// Popular CodeMirror add-ons, bundled against the editor's own CodeMirror (two copies
// don't mix) and loaded only when a package asks for them.
const extras = Object.freeze({
  vim: () => import('@replit/codemirror-vim'),
  minimap: () => import('@replit/codemirror-minimap'),
  indentationMarkers: () => import('@replit/codemirror-indentation-markers'),
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

  async activate(name) {
    const pkg = this.packages.get(name);
    if (!pkg || pkg.active) return;
    const { manifest } = pkg.meta;
    const url = `mide://pkg/${encodeURIComponent(name)}@${Date.now()}/`; // fresh module graph per activation
    const api = this.createApi(pkg);
    pkg.error = null;
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
        onDidChangePending: (fn) => track(app.keymap.on('pending', fn)),
        allowInPassthrough: (...ids) => track(app.keymap.allowInPassthrough(...ids)),
        list: () => [...app.keymap.resolved()].map(([binding, command]) => ({ binding, command })),
        onDidChange: (fn) => track(app.keymap.on('changed', fn)),
      },
      config: {
        register: (schema) => track(app.config.register(prefixSchema(schema, name), name)),
        get: (key, fallback) => app.config.get(key, fallback),
        set: (key, value) => app.config.set(key, value),
        observe: (key, fn) => track(app.config.observe(key, fn)),
        onDidChange: (key, fn) => track(app.config.onDidChange(key, fn)),
        onDidChangeAny: (fn) => track(app.config.on('change', fn)),
        getSchema: () => [...app.config.schema.values()],
      },
      workspace: {
        get project() { return ws.project; },
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
        refreshPaneActions: () => ws.refreshPaneActions(),
        splitRight: (opts = {}) => ws.splitRight(ws.activePane, opts.empty ? null : ws.activePane.active),
        addOpener: (fn) => track(ws.addOpener(fn)),
        onWillSave: (fn) => track(ws.onWillSave(fn)),
        onDidSave: (fn) => track(ws.on('did-save', fn)),
        onDidChangeActiveItem: (fn) => track(ws.on('active-item-changed', fn)),
        observeActiveItem: (fn) => { fn(ws.getActiveItem()); return track(ws.on('active-item-changed', fn)); },
        onDidChangeProject: (fn) => track(ws.on('project-changed', fn)),
        onDidChangeFiles: (fn) => track(ws.on('files-changed', fn)),
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
      },
      cm,
      ui: {
        h, icon, fileIcon, registerIcon,
        selectList: (o) => app.ui.selectList(o),
        prompt: (o) => app.ui.prompt(o),
        confirm: (o) => window.native.dialog.confirm(o),
        contextMenu: (items) => window.native.menu.popup(items),
        fuzzyFilter, fuzzyMatch, highlightMatches,
        setWelcomeTip: (tip) => app.addWelcomeTip(tip),
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
      services: {
        provide: (svc, value) => track(this.services.provide(svc, value)),
        consume: (svc, fn) => track(this.services.consume(svc, fn)),
      },
      packages: {
        list: () => [...this.packages.values()].map((p) => ({ name: p.meta.name, manifest: p.meta.manifest, builtin: p.meta.builtin, active: p.active, disabled: this.isDisabled(p.meta.name), theme: this.isTheme(p), error: p.error?.message })),
        setEnabled: (n, e) => this.setEnabled(n, e),
        reload: (n) => this.reload(n),
        setTheme: (n) => app.config.set('core.theme', n),
        onDidChange: (fn) => track(this.on('changed', fn)),
      },
      fs: window.native.fs,
      project: {
        files: () => app.projectFiles(),
        search: (query, opts = {}) => window.native.project.search(opts.root || ws.project, query, { ignored: app.config.get('core.ignoredNames'), ...opts, root: undefined }),
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
      clipboard: window.native.clipboard,
      path: { basename, dirname, join: (...p) => p.join('/').replace(/\/+/g, '/') },
      user: app.userInfo,
    };
  }
}

function prefixSchema(schema, pkgName) {
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k.includes('.') ? k : `${pkgName}.${k}`] = v;
  return out;
}

export function loadStylesheet(href, owner) {
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: `${href}?v=${Date.now()}`, dataset: { pkg: owner || '' } });
    link.onload = () => resolve(link);
    link.onerror = () => { console.warn(`[styles] failed to load ${href}`); resolve(link); };
    const userStyles = document.getElementById('user-styles');
    if (userStyles) document.head.insertBefore(link, userStyles); else document.head.append(link);
  });
}
