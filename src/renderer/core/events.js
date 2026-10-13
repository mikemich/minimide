// Tiny event + disposable primitives shared by the whole app.

export class Disposable {
  constructor(fn) { this.fn = fn; }
  dispose() { const fn = this.fn; this.fn = null; fn?.(); }
  static from(...items) {
    return new Disposable(() => items.forEach((d) => (typeof d === 'function' ? d() : d?.dispose?.())));
  }
}

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return new Disposable(() => this.handlers.get(event)?.delete(fn));
  }
  once(event, fn) {
    const d = this.on(event, (...a) => { d.dispose(); fn(...a); });
    return d;
  }
  emit(event, ...args) {
    for (const fn of [...(this.handlers.get(event) || [])]) {
      try { fn(...args); } catch (err) { console.error(`[event:${event}]`, err); }
    }
  }
}
