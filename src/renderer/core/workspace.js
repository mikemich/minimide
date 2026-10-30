// The workspace: project root, documents, panes and their tabbed items.
import { Emitter, Disposable } from './events.js';
import { h, icon, fileIcon, basename } from './dom.js';
import { Document, EditorItem, BinaryItem, bindEditorConfig } from './editor.js';
import { MAX_OPEN_SIZE, isLargeText, hasLongLine, formatSize } from './large-files.js';

/** A row or column of panes (or of further splits). Each child has a `flex` share of the space. */
class Split {
  constructor(dir, children = []) {
    this.dir = dir; // 'row' (side by side) or 'col' (stacked)
    this.children = children;
    this.parent = null;
    this.flex = 1;
    this.element = h(`div.pane-split.${dir}`);
    for (const c of children) c.parent = this;
  }
  leaves() { return this.children.flatMap((c) => (c instanceof Split ? c.leaves() : [c])); }
  serialize() { return { dir: this.dir, flex: this.flex, children: this.children.map((c) => c.serialize()) }; }
}

export class Pane extends Emitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.items = [];
    this.active = null;
    this.flex = 1;
    this.parent = null;
    this.tabBar = h('div.tab-bar', { ondragover: (e) => this.onDragOver(e), ondrop: (e) => this.onDrop(e), ondblclick: (e) => { if (e.target === this.tabBar || e.target === this.tabsEl) ws.commands.run('file:new'); } });
    this.tabsEl = h('div.tabs', { role: 'tablist', 'aria-label': 'Open files', onkeydown: (e) => this.onTabKey(e) });
    this.customActions = h('div.tab-actions-custom');
    this.tabBar.append(this.tabsEl, h('div.tab-actions', this.customActions,
      h('button.icon-btn.split-action', { title: 'Split Right', 'aria-label': 'Split Right', onclick: () => ws.splitRight(this) }, icon('split', 15))));
    this.content = h('div.pane-content');
    this.element = h('div.pane', { role: 'group', 'aria-label': 'Editor pane', onmousedown: () => ws.setActivePane(this, false) }, this.tabBar, this.content);
    this.tabEls = new Map();
  }

  addItem(item, { index, activate = true, pending = false } = {}) {
    if (!this.items.includes(item)) {
      if (pending) {
        const old = this.items.find((i) => i.pending);
        if (old && old !== item) {
          index ??= this.items.indexOf(old);
          this.removeItem(old, { destroy: true, keepPane: true });
        }
      }
      item.pending = pending;
      if (index == null) {
        const at = this.active ? this.items.indexOf(this.active) + 1 : this.items.length;
        index = at;
      }
      this.items.splice(Math.min(index, this.items.length), 0, item);
      const el = item.getElement();
      el.classList.add('pane-item');
      el.hidden = true;
      this.content.append(el);
      this.renderTab(item, index);
      item.__titleSub = item.on?.('title-changed', () => { this.updateTab(item); this.ws.updateTitle(); });
      if (item.type === 'editor') {
        item.__pinSub = item.document.on('dirty', (d) => { if (d && item.pending) this.pin(item); });
      }
      this.ws.emit('item-added', item, this);
    }
    if (activate) this.activate(item);
    this.ws.updateEmptyState();
    return item;
  }

  pin(item) {
    if (!item.pending) return;
    item.pending = false;
    this.updateTab(item);
  }

  renderTab(item, index) {
    const tab = h('div.tab', {
      draggable: true,
      role: 'tab',
      tabindex: '-1',
      title: item.getPath?.() || item.getTitle(),
      onmousedown: (e) => {
        if (e.button === 1) { e.preventDefault(); this.ws.closeItem(item); return; }
        if (e.button === 0) this.activate(item);
      },
      ondblclick: () => this.pin(item),
      oncontextmenu: (e) => { e.preventDefault(); this.tabContextMenu(item); },
      ondragstart: (e) => {
        this.ws.dragging = { item, pane: this };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.getPath?.() || item.getTitle());
        tab.classList.add('dragging');
      },
      ondragend: () => { tab.classList.remove('dragging'); this.ws.dragging = null; this.clearDropMarkers(); },
    });
    // Reached from the keyboard with Delete on the tab or the Close Tab command, so it isn't a tab stop of its own.
    const close = h('button.tab-close', {
      title: 'Close',
      tabindex: '-1',
      onmousedown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); this.ws.closeItem(item); },
    }, icon('close', 13));
    const iconEl = item.getIcon?.() || (item.getPath?.() ? fileIcon(item.getTitle()) : icon(item.iconName || 'file', 15));
    tab.append(iconEl, h('span.tab-title'), close);
    this.tabEls.set(item, tab);
    const ref = this.tabsEl.children[index];
    this.tabsEl.insertBefore(tab, ref || null);
    this.updateTab(item);
  }

  updateTab(item) {
    const tab = this.tabEls.get(item);
    if (!tab) return;
    tab.querySelector('.tab-title').textContent = item.getTitle();
    tab.title = item.getPath?.() || item.getTitle();
    tab.classList.toggle('dirty', !!item.isDirty?.());
    tab.classList.toggle('pending', !!item.pending);
    tab.classList.toggle('active', item === this.active);
    const state = [item.isDirty?.() ? 'unsaved changes' : '', item.pending ? 'preview' : ''].filter(Boolean).join(', ');
    tab.setAttribute('aria-label', item.getTitle() + (state ? `, ${state}` : ''));
    tab.setAttribute('aria-selected', String(item === this.active));
    // One tab stop per tab bar: the active tab (or the first when none is).
    tab.tabIndex = item === this.active || (!this.active && item === this.items[0]) ? 0 : -1;
    tab.querySelector('.tab-close').setAttribute('aria-label', `Close ${item.getTitle()}`);
    // Disambiguate identical names by showing the parent folder.
    const dupes = this.items.filter((i) => i !== item && i.getTitle() === item.getTitle() && i.getPath?.());
    let hint = tab.querySelector('.tab-hint');
    if (dupes.length && item.getPath?.()) {
      const parts = item.getPath().split('/');
      if (!hint) { hint = h('span.tab-hint'); tab.querySelector('.tab-title').after(hint); }
      hint.textContent = parts.at(-2) || '';
    } else hint?.remove();
  }

  /** Render package-provided buttons (ws.addPaneAction) for the active item. */
  renderActions() {
    const item = this.active;
    this.customActions.replaceChildren(...this.ws.paneActions
      .filter((a) => { try { return !a.when || a.when(item, this); } catch { return false; } })
      .map((a) => h('button.icon-btn.pane-action', {
        title: typeof a.title === 'function' ? a.title(item) : a.title,
        'aria-label': typeof a.title === 'function' ? a.title(item) : a.title,
        class: a.className || '',
        dataset: a.command ? { command: typeof a.command === 'function' ? a.command(item) : a.command } : {},
        onclick: (e) => { e.stopPropagation(); a.run(item, this); },
      }, icon(typeof a.icon === 'function' ? a.icon(item) : a.icon, 15))));
  }

  activate(item) {
    if (!this.items.includes(item)) return;
    const prev = this.active;
    this.active = item;
    for (const i of this.items) i.getElement().hidden = i !== item;
    for (const i of this.items) this.updateTab(i);
    this.tabEls.get(item)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    item.view?.requestMeasure?.(); // a side-by-side diff's view is a MergeView, which has none
    this.ws.setActivePane(this, false);
    this.renderActions();
    if (prev !== item) this.ws.emit('pane-active-item-changed', this, item);
    this.ws.notifyActiveItem();
  }

  removeItem(item, { destroy = true, keepPane = false } = {}) {
    const idx = this.items.indexOf(item);
    if (idx < 0) return;
    this.items.splice(idx, 1);
    this.tabEls.get(item)?.remove();
    this.tabEls.delete(item);
    item.__titleSub?.dispose();
    item.__pinSub?.dispose();
    item.getElement().remove();
    item.getElement().classList.remove('pane-item');
    if (this.active === item) {
      this.active = null;
      const next = this.items[Math.min(idx, this.items.length - 1)] || this.items[idx - 1];
      if (next) this.activate(next);
    }
    for (const i of this.items) this.updateTab(i);
    this.renderActions();
    this.ws.emit('item-removed', item, this);
    if (destroy) {
      item.destroy();
      if (item.type === 'editor') this.ws.releaseDocument(item.document);
    }
    if (!this.items.length && this.ws.panes.length > 1 && !keepPane) this.ws.removePane(this);
    else { this.ws.notifyActiveItem(); this.ws.updateEmptyState(); }
  }

  /** Tab bar keyboard: arrows, Home and End move between tabs; Enter and Space open one; Delete closes it; the menu key opens its menu. */
  onTabKey(e) {
    const entry = [...this.tabEls].find(([, el]) => el === e.target.closest('.tab'));
    if (!entry || e.altKey || e.ctrlKey || e.metaKey) return;
    const [item] = entry;
    const at = this.items.indexOf(item);
    const go = (i) => { const next = this.items[(i + this.items.length) % this.items.length]; this.activate(next); this.tabEls.get(next)?.focus(); };
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); go(at + 1); break;
      case 'ArrowLeft': e.preventDefault(); go(at - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(this.items.length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); this.activate(item); item.focus?.(); break;
      case 'Delete': e.preventDefault(); this.ws.closeItem(item); break;
      case 'ContextMenu': e.preventDefault(); this.tabContextMenu(item); break;
      case 'F10': if (e.shiftKey) { e.preventDefault(); this.tabContextMenu(item); } break;
    }
  }

  /** Moves a tab one place left or right in this pane (the keyboard way to reorder tabs). */
  moveTab(item, delta) {
    const from = this.items.indexOf(item);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= this.items.length) return;
    this.items.splice(from, 1);
    this.items.splice(to, 0, item);
    for (const i of this.items) this.tabsEl.append(this.tabEls.get(i));
  }

  async tabContextMenu(item) {
    const path = item.getPath?.();
    const at = this.items.indexOf(item);
    const choice = await window.native.menu.popup([
      { id: 'close', label: 'Close Tab' },
      { id: 'others', label: 'Close Other Tabs', enabled: this.items.length > 1 },
      { id: 'left', label: 'Close Tabs to the Left', enabled: at > 0 },
      { id: 'right', label: 'Close Tabs to the Right', enabled: at < this.items.length - 1 },
      { id: 'all', label: 'Close All Tabs' },
      { type: 'separator' },
      { id: 'split', label: 'Split Right' },
      { id: 'split-down', label: 'Split Down' },
      { type: 'separator' },
      { id: 'copy', label: 'Copy Path', enabled: !!path },
      { id: 'copy-rel', label: 'Copy Relative Path', enabled: !!path && !!this.ws.project },
      { id: 'reveal', label: 'Reveal in Finder', enabled: !!path },
      { id: 'tree', label: 'Reveal in Tree View', enabled: !!path },
      ...(path && (this.ws.commands.has('local-history:show') || this.ws.commands.has('git-history:file-history')) ? [{ type: 'separator' }] : []),
      ...(path && this.ws.commands.has('local-history:show') ? [{ id: 'history', label: 'Show Local History' }] : []),
      ...(path && this.ws.commands.has('git-history:file-history') ? [{ id: 'git-history', label: 'Git: File History' }] : []),
    ]);
    const idx = this.items.indexOf(item);
    switch (choice) {
      case 'close': return this.ws.closeItem(item);
      case 'others': for (const i of this.items.filter((x) => x !== item)) if (!await this.ws.closeItem(i)) break; return;
      case 'left': for (const i of this.items.slice(0, idx)) if (!await this.ws.closeItem(i)) break; return;
      case 'right': for (const i of this.items.slice(idx + 1)) if (!await this.ws.closeItem(i)) break; return;
      case 'all': for (const i of [...this.items]) if (!await this.ws.closeItem(i)) break; return;
      case 'split': return this.ws.splitRight(this, item);
      case 'split-down': return this.ws.splitDown(this, item);
      case 'copy': return window.native.clipboard.write(path);
      case 'copy-rel': return window.native.clipboard.write(this.ws.relativePath(path));
      case 'reveal': return window.native.shell.reveal(path);
      case 'tree': this.activate(item); return this.ws.commands.run('tree-view:reveal-active-file');
      case 'history': return this.ws.commands.run('local-history:show-for', path);
      case 'git-history': return this.ws.commands.run('git-history:file-history-for', path);
    }
  }

  // --- drag & drop between/within panes ---------------------------------
  dropIndex(e) {
    const tabs = [...this.tabsEl.children];
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  }
  clearDropMarkers() { for (const t of this.tabsEl.children) t.classList.remove('drop-before', 'drop-after'); }
  onDragOver(e) {
    if (!this.ws.dragging) return;
    e.preventDefault();
    this.clearDropMarkers();
    const i = this.dropIndex(e);
    const tabs = this.tabsEl.children;
    if (tabs[i]) tabs[i].classList.add('drop-before');
    else tabs[tabs.length - 1]?.classList.add('drop-after');
  }
  onDrop(e) {
    const drag = this.ws.dragging;
    if (!drag) return;
    e.preventDefault();
    this.clearDropMarkers();
    let index = this.dropIndex(e);
    if (drag.pane === this) {
      const from = this.items.indexOf(drag.item);
      if (from < index) index--;
      if (from === index) return;
      this.items.splice(from, 1);
      this.items.splice(index, 0, drag.item);
      for (const i of this.items) this.tabsEl.append(this.tabEls.get(i));
    } else {
      this.ws.moveItem(drag.item, drag.pane, this, index);
    }
  }

  serialize() {
    return { flex: this.flex, items: this.items.map((i) => i.serialize?.()).filter(Boolean), active: this.items.indexOf(this.active) };
  }
}

