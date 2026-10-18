// Layered configuration: schema defaults <- ~/.minimide/config.json.
// Keys are dotted paths, e.g. "editor.fontSize". The file is watched and live-reloaded.
import { Disposable, Emitter } from './events.js';

export function parseJSONC(text) {
  // Strip // and /* */ comments outside strings, plus trailing commas.
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return out.trim() ? JSON.parse(out) : {};
}

function getPath(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  if (value === undefined) delete cur[parts.at(-1)];
  else cur[parts.at(-1)] = value;
}

export class Config extends Emitter {
  constructor() {
    super();
    this.schema = new Map(); // key -> { type, default, title, description, enum, source }
    this.user = {};
    this.file = null;
    this.lastWritten = null;
  }

  async load(file) {
    this.file = file;
    await this.reload();
  }

  async reload() {
    let text = '{}';
    try { text = await window.native.fs.read(this.file); } catch {}
    if (text === this.lastWritten) { this.lastWritten = null; return; } // our own write echoing back
    try {
      const next = parseJSONC(text);
      const prev = this.user;
      this.user = next;
      this.parseFailed = false;
      this.emitDiff(prev, next);
    } catch (err) {
      this.parseFailed = true;
      this.emit('error', err);
    }
  }

  emitDiff(prevUser, nextUser) {
    const keys = new Set([...this.schema.keys(), ...flatKeys(prevUser), ...flatKeys(nextUser)]);
    for (const key of keys) {
      const a = getPath(prevUser, key);
      const b = getPath(nextUser, key);
      if (JSON.stringify(a) !== JSON.stringify(b)) this.emit(`change:${key}`, this.get(key));
    }
    this.emit('change');
  }

  /** register({ 'editor.fontSize': { type: 'number', default: 14, title, description } }, source) */
  register(schema, source = 'core') {
    for (const [key, def] of Object.entries(schema)) this.schema.set(key, { ...def, key, source });
    this.emit('schema');
    return new Disposable(() => {
      for (const key of Object.keys(schema)) if (this.schema.get(key)?.source === source) this.schema.delete(key);
      this.emit('schema');
    });
  }

  get(key, fallback) {
    const v = getPath(this.user, key);
    if (v !== undefined) return v;
    const def = this.schema.get(key);
    return def && def.default !== undefined ? def.default : fallback;
  }

  async set(key, value) {
    const prev = structuredClone(this.user);
    if (value !== undefined && JSON.stringify(value) === JSON.stringify(this.schema.get(key)?.default)) value = undefined;
    setPath(this.user, key, value);
    prune(this.user);
    this.emitDiff(prev, this.user);
    if (this.file) {
      // Rewriting a file we couldn't parse would throw away everything else in it.
      if (this.parseFailed) {
        this.emit('error', new Error('config.json has a syntax error, so this change was applied for now but not saved. Fix the file to save settings again.'));
        return;
      }
      this.lastWritten = JSON.stringify(this.user, null, 2) + '\n';
      await window.native.fs.write(this.file, this.lastWritten);
    }
  }

  /** observe(key, fn) calls fn now and on every change. */
  observe(key, fn) {
    fn(this.get(key));
    return this.on(`change:${key}`, fn);
  }

  onDidChange(key, fn) { return this.on(`change:${key}`, fn); }
}

function flatKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v, key));
    else out.push(key);
  }
  return out;
}

function prune(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      prune(v);
      if (!Object.keys(v).length) delete obj[k];
    }
  }
}
