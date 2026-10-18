// Minimide renderer entry: wires the core services together, loads packages,
// restores the session and hands control to the user.
import { CommandRegistry } from './core/commands.js';
import { Keymap, prettyBinding } from './core/keymap.js';
import { Config, parseJSONC } from './core/config.js';
import { Workspace } from './core/workspace.js';
import { PackageManager, loadStylesheet } from './core/packages.js';
import { selectList, prompt, notify, Dock, StatusBar, closeModal } from './core/ui.js';
import { h, basename } from './core/dom.js';
import { registerCoreCommands, CORE_KEYMAP } from './core/core-commands.js';
import { CORE_SCHEMA } from './core/schema.js';
import { bindThemedAppIcon, renderAppIcon } from './core/app-icon.js';

// ui.accentColor overrides the theme's accent and everything derived from it.
// Inline styles on <html> beat the theme's :root rules, so this survives theme switches.
const ACCENT_VARS = ['--accent', '--accent-fg', '--cursor', '--selection', '--bg-selected-focus', '--bracket-match'];
function applyAccent(root, color) {
  if (!color || !CSS.supports('color', color)) { for (const v of ACCENT_VARS) root.removeProperty(v); return; }
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = color;
  const s = probe.fillStyle; // "#rrggbb", or "rgba(…)" for translucent colors
  const [r, g, b] = s.startsWith('#') ? s.slice(1).match(/../g).map((x) => parseInt(x, 16)) : s.match(/[\d.]+/g).map(Number);
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
  root.setProperty('--accent', color);
  root.setProperty('--accent-fg', light ? '#101216' : '#ffffff');
  root.setProperty('--cursor', color);
  root.setProperty('--selection', `color-mix(in srgb, ${color} 22%, transparent)`);
  root.setProperty('--bg-selected-focus', `color-mix(in srgb, ${color} 17%, transparent)`);
  root.setProperty('--bracket-match', `color-mix(in srgb, ${color} 28%, transparent)`);
}

class App {
  constructor() {
    this.version = '0.1.0';
    this.commands = new CommandRegistry();
    this.keymap = new Keymap(this.commands);
    this.config = new Config();
    this.ui = { selectList, prompt, notify, closeModal };
    this.welcomeTips = [];
    this.state = {};
    this.fileCache = null;
    this.procSeq = 0;
    // Unique per page load: after Reload Window, old and new process ids can't collide.
    this.procPrefix = Math.random().toString(36).slice(2, 8);
  }

