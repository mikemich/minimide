// The editor side of sandboxed packages (the package side is ../sandbox-worker.js).
//
// A sandboxed package runs in its own worker with no DOM, Node or network. Everything it
// does arrives here as a message, and each request is checked against the permissions the
// user granted at install time. Without permissions a package can add commands, status bar
// items and notifications, show pickers, read settings, and read/edit the active editor.
import { Disposable } from './events.js';

const VISIBLE_CONFIG = (name) => (key) => key.startsWith(`${name}.`) || key.startsWith('editor.') || key.startsWith('ui.') || key === 'core.theme';
const LIMITS = { commands: 200, statusItems: 5, listItems: 5000, text: 200, notifications: 3, notifyWindowMs: 10000 };
const RATE = { burst: 400, perSecond: 200, maxDropped: 5000 };

export class SandboxedPackage {
  constructor(app, pkg, permissions) {
    this.app = app;
    this.pkg = pkg;
    this.name = pkg.meta.name;
    this.permissions = new Set(permissions);
    this.subs = [];
    this.commands = new Map(); // id -> Disposable
    this.statusItems = new Map(); // id -> { dispose, el }
    this.subscribed = new Set();
    this.seq = 0;
    this.lastConfig = {};
    this.dropped = 0;
    this.recentNotifications = [];
  }

