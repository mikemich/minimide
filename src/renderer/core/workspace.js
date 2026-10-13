// The workspace: project root, documents, panes and their tabbed items.
import { Emitter, Disposable } from './events.js';
import { h, icon, fileIcon, basename } from './dom.js';
import { Document, EditorItem, BinaryItem, bindEditorConfig } from './editor.js';

const MAX_TEXT_SIZE = 8 * 1024 * 1024;

export class Pane extends Emitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.items = [];
    this.active = null;
    this.flex = 1;
    this.tabBar = h('div.tab-bar', { ondragover: (e) => this.onDragOver(e), ondrop: (e) => this.onDrop(e), ondblclick: (e) => { if (e.target === this.tabBar || e.target === this.tabsEl) ws.commands.run('file:new'); } });
    this.tabsEl = h('div.tabs');
    this.tabBar.append(this.tabsEl, h('div.tab-actions',
      h('button.icon-btn', { title: 'Split Right', onclick: () => ws.splitRight(this) }, icon('split', 15))));
    this.content = h('div.pane-content');
    this.element = h('div.pane', { onmousedown: () => ws.setActivePane(this, false) }, this.tabBar, this.content);
    this.tabEls = new Map();
  }

  addItem(item, { index, activate = true, pending = false } = {}) {
    if (!this.items.includes(item)) {
      if (pending) {
        const old = this.items.find((i) => i.pending);
        if (old && old !== item) {
          index ??= this.items.indexOf(old);
          this.removeItem(old, { destroy: true, force: false });
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
    const close = h('button.tab-close', {
      title: 'Close',
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
    // Disambiguate identical names by showing the parent folder.
    const dupes = this.items.filter((i) => i !== item && i.getTitle() === item.getTitle() && i.getPath?.());
    let hint = tab.querySelector('.tab-hint');
    if (dupes.length && item.getPath?.()) {
      const parts = item.getPath().split('/');
      if (!hint) { hint = h('span.tab-hint'); tab.querySelector('.tab-title').after(hint); }
      hint.textContent = parts.at(-2) || '';
    } else hint?.remove();
  }

  activate(item) {
    if (!this.items.includes(item)) return;
    const prev = this.active;
    this.active = item;
    for (const i of this.items) i.getElement().hidden = i !== item;
    for (const i of this.items) this.updateTab(i);
    this.tabEls.get(item)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (item.view) item.view.requestMeasure();
    this.ws.setActivePane(this, false);
    if (prev !== item) this.ws.emit('pane-active-item-changed', this, item);
    this.ws.notifyActiveItem();
  }

  removeItem(item, { destroy = true } = {}) {
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
    this.ws.emit('item-removed', item, this);
    if (destroy) {
      item.destroy();
      if (item.type === 'editor') this.ws.releaseDocument(item.document);
    }
    if (!this.items.length && this.ws.panes.length > 1) this.ws.removePane(this);
    else { this.ws.notifyActiveItem(); this.ws.updateEmptyState(); }
  }

  async tabContextMenu(item) {
    const path = item.getPath?.();
    const choice = await window.native.menu.popup([
      { id: 'close', label: 'Close Tab' },
      { id: 'others', label: 'Close Other Tabs' },
      { id: 'right', label: 'Close Tabs to the Right' },
      { id: 'all', label: 'Close All Tabs' },
      { type: 'separator' },
      { id: 'split', label: 'Split Right' },
      { type: 'separator' },
      { id: 'copy', label: 'Copy Path', enabled: !!path },
      { id: 'copy-rel', label: 'Copy Relative Path', enabled: !!path && !!this.ws.project },
      { id: 'reveal', label: 'Reveal in Finder', enabled: !!path },
      { id: 'tree', label: 'Reveal in Tree View', enabled: !!path },
    ]);
    const idx = this.items.indexOf(item);
    switch (choice) {
      case 'close': return this.ws.closeItem(item);
      case 'others': for (const i of this.items.filter((x) => x !== item)) if (!await this.ws.closeItem(i)) break; return;
      case 'right': for (const i of this.items.slice(idx + 1)) if (!await this.ws.closeItem(i)) break; return;
      case 'all': for (const i of [...this.items]) if (!await this.ws.closeItem(i)) break; return;
      case 'split': return this.ws.splitRight(this, item);
      case 'copy': return window.native.clipboard.write(path);
      case 'copy-rel': return window.native.clipboard.write(this.ws.relativePath(path));
      case 'reveal': return window.native.shell.reveal(path);
      case 'tree': this.activate(item); return this.ws.commands.run('tree-view:reveal-active-file');
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
    this.project = null;
    this.documents = new Map(); // path -> Document
    this.panes = [];
    this.activePane = null;
    this.openers = [];
    this.saveHooks = [];
    this.extensions = new Set();
    this.dragging = null;
    this.panesEl = document.getElementById('panes');
    this.welcome = null;
    this.addPane();
    bindEditorConfig(this);

    window.native.fs.onChange((paths, key) => { if (key === 'project') this.onFilesChanged(paths); });
    window.addEventListener('focus', () => this.checkOpenFilesOnDisk());
  }

  // --- panes ---------------------------------------------------------------
  addPane(after) {
    const pane = new Pane(this);
    const idx = after ? this.panes.indexOf(after) + 1 : this.panes.length;
    this.panes.splice(idx, 0, pane);
    this.layoutPanes();
    this.setActivePane(pane, false);
    return pane;
  }

  removePane(pane) {
    if (this.panes.length <= 1) return;
    const idx = this.panes.indexOf(pane);
    for (const item of [...pane.items]) pane.removeItem(item, { destroy: true });
    this.panes.splice(idx, 1);
    this.layoutPanes();
    if (this.activePane === pane) this.setActivePane(this.panes[Math.max(0, idx - 1)]);
    this.notifyActiveItem();
  }

  layoutPanes() {
    this.panesEl.replaceChildren();
    this.panes.forEach((pane, i) => {
      if (i > 0) this.panesEl.append(this.paneResizer(this.panes[i - 1], pane));
      pane.element.style.flex = `${pane.flex} 1 0`;
      this.panesEl.append(pane.element);
    });
    this.panesEl.classList.toggle('split', this.panes.length > 1);
    this.updateEmptyState();
  }

  paneResizer(left, right) {
    const el = h('div.resizer.resizer-v.pane-resizer');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const lw = left.element.getBoundingClientRect().width;
      const rw = right.element.getBoundingClientRect().width;
      const total = left.flex + right.flex;
      document.body.classList.add('resizing-h');
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const nl = Math.max(160, lw + dx);
        const nr = Math.max(160, rw - dx);
        left.flex = (nl / (nl + nr)) * total;
        right.flex = (nr / (nl + nr)) * total;
        left.element.style.flex = `${left.flex} 1 0`;
        right.element.style.flex = `${right.flex} 1 0`;
      };
      const up = () => { document.body.classList.remove('resizing-h'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.emit('layout-changed'); };
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

  splitRight(pane = this.activePane, item = pane.active) {
    const newPane = this.addPane(pane);
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

  focusPaneOffset(delta) {
    if (this.panes.length < 2) return;
    const i = (this.panes.indexOf(this.activePane) + delta + this.panes.length) % this.panes.length;
    this.setActivePane(this.panes[i]);
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
      this.welcome ??= this.renderWelcome?.() || h('div');
      if (!this.welcome.isConnected) this.panes[0].content.append(this.welcome);
    } else this.welcome?.remove();
  }

  updateTitle() {
    const item = this.getActiveItem();
    const proj = this.project ? basename(this.project) : null;
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
    window.native.fs.watch(root);
    window.native.window.setProject(root);
    this.emit('project-changed', root);
    this.updateTitle();
  }

  relativePath(p) {
    if (!p || p === this.project) return '';
    if (this.project && p.startsWith(this.project + '/')) return p.slice(this.project.length + 1);
    return p;
  }

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

  async open(path, { pane = this.activePane, line, col, length, pending = false, focus = true, activate = true } = {}) {
    if (!path) return this.newFile();
    const existing = this.findItemForPath(path, pane);
    let item;
    if (existing) {
      item = existing.item;
      if (activate) existing.pane.activate(item);
      if (!pending) existing.pane.pin(item);
      pane = existing.pane;
    } else {
      for (const opener of this.openers) {
        item = await opener(path, { pane });
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
    let doc = this.documents.get(path);
    if (!doc) {
      const stat = await window.native.fs.stat(path);
      if (stat && !stat.isFile) return null;
      let text = '';
      if (stat) {
        if (stat.size > MAX_TEXT_SIZE) return new BinaryItem(path);
        try { text = await window.native.fs.read(path); } catch (err) { this.ui.notify.error(`Could not open ${basename(path)}`, err.message); return null; }
        if (text.slice(0, 8000).includes('\u0000')) return new BinaryItem(path);
      }
      doc = new Document(path, text);
      this.documents.set(path, doc);
      this.emit('document-opened', doc);
    }
    const source = [...doc.views][0]?.view;
    return new EditorItem(doc, this, source);
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
      this.documents.delete(doc.path);
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
    if (this.panes.length > 1) this.removePane(pane);
    return true;
  }

  /** Register a hook that runs before save: (editor) => void|Promise. */
  onWillSave(fn) {
    this.saveHooks.push(fn);
    return new Disposable(() => { this.saveHooks = this.saveHooks.filter((f) => f !== fn); });
  }

  async save(item = this.getActiveItem()) {
    if (!item) return false;
    if (item.type !== 'editor') return item.save ? item.save() : false;
    const doc = item.document;
    if (!doc.path) return this.saveAs(item);
    for (const hook of this.saveHooks) {
      try { await hook(item); } catch (err) { console.error('[save hook]', err); }
    }
    const text = doc.getTextForSave();
    try {
      this.selfWrites.add(doc.path);
      await window.native.fs.write(doc.path, text);
      doc.markSaved(text);
      this.activePane.pin(item);
      this.emit('did-save', item);
      return true;
    } catch (err) {
      this.ui.notify.error(`Failed to save ${doc.title}`, err.message);
      return false;
    }
  }

  async saveAs(item = this.getActiveItem()) {
    if (item?.type !== 'editor') return false;
    const target = await window.native.dialog.saveAs(item.document.path || (this.project ? `${this.project}/untitled` : undefined));
    if (!target) return false;
    const doc = item.document;
    if (doc.path) this.documents.delete(doc.path);
    doc.setPath(target);
    this.documents.set(target, doc);
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
  selfWrites = new Set();

  async onFilesChanged(paths) {
    this.emit('files-changed', paths);
    for (const p of paths) {
      if (this.selfWrites.delete(p)) continue;
      const doc = this.documents.get(p);
      if (doc) this.syncFromDisk(doc);
    }
  }

  async checkOpenFilesOnDisk() {
    for (const doc of this.documents.values()) this.syncFromDisk(doc);
  }

  async syncFromDisk(doc) {
    let text;
    try { text = await window.native.fs.read(doc.path); } catch { return; }
    const saved = doc.savedDoc.toString();
    if (text.replace(/\r\n/g, '\n') === saved) return;
    if (!doc.dirty) doc.reloadFrom(text);
    else if (!doc.conflict) {
      doc.conflict = true;
      this.ui.notify.warn(`${doc.title} changed on disk`, 'You have unsaved changes. Save to overwrite, or use "File: Revert" to reload.');
    }
  }

  async revert(item = this.getActiveEditor()) {
    if (!item?.document.path) return;
    try { item.document.reloadFrom(await window.native.fs.read(item.document.path)); } catch (err) { this.ui.notify.error('Revert failed', err.message); }
  }

  // --- editor extensions ---------------------------------------------------
  addEditorExtension(ext) {
    this.extensions.add(ext);
    this.emit('editor-extensions-changed');
    return new Disposable(() => { this.extensions.delete(ext); this.emit('editor-extensions-changed'); });
  }
  editorExtensions() { return [...this.extensions]; }

  // --- session -------------------------------------------------------------
  serialize() {
    return { panes: this.panes.map((p) => p.serialize()), activePane: this.panes.indexOf(this.activePane) };
  }

  async restore(state) {
    if (!state?.panes?.length) return;
    const panes = state.panes;
    for (let i = 0; i < panes.length; i++) {
      const ps = panes[i];
      const pane = i === 0 ? this.panes[0] : this.addPane(this.panes[i - 1]);
      pane.flex = ps.flex || 1;
      for (const s of ps.items) {
        if (s.type !== 'editor' || !s.path) continue;
        const stat = await window.native.fs.stat(s.path);
        if (!stat?.isFile) continue;
        const item = await this.open(s.path, { pane, focus: false, activate: false });
        item?.restore?.(s);
      }
      const active = pane.items[ps.active] || pane.items[0];
      if (active) pane.activate(active);
    }
    this.panes.filter((p) => !p.items.length && this.panes.length > 1).forEach((p) => this.removePane(p));
    this.layoutPanes();
    const ap = this.panes[state.activePane] || this.panes[0];
    this.setActivePane(ap, false);
    requestAnimationFrame(() => ap.active?.focus());
  }
}