  async start() {
    this.userInfo = await window.native.user.info();
    document.body.classList.add(`platform-${this.userInfo.platform}`);

    this.config.register(CORE_SCHEMA, 'core');
    // Listen before loading, so a broken config.json is reported at launch too.
    this.config.on('error', (err) => notify.error('Problem with config.json', err.message, { actions: [{ label: 'Open config.json', run: () => this.workspace?.open(`${this.userInfo.dir}/config.json`) }] }));
    await this.config.load(`${this.userInfo.dir}/config.json`);
    this.bindAppearance();

    this.state = await window.native.state.load();
    const global = this.state.global || {};
    this.sidebar = new Dock(document.getElementById('sidebar'), { name: 'sidebar', axis: 'x', state: { visible: true, ...global.sidebar }, defaultSize: 260 });
    this.panel = new Dock(document.getElementById('panel'), { name: 'panel', axis: 'y', state: { visible: false, ...global.panel }, defaultSize: 240, minSize: 80 });
    this.sidebar.attachResizer(document.getElementById('sidebar-resizer'));
    this.panel.attachResizer(document.getElementById('panel-resizer'), true);
    this.statusBar = new StatusBar(document.getElementById('statusbar'));

    this.workspace = new Workspace({ config: this.config, commands: this.commands, keymap: this.keymap, ui: this.ui });
    this.workspace.renderWelcome = () => this.renderWelcome();
    this.workspace.updateEmptyState();

    this.keymap.add(CORE_KEYMAP, 'core');
    registerCoreCommands(this);
    await this.loadUserKeymap();
    await loadStylesheet('mide://user/styles.css', 'user').then((el) => { el.id = 'user-styles'; this.userStylesEl = el; });

    this.packages = new PackageManager(this);
    await this.packages.discover();
    await this.packages.activateAll();
    this.config.onDidChange('core.theme', (name) => this.packages.setTheme(name));

    window.native.fs.watch(this.userInfo.dir, 'user');
    window.native.fs.onChange((paths, key) => { if (key === 'user') this.onUserFilesChanged(paths); });
    window.native.fs.onWatchLimited((root, count) => this.ui.notify.warn('Not every folder is being watched',
      `This project has more than ${count.toLocaleString()} folders, so changes made outside Minimide in some of them won't show up until you reopen the folder. To watch more, raise the limit: sudo sysctl fs.inotify.max_user_watches=524288`));
    window.native.window.onCommand((id) => this.commands.run(id));
    window.native.window.onRequestClose(() => this.requestClose());
    window.native.window.onOpenPath((p) => this.workspace.open(p));
    this.workspace.on('files-changed', (paths) => this.invalidateFileCache(paths));
    this.trackClosedItems();
    this.bindAutoSave();
    this.bindSessionSaving();

    const initial = await window.native.project.initial();
    const project = initial.project || (initial.restore && this.config.get('core.restoreSession') ? this.state.lastProject : null);
    if (project && await window.native.fs.stat(project)) await this.openProject(project, { restore: this.config.get('core.restoreSession') });
    else this.workspace.updateTitle();
    for (const file of initial.files || []) await this.workspace.open(file); // opened via Finder/CLI at launch

    await this.runInitScript();
    document.body.classList.add('ready');
    bindThemedAppIcon(this);
    this.renderAppIcon = renderAppIcon;
    // Daily update check (skipped in automated test runs).
    if (this.config.get('core.checkForUpdates') !== false && !window.mideTest && Date.now() - (this.state.lastUpdateCheck || 0) > 24 * 3600 * 1000) {
      setTimeout(() => this.checkForUpdates({ manual: false }), 8000);
    }
  }

  // --- appearance ----------------------------------------------------------
  bindAppearance() {
    const root = document.documentElement.style;
    this.config.observe('editor.fontFamily', (v) => root.setProperty('--editor-font', v));
    this.config.observe('editor.fontSize', (v) => root.setProperty('--editor-font-size', `${v}px`));
    this.config.observe('editor.lineHeight', (v) => root.setProperty('--editor-line-height', String(v)));
    this.config.observe('ui.fontSize', (v) => root.setProperty('--ui-font-size', `${v}px`));
    this.config.observe('ui.fontFamily', (v) => (v ? root.setProperty('--ui-font', `${v}, -apple-system, system-ui, sans-serif`) : root.removeProperty('--ui-font')));
    this.config.observe('editor.fontLigatures', (v) => root.setProperty('--editor-ligatures', v === false ? 'none' : 'contextual'));
    this.config.observe('ui.accentColor', (v) => applyAccent(root, v));
    this.config.observe('ui.compactTabs', (v) => document.body.classList.toggle('compact-tabs', !!v));
  }

