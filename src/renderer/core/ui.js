// UI building blocks shared by core and packages: select lists, prompts,
// notifications, docks (sidebar / bottom panel) and the status bar.
import { Emitter, Disposable } from './events.js';
import { h, icon, makeActivatable } from './dom.js';
import { fuzzyFilter, highlightMatches } from './fuzzy.js';
import { trapTab, focusables, uniqueId } from './a11y.js';

// ---------------------------------------------------------------------------
// Modal overlay management (only one at a time)

let activeModal = null;

export function openModal(el, { onClose, id, label } = {}) {
  activeModal?.close();
  const root = document.getElementById('overlay-root');
  // A dialog: named, modal, with Tab kept inside it and focus handed back to where it was when it closes.
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (label) el.setAttribute('aria-label', label);
  const backdrop = h('div.modal-backdrop', { onmousedown: (e) => { if (e.target === backdrop) modal.close(); }, onkeydown: (e) => trapTab(el, e) }, el);
  const previousFocus = document.activeElement;
  const modal = {
    id,
    el,
    close(restoreFocus = true) {
      if (activeModal !== modal) return;
      activeModal = null;
      backdrop.classList.add('closing');
      backdrop.setAttribute('aria-hidden', 'true');
      setTimeout(() => backdrop.remove(), 90);
      onClose?.();
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
    },
  };
  root.append(backdrop);
  activeModal = modal;
  requestAnimationFrame(() => {
    if (activeModal !== modal || el.contains(document.activeElement)) return;
    const first = focusables(el)[0] || Object.assign(el, { tabIndex: -1 });
    first.focus({ preventScroll: true });
  });
  return modal;
}

export function closeModal() { activeModal?.close(); }
export function isModalOpen(id) { return !!activeModal && (!id || activeModal.id === id); }

// ---------------------------------------------------------------------------
// Select list: the engine behind the palette, file finder and friends.

/**
 * selectList({
 *   items: Item[] | () => Item[] | Promise<Item[]>,
 *   filterKey?: (item) => string,          // default item.label
 *   render?: (item, indices) => Node,       // default label/detail/hint row
 *   onSelect: (item, query) => void,
 *   onQuery?: (query, list) => Item[] | null, // dynamic items (overrides fuzzy filter when non-null)
 *   transformQuery?: (query) => string,     // rewrite the query before fuzzy filtering
 *   alternateQueries?: (query) => string[], // more queries to try (synonyms), ranked with the main one
 *   onEnterWithoutMatch?: (query) => void,  // Enter when nothing matches (e.g. run a typed command)
 *   onHighlight?: (item) => void,
 *   placeholder?, initialQuery?, emptyMessage? (text or () => text), id?, maxItems?
 *   modes?: [{ prefix, title, ...any of the above }], // one box, several searches: see below
 * })
 * Item: { label, detail?, hint?, icon?: Node, ... }
 *
 * With `modes`, what the query starts with picks the mode (">" for commands, "@" for symbols…; the
 * mode with prefix "" is the default), and that mode sees the query without its prefix.
 */
