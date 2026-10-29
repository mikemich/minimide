// Runs one sandboxed package in a module worker.
//
// The worker has no DOM, no Node and (by its CSP) no network. The only way it can affect
// anything is by messaging the editor, which checks each request against the permissions
// the user granted when installing the package (see core/sandbox.js). This file builds the
// friendly `mide` API out of those messages. Every call that crosses over returns a promise.

const post = self.postMessage.bind(self);
const pending = new Map();
const callbacks = new Map();
const listeners = new Map();
let seq = 0;
let config = {};
let project = null;
let folders = [];
let pkg = null;
let mod = null;

// Every sandboxed worker shares the editor's origin (mide://app), so anything origin-wide would be
// a channel between packages (pooling permissions granted to different ones) or into the editor's
// storage. Remove them before package code runs, on the prototypes too, so a saved getter can't
// bring them back.
const hide = (obj, key) => {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      try { Object.defineProperty(o, key, { value: undefined, writable: false, configurable: false }); } catch {}
    }
  }
  try { Object.defineProperty(obj, key, { value: undefined, writable: false, configurable: false }); } catch {}
};
for (const key of ['indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Worker', 'webkitRequestFileSystem', 'webkitResolveLocalFileSystemURL']) hide(self, key);
for (const key of ['storage', 'locks', 'serviceWorker']) hide(navigator, key);

const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  post({ type: 'call', id, method, args });
});
const callback = (fn) => { const id = ++seq; callbacks.set(id, fn); return id; };
const disposable = (fn) => { let done = false; return { dispose() { if (!done) { done = true; fn(); } } }; };
const on = (name, fn) => {
  if (!listeners.has(name)) { listeners.set(name, new Set()); post({ type: 'subscribe', name }); }
  listeners.get(name).add(fn);
  return disposable(() => listeners.get(name)?.delete(fn));
};

const basename = (p) => p.replace(/\/+$/, '').split('/').pop();
const dirname = (p) => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';

function addCommand(id, title, run) {
  const cb = callback(run);
  call('commands.add', id, title, cb).catch((err) => console.error(`[${pkg.name}]`, err.message));
  return disposable(() => { callbacks.delete(cb); call('commands.remove', id).catch(() => {}); });
}