  // --- updates -------------------------------------------------------------
  async checkForUpdates({ manual = true } = {}) {
    const { notify } = this.ui;
    const open = (url) => window.native.shell.openExternal(url);
    let info;
    try { info = await window.native.updates.check(); } catch (err) {
      if (manual) notify.error("Couldn't check for updates", String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return;
    }
    this.state.lastUpdateCheck = Date.now();
    this.persistState();
    if (!info.available) { if (manual) notify.success("You're up to date", `Minimide ${info.current} is the latest version.`); return; }
    if (await window.native.updates.staged() === info.version) return this.updateReady(info.version);
    notify.info(`Minimide ${info.version} is available`, `You have ${info.current}.`, {
      timeout: 0,
      actions: [
        info.canInstall ? { label: 'Update and Restart', run: () => this.installUpdate(info) } : { label: 'Download', run: () => open(info.url) },
        { label: "What's New", run: () => open(info.url) },
      ],
    });
  }

  async installUpdate(info) {
    const label = h('span', `Downloading ${info.version}…`);
    const item = this.statusBar.addItem({ id: 'update-progress', element: label, align: 'right', priority: 1 });
    const off = window.native.updates.onProgress((f) => { label.textContent = `Downloading ${info.version}… ${Math.round(f * 100)}%`; });
    try {
      await window.native.updates.prepare(info);
      this.updateReady(info.version);
    } catch (err) {
      this.ui.notify.error("Couldn't update Minimide", String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), {
        actions: [{ label: 'Open Releases Page', run: () => window.native.shell.openExternal(info.url) }],
      });
    } finally { off(); item.dispose(); }
  }

  updateReady(version) {
    this.ui.notify.success(`Minimide ${version} is ready`, "Restart to finish updating. If you don't, it's installed the next time you quit.", {
      timeout: 0, actions: [{ label: 'Restart Now', run: () => window.native.updates.restart() }],
    });
  }

  // --- project -------------------------------------------------------------
  async openProject(root, { restore = true, newWindow = false } = {}) {
    if (!root) return;
    // Like Atom: a window owns one project; opening another one gets its own window.
    if (newWindow || (this.workspace.project && this.workspace.project !== root)) return window.native.window.newWindow(root);
    if (this.workspace.project === root) return;
    this.saveSession();
    this.fileCache = null;
    await this.workspace.setProject(root);
    this.state.recentProjects = [root, ...(this.state.recentProjects || []).filter((p) => p !== root)].slice(0, 12);
    this.state.lastProject = root;
    this.persistState();
    const session = this.state.sessions?.[root];
    if (restore && session?.workspace) await this.workspace.restore(session.workspace);
    this.sidebar.show(undefined);
    this.welcomeEl = null;
    this.workspace.welcome?.remove();
    this.workspace.welcome = null;
    this.workspace.updateEmptyState();
  }

  async projectFiles() {
    const root = this.workspace.project;
    if (!root) return [];
    if (!this.fileCache || this.fileCache.root !== root) {
      const promise = window.native.project.files(root, this.config.get('core.ignoredNames'));
      this.fileCache = { root, promise, set: null };
      promise.then((files) => { if (this.fileCache?.promise === promise) this.fileCache.set = new Set(files); });
    }
    return this.fileCache.promise;
  }

  // Patch the cached file list instead of re-listing the whole project (slow on big repos).
  // A large burst (a branch switch, npm install…) just drops the cache and re-lists lazily.
  async invalidateFileCache(paths) {
    const cache = this.fileCache;
    if (!cache) return;
    if (!cache.set || !paths || paths.length > 300) { this.fileCache = null; return; }
    const ignored = new Set(this.config.get('core.ignoredNames') || []);
    for (const p of paths) {
      if (!p.startsWith(cache.root + '/')) continue;
      if (p.slice(cache.root.length + 1).split('/').some((s) => ignored.has(s))) continue;
      const stat = await window.native.fs.stat(p).catch(() => null);
      if (this.fileCache !== cache) return;
      if (stat?.isFile) cache.set.add(p);
      else if (!stat) {
        cache.set.delete(p);
        // A deleted or renamed folder takes its files with it.
        const prefix = p + '/';
        for (const f of cache.set) if (f.startsWith(prefix)) cache.set.delete(f);
      } else if (stat.isDir) { this.fileCache = null; return; } // a new folder: re-list to pick up its contents
    }
    cache.promise = Promise.resolve([...cache.set]);
  }