export class Workspace extends Emitter {
  constructor({ config, commands, keymap, ui }) {
    super();
    this.config = config;
    this.commands = commands;
    this.keymap = keymap;
    this.ui = ui;
    this.project = null; // the first (primary) folder
    this.folders = []; // every project folder, primary first
    this.watched = new Map(); // folder -> its fs watch key
    this.documents = new Map(); // path -> Document
    this.root = null; // a Pane, or a Split of them; `panes` lists the leaves in reading order
    this.activePane = null;
    this.openers = [];
    this.paneActions = [];
    this.loadingDocs = new Map(); // path -> Promise while a file is being read
    this.selfWrites = new Map(); // path -> time we last wrote it ourselves
    this.completionSources = new Set();
    // One stable source that merges results from every registered source (snippets, …).
    this.extraCompletionSource = async (ctx) => {
      const results = (await Promise.all([...this.completionSources].map((s) => Promise.resolve(s(ctx)).catch(() => null)))).filter(Boolean);
      if (!results.length) return null;
      if (results.length === 1) return results[0];
      // Sources may disagree on where the word starts (snippets count "$" or ".", words don't).
      // Align them on the earliest start by putting the skipped text in front of the later ones'
      // labels, so typing "$ns" can still offer "$nsr1". Later sources lose to earlier ones on
      // duplicate labels.
      const from = Math.min(...results.map((r) => r.from));
      const seen = new Set();
      const options = [];
      for (const r of results) {
        const lead = ctx.state.sliceDoc(from, r.from);
        if (lead && /\s/.test(lead)) continue;
        for (const o of r.options) {
          const label = lead + o.label;
          if (seen.has(label)) continue;
          seen.add(label);
          if (!lead) { options.push(o); continue; }
          const apply = typeof o.apply === 'function'
            ? (view, completion, f, to) => o.apply(view, completion, f + lead.length, to)
            : lead + (o.apply ?? o.label);
          options.push({ ...o, label, apply });
        }
      }
      return { from, options };
    };
    this.saveHooks = [];
    this.extensions = new Set();
    this.dragging = null;
    this.panesEl = document.getElementById('panes');
    this.welcome = null;
    this.addPane();
    bindEditorConfig(this);

    window.native.fs.onChange((paths, key) => { if (key === 'project' || key?.startsWith('folder:')) this.onFilesChanged(paths); });
    window.addEventListener('focus', () => this.checkOpenFilesOnDisk());
  }

