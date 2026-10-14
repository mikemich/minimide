// Global keymap with chords ("Mod-k Mod-b"), user overrides, and pretty printing.
import { Disposable, Emitter } from './events.js';

const isMac = navigator.platform.toLowerCase().includes('mac');

const CODE_KEYS = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
  Backquote: '`', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Space: 'Space',
};

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

/** Normalize "mod-shift-P" / "Cmd+Shift+p" into a canonical "Shift-Cmd-p" form. */
export function normalizeKeystroke(stroke) {
  const parts = stroke.split(/[-+](?!$)/);
  let key = parts.pop();
  const mods = new Set();
  for (let p of parts) {
    p = p.toLowerCase();
    if (p === 'mod') mods.add(isMac ? 'Cmd' : 'Ctrl');
    else if (p === 'cmd' || p === 'meta' || p === 'super') mods.add('Cmd');
    else if (p === 'ctrl' || p === 'control') mods.add('Ctrl');
    else if (p === 'alt' || p === 'option' || p === 'opt') mods.add('Alt');
    else if (p === 'shift') mods.add('Shift');
  }
  key = key.length === 1 ? key.toLowerCase() : key[0].toUpperCase() + key.slice(1);
  if (key === ' ') key = 'Space';
  if (key === 'Esc') key = 'Escape';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('-');
}

export function normalizeBinding(binding) {
  return binding.trim().split(/\s+/).map(normalizeKeystroke).join(' ');
}

export function keystrokeFromEvent(e) {
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Cmd');
  return [...mods, key].join('-');
}

const PRETTY_MAC = { Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Backspace: '⌫', Escape: '⎋', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: '⇥', Space: '␣' };

export function prettyBinding(binding) {
  return binding.split(' ').map((stroke) => {
    const parts = stroke.split(/-(?!$)/);
    if (isMac) return parts.map((p) => PRETTY_MAC[p] || (p.length === 1 ? p.toUpperCase() : p)).join('');
    return parts.map((p) => (p === 'Cmd' ? 'Super' : p.length === 1 ? p.toUpperCase() : p)).join('+');
  }).join(' ');
}

export class Keymap extends Emitter {
  constructor(commands) {
    super();
    this.commands = commands;
    this.layers = []; // { bindings: Map<binding, commandId|null>, source }
    this.userLayer = { bindings: new Map(), source: 'user' };
    this.pending = [];
    this.pendingTimer = null;
    this.passthroughCommands = new Set();
    window.addEventListener('keydown', (e) => this.handle(e), true);
  }

  add(bindings, source = 'core') {
    const layer = { bindings: new Map(Object.entries(bindings).map(([k, v]) => [normalizeBinding(k), v])), source };
    this.layers.push(layer);
    this.emit('changed');
    return new Disposable(() => {
      this.layers = this.layers.filter((l) => l !== layer);
      this.emit('changed');
    });
  }

  setUserBindings(bindings) {
    this.userLayer.bindings = new Map(Object.entries(bindings || {}).map(([k, v]) => [normalizeBinding(k), v]));
    this.emit('changed');
  }

  /** Effective binding -> command map (user wins, later layers win). */
  resolved() {
    const map = new Map();
    for (const layer of [...this.layers, this.userLayer]) for (const [k, v] of layer.bindings) map.set(k, v);
    for (const [k, v] of map) if (v == null) map.delete(k);
    return map;
  }

  /** Every command bound to `binding`, highest priority first (user, then later layers). */
  candidates(binding) {
    const out = [];
    for (const layer of [this.userLayer, ...[...this.layers].reverse()]) {
      if (!layer.bindings.has(binding)) continue;
      const cmd = layer.bindings.get(binding);
      if (cmd == null) break; // explicitly unbound: stop here
      if (!out.includes(cmd)) out.push(cmd);
    }
    return out;
  }

  bindingsFor(commandId) {
    const out = [];
    for (const [k, v] of this.resolved()) if (v === commandId) out.push(k);
    return out;
  }

  /** Commands that still fire inside passthrough zones (e.g. terminal:toggle). */
  allowInPassthrough(...ids) {
    for (const id of ids) this.passthroughCommands.add(id);
    return new Disposable(() => { for (const id of ids) this.passthroughCommands.delete(id); });
  }

  handle(e) {
    if (e.isComposing) return;
    const stroke = keystrokeFromEvent(e);
    if (!stroke) return;
    const seq = [...this.pending, stroke].join(' ');
    // Inside [data-keymap-passthrough] (terminals, Vim) the keyboard belongs to the program running
    // there: only ⌘ shortcuts (Ctrl-Shift elsewhere), F-keys and allowed commands are handled.
    const passthrough = !!e.target?.closest?.('[data-keymap-passthrough]');
    const reserved = (binding) => {
      const first = binding.split(' ')[0];
      if (/^(Shift-)?F\d+$/.test(first)) return true;
      return isMac ? first.includes('Cmd-') : /^Ctrl-(Alt-)?Shift-/.test(first);
    };
    const allowed = (binding, id) => !passthrough || this.passthroughCommands.has(id) || reserved(binding);
    const editable = isEditable(e.target);
    const bare = !/^(Ctrl|Alt|Cmd)-/.test(stroke) && !/^(Shift-)?(F\d+|Escape)$/.test(stroke);
    const blockedBare = bare && editable && !this.pending.length;

    // A key can map to several commands; the first allowed one whose `when` passes wins.
    const exact = this.candidates(seq).find((id) => allowed(seq, id) && this.commands.isEnabled(id));
    const isPrefix = [...this.resolved()].some(([k, id]) => k.startsWith(seq + ' ') && allowed(k, id));

    if (exact && !blockedBare) {
      e.preventDefault();
      e.stopPropagation();
      this.clearPending();
      this.commands.run(exact);
      return;
    }
    if (isPrefix && !blockedBare) {
      e.preventDefault();
      e.stopPropagation();
      this.pending.push(stroke);
      this.emit('pending', this.pending.join(' '));
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.clearPending(), 2000);
      return;
    }
    if (this.pending.length) {
      e.preventDefault();
      e.stopPropagation();
      this.clearPending();
    }
  }

  clearPending() {
    this.pending = [];
    clearTimeout(this.pendingTimer);
    this.emit('pending', '');
  }
}

function isEditable(el) {
  return el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

export { isMac };