  // --- processes -----------------------------------------------------------
  spawn(command, { cwd, env, onData, onExit } = {}, track = (d) => d) {
    const id = `p-${this.procPrefix}-${++this.procSeq}`;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const offData = window.native.proc.onData((pid, data, stream) => { if (pid === id) onData?.(data, stream); });
    const offExit = window.native.proc.onExit((pid, code, signal) => {
      if (pid !== id) return;
      offData(); offExit();
      onExit?.(code, signal);
      resolveDone({ code, signal });
    });
    window.native.proc.spawn(id, command, { cwd, env });
    const handle = {
      id,
      done,
      write: (data) => window.native.proc.write(id, data),
      kill: () => window.native.proc.kill(id),
      dispose: () => window.native.proc.kill(id),
    };
    track({ dispose: () => window.native.proc.kill(id) });
    return handle;
  }

  /** JSON-RPC (Content-Length framed) child process, e.g. a language server. */
  spawnRpc(argv, { cwd, env, onMessage, onStderr, onExit } = {}, track = (d) => d) {
    const id = `rpc-${this.procPrefix}-${++this.procSeq}`;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const offMsg = window.native.proc.onMessage((pid, body) => {
      if (pid !== id) return;
      let msg;
      try { msg = JSON.parse(body); } catch { return; }
      onMessage?.(msg);
    });
    const offData = window.native.proc.onData((pid, data) => { if (pid === id) onStderr?.(data); });
    const offExit = window.native.proc.onExit((pid, code, signal) => {
      if (pid !== id) return;
      offMsg(); offData(); offExit();
      onExit?.(code, signal);
      resolveDone({ code, signal });
    });
    window.native.proc.spawnRpc(id, argv, { cwd, env });
    const handle = {
      id,
      done,
      send: (msg) => window.native.proc.send(id, JSON.stringify(msg)),
      kill: () => window.native.proc.kill(id),
      dispose: () => window.native.proc.kill(id),
    };
    track({ dispose: () => window.native.proc.kill(id) });
    return handle;
  }

  /** A pseudo-terminal: an interactive shell, or `command` run through a login shell. */
  spawnPty({ command, cwd, cols, rows, env, shell } = {}, track = (d) => d) {
    const id = `pty-${this.procPrefix}-${++this.procSeq}`;
    const dataFns = new Set();
    const exitFns = new Set();
    const offData = window.native.term.onData((pid, data) => { if (pid === id) for (const fn of dataFns) fn(data); });
    const offExit = window.native.term.onExit((pid, code, signal) => {
      if (pid !== id) return;
      offData(); offExit();
      handle.exited = { code, signal };
      for (const fn of exitFns) fn(code, signal);
    });
    const handle = {
      id,
      exited: null,
      ready: window.native.term.create(id, { command, cwd, cols, rows, env, shell }),
      write: (data) => window.native.term.write(id, data),
      resize: (c, r) => window.native.term.resize(id, c, r),
      kill: (signal) => window.native.term.kill(id, signal),
      onData: (fn) => { dataFns.add(fn); return { dispose: () => dataFns.delete(fn) }; },
      onExit: (fn) => { exitFns.add(fn); return { dispose: () => exitFns.delete(fn) }; },
      dispose: () => { if (!handle.exited) window.native.term.kill(id); },
    };
    handle.ready.catch(() => { offData(); offExit(); });
    track({ dispose: () => handle.dispose() });
    return handle;
  }

  // --- user files ----------------------------------------------------------
  async loadUserKeymap() {
    try {
      const text = await window.native.fs.read(`${this.userInfo.dir}/keymap.json`);
      this.keymap.setUserBindings(parseJSONC(text));
    } catch (err) {
      if (!/ENOENT/.test(err.message)) notify.error('Could not parse keymap.json', err.message);
    }
  }