  /** Starts the worker and resolves once the package's activate() has finished. */
  start(moduleUrl) {
    // ?pkg= gives this worker a CSP that only allows loading this package's own files.
    this.worker = new Worker(new URL(`mide://app/sandbox-worker.js?pkg=${encodeURIComponent(this.name)}`), { type: 'module', name: `sandbox:${this.name}` });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The package took more than 10 seconds to start.')), 10000);
      this.worker.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message || 'The sandbox failed to start.')); };
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'ready') { clearTimeout(timeout); resolve(); return; }
        if (m.type === 'failed') { clearTimeout(timeout); reject(new Error(m.error)); return; }
        this.onMessage(m);
      };
      this.worker.postMessage({
        type: 'init', name: this.name, manifest: this.pkg.meta.manifest, url: moduleUrl,
        permissions: [...this.permissions], config: this.configSnapshot(), project: this.app.workspace.project, folders: [...this.app.workspace.folders],
      });
    });
  }

  dispose() {
    try { this.worker?.postMessage({ type: 'deactivate' }); } catch {}
    const worker = this.worker;
    setTimeout(() => worker?.terminate(), 300); // let deactivate() run briefly, then stop it regardless
    this.worker = null;
    for (const d of [...this.commands.values(), ...this.statusItems.values(), ...this.subs]) { try { d.dispose(); } catch {} }
    this.commands.clear();
    this.statusItems.clear();
    this.subs = [];
  }

  post(msg) { this.worker?.postMessage(msg); }
  emit(name, data) { if (this.subscribed.has(name)) this.post({ type: 'event', name, data }); }
  invoke(id, args = []) { this.post({ type: 'callback', id, args: safeClone(args) }); }

  configSnapshot() {
    const visible = VISIBLE_CONFIG(this.name);
    const out = {};
    for (const def of this.app.config.schema.values()) if (visible(def.key)) out[def.key] = safeClone(this.app.config.get(def.key));
    return (this.lastConfig = out);
  }

  async onMessage(m) {
    if (m.type === 'subscribe') return this.subscribe(m.name);
    if (m.type !== 'call') return;
    if (!this.allowCall()) { this.post({ type: 'result', id: m.id, error: 'Too many requests; slow down.' }); return; }
    try {
      const fn = this.methods[m.method];
      if (!fn) throw new Error(`Unknown sandbox call "${m.method}"`);
      const value = await fn.apply(this, m.args || []);
      this.post({ type: 'result', id: m.id, value: safeClone(value) });
    } catch (err) {
      this.post({ type: 'result', id: m.id, error: err?.message || String(err) });
    }
  }

  need(...perms) {
    if (perms.some((p) => this.permissions.has(p))) return;
    const labels = { 'project-files': 'read project files', 'project-write': 'change project files', files: 'access files', shell: 'run programs', network: 'use the network', clipboard: 'read the clipboard', commands: 'run other commands' };
    throw new Error(`"${this.name}" doesn't have permission to ${labels[perms[0]] || perms[0]}. Add "${perms[0]}" to its "permissions" in package.json.`);
  }

  activeEditor() { return this.app.workspace.getActiveEditor(); }
  editorInfo(ed = this.activeEditor()) { return ed ? { path: ed.getPath() || null, language: ed.getLanguageName(), dirty: ed.isDirty() } : null; }

  subscribe(name) {
    if (this.subscribed.has(name)) return;
    this.subscribed.add(name);
    const ws = this.app.workspace;
    const track = (d) => this.subs.push(d);
    if (name === 'activeEditor') track(ws.on('active-item-changed', () => this.emit('activeEditor', this.editorInfo())));
    else if (name === 'save') track(ws.on('did-save', (item) => this.emit('save', { path: item?.getPath?.() || null })));
    else if (name === 'project') track(ws.on('project-changed', (root) => this.emit('project', root)));
    else if (name === 'folders') track(ws.on('folders-changed', (folders) => this.emit('folders', [...folders])));
    else if (name === 'editorChange') {
      let timer = null;
      track(ws.on('editor-updated', (ed, update) => {
        if (ed !== this.activeEditor() || (update && !update.docChanged)) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.emit('editorChange', { path: ed.getPath() || null }), 250);
      }));
      track(new Disposable(() => clearTimeout(timer)));
    } else if (name === 'config') {
      track(this.app.config.on('change', () => {
        const before = this.lastConfig;
        const now = this.configSnapshot();
        const changes = {};
        for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) changes[k] = now[k];
        if (Object.keys(changes).length) this.emit('config', changes);
      }));
    }
  }

  // Resolves a path the package wants to touch, enforcing "project-files" vs "files". Returns the
  // real path (symlinks resolved), so what was checked is exactly what gets read or written.
  async checkPath(p, { forWrite = false } = {}) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('Expected a file path.');
    if (!this.permissions.has('files')) {
      if (forWrite) this.need('project-write');
      else this.need('project-files', 'project-write');
    }
    const project = this.app.workspace.project;
    const abs = normalize(/^([/\\]|[A-Za-z]:[\\/])/.test(p) ? p : `${project || ''}/${p}`);
    const real = async (x) => (await window.native.fs.realpath(x).catch(() => null)) || null;
    let target = await real(abs);
    if (!target && forWrite) { const parent = await real(abs.replace(/\/[^/]+$/, '')); target = parent && `${parent}/${abs.split('/').pop()}`; }
    if (!target) target = abs;
    // ~/.minimide holds code that runs with full access (init.js, your packages, installed.json),
    // so no permission reaches it: writing there would turn any file access into full access.
    const userDir = (await real(this.app.userInfo.dir)) || this.app.userInfo.dir;
    if (within(target, userDir)) throw new Error(`"${this.name}" can't access Minimide's own folder (${this.app.userInfo.dir}).`);
    // git and language servers run code from these (a command in .git/config, a TypeScript copy in
    // node_modules), so writing there would amount to running programs.
    if (forWrite && /(^|\/)(\.git|node_modules)(\/|$)/i.test(target)) throw new Error(`"${this.name}" can't change files inside .git or node_modules.`);
    if (this.permissions.has('files')) return target;
    if (!project) throw new Error('No project is open.');
    // Compare real paths, so a symlink inside the project can't lead outside it.
    const roots = await Promise.all(this.app.workspace.folders.map(async (f) => (await real(f)) || f));
    if (!roots.some((root) => within(target, root))) throw new Error(`"${this.name}" can only access files inside the open project.`);
    return target;
  }

  // Editing the open file is allowed without permissions, but not when that file is one that
  // runs with full access once you save it (init.js, your packages) or that git executes.
  guardActiveEditor() {
    const path = this.activeEditor()?.getPath();
    if (path && (within(path, this.app.userInfo.dir) || /(^|\/)\.git(\/|$)/.test(path))) {
      throw new Error(`"${this.name}" can't edit ${path.split('/').pop()}: it's part of Minimide's settings or git's internals.`);
    }
  }

  // Each package gets a budget of calls, so a flood can't freeze the editor.
  allowCall() {
    const now = performance.now();
    this.tokens = Math.min(RATE.burst, (this.tokens ?? RATE.burst) + ((now - (this.lastRefill ?? now)) / 1000) * RATE.perSecond);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    if (++this.dropped > RATE.maxDropped && this.worker) {
      this.app.ui.notify.error(`Stopped "${this.name}"`, 'It was sending requests faster than Minimide allows.');
      this.app.packages.deactivate(this.name);
    }
    return false;
  }

  get methods() {
    const app = this.app;
    const name = this.name;
    const text = (s, max = LIMITS.text) => String(s ?? '').slice(0, max);
    return {
      'commands.add'(id, title, callback) {
        if (typeof id !== 'string' || !id.startsWith(`${name}:`)) throw new Error(`Command ids must start with "${name}:" (got "${id}").`);
        if (this.commands.size >= LIMITS.commands) throw new Error('Too many commands.');
        if (app.commands.has(id) && !this.commands.has(id)) throw new Error(`Command "${id}" already exists.`);
        this.commands.get(id)?.dispose();
        this.commands.set(id, app.commands.add(id, title ? text(title, 100) : undefined, (...args) => this.invoke(callback, args)));
      },
      'commands.remove'(id) { this.commands.get(id)?.dispose(); this.commands.delete(id); },
      'commands.run'(id, args = []) {
        if (!String(id).startsWith(`${name}:`)) this.need('commands');
        return app.commands.run(id, ...args);
      },
      notify(level, title, detail, actions = []) {
        const now = Date.now();
        this.recentNotifications = this.recentNotifications.filter((t) => now - t < LIMITS.notifyWindowMs);
        if (this.recentNotifications.length >= LIMITS.notifications) throw new Error('Too many notifications.');
        this.recentNotifications.push(now);
        if (!['info', 'success', 'warn', 'error'].includes(level)) level = 'info';
        app.ui.notify[level](text(title), detail == null ? undefined : text(detail, 2000), {
          actions: actions.slice(0, 3).map((a) => ({ label: text(a.label, 40), run: () => this.invoke(a.callback) })),
        });
      },
      'config.set'(key, value) {
        if (!String(key).startsWith(`${name}.`)) throw new Error(`"${name}" can only change its own settings ("${name}.*").`);
        return app.config.set(key, value);
      },
      'statusBar.add'({ text: t, tooltip, align, priority, click }) {
        if (this.statusItems.size >= LIMITS.statusItems) throw new Error('A package can add at most 5 status bar items.');
        const id = ++this.seq;
        const el = document.createElement('span');
        el.textContent = text(t, 80);
        const d = app.statusBar.addItem({ id: `${name}-${id}`, element: el, tooltip: text(tooltip), align: align === 'right' ? 'right' : 'left', priority: Number(priority) || 100, onClick: click ? () => this.invoke(click) : undefined });
        this.statusItems.set(id, { dispose: () => d.dispose(), el });
        return id;
      },
      'statusBar.update'(id, { text: t, tooltip }) {
        const item = this.statusItems.get(id);
        if (!item) return;
        if (t !== undefined) item.el.textContent = text(t, 80);
        if (tooltip !== undefined) item.el.parentElement?.setAttribute('title', text(tooltip));
      },
      'statusBar.remove'(id) { this.statusItems.get(id)?.dispose(); this.statusItems.delete(id); },
      'editor.info'() { return this.editorInfo(); },
      'editor.getText'() { return this.activeEditor()?.getText() ?? null; },
      'editor.getSelectedText'() { return this.activeEditor()?.getSelectedText() ?? null; },
      'editor.getCursor'() {
        const view = this.activeEditor()?.view;
        if (!view) return null;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        return { line: line.number, col: head - line.from + 1 };
      },
      'editor.insertText'(t) { this.guardActiveEditor(); const view = this.activeEditor()?.view; if (!view) return false; view.dispatch(view.state.replaceSelection(String(t)), { userEvent: 'input' }); return true; },
      'editor.replaceSelection'(t) { return this.methods['editor.insertText'].call(this, t); },
      'editor.setText'(t) {
        this.guardActiveEditor();
        const view = this.activeEditor()?.view;
        if (!view) return false;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(t) }, userEvent: 'input' });
        return true;
      },
      async 'workspace.open'(p, opts = {}) {
        const abs = await this.checkPath(p);
        await app.workspace.open(abs, { line: opts.line, col: opts.col });
      },
      async 'ui.selectList'({ items = [], placeholder }) {
        const list = items.slice(0, LIMITS.listItems).map((it, i) => ({ label: text(it.label), detail: it.detail ? text(it.detail) : undefined, hint: it.hint ? text(it.hint, 40) : undefined, __i: i }));
        return new Promise((resolve) => app.ui.selectList({
          id: `sandbox-${name}`, placeholder: `${name}: ${text(placeholder) || 'choose an item'}`, items: list,
          onSelect: (it) => resolve(it.__i), onCancel: () => resolve(null),
        }));
      },
      // Labelled with the package's name, so a prompt can't pass itself off as Minimide asking.
      'ui.prompt'({ title, placeholder, value }) { return app.ui.prompt({ title: `${name} asks: ${text(title)}`, placeholder: text(placeholder), value: text(value, 10000) }); },
      async 'fs.read'(p) { return window.native.fs.read(await this.checkPath(p)); },
      async 'fs.write'(p, t) { return window.native.fs.write(await this.checkPath(p, { forWrite: true }), String(t)); },
      async 'fs.readdir'(p) { return window.native.fs.readdir(await this.checkPath(p)); },
      async 'fs.stat'(p) { return window.native.fs.stat(await this.checkPath(p)); },
      'process.exec'(cmd, args = [], opts = {}) {
        this.need('shell');
        return window.native.proc.exec(String(cmd), (args || []).map(String), { cwd: opts.cwd || app.workspace.project || undefined, timeout: Math.min(Number(opts.timeout) || 30000, 120000) });
      },
      'net.fetch'(url, opts = {}) {
        this.need('network');
        return window.native.net.fetch(url, { method: opts.method, headers: opts.headers, body: typeof opts.body === 'string' ? opts.body : undefined });
      },
      'clipboard.writeText'(t) { return window.native.clipboard.write(String(t)); },
      'clipboard.readText'() { this.need('clipboard'); return window.native.clipboard.read(); },
      'shell.openExternal'(url) {
        // Opening a URL can carry data out, so it counts as network access.
        this.need('network');
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links can be opened.');
        return window.native.shell.openExternal(url);
      },
    };
  }
}