export function selectList(opts) {
  if (opts.id && isModalOpen(opts.id)) { closeModal(); return null; }
  const modes = opts.modes?.length ? opts.modes : [{ ...opts, prefix: '' }];
  const modeFor = (q) => modes.filter((m) => q.startsWith(m.prefix || '')).sort((a, b) => (b.prefix || '').length - (a.prefix || '').length)[0] || modes[0];
  const keyOf = (m) => m.filterKey || ((it) => it.label ?? String(it));
  // Passthrough: Ctrl-N/Ctrl-P move the selection here instead of running New File / Find File.
  const label = opts.label || opts.placeholder || 'Search';
  const listId = uniqueId('select-items');
  const input = h('input.select-input', {
    type: 'text', placeholder: opts.placeholder || 'Type to search…', spellcheck: false, dataset: { keymapPassthrough: '' },
    role: 'combobox', 'aria-label': label, 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-haspopup': 'listbox',
  });
  const badge = h('span.select-mode');
  const list = h('ol.select-items', { id: listId, role: 'listbox', 'aria-label': label });
  const footer = h('div.select-footer');
  const status = h('div.sr-only', { role: 'status' }); // "5 results", read as the list changes
  const panel = h('div.select-list', h('div.select-input-row', input, opts.modes ? badge : null), list, footer, status);
  const loaded = new Map(); // mode -> { items, loading }
  let current = null;
  let filtered = [];
  let selected = 0;

  let chosen = false;
  const modal = openModal(panel, { id: opts.id, label, onClose: () => { if (!chosen) opts.onCancel?.(); } });

  // A mode's items load the first time the query switches to it.
  const stateOf = (m) => {
    if (!loaded.has(m)) {
      const st = { items: [], loading: true };
      loaded.set(m, st);
      Promise.resolve(typeof m.items === 'function' ? m.items() : m.items).then((result) => {
        st.items = result || [];
        st.loading = false;
        if (current === m) update();
      }, () => { st.loading = false; if (current === m) update(); });
    }
    return loaded.get(m);
  };
  const queryFor = (m, q) => (m.prefix ? q.slice(m.prefix.length).trimStart() : q);

  const renderItem = (m, item, indices) => {
    if (m.render) return m.render(item, indices);
    const row = h('div.select-row');
    if (item.icon) row.append(item.icon.cloneNode ? item.icon.cloneNode(true) : item.icon);
    // Highlight matches inside the label even when filtering on a longer key (e.g. "detail label").
    const label = item.label ?? keyOf(m)(item);
    const key = keyOf(m)(item);
    const offset = key === label ? 0 : key.lastIndexOf(label);
    const labelIndices = offset < 0 ? [] : indices.filter((i) => i >= offset && i < offset + label.length).map((i) => i - offset);
    const text = h('div.select-text', h('div.select-label', highlightMatches(label, labelIndices)));
    if (item.detail) text.append(h('div.select-detail', item.detail));
    row.append(text);
    if (item.hint) row.append(h('kbd.select-hint', item.hint));
    return row;
  };

  const update = () => {
    const m = modeFor(input.value);
    current = m;
    const st = stateOf(m);
    const q = queryFor(m, input.value);
    badge.textContent = m.title || '';
    badge.hidden = !m.title;
    const dyn = m.onQuery?.(q, handle);
    if (dyn) filtered = dyn.map((item) => ({ item, indices: [] }));
    else {
      const max = m.maxItems || 100;
      const main = m.transformQuery ? m.transformQuery(q) : q;
      filtered = fuzzyFilter(main, st.items, keyOf(m), max);
      const alts = ((main && m.alternateQueries?.(main)) || []).filter((alt) => alt !== main);
      if (alts.length) {
        // Rank every match together, keeping each item's best score.
        const best = new Map(filtered.map((f) => [f.item, f]));
        for (const alt of alts) for (const f of fuzzyFilter(alt, st.items, keyOf(m), max)) if (!(best.get(f.item)?.score >= f.score)) best.set(f.item, f);
        filtered = [...best.values()].sort((a, b) => b.score - a.score).slice(0, max);
      }
    }
    selected = 0;
    list.replaceChildren(...filtered.map(({ item, indices }, i) => {
      const li = h('li.select-item', {
        id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false',
        onmousemove: () => { if (selected !== i) { selected = i; highlight(); } },
        onmousedown: (e) => { e.preventDefault(); choose(i); },
      }, renderItem(m, item, indices));
      return li;
    }));
    if (!filtered.length) {
      list.append(h('li.select-empty', { role: 'option', 'aria-disabled': 'true' }, st.loading && !dyn ? 'Loading…' : (typeof m.emptyMessage === 'function' ? m.emptyMessage() : m.emptyMessage) || 'No matches'));
    }
    status.textContent = filtered.length ? `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}` : list.querySelector('.select-empty')?.textContent || '';
    footer.textContent = filtered.length && m.footer ? m.footer(filtered.length, st.items.length) : '';
    footer.hidden = !footer.textContent;
    highlight();
  };

  const highlight = () => {
    [...list.children].forEach((li, i) => { li.classList.toggle('selected', i === selected); if (li.getAttribute('role') === 'option' && !li.classList.contains('select-empty')) li.setAttribute('aria-selected', String(i === selected)); });
    const active = filtered.length ? list.children[selected] : null;
    if (active) input.setAttribute('aria-activedescendant', active.id); else input.removeAttribute('aria-activedescendant');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
    if (filtered[selected]) current?.onHighlight?.(filtered[selected].item);
  };

  const choose = (i) => {
    const m = current;
    const entry = filtered[i];
    const q = queryFor(m, input.value);
    if (!entry) {
      if (q.trim() && m.onEnterWithoutMatch) { chosen = true; modal.close(!opts.keepFocus); m.onEnterWithoutMatch(q.trim()); }
      return;
    }
    chosen = true;
    modal.close(!opts.keepFocus);
    m.onSelect?.(entry.item, q);
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    const n = filtered.length;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); selected = n ? (selected + 1) % n : 0; highlight(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); selected = n ? (selected - 1 + n) % n : 0; highlight(); }
    else if (e.key === 'PageDown') { e.preventDefault(); selected = Math.min(n - 1, selected + 10); highlight(); }
    else if (e.key === 'PageUp') { e.preventDefault(); selected = Math.max(0, selected - 10); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); modal.close(); }
  });

  const handle = {
    close: () => modal.close(),
    setItems: (next) => { if (current) stateOf(current).items = next; update(); },
    refresh: () => update(),
    setQuery: (q) => { input.value = q; update(); input.focus(); input.setSelectionRange(q.length, q.length); },
    get query() { return input.value; },
    get mode() { return current; },
  };

  if (opts.initialQuery) { input.value = opts.initialQuery; }
  // Opened on a prefix ("> "): keep it and type after it. Otherwise select the text to replace it.
  const onPrefix = !!opts.initialQuery && modes.some((m) => m.prefix && m.prefix === opts.initialQuery);
  requestAnimationFrame(() => { input.focus(); if (onPrefix) input.setSelectionRange(input.value.length, input.value.length); else input.select(); });

  update();
  return handle;
}