  async onUserFilesChanged(paths) {
    const dir = this.userInfo.dir;
    const has = (name) => paths.includes(`${dir}/${name}`);
    if (has('config.json')) await this.config.reload();
    if (has('keymap.json')) { await this.loadUserKeymap(); notify.info('Keymap reloaded'); }
    if (has('styles.css') && this.userStylesEl) this.userStylesEl.href = `mide://user/styles.css?v=${Date.now()}`;
    const pkgChanges = paths.filter((p) => p.startsWith(`${this.userInfo.packagesDir}/`));
    if (pkgChanges.length && this.config.get('core.hotReloadPackages')) {
      const names = new Set(pkgChanges.map((p) => p.slice(this.userInfo.packagesDir.length + 1).split('/')[0]));
      for (const dirName of names) {
        await this.packages.discover();
        const pkg = [...this.packages.packages.values()].find((p) => p.meta.dir.endsWith(`/${dirName}`));
        // The package manager just put this folder in place and activated it; don't reload it again.
        if (pkg && (this.packages.justInstalled.get(pkg.meta.name) || 0) > Date.now()) continue;
        if (pkg && !this.packages.isDisabled(pkg.meta.name) && (!this.packages.isTheme(pkg) || pkg.active)) {
          clearTimeout(this.reloadTimers?.[dirName]);
          this.reloadTimers = { ...this.reloadTimers, [dirName]: setTimeout(async () => {
            await this.packages.reload(pkg.meta.name);
            notify.info(`Reloaded package "${pkg.meta.name}"`);
          }, 250) };
        }
      }
    }
  }

  async runInitScript() {
    const fakePkg = { meta: { name: 'init', dir: this.userInfo.dir, url: 'mide://user/', manifest: { name: 'init' } }, subscriptions: [], styleEls: [] };
    try {
      const mod = await import(/* @vite-ignore */ `mide://user/init.js?v=${Date.now()}`);
      if (typeof mod.default === 'function') await mod.default(this.packages.createApi(fakePkg));
    } catch (err) {
      console.error('[init.js]', err);
      notify.error('Error in init.js', err.message, { actions: [{ label: 'Open init.js', run: () => this.workspace.open(`${this.userInfo.dir}/init.js`) }] });
    }
  }

  addWelcomeTip(tip) {
    this.welcomeTips.push(tip);
    return { dispose: () => { this.welcomeTips = this.welcomeTips.filter((t) => t !== tip); } };
  }

  // --- welcome screen ------------------------------------------------------
  renderWelcome() {
    const kb = (id) => {
      const b = this.keymap.bindingsFor(id)[0];
      return b ? h('kbd', prettyBinding(b)) : null;
    };
    const action = (label, id) => h('button.welcome-action', { onclick: () => this.commands.run(id) }, h('span', label), kb(id));
    const recents = (this.state.recentProjects || []).slice(0, 6);
    const el = h('div.welcome',
      h('div.welcome-inner',
        h('div.welcome-logo', h('span.logo-mark', 'm'), h('span.logo-word', 'minimide')),
        h('p.welcome-tagline', 'A small, hackable editor.'),
        h('div.welcome-actions',
          this.workspace.project ? action('Find File', 'fuzzy-finder:toggle') : action('Open Folder…', 'project:open-folder'),
          action('New File', 'file:new'),
          action('Command Palette', 'command-palette:toggle'),
          action('Settings', 'settings:open')),
        !this.workspace.project && recents.length ? h('div.welcome-recents',
          h('div.welcome-heading', 'Recent'),
          recents.map((p) => h('button.welcome-recent', { onclick: () => this.openProject(p) },
            h('span.recent-name', basename(p)), h('span.recent-path', p.replace(this.userInfo.home, '~'))))) : null,
        h('div.welcome-hint', 'Make it yours — ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.commands.run('settings:open-init-script'); } }, 'init.js'), ', ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.commands.run('settings:open-stylesheet'); } }, 'styles.css'), ' or ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.commands.run('packages:create'); } }, 'a new package'), '.')));
    return el;
  }