  // --- panes ---------------------------------------------------------------
  get panes() { return this.root instanceof Split ? this.root.leaves() : this.root ? [this.root] : []; }

  /** A new pane next to `after` (default: the last one): to its right, or below it for dir 'col'. */
  addPane(after = this.panes.at(-1), dir = 'row') {
    const pane = new Pane(this);
    const parent = after?.parent;
    if (!after) this.root = pane;
    else if (parent?.dir === dir) {
      after.flex /= 2;
      pane.flex = after.flex;
      pane.parent = parent;
      parent.children.splice(parent.children.indexOf(after) + 1, 0, pane);
    } else {
      // Not in a split of this direction yet: swap in a new one holding both panes.
      const split = new Split(dir);
      split.flex = after.flex;
      after.flex = 1;
      this.replaceNode(after, split);
      split.children.push(after, pane);
      after.parent = pane.parent = split;
    }
    this.layoutPanes();
    this.setActivePane(pane, false);
    return pane;
  }

  replaceNode(node, by) {
    const parent = node.parent;
    by.parent = parent;
    if (parent) parent.children[parent.children.indexOf(node)] = by;
    else this.root = by;
  }

  removePane(pane) {
    const panes = this.panes;
    const idx = panes.indexOf(pane);
    if (idx < 0 || panes.length <= 1) return; // already gone (e.g. emptied by its last close)
    for (const item of [...pane.items]) pane.removeItem(item, { destroy: true });
    const parent = pane.parent;
    if (!parent) return; // removing its last item already removed it
    parent.children.splice(parent.children.indexOf(pane), 1);
    pane.parent = null;
    if (parent.children.length === 1) this.collapse(parent);
    this.layoutPanes();
    if (this.activePane === pane) this.setActivePane(this.panes[Math.max(0, idx - 1)]);
    this.notifyActiveItem();
  }

