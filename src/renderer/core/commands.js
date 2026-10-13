// Command registry. Every action in Minimide is a named command, so anything can
// be bound to a key, shown in the palette, or invoked by another package.
import { Disposable, Emitter } from './events.js';

export class CommandRegistry extends Emitter {
  constructor() {
    super();
    this.commands = new Map();
  }

  /**
   * add('pkg:do-thing', 'Do Thing', fn, { when, hidden })
   * add({ 'pkg:a': fn, 'pkg:b': { title, run, when } })
   */
  add(id, title, run, opts = {}) {
    if (typeof id === 'object') {
      return Disposable.from(...Object.entries(id).map(([k, v]) =>
        typeof v === 'function' ? this.add(k, titleFromId(k), v) : this.add(k, v.title || titleFromId(k), v.run, v)));
    }
    if (typeof title === 'function') { opts = run || {}; run = title; title = titleFromId(id); }
    const cmd = { id, title: title || titleFromId(id), run, when: opts.when, hidden: !!opts.hidden, category: opts.category || categoryFromId(id) };
    this.commands.set(id, cmd);
    this.emit('changed');
    return new Disposable(() => {
      if (this.commands.get(id) === cmd) { this.commands.delete(id); this.emit('changed'); }
    });
  }

  has(id) { return this.commands.has(id); }
  get(id) { return this.commands.get(id); }

  isEnabled(id) {
    const cmd = this.commands.get(id);
    return !!cmd && (!cmd.when || safeWhen(cmd));
  }

  async run(id, ...args) {
    const cmd = this.commands.get(id);
    if (!cmd) { console.warn(`[commands] unknown command: ${id}`); return false; }
    if (cmd.when && !safeWhen(cmd)) return false;
    try {
      this.emit('will-run', id);
      const result = await cmd.run(...args);
      this.emit('did-run', id);
      return result === undefined ? true : result;
    } catch (err) {
      console.error(`[commands] ${id} failed`, err);
      this.emit('error', id, err);
      return false;
    }
  }

  list() {
    return [...this.commands.values()].filter((c) => !c.hidden && (!c.when || safeWhen(c)));
  }
}

function safeWhen(cmd) {
  try { return cmd.when(); } catch { return false; }
}

export function titleFromId(id) {
  const [pkg, name = pkg] = id.split(':');
  return name.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function categoryFromId(id) {
  if (!id.includes(':')) return '';
  return id.split(':')[0].split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}