  // --- auto save, closed tabs, session -------------------------------------
  bindAutoSave() {
    let timer = null;
    const saveDirty = () => {
      for (const doc of this.workspace.dirtyDocuments()) {
        const item = [...doc.views][0];
        if (doc.path && item) this.workspace.save(item);
      }
    };
    window.addEventListener('blur', () => { if (this.config.get('core.autoSave') === 'onFocusChange') saveDirty(); });
    this.workspace.on('active-item-changed', () => { if (this.config.get('core.autoSave') === 'onFocusChange') saveDirty(); });
    this.workspace.on('editor-updated', (_item, update) => {
      if (!update?.docChanged || this.config.get('core.autoSave') !== 'afterDelay') return;
      clearTimeout(timer);
      timer = setTimeout(saveDirty, this.config.get('core.autoSaveDelay'));
    });
  }

  trackClosedItems() {
    this.closedPaths = [];
    this.workspace.on('item-removed', (item) => {
      queueMicrotask(() => {
        if (item.type === 'editor' && !item.view && item.document.path) {
          this.closedPaths = [item.document.path, ...this.closedPaths.filter((p) => p !== item.document.path)].slice(0, 30);
        }
      });
    });
  }

  bindSessionSaving() {
    let timer = null;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => this.saveSession(), 800); };
    for (const ev of ['item-added', 'item-removed', 'active-item-changed', 'layout-changed']) this.workspace.on(ev, schedule);
    this.sidebar.on('changed', schedule);
    this.panel.on('changed', schedule);
    window.addEventListener('beforeunload', () => this.saveSession());
  }

  saveSession() {
    if (!this.workspace) return;
    this.state.global = { sidebar: this.sidebar.serialize(), panel: this.panel.serialize() };
    const root = this.workspace.project;
    if (root) {
      this.state.sessions ||= {};
      this.state.sessions[root] = { workspace: this.workspace.serialize(), at: Date.now() };
      const entries = Object.entries(this.state.sessions).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 30);
      this.state.sessions = Object.fromEntries(entries);
    }
    this.persistState();
  }

  async persistState() {
    // The main process merges this with what other windows wrote and saves atomically.
    await window.native.state.save(this.state);
  }

  /** Ask about unsaved changes. Resolves true if it's OK to discard the window's state. */
  async confirmUnsaved(action = 'close') {
    const dirty = this.workspace.dirtyDocuments();
    if (!dirty.length) return true;
    const choice = await window.native.dialog.confirm({
      type: 'warning',
      message: dirty.length === 1 ? `Save changes to ${dirty[0].title} before you ${action}?` : `You have ${dirty.length} unsaved files.`,
      detail: dirty.length > 1 ? dirty.map((d) => d.title).join(', ') : "Your changes will be lost if you don't save them.",
      buttons: [dirty.length === 1 ? 'Save' : 'Save All', "Don't Save", 'Cancel'],
      cancelId: 2,
    });
    if (choice === 2) return false;
    if (choice === 0) {
      for (const doc of dirty) if (!await this.workspace.save([...doc.views][0])) return false;
    }
    return true;
  }

  async requestClose() {
    const dirty = this.workspace.dirtyDocuments();
    if (dirty.length) {
      const choice = await window.native.dialog.confirm({
        type: 'warning',
        message: dirty.length === 1 ? `Save changes to ${dirty[0].title}?` : `You have ${dirty.length} unsaved files.`,
        detail: dirty.length > 1 ? dirty.map((d) => d.title).join(', ') : "Your changes will be lost if you don't save them.",
        buttons: [dirty.length === 1 ? 'Save' : 'Save All', "Don't Save", 'Cancel'],
        cancelId: 2,
      });
      if (choice === 2) { window.native.window.cancelClose(); return; }
      if (choice === 0) {
        for (const doc of dirty) {
          const item = [...doc.views][0];
          if (!await this.workspace.save(item)) { window.native.window.cancelClose(); return; }
        }
      }
    }
    this.saveSession();
    await this.persistState();
    window.native.window.close();
  }
}

const app = new App();
window.minimide = app; // handy in DevTools
app.start().catch((err) => {
  console.error(err);
  document.body.append(h('pre.fatal', String(err.stack || err)));
});