// ---------------------------------------------------------------------------
// Prompt: a single-line input in the select-list style.

export function prompt({ title, placeholder, value = '', selection, validate, secret = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const messageId = uniqueId('prompt-message');
    const input = h('input.select-input', { type: secret ? 'password' : 'text', placeholder: placeholder || '', value, spellcheck: false, autocomplete: 'off', 'aria-label': title || placeholder || 'Input', 'aria-describedby': messageId });
    const message = h('div.prompt-message', { id: messageId, 'aria-live': 'polite' }, title || '');
    const panel = h('div.select-list.prompt', message, input);
    const modal = openModal(panel, { label: title || placeholder || 'Input', onClose: () => { if (!done) resolve(null); } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const err = validate?.(input.value);
        if (err) { message.textContent = err; message.classList.add('error'); input.setAttribute('aria-invalid', 'true'); return; }
        done = true;
        modal.close();
        resolve(input.value);
      } else if (e.key === 'Escape') { e.preventDefault(); modal.close(); }
    });
    input.addEventListener('input', () => { message.textContent = title || ''; message.classList.remove('error'); input.removeAttribute('aria-invalid'); });
    requestAnimationFrame(() => {
      input.focus();
      if (selection) input.setSelectionRange(...selection);
      else input.select();
    });
  });
}

// ---------------------------------------------------------------------------
// Notifications