  /** A split with a single child left is replaced by that child, merged into its parent if they run the same way. */
  collapse(split) {
    const [child] = split.children;
    child.flex = split.flex;
    this.replaceNode(split, child);
    const parent = child.parent;
    if (child instanceof Split && parent?.dir === child.dir) {
      const sum = child.children.reduce((n, c) => n + c.flex, 0);
      for (const c of child.children) { c.flex = (c.flex / sum) * child.flex; c.parent = parent; }
      parent.children.splice(parent.children.indexOf(child), 1, ...child.children);
    }
  }

  layoutPanes() {
    const draw = (node) => {
      if (node instanceof Split) {
        node.element.replaceChildren(...node.children.flatMap((c, i) => {
          draw(c);
          return i ? [this.paneResizer(node.children[i - 1], c, node.dir), c.element] : [c.element];
        }));
      }
      node.element.style.flex = `${node.parent ? node.flex : 1} 1 0`;
    };
    draw(this.root);
    this.panesEl.replaceChildren(this.root.element);
    this.panesEl.classList.toggle('split', this.panes.length > 1);
    this.panes.forEach((p, i, all) => p.element.setAttribute('aria-label', all.length > 1 ? `Editor pane ${i + 1} of ${all.length}` : 'Editor pane'));
    this.updateEmptyState();
  }