const mide = {
  sandboxed: true,
  get package() { return pkg; },
  get project() { return project; },
  /** Every project folder, the project first. */
  get folders() { return [...folders]; },
  Disposable: { from: (...ds) => disposable(() => ds.forEach((d) => d?.dispose?.())) },

  commands: {
    /** add('pkg:id', 'Title', fn) or add({ 'pkg:id': fn | { title, run } }) */
    add(id, title, run) {
      if (typeof id === 'object') {
        const ds = Object.entries(id).map(([k, v]) => (typeof v === 'function' ? addCommand(k, null, v) : addCommand(k, v.title, v.run)));
        return disposable(() => ds.forEach((d) => d.dispose()));
      }
      if (typeof title === 'function') return addCommand(id, null, title);
      return addCommand(id, title, run);
    },
    run: (id, ...args) => call('commands.run', id, args),
  },

  notify: Object.fromEntries(['info', 'success', 'warn', 'error'].map((level) => [level, (title, detail, opts = {}) =>
    call('notify', level, String(title ?? ''), detail == null ? null : String(detail), (opts.actions || []).map((a) => ({ label: String(a.label), callback: callback(a.run) })))])),

  config: {
    get: (key, fallback) => (key in config && config[key] !== undefined ? config[key] : fallback),
    set: (key, value) => call('config.set', key, value),
    onDidChange: (key, fn) => on('config', (changes) => { if (key in changes) fn(changes[key]); }),
    observe(key, fn) { fn(this.get(key)); return this.onDidChange(key, fn); },
  },

  statusBar: {
    /** addItem({ text, tooltip, align: 'left'|'right', priority, onClick }) */
    addItem({ text = '', tooltip = '', align = 'left', priority = 100, onClick } = {}) {
      const click = onClick ? callback(onClick) : null;
      const id = call('statusBar.add', { text: String(text), tooltip: String(tooltip), align, priority, click });
      return {
        setText: (t) => id.then((i) => call('statusBar.update', i, { text: String(t) })),
        setTooltip: (t) => id.then((i) => call('statusBar.update', i, { tooltip: String(t) })),
        dispose: () => { if (click) callbacks.delete(click); id.then((i) => call('statusBar.remove', i)); },
      };
    },
  },

  workspace: {
    /** { path, language, dirty } of the active editor, or null. */
    getActiveEditor: () => call('editor.info'),
    onDidChangeActiveEditor: (fn) => on('activeEditor', fn),
    onDidSave: (fn) => on('save', fn),
    onDidChangeProject: (fn) => on('project', fn),
    onDidChangeFolders: (fn) => on('folders', fn),
    open: (path, opts) => call('workspace.open', path, opts),
  },

  editor: {
    getText: () => call('editor.getText'),
    getSelectedText: () => call('editor.getSelectedText'),
    getCursor: () => call('editor.getCursor'),
    insertText: (text) => call('editor.insertText', String(text)),
    replaceSelection: (text) => call('editor.replaceSelection', String(text)),
    setText: (text) => call('editor.setText', String(text)),
    /** Called (debounced) after the active editor's text changes: fn({ path }) */
    onDidChange: (fn) => on('editorChange', fn),
  },

  ui: {
    /** selectList({ items: [{ label, detail, hint }], placeholder }) -> the chosen item, or null */
    async selectList({ items = [], placeholder } = {}) {
      const index = await call('ui.selectList', { placeholder, items: items.map((i) => ({ label: String(i.label ?? i), detail: i.detail ? String(i.detail) : undefined, hint: i.hint ? String(i.hint) : undefined })) });
      return index == null ? null : items[index];
    },
    /** prompt({ title, placeholder, value }) -> string, or null if cancelled */
    prompt: (opts = {}) => call('ui.prompt', { title: opts.title, placeholder: opts.placeholder, value: opts.value }),
  },

  // These need permissions ("project-files"/"files", "shell", "network", "clipboard").
  fs: {
    read: (p) => call('fs.read', p),
    write: (p, text) => call('fs.write', p, String(text)),
    readdir: (p) => call('fs.readdir', p),
    stat: (p) => call('fs.stat', p),
  },
  process: { exec: (cmd, args = [], opts = {}) => call('process.exec', cmd, args, opts) },
  net: { fetch: (url, opts = {}) => call('net.fetch', String(url), opts) },
  clipboard: { writeText: (t) => call('clipboard.writeText', String(t)), readText: () => call('clipboard.readText') },
  shell: { openExternal: (url) => call('shell.openExternal', String(url)) },
  path: { basename, dirname, join: (...p) => p.join('/').replace(/\/+/g, '/') },
};

self.onmessage = async ({ data: m }) => {
  if (m.type === 'result') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
  } else if (m.type === 'callback') {
    try { await callbacks.get(m.id)?.(...(m.args || [])); } catch (err) { console.error(`[${pkg?.name}]`, err); }
  } else if (m.type === 'event') {
    if (m.name === 'config') Object.assign(config, m.data);
    if (m.name === 'project') project = m.data;
    if (m.name === 'folders') { folders = m.data; project = folders[0] ?? null; }
    for (const fn of listeners.get(m.name) || []) { try { fn(m.data); } catch (err) { console.error(`[${pkg?.name}]`, err); } }
  } else if (m.type === 'init') {
    pkg = Object.freeze({ name: m.name, manifest: m.manifest, permissions: Object.freeze([...m.permissions]) });
    config = m.config;
    project = m.project;
    folders = m.folders || [];
    on('folders', () => {}); // keeps `folders` and `project` current
    try {
      mod = await import(m.url);
      await mod.activate?.(mide);
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'failed', error: err?.message || String(err) });
    }
  } else if (m.type === 'deactivate') {
    try { await mod?.deactivate?.(); } catch (err) { console.error(err); }
    post({ type: 'deactivated' });
  }
};