/**
 * Stylesheets from sandboxed packages (including installed themes) go through the browser's own
 * CSS parser, then only safe declarations are kept:
 * - visual properties only (colors, borders, shadows, fonts…), so a package can restyle the editor
 *   but can't position, add content to or hide UI, which would let it draw fake prompts;
 * - images only from data: or the package's own files, so CSS can't contact the internet
 *   (the parser has already resolved escapes like `u\72l(`, and image-set() is covered too).
 * Custom properties (--x) are allowed, but not with any url-like value.
 */
const SAFE_PROPERTY = /^(--[\w-]+|color|background(-color|-image|-position.*|-size|-repeat|-clip|-origin|-blend-mode)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(color|style|width|radius))?|border-(top|bottom)-(left|right)-radius|border-(start|end)-(start|end)-radius|outline(-(color|style|width|offset))?|box-shadow|text-shadow|text-decoration(-(line|color|style|thickness))?|text-underline-offset|font(-(family|style|weight|size|variant.*|feature-settings|stretch))?|letter-spacing|line-height|caret-color|accent-color|fill|stroke(-width)?|opacity|cursor|transition(-.*)?|animation(-.*)?|color-scheme|scrollbar-(color|width)|filter|backdrop-filter|mix-blend-mode|-webkit-font-smoothing|font-smooth)$/i;
const URLISH = /\b(url|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|paint|src)\s*\(/i;

export async function loadSandboxedStyles(baseUrl, file, owner) {
  const res = await fetch(baseUrl + file);
  if (!res.ok) throw new Error(`Couldn't load ${file}`);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await res.text()); // drops @import; unparseable rules are skipped
  const own = new URL(baseUrl).href.replace(/~\d+\/$/, ''); // mide://pkg/<name>/
  const fileUrl = new URL(file, baseUrl).href;

  const safeValue = (prop, value) => {
    if (!URLISH.test(value)) return value;
    if (prop.startsWith('--')) return null;
    // Every url-like function must be url("data:image|font…") or a file of this package.
    let ok = true;
    const rewritten = value.replace(/\b([\w-]+)\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))/gi, (m, fn, d, s1, bare) => {
      if (!URLISH.test(`${fn}(`)) return m;
      const target = d ?? s1 ?? bare ?? '';
      if (fn.toLowerCase() !== 'url') { ok = false; return m; }
      if (/^data:(image|font)\//i.test(target)) return m;
      let abs;
      try { abs = new URL(target, fileUrl).href; } catch { ok = false; return m; }
      if (!abs.replace(/~\d+\//, '').startsWith(own)) { ok = false; return m; }
      return `url("${abs}"`;
    });
    return ok ? rewritten : null;
  };

  const walk = (rules) => [...rules].flatMap((rule) => {
    if (rule instanceof CSSStyleRule || rule instanceof CSSFontFaceRule || rule instanceof CSSKeyframeRule) {
      const decls = [];
      for (const prop of rule.style) {
        const fontFace = rule instanceof CSSFontFaceRule && /^(src|font-family|font-style|font-weight|font-display|unicode-range)$/.test(prop);
        if (!SAFE_PROPERTY.test(prop) && !fontFace) continue;
        const value = safeValue(prop, rule.style.getPropertyValue(prop));
        if (value != null) decls.push(`${prop}: ${value}${rule.style.getPropertyPriority(prop) ? ' !important' : ''};`);
      }
      const selector = rule instanceof CSSFontFaceRule ? '@font-face' : rule instanceof CSSKeyframeRule ? rule.keyText : rule.selectorText;
      return decls.length ? [`${selector} { ${decls.join(' ')} }`] : [];
    }
    if (rule instanceof CSSKeyframesRule) return [`@keyframes ${rule.name} { ${walk(rule.cssRules).join(' ')} }`];
    if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner = walk(rule.cssRules);
      return inner.length ? [`@${rule instanceof CSSMediaRule ? 'media' : 'supports'} ${rule.conditionText} { ${inner.join(' ')} }`] : [];
    }
    return []; // @import, @layer, @property, @page, @container… are dropped
  });
  const out = walk(sheet.cssRules);

  const el = document.createElement('style');
  el.dataset.pkg = owner;
  el.textContent = out.join('\n');
  const userStyles = document.getElementById('user-styles');
  userStyles ? userStyles.before(el) : document.head.append(el);
  return el;
}

// Path containment, ignoring case on macOS and Windows (their file systems usually do).
const FOLD_CASE = /mac|win/i.test(navigator.platform);
function within(path, dir) {
  const a = FOLD_CASE ? path.toLowerCase() : path;
  const b = (FOLD_CASE ? dir.toLowerCase() : dir).replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/');
}

function normalize(p) {
  const out = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return (/^[A-Za-z]:$/.test(out[0] || '') ? '' : '/') + out.join('/');
}

function safeClone(v) {
  try { return structuredClone(v); } catch { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } }
}