  /** The draggable divider between two neighbours: vertical in a row, horizontal in a column. */
  paneResizer(a, b, dir) {
    const row = dir === 'row';
    const el = h(`div.resizer.pane-resizer.${row ? 'resizer-v' : 'resizer-h'}`, { role: 'separator', tabindex: '0', 'aria-orientation': row ? 'vertical' : 'horizontal', 'aria-label': row ? 'Resize panes side by side' : 'Resize stacked panes' });
    const min = row ? 160 : 80;
    // Arrow keys nudge the divider by a tenth of the two panes' space.
    el.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!d || (row ? e.key === 'ArrowUp' || e.key === 'ArrowDown' : e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      const total = a.flex + b.flex;
      const na = Math.min(total * 0.9, Math.max(total * 0.1, a.flex + d * total * 0.1));
      a.flex = na; b.flex = total - na;
      a.element.style.flex = `${a.flex} 1 0`;
      b.element.style.flex = `${b.flex} 1 0`;
      this.emit('layout-changed');
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const at = (ev) => (row ? ev.clientX : ev.clientY);
      const size = (n) => n.element.getBoundingClientRect()[row ? 'width' : 'height'];
      const start = at(e), sa = size(a), sb = size(b), total = a.flex + b.flex;
      const cls = row ? 'resizing-h' : 'resizing-v';
      document.body.classList.add(cls);
      const move = (ev) => {
        const d = at(ev) - start;
        const na = Math.max(min, sa + d);
        const nb = Math.max(min, sb - d);
        a.flex = (na / (na + nb)) * total;
        b.flex = (nb / (na + nb)) * total;
        a.element.style.flex = `${a.flex} 1 0`;
        b.element.style.flex = `${b.flex} 1 0`;
      };
      const up = () => { document.body.classList.remove(cls); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.emit('layout-changed'); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return el;
  }

  setActivePane(pane, focus = true) {
    if (this.activePane !== pane) {
      this.activePane = pane;
      for (const p of this.panes) p.element.classList.toggle('active', p === pane);
      this.notifyActiveItem();
    }
    if (focus) pane.active?.focus();
  }

  splitRight(pane = this.activePane, item = pane.active) { return this.split(pane, item, 'row'); }
  splitDown(pane = this.activePane, item = pane.active) { return this.split(pane, item, 'col'); }

  split(pane, item, dir) {
    const newPane = this.addPane(pane, dir);
    if (item?.type === 'editor') {
      const copy = new EditorItem(item.document, this, item.view);
      newPane.addItem(copy);
      copy.focus();
    }
    return newPane;
  }

  moveItem(item, from, to, index) {
    from.removeItem(item, { destroy: false });
    to.addItem(item, { index });
    this.setActivePane(to);
  }

  /** Next or previous pane in reading order (left to right, top to bottom within each split). */
  focusPaneOffset(delta) {
    const panes = this.panes;
    if (panes.length < 2) return;
    this.setActivePane(panes[(panes.indexOf(this.activePane) + delta + panes.length) % panes.length]);
  }

  /** The nearest pane above (dy -1) or below (dy 1) that overlaps the active one horizontally. */
  focusPaneVertical(dy) {
    const r = this.activePane.element.getBoundingClientRect();
    let best = null;
    for (const p of this.panes) {
      const q = p.element.getBoundingClientRect();
      const gap = dy < 0 ? r.top - q.bottom : q.top - r.bottom;
      const overlap = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      if (p === this.activePane || gap < -1 || overlap <= 0) continue;
      if (!best || gap < best.gap - 1 || (Math.abs(gap - best.gap) <= 1 && overlap > best.overlap)) best = { p, gap, overlap };
    }
    if (best) this.setActivePane(best.p);
  }

  allItems() { return this.panes.flatMap((p) => p.items); }
  getActiveItem() { return this.activePane?.active ?? null; }
  getActiveEditor() { const i = this.getActiveItem(); return i?.type === 'editor' ? i : null; }

  notifyActiveItem() {
    const item = this.getActiveItem();
    if (item !== this.lastActive) {
      this.lastActive = item;
      this.emit('active-item-changed', item);
      this.updateTitle();
    }
  }

  focusItem(item) {
    const pane = this.panes.find((p) => p.items.includes(item));
    if (pane && (this.activePane !== pane || pane.active !== item)) {
      if (pane.active !== item) pane.activate(item);
      this.setActivePane(pane, false);
    }
  }

  updateEmptyState() {
    const empty = this.panes.length === 1 && this.panes[0].items.length === 0;
    document.body.classList.toggle('workspace-empty', empty);
    if (empty) {
      if (!this.welcome && this.renderWelcome) this.welcome = this.renderWelcome();
      if (this.welcome && !this.welcome.isConnected) this.panes[0].content.append(this.welcome);
    } else this.welcome?.remove();
  }

  updateTitle() {
    const item = this.getActiveItem();
    const proj = this.project ? basename(this.project) + (this.folders.length > 1 ? ` +${this.folders.length - 1}` : '') : null;
    const parts = [item ? `${item.isDirty?.() ? '● ' : ''}${item.getTitle()}` : null, proj, 'Minimide'].filter(Boolean);
    const title = parts.join(' — ');
    document.title = title;
    window.native.window.setTitle(title);
    const tb = document.querySelector('#titlebar .title');
    if (tb) tb.textContent = [item?.getTitle(), proj].filter(Boolean).join(' — ') || 'Minimide';
  }

  // --- project -------------------------------------------------------------
  async setProject(root) {
    this.project = root;
    this.folders = root ? [root] : [];
    this.watchFolders();
    window.native.window.setProject(root);
    this.emit('project-changed', root);
    this.emit('folders-changed', this.folders);
    this.updateTitle();
  }

  /**
   * The open folder that is the same folder as `path` on disk (by real path: a link to it, or the
   * same path spelled differently), or null. A folder inside another one is a different folder.
   */
  async sameFolder(path) {
    path = path.replace(/(.)\/+$/, '$1');
    if (this.folders.includes(path)) return path;
    const real = async (p) => (await window.native.fs.realpath(p)) || p;
    const [target, ...open] = await Promise.all([path, ...this.folders].map(real));
    return this.folders[open.indexOf(target)] || null;
  }

  /** Adds another folder (the first one becomes the project). Resolves false if it's already there. */
  async addFolder(path) {
    path = path.replace(/(.)\/+$/, '$1');
    if (!this.project) { await this.setProject(path); return true; }
    if (await this.sameFolder(path)) return false;
    this.folders = [...this.folders, path];
    this.watchFolders();
    this.emit('folders-changed', this.folders);
    this.updateTitle();
    return true;
  }

  /** Removes a folder, except the last one. Removing the first makes the next one the project. */
  removeFolder(path) {
    if (!this.folders.includes(path) || this.folders.length < 2) return false;
    this.folders = this.folders.filter((f) => f !== path);
    this.watchFolders();
    if (this.project !== this.folders[0]) {
      this.project = this.folders[0];
      window.native.window.setProject(this.project);
      this.emit('project-changed', this.project);
    }
    this.emit('folders-changed', this.folders);
    this.updateTitle();
    return true;
  }

  // The first folder keeps the 'project' watch key; each other folder gets its own.
  watchFolders() {
    const want = new Map(this.folders.map((f, i) => [f, i ? `folder:${f}` : 'project']));
    for (const [f, key] of this.watched) if (want.get(f) !== key) window.native.fs.watch(null, key);
    for (const [f, key] of want) if (this.watched.get(f) !== key) window.native.fs.watch(f, key);
    if (!want.size) window.native.fs.watch(null);
    this.watched = want;
  }

  /** The project folder that contains `p` (the innermost one if folders nest), or null. */
  folderFor(p) {
    let best = null;
    for (const f of p ? this.folders : []) {
      if ((p === f || p.startsWith(f.endsWith('/') ? f : f + '/')) && (!best || f.length > best.length)) best = f;
    }
    return best;
  }

  /** The folder of the active file, else the project. */
  getActiveFolder() { return this.folderFor(this.getActiveItem()?.getPath?.()) || this.project; }

  /**
   * The name a project folder goes by in relative paths: its own, or, when another folder has the
   * same name, with its parent folder's ("app (client)"), so each one can be told apart and found again.
   */
  folderLabel(f) {
    const name = basename(f);
    const same = this.folders.filter((x) => basename(x) === name);
    if (same.length < 2) return name;
    const parent = (x) => basename(x.slice(0, x.lastIndexOf('/')) || '/') || '/';
    return same.filter((x) => parent(x) === parent(f)).length < 2 ? `${name} (${parent(f)})` : `${name} (${same.indexOf(f) + 1})`;
  }

  /** `p` relative to its folder; with several folders, prefixed with that folder's name. */
  relativePath(p) {
    const f = this.folderFor(p);
    if (!p || !f) return p || '';
    const rel = p === f ? '' : p.slice(f.length + (f.endsWith('/') ? 0 : 1));
    if (this.folders.length < 2) return rel;
    const label = this.folderLabel(f);
    return rel ? `${label}/${rel}` : label;
  }

  /** The absolute path of a relativePath() result (absolute paths are returned as they are). */
  resolvePath(rel) {
    if (!rel || rel.startsWith('/')) return rel || this.project;
    if (this.folders.length > 1) {
      const [head, ...rest] = rel.split('/');
      const f = this.folders.find((x) => this.folderLabel(x) === head) || this.folders.find((x) => basename(x) === head);
      if (f) return rest.length ? `${f}/${rest.join('/')}` : f;
    }
    return this.project ? `${this.project}/${rel}` : rel;
  }

  addCompletionSource(source) {
    this.completionSources.add(source);
    return new Disposable(() => this.completionSources.delete(source));
  }

  /** addPaneAction({ id, icon, title, when(item, pane), run(item, pane), className }) */
  addPaneAction(action) {
    this.paneActions.push(action);
    this.refreshPaneActions();
    return new Disposable(() => { this.paneActions = this.paneActions.filter((a) => a !== action); this.refreshPaneActions(); });
  }

  refreshPaneActions() { for (const p of this.panes) p.renderActions(); }

  // --- opening -------------------------------------------------------------
  /** Register a custom opener: (path, opts) => item | null | Promise */
  addOpener(fn) {
    this.openers.unshift(fn);
    return new Disposable(() => { this.openers = this.openers.filter((o) => o !== fn); });
  }

  findItemForPath(path, pane) {
    const panes = pane ? [pane, ...this.panes.filter((p) => p !== pane)] : this.panes;
    for (const p of panes) {
      const item = p.items.find((i) => i.getPath?.() === path);
      if (item) return { item, pane: p };
    }
    return null;
  }

  async open(path, opts = {}) {
    let { pane = this.activePane, line, col, length, pending = false, focus = true, activate = true } = opts;
    if (!path) return this.newFile();
    const existing = this.findItemForPath(path, pane);
    let item;
    // Asked for a specific pane while the file is open in another one: give that pane its own view.
    if (existing && opts.pane && existing.pane !== pane && existing.item.type === 'editor') {
      item = new EditorItem(existing.item.document, this, existing.item.view);
      pane.addItem(item, { pending, activate });
    } else if (existing) {
      item = existing.item;
      if (activate) existing.pane.activate(item);
      if (!pending) existing.pane.pin(item);
      pane = existing.pane;
    } else {
      for (const opener of this.openers) {
        item = await opener(path, { ...opts, pane });
        if (item) break;
      }
      if (!item) item = await this.createEditorForPath(path);
      if (!item) return null;
      pane.addItem(item, { pending, activate });
    }
    if (line != null && item.type === 'editor') {
      requestAnimationFrame(() => (length ? item.selectRange(line, col || 0, length) : item.goToLine(line, col || 0)));
    }
    if (focus && activate) { this.setActivePane(pane, false); requestAnimationFrame(() => item.focus()); }
    return item;
  }

  async createEditorForPath(path) {
    // Two opens of the same path racing (restore + Finder) must share one Document.
    if (this.loadingDocs.has(path)) await this.loadingDocs.get(path).catch(() => {});
    let doc = this.documents.get(path);
    if (!doc) {
      let done;
      this.loadingDocs.set(path, new Promise((r) => { done = r; }));
      try {
        doc = await this.loadDocument(path);
      } finally {
        this.loadingDocs.delete(path);
        done();
      }
      if (!doc || doc instanceof BinaryItem) return doc;
    }
    const source = [...doc.views][0]?.view;
    return new EditorItem(doc, this, source);
  }

  async loadDocument(path) {
    const stat = await window.native.fs.stat(path);
    if (stat && !stat.isFile) return null;
    let text = '';
    let meta = {};
    let large = false;
    let longLines = false;
    if (stat) {
      // Refused before reading: a string that big can't be built, and trying would freeze the window.
      if (stat.size > MAX_OPEN_SIZE) {
        this.ui.notify.error(`${basename(path)} is too large to open`, `It is ${formatSize(stat.size)}; the largest file Minimide opens is ${formatSize(MAX_OPEN_SIZE)}.`);
        return new BinaryItem(path, `This file is ${formatSize(stat.size)}, too large to open here (the limit is ${formatSize(MAX_OPEN_SIZE)}).`);
      }
      let read;
      try { read = await window.native.fs.readText(path, { sniff: true, maxBytes: MAX_OPEN_SIZE }); } catch (err) { this.ui.notify.error(`Could not open ${basename(path)}`, err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
      if (read.binary || read.text.slice(0, 8000).includes('\u0000')) return new BinaryItem(path);
      ({ text, ...meta } = read);
      large = isLargeText(text, stat.size, this.config.get('editor.largeFileSize'));
      longLines = large && hasLongLine(text);
    }
    const doc = new Document(path, text, { ...meta, large, longLines });
    doc.size = stat?.size || 0;
    doc.on('large', () => this.emit('large-file-changed', doc));
    this.documents.set(path, doc);
    this.emit('document-opened', doc);
    return doc;
  }

  newFile(pane = this.activePane) {
    const doc = new Document(null, '');
    const item = new EditorItem(doc, this);
    pane.addItem(item);
    requestAnimationFrame(() => item.focus());
    return item;
  }

  openItem(item, { pane = this.activePane, activate = true } = {}) {
    const existing = this.panes.find((p) => p.items.includes(item));
    if (existing) { existing.activate(item); return item; }
    pane.addItem(item, { activate });
    if (activate) requestAnimationFrame(() => item.focus?.());
    return item;
  }

  releaseDocument(doc) {
    if (doc.views.size === 0 && doc.path) {
      if (this.documents.get(doc.path) === doc) this.documents.delete(doc.path);
      this.emit('document-closed', doc);
    }
  }

  // --- closing & saving ----------------------------------------------------
  async closeItem(item) {
    const pane = this.panes.find((p) => p.items.includes(item));
    if (!pane) return true;
    if (item.type === 'editor' && item.document.dirty && item.document.views.size === 1) {
      const choice = await window.native.dialog.confirm({
        type: 'warning',
        message: `Save changes to ${item.getTitle()}?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ['Save', "Don't Save", 'Cancel'],
        cancelId: 2,
      });
      if (choice === 2) return false;
      if (choice === 0 && !await this.save(item)) return false;
    }
    if (item.canClose && !await item.canClose()) return false;
    pane.removeItem(item);
    return true;
  }

  async closeActivePane() {
    const pane = this.activePane;
    for (const item of [...pane.items]) if (!await this.closeItem(item)) return false;
    if (this.panes.includes(pane)) this.removePane(pane);
    return true;
  }

  /** Register a hook that runs before save: (editor) => void|Promise. */
  onWillSave(fn) {
    this.saveHooks.push(fn);
    return new Disposable(() => { this.saveHooks = this.saveHooks.filter((f) => f !== fn); });
  }

  /** Saves an editor. `opts.auto` marks a save made by Auto Save (passed on to 'did-save' listeners). */
  async save(item = this.getActiveItem(), opts = {}) {
    if (!item) return false;
    if (item.type !== 'editor') return item.save ? item.save() : false;
    const doc = item.document;
    if (!doc.path) return this.saveAs(item);
    for (const hook of this.saveHooks) {
      try { await hook(item); } catch (err) { console.error('[save hook]', err); }
    }
    const text = doc.getTextForSave();
    const saving = doc.primaryView()?.state.doc;
    try {
      this.selfWrites.set(doc.path, Date.now());
      // Files that aren't plain UTF-8 are written back the way they were read.
      const used = await window.native.fs.write(doc.path, text, doc.encoding !== 'utf8' || doc.bom ? { encoding: doc.encoding, bom: doc.bom } : undefined);
      if (used && used !== doc.encoding) {
        doc.encoding = used;
        this.ui.notify.warn(`${doc.title} is now saved as UTF-8`, "It had characters its old encoding can't hold.");
      }
      doc.markSaved(text, saving);
      this.activePane.pin(item);
      this.emit('did-save', item, { auto: !!opts.auto });
      return true;
    } catch (err) {
      this.selfWrites.delete(doc.path);
      this.ui.notify.error(`Failed to save ${doc.title}`, err.message);
      return false;
    }
  }

  /**
   * A file or folder moved on disk: point open documents (and their map keys) at the new path.
   * Used by rename/move in the tree, File: Rename, and language-server workspace edits.
   */
  renamePath(from, to) {
    for (const [path, doc] of [...this.documents]) {
      if (path !== from && !path.startsWith(from + '/')) continue;
      const next = to + path.slice(from.length);
      this.documents.delete(path);
      doc.setPath(next);
      this.documents.set(next, doc);
    }
    // Images and other path-backed tabs follow the rename too, so their titles and the saved session stay right.
    for (const item of this.allItems()) {
      if (item.type === 'editor' || typeof item.path !== 'string') continue;
      if (item.path !== from && !item.path.startsWith(from + '/')) continue;
      item.path = to + item.path.slice(from.length);
      this.panes.find((pane) => pane.items.includes(item))?.updateTab(item);
    }
    this.updateTitle();
    this.emit('path-renamed', from, to);
  }

  async saveAs(item = this.getActiveItem()) {
    if (item?.type !== 'editor') return false;
    const target = await window.native.dialog.saveAs(item.document.path || (this.project ? `${this.project}/untitled` : undefined));
    if (!target) return false;
    const doc = item.document;
    const other = this.documents.get(target);
    if (other && other !== doc) {
      // The target is open in another tab: that tab's copy is about to be replaced on disk.
      if (other.dirty) {
        this.ui.notify.error(`${basename(target)} is open with unsaved changes`, 'Save or close that tab first, then try Save As again.');
        return false;
      }
      for (const view of [...other.views]) this.panes.find((p) => p.items.includes(view))?.removeItem(view);
    }
    const hadPath = !!doc.path;
    if (hadPath && this.documents.get(doc.path) === doc) this.documents.delete(doc.path);
    doc.setPath(target);
    this.documents.set(target, doc);
    if (!hadPath) this.emit('document-opened', doc);
    return this.save(item);
  }

  async saveAll() {
    const seen = new Set();
    for (const item of this.allItems()) {
      if (item.type === 'editor' && item.document.dirty && !seen.has(item.document)) {
        seen.add(item.document);
        await this.save(item);
      }
    }
  }

  dirtyDocuments() {
    return [...new Set(this.allItems().filter((i) => i.type === 'editor' && i.document.dirty).map((i) => i.document))];
  }

  // --- external changes ----------------------------------------------------
  async onFilesChanged(paths) {
    this.emit('files-changed', paths);
    for (const p of paths) {
      // Our own save echoing back through the watcher (only briefly, so real edits aren't missed).
      const wrote = this.selfWrites.get(p);
      this.selfWrites.delete(p);
      if (wrote && Date.now() - wrote < 1500) continue;
      const doc = this.documents.get(p);
      if (doc) this.syncFromDisk(doc);
      // A folder that was deleted or replaced takes its files with it, without an event for each.
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const [path, inner] of this.documents) if (path.startsWith(prefix)) this.syncFromDisk(inner);
    }
  }

  async checkOpenFilesOnDisk() {
    for (const doc of this.documents.values()) this.syncFromDisk(doc);
  }

  async syncFromDisk(doc) {
    if (!doc.path) return;
    let text, meta;
    try { ({ text, ...meta } = await window.native.fs.readText(doc.path)); } catch (err) {
      // Deleted on disk (git checkout, rm…): keep the buffer, mark it unsaved so closing asks.
      if (/ENOENT/.test(err.message) && !doc.deleted) { doc.deleted = true; doc.updateDirty(); doc.emit('dirty', doc.dirty); }
      return;
    }
    if (doc.deleted) { doc.deleted = false; doc.updateDirty(); doc.emit('dirty', doc.dirty); }
    const saved = doc.savedDoc.toString();
    if (text.replace(/\r\n?/g, '\n') === saved) return;
    if (!doc.dirty) { this.emit('will-reload', doc, 'disk'); doc.reloadFrom(text, meta); }
    else if (!doc.conflict) {
      doc.conflict = true;
      this.ui.notify.warn(`${doc.title} changed on disk`, 'You have unsaved changes. Save to overwrite, or use "File: Revert" to reload.');
    }
  }

  async revert(item = this.getActiveEditor()) {
    if (!item?.document.path) return;
    try {
      const { text, ...meta } = await window.native.fs.readText(item.document.path);
      this.emit('will-reload', item.document, 'revert');
      item.document.reloadFrom(text, meta);
    } catch (err) { this.ui.notify.error('Revert failed', err.message); }
  }

  // --- editor extensions ---------------------------------------------------
  /** `largeFiles: false` leaves the extension out of large files' editors (until their features are turned on). */
  addEditorExtension(ext, { largeFiles = true } = {}) {
    const entry = { ext, largeFiles };
    this.extensions.add(entry);
    this.emit('editor-extensions-changed');
    return new Disposable(() => { this.extensions.delete(entry); this.emit('editor-extensions-changed'); });
  }
  editorExtensions(large = false) { return [...this.extensions].filter((e) => e.largeFiles || !large).map((e) => e.ext); }

  // --- session -------------------------------------------------------------
  serialize() {
    return { layout: this.root.serialize(), activePane: this.panes.indexOf(this.activePane) };
  }

  async restore(state) {
    // Older sessions saved a flat list of panes: that is one row.
    const layout = state?.layout || (state?.panes?.length && { dir: 'row', children: state.panes });
    if (!layout) return;
    let first = this.panes[0];
    const build = (d) => {
      const node = d.children?.length
        ? new Split(d.dir === 'col' ? 'col' : 'row', d.children.map(build))
        : (first ? first : new Pane(this));
      first = null;
      node.flex = d.flex > 0 ? d.flex : 1;
      return node;
    };
    const old = this.panes.slice(1);
    this.root = build(layout);
    this.root.parent = null;
    for (const p of old) for (const item of [...p.items]) p.removeItem(item, { destroy: true });
    this.layoutPanes();
    const saved = [];
    (function walk(d) { if (d.children?.length) d.children.forEach(walk); else saved.push(d); })(layout);
    const panes = this.panes;
    for (let i = 0; i < panes.length; i++) {
      const ps = saved[i], pane = panes[i];
      for (const s of ps.items || []) {
        if (!s?.path) continue; // editors and any other item that serializes a path (images…)
        const stat = await window.native.fs.stat(s.path);
        if (!stat?.isFile) continue;
        const item = await this.open(s.path, { pane, focus: false, activate: false });
        item?.restore?.(s);
      }
      const activePath = ps.items?.[ps.active]?.path;
      const active = pane.items.find((i) => activePath && i.getPath?.() === activePath) || pane.items[0];
      if (active) pane.activate(active);
    }
    const ap = panes[state.activePane] || panes[0];
    panes.filter((p) => !p.items.length && this.panes.length > 1).forEach((p) => this.removePane(p));
    this.layoutPanes();
    this.setActivePane(this.panes.includes(ap) ? ap : this.panes[0], false);
    requestAnimationFrame(() => this.activePane.active?.focus());
  }
}