export const notify = {
  show(type, title, detail, { timeout, actions = [] } = {}) {
    const root = document.getElementById('notifications');
    let timer = 0;
    const close = () => { clearTimeout(timer); el.classList.add('closing'); setTimeout(() => el.remove(), 160); };
    // Errors and warnings interrupt a screen reader; the rest wait for it to finish speaking.
    const el = h(`div.notification.${type}`, { role: type === 'error' || type === 'warn' ? 'alert' : 'status' },
      h('div.notification-bar'),
      h('div.notification-body',
        h('div.notification-title', title),
        detail ? h('div.notification-detail', detail) : null,
        actions.length ? h('div.notification-actions', actions.map((a) => h('button.btn.small', { onclick: () => { close(); a.run(); } }, a.label))) : null),
      h('button.icon-btn.notification-close', { 'aria-label': 'Dismiss notification', title: 'Dismiss', onclick: close }, icon('close', 13)));
    root.append(el);
    const ms = timeout ?? (type === 'error' ? 9000 : type === 'warn' ? 7000 : 3500);
    if (ms > 0) {
      timer = setTimeout(close, ms);
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
      // Someone reaching its buttons with the keyboard shouldn't have it vanish underneath them.
      el.addEventListener('focusin', () => clearTimeout(timer));
      el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) timer = setTimeout(close, 2000); });
    }
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    return { close };
  },
  info(t, d, o) { return notify.show('info', t, d, o); },
  success(t, d, o) { return notify.show('success', t, d, o); },
  warn(t, d, o) { return notify.show('warn', t, d, o); },
  error(t, d, o) { return notify.show('error', t, d, o); },
};

// ---------------------------------------------------------------------------
// Docks

export class Dock extends Emitter {
  constructor(el, { name, axis, state = {}, minSize = 140, defaultSize = 260 }) {
    super();
    this.el = el;
    this.name = name;
    this.axis = axis; // 'x' (sidebar width) or 'y' (panel height)
    this.minSize = minSize;
    this.views = new Map();
    this.header = el.querySelector('.dock-header');
    this.body = el.querySelector('.dock-body');
    // The views are tabs: one tab stop, arrow keys to move between them.
    this.header.setAttribute('role', 'tablist');
    this.header.setAttribute('aria-label', name === 'sidebar' ? 'Sidebar views' : 'Panel views');
    this.header.addEventListener('keydown', (e) => this.onTabKey(e));
    this.preferred = state.active || null;
    this.activeId = null;
    this.size = state.size || defaultSize;
    this.visible = state.visible ?? false;
    this.applySize();
    this.render();
  }

  addView(view) {
    const v = { order: 100, ...view };
    v.element.classList.add('dock-view');
    v.element.hidden = true;
    this.views.set(v.id, v);
    this.body.append(v.element);
    // Restore the last active view if it shows up; otherwise prefer the lowest order.
    const current = this.views.get(this.activeId);
    if (v.id === this.preferred || (!(this.preferred && this.activeId === this.preferred) && (!current || v.order < current.order))) this.activeId = v.id;
    this.render();
    return new Disposable(() => {
      this.views.delete(v.id);
      v.element.remove();
      if (this.activeId === v.id) this.activeId = [...this.views.keys()][0] || null;
      this.render();
    });
  }

  sortedViews() { return [...this.views.values()].sort((a, b) => a.order - b.order); }

  render() {
    const views = this.sortedViews();
    this.el.classList.toggle('hidden', !this.visible || !views.length);
    this.el.classList.toggle('multi', views.length > 1);
    const hadFocus = this.header.contains(document.activeElement);
    this.header.replaceChildren(...views.map((v) => h('button.dock-tab', {
      class: v.id === this.activeId ? 'active' : '',
      title: v.title,
      id: this.tabId(v),
      role: 'tab',
      'aria-selected': String(v.id === this.activeId),
      'aria-label': v.title, // the sidebar shows only the icon
      tabindex: v.id === this.activeId ? '0' : '-1',
      dataset: v.command ? { command: v.command } : {}, // its shortcut shows while ⌘ is held
      onclick: () => this.show(v.id, { focus: true }),
    }, v.icon ? icon(v.icon, 15) : null, h('span', v.title))));
    if (hadFocus) this.header.querySelector('[aria-selected="true"]')?.focus();
    for (const v of views) {
      v.element.setAttribute('role', 'tabpanel');
      v.element.setAttribute('aria-labelledby', this.tabId(v));
      const show = v.id === this.activeId && this.visible;
      if (v.element.hidden === show) {
        v.element.hidden = !show;
        if (show) v.onShow?.(); else v.onHide?.();
      }
    }
    const resizer = this.el.previousElementSibling?.classList.contains('resizer') ? this.el.previousElementSibling : this.el.nextElementSibling;
    if (resizer?.classList.contains('resizer')) resizer.hidden = !this.visible || !views.length;
    this.emit('changed');
  }

