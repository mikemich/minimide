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
  }

  async start() {
    this.userInfo = await window.native.user.info();
    document.body.classList.add(`platform-${this.userInfo.platform}`);

    this.config.register(CORE_SCHEMA, 'core');
    await this.config.load(`${this.userInfo.dir}/config.json`);
    this.config.on('error', (err) => notify.error('Could not parse config.json', err.message));
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
    window.native.window.onCommand((id) => this.commands.run(id));
    window.native.window.onRequestClose(() => this.requestClose());
    this.workspace.on('files-changed', (paths) => this.invalidateFileCache(paths));
    this.trackClosedItems();
    this.bindAutoSave();
    this.bindSessionSaving();

    const initial = await window.native.project.initial();
    const project = initial.project || (initial.restore && this.config.get('core.restoreSession') ? this.state.lastProject : null);
    if (project && await window.native.fs.stat(project)) await this.openProject(project, { restore: this.config.get('core.restoreSession') });
    else this.workspace.updateTitle();

    await this.runInitScript();
    document.body.classList.add('ready');
  }

  // --- appearance ----------------------------------------------------------
  bindAppearance() {
    const root = document.documentElement.style;
    this.config.observe('editor.fontFamily', (v) => root.setProperty('--editor-font', v));
    this.config.observe('editor.fontSize', (v) => root.setProperty('--editor-font-size', `${v}px`));
    this.config.observe('editor.lineHeight', (v) => root.setProperty('--editor-line-height', String(v)));
    this.config.observe('ui.fontSize', (v) => root.setProperty('--ui-font-size', `${v}px`));
    this.config.observe('ui.compactTabs', (v) => document.body.classList.toggle('compact-tabs', !!v));
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

  invalidateFileCache(paths) {
    const cache = this.fileCache;
    if (!cache?.set) return;
    const root = this.workspace.project;
    if (paths.some((p) => !cache.set.has(p.slice(root.length + 1)))) this.fileCache = null;
  }

  // --- processes -----------------------------------------------------------
  spawn(command, { cwd, env, onData, onExit } = {}, track = (d) => d) {
    const id = `p${++this.procSeq}`;
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
    // Merge with whatever other windows wrote, so they don't clobber each other.
    const disk = await window.native.state.load();
    const merged = { ...disk, ...this.state, sessions: { ...disk.sessions, ...this.state.sessions } };
    await window.native.state.save(merged);
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
      if (choice === 2) return;
      if (choice === 0) {
        for (const doc of dirty) {
          const item = [...doc.views][0];
          if (!await this.workspace.save(item)) return;
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