  tabId(view) { return `${this.name}-tab-${view.id}`; }

  onTabKey(e) {
    const views = this.sortedViews();
    const at = views.findIndex((v) => v.id === this.activeId);
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: views.length - 1 }[e.key];
    if (to == null || !views.length || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    this.show(views[(to + views.length) % views.length].id);
  }

  show(id = this.activeId, { focus = false } = {}) {
    if (id && this.views.has(id)) this.activeId = id;
    this.visible = true;
    this.render();
    if (focus) this.views.get(this.activeId)?.focus?.();
  }

  hide() { this.visible = false; this.render(); }

  toggle(id) {
    if (this.visible && (!id || id === this.activeId)) this.hide();
    else this.show(id, { focus: true });
  }

  isActive(id) { return this.visible && this.activeId === id; }

  applySize() {
    this.el.style[this.axis === 'x' ? 'width' : 'height'] = `${this.size}px`;
  }

  attachResizer(resizer, invert = false) {
    // The divider is a separator that arrow keys move, so resizing isn't mouse-only.
    resizer.setAttribute('role', 'separator');
    resizer.tabIndex = 0;
    resizer.setAttribute('aria-orientation', this.axis === 'x' ? 'vertical' : 'horizontal');
    resizer.setAttribute('aria-label', this.name === 'sidebar' ? 'Resize sidebar' : 'Resize bottom panel');
    resizer.addEventListener('keydown', (e) => {
      const grow = this.axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
      const d = grow[e.key];
      if (!d) return;
      e.preventDefault();
      const max = this.axis === 'x' ? window.innerWidth * 0.6 : window.innerHeight * 0.75;
      this.size = Math.round(Math.max(this.minSize, Math.min(max, this.size + (invert ? -d : d) * 24)));
      this.applySize();
      this.emit('changed');
    });
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const start = this.axis === 'x' ? e.clientX : e.clientY;
      const startSize = this.size;
      document.body.classList.add(this.axis === 'x' ? 'resizing-h' : 'resizing-v');
      const move = (ev) => {
        const delta = (this.axis === 'x' ? ev.clientX : ev.clientY) - start;
        const max = this.axis === 'x' ? window.innerWidth * 0.6 : window.innerHeight * 0.75;
        this.size = Math.round(Math.max(this.minSize, Math.min(max, startSize + (invert ? -delta : delta))));
        this.applySize();
      };
      const up = () => {
        document.body.classList.remove('resizing-h', 'resizing-v');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.emit('changed');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    resizer.addEventListener('dblclick', () => { this.size = this.axis === 'x' ? 260 : 240; this.applySize(); this.emit('changed'); });
  }

  serialize() { return { active: this.activeId, size: this.size, visible: this.visible }; }
}

// ---------------------------------------------------------------------------
// Status bar

export class StatusBar {
  constructor(el) {
    this.left = el.querySelector('.status-left');
    this.right = el.querySelector('.status-right');
    this.items = [];
  }

  /** addItem({ id, element, align: 'left'|'right', priority, onClick, tooltip, command }) */
  addItem({ id, element, align = 'left', priority = 100, onClick, tooltip, command }) {
    const el = h('div.status-item', { dataset: { id: id || '', ...(command ? { command } : {}) }, title: tooltip || '' }, element);
    if (onClick) { el.classList.add('clickable'); el.addEventListener('click', onClick); makeActivatable(el); }
    const entry = { el, align, priority };
    this.items.push(entry);
    this.layout();
    return new Disposable(() => { this.items = this.items.filter((i) => i !== entry); el.remove(); });
  }

  layout() {
    const sorted = [...this.items].sort((a, b) => a.priority - b.priority);
    this.left.replaceChildren(...sorted.filter((i) => i.align === 'left').map((i) => i.el));
    this.right.replaceChildren(...sorted.filter((i) => i.align === 'right').reverse().map((i) => i.el));
  }
}
