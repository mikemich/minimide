// Outline: breadcrumbs above each editor (folder › file › Class › method at the cursor) and a
// sidebar view of the file's symbols. Symbols come from the language server when one is attached
// (through the lsp service) and otherwise from the syntax tree (symbols.js). Both are computed
// once typing pauses and reused, with positions mapped through edits, until the text changes again.
//
// Provides the `symbols` service so other packages can use the same symbols.
import { syntaxSymbols, pathAt, flatten } from './symbols.js';

const DELAY = 300; // ms after the last edit before symbols are computed again

export function activate(mide) {
  const { h, icon, fileIcon, registerIcon } = mide.ui;
  const { ViewPlugin, EditorView, showPanel } = mide.cm.view;
  const lang = mide.cm.language;

  // Kind -> [icon, color]. Icons are drawn here so they follow the theme's colors.
  registerIcon('outline', '<path d="M4 6h3M4 12h3M4 18h3"/><path d="M10 6h10M13 12h7M13 18h7"/>');
  registerIcon('sym-class', '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>');
  registerIcon('sym-function', '<path d="M14 4h-1a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H6"/><path d="M7 11h8"/>');
  registerIcon('sym-property', '<path d="M5 19l7-7"/><circle cx="15.5" cy="8.5" r="4"/>');
  registerIcon('sym-variable', '<path d="M7 5L4 12l3 7M17 5l3 7-3 7"/><path d="M9.5 9l5 6M14.5 9l-5 6"/>');
  registerIcon('sym-constant', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h8"/>');
  registerIcon('sym-interface', '<circle cx="7" cy="12" r="3.5"/><path d="M10.5 12H21"/>');
  registerIcon('sym-enum', '<rect x="3" y="4" width="8" height="8" rx="1.5"/><path d="M14 6h7M14 10h7M6 16h15M6 20h15"/>');
  registerIcon('sym-module', '<path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1"/>');
  registerIcon('sym-key', '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>');
  registerIcon('sym-heading', '<path d="M6 4v16M18 4v16M6 12h12"/>');
  registerIcon('sym-selector', '<path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2"/><circle cx="12" cy="12" r="1.5"/>');
  registerIcon('sym-symbol', '<circle cx="12" cy="12" r="3.5"/>');
  registerIcon('unfold', '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>');

  const KINDS = {
    class: ['sym-class', 'orange'], struct: ['sym-class', 'orange'], object: ['sym-module', 'orange'],
    method: ['sym-function', 'magenta'], function: ['sym-function', 'magenta'], constructor: ['sym-function', 'orange'], operator: ['sym-function', 'magenta'], event: ['sym-function', 'yellow'],
    property: ['sym-property', 'blue'], field: ['sym-property', 'blue'],
    variable: ['sym-variable', 'blue'], 'type parameter': ['sym-variable', 'cyan'],
    constant: ['sym-constant', 'blue'], string: ['sym-key', 'green'], number: ['sym-key', 'orange'], boolean: ['sym-key', 'cyan'], null: ['sym-key', 'muted'], array: ['sym-module', 'cyan'],
    interface: ['sym-interface', 'cyan'], type: ['sym-interface', 'cyan'],
    enum: ['sym-enum', 'yellow'], 'enum member': ['sym-enum', 'yellow'],
    module: ['sym-module', 'muted'], namespace: ['sym-module', 'muted'], package: ['sym-module', 'muted'], file: ['sym-module', 'muted'],
    key: ['sym-key', 'yellow'], heading: ['sym-heading', 'blue'], selector: ['sym-selector', 'green'],
  };
  const kindIcon = (kind) => {
    const [name, color] = KINDS[kind] || ['sym-symbol', 'muted'];
    const el = icon(name, 14);
    el.dataset.color = color;
    el.title = kind;
    return el;
  };

  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view) || null;
  const breadcrumbsOn = () => mide.config.get('outline.breadcrumbs') !== false;
  const outlineVisible = () => mide.sidebar.isActive('outline');
  const changeListeners = new Set();

  // ---------------------------------------------------------------------------
  // Symbols per editor view

  const trackers = new Set();

  class Tracker {
    constructor(view) {
      this.view = view;
      this.snapshot = null; // { symbols, source, doc, partial?, language? }: positions are in snapshot.doc
      this.mapping = null; // ChangeSet from snapshot.doc to the current text
      this.inverse = null;
      this.dirty = true;
      this.seq = 0;
      this.timer = null;
      this.pending = null;
      this.reqChanges = undefined; // edits made while a computation runs
      trackers.add(this);
      this.schedule(20);
    }

    update(u) {
      if (u.docChanged) {
        if (this.snapshot) { this.mapping = this.mapping ? this.mapping.compose(u.changes) : u.changes; this.inverse = null; }
        if (this.reqChanges !== undefined) this.reqChanges = this.reqChanges ? this.reqChanges.compose(u.changes) : u.changes;
        this.dirty = true;
        this.schedule(DELAY);
      } else if (this.snapshot?.source === 'syntax' && (this.snapshot.partial || u.state.facet(lang.language) !== this.snapshot.language)
        && lang.syntaxTree(u.startState) !== lang.syntaxTree(u.state)) {
        // The language just loaded, or the parser got further than last time.
        this.dirty = true;
        this.schedule(DELAY);
      } else if (this.dirty && (u.geometryChanged || u.viewportChanged)) this.schedule(100); // shown again
    }

    wanted() {
      const { view } = this;
      if (!view.dom.isConnected || !view.dom.getClientRects().length) return false;
      return breadcrumbsOn() || (outlineVisible() && mide.workspace.getActiveEditor()?.view === view);
    }

    schedule(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.dirty && this.wanted()) this.compute(); }, delay);
    }

    /** Recompute now if the text changed since last time and someone shows the result. */
    refresh() { if (this.dirty && this.wanted()) this.compute(); }

    compute() {
      clearTimeout(this.timer);
      const seq = ++this.seq;
      const { view } = this;
      const doc = view.state.doc;
      this.dirty = false;
      this.reqChanges = null;
      this.pending = (async () => {
        const lsp = mide.services.get('lsp');
        const editor = editorFor(view);
        let fromServer = null;
        if (lsp?.documentSymbols && editor) {
          try { fromServer = await lsp.documentSymbols(editor); } catch {}
        }
        if (seq !== this.seq || !trackers.has(this)) return;
        let snap = fromServer?.symbols.length ? { symbols: fromServer.symbols, source: 'lsp', doc: fromServer.doc } : null;
        if (!snap) {
          const { symbols, partial } = syntaxSymbols(view.state, lang);
          snap = symbols.length || !fromServer
            ? { symbols, source: 'syntax', doc: view.state.doc, partial, language: view.state.facet(lang.language) }
            : { symbols: [], source: 'lsp', doc: fromServer.doc };
        }
        let mapping = null;
        if (snap.doc !== view.state.doc) {
          // Typed while the server answered: map its positions through what was typed since.
          if (snap.doc !== doc || !this.reqChanges) { this.dirty = true; this.schedule(DELAY); return; }
          mapping = this.reqChanges;
        }
        this.reqChanges = undefined;
        this.snapshot = snap;
        this.mapping = mapping;
        this.inverse = null;
        emitChange(this);
      })();
      return this.pending;
    }

    async ensure() {
      if (this.dirty || !this.snapshot) await this.compute();
      else if (this.pending) await this.pending;
      return this.snapshot;
    }

    /** Position in the current text -> position in the snapshot's text, and back. */
    toSnap(pos) {
      if (!this.mapping) return pos;
      this.inverse ??= this.mapping.invertedDesc;
      return this.inverse.mapPos(pos);
    }
    fromSnap(pos) { return this.mapping ? this.mapping.mapPos(pos) : pos; }

    pathAt(pos = this.view.state.selection.main.head) {
      return this.snapshot ? pathAt(this.snapshot.symbols, this.toSnap(pos)) : [];
    }

    jumpTo(sym) {
      const { view } = this;
      const pos = Math.min(this.fromSnap(sym.selFrom), view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select.outline' });
      view.focus();
    }

    destroy() { trackers.delete(this); clearTimeout(this.timer); this.seq++; }
  }

  const trackerPlugin = ViewPlugin.fromClass(Tracker);
  const trackerFor = (view) => (view ? view.plugin(trackerPlugin) : null);
  mide.editor.addExtension(trackerPlugin);

  function emitChange(tracker) {
    for (const c of crumbs) if (c.view === tracker.view) c.render();
    if (outline.editor?.view === tracker.view) outline.render();
    const editor = editorFor(tracker.view);
    if (editor) for (const fn of [...changeListeners]) { try { fn(editor); } catch (err) { console.error('[outline]', err); } }
  }

  /** Copies of the snapshot's symbols with positions in the current text. */
  function mapped(tracker, list) {
    if (!tracker.mapping) return list;
    return list.map((s) => ({
      ...s, from: tracker.fromSnap(s.from), to: tracker.fromSnap(s.to), selFrom: tracker.fromSnap(s.selFrom), selTo: tracker.fromSnap(s.selTo),
      children: mapped(tracker, s.children),
    }));
  }

  // A server that just opened this document has better symbols than the syntax tree.
  mide.services.consume('lsp', (lsp) => {
    const sub = lsp.onDidAttach?.((doc) => {
      for (const t of trackers) {
        if (editorFor(t.view)?.document !== doc) continue;
        t.dirty = true;
        t.schedule(0);
      }
    });
    if (sub) mide.subscriptions.add(sub);
  });

  mide.services.provide('symbols', {
    /** { symbols, source: 'lsp' | 'syntax' } for an editor, positions in its current text; null for other items. */
    async getSymbols(editor) {
      const tracker = trackerFor(editor?.view);
      if (!tracker) return null;
      const snap = await tracker.ensure();
      return snap ? { symbols: mapped(tracker, snap.symbols), source: snap.source } : null;
    },
    /** The symbols around `pos` (default: the cursor), outermost first, from the last computed symbols. */
    symbolPathAt(editor, pos) {
      const tracker = trackerFor(editor?.view);
      if (!tracker) return [];
      return mapped(tracker, tracker.pathAt(pos)).map(({ children, ...s }) => s);
    },
    /** `fn(editor)` whenever an editor's symbols were computed again. */
    onDidChange(fn) { changeListeners.add(fn); return { dispose: () => changeListeners.delete(fn) }; },
  });

  // ---------------------------------------------------------------------------
  // A small list of symbols under a breadcrumb, with a filter

  let menu = null;
  function closeMenu(refocus) {
    if (!menu) return;
    const { el, view } = menu;
    menu = null;
    el.remove();
    window.removeEventListener('mousedown', onOutside, true);
    if (refocus && view?.dom.isConnected) view.focus();
  }
  const onOutside = (e) => { if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu(false); };

  function openMenu(anchor, tracker, symbols, current) {
    closeMenu(false);
    const input = h('input.cm-crumbs-filter', { placeholder: 'Filter', spellcheck: false });
    const list = h('div.cm-crumbs-list');
    const el = h('div.cm-crumbs-menu', input, list);
    let rows = [];
    let index = 0;
    const select = (i) => {
      rows[index]?.el.classList.remove('selected');
      index = Math.max(0, Math.min(rows.length - 1, i));
      rows[index]?.el.classList.add('selected');
      rows[index]?.el.scrollIntoView({ block: 'nearest' });
    };
    const pick = (sym) => { closeMenu(false); tracker.jumpTo(sym); };
    const fill = () => {
      const q = input.value.trim();
      rows = [];
      for (const sym of symbols) {
        const m = q ? mide.ui.fuzzyMatch(q, sym.name) : { indices: [] };
        if (!m) continue;
        const row = h('div.cm-crumbs-item', { onmousedown: (e) => { e.preventDefault(); pick(sym); } },
          kindIcon(sym.kind), h('span.cm-crumbs-name', mide.ui.highlightMatches(sym.name, m.indices)), sym.detail ? h('span.cm-crumbs-detail', sym.detail) : null);
        if (sym === current) row.classList.add('current');
        rows.push({ sym, el: row });
      }
      list.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [h('div.cm-crumbs-none', 'No symbols')]));
      index = 0;
      select(q ? 0 : Math.max(0, rows.findIndex((r) => r.sym === current)));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => {
      const page = 8;
      if (e.key === 'ArrowDown') select(index + 1);
      else if (e.key === 'ArrowUp') select(index - 1);
      else if (e.key === 'PageDown') select(index + page);
      else if (e.key === 'PageUp') select(index - page);
      else if (e.key === 'Enter') { if (rows[index]) pick(rows[index].sym); }
      else if (e.key === 'Escape') closeMenu(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('focusout', (e) => { if (menu?.el === el && !el.contains(e.relatedTarget)) closeMenu(false); });
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${r.bottom + 2}px`;
    el.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 24)}px`;
    menu = { el, anchor, view: tracker.view };
    window.addEventListener('mousedown', onOutside, true);
    fill();
    input.focus();
  }
  mide.subscriptions.add({ dispose: () => closeMenu(false) });

  // ---------------------------------------------------------------------------
  // Breadcrumbs: a panel at the top of each editor

  const crumbs = new Set();

  class Breadcrumbs {
    constructor(view) {
      this.view = view;
      this.key = null;
      this.editor = null;
      this.dom = h('div.cm-breadcrumbs', { onmousedown: (e) => this.onMouseDown(e) });
      crumbs.add(this);
      this.render();
    }

    update(u) { if (u.selectionSet || u.docChanged) this.render(); }

    render(force) {
      const { view } = this;
      this.editor ||= editorFor(view);
      const tracker = trackerFor(view);
      const path = this.editor?.getPath() || null;
      const symbols = tracker ? tracker.pathAt() : [];
      const key = `${path}\n${tracker?.snapshot?.symbols.length ?? -1}\n${symbols.map((s) => `${s.kind}:${s.name}`).join('\n')}`;
      if (!force && key === this.key) return;
      this.key = key;
      this.symbols = symbols;
      const sep = () => h('span.cm-crumb-sep', icon('chevron', 11));
      const parts = [];
      if (path) {
        const rel = mide.workspace.relativePath(path);
        const segs = rel.split('/').filter(Boolean);
        let dirs = segs.slice(0, -1);
        if (dirs.length > 4) dirs = ['…', ...dirs.slice(-3)];
        for (const d of dirs) parts.push(h('span.cm-crumb', { dataset: { type: 'folder' }, title: 'Reveal in the file tree' }, d), sep());
        const name = segs.at(-1) || mide.path.basename(path);
        parts.push(h('span.cm-crumb', { dataset: { type: 'file' }, title: rel }, fileIcon(name), h('span', name)));
      } else {
        parts.push(h('span.cm-crumb', { dataset: { type: 'file' } }, this.editor?.getTitle() || 'untitled'));
      }
      symbols.forEach((s, i) => parts.push(sep(), h('span.cm-crumb', { dataset: { type: 'symbol', index: i }, title: s.detail ? `${s.name} ${s.detail}` : s.name }, kindIcon(s.kind), h('span', s.name))));
      this.dom.replaceChildren(...parts);
    }

    onMouseDown(e) {
      const crumb = e.target.closest('.cm-crumb');
      if (!crumb || e.button !== 0) return;
      e.preventDefault();
      if (crumb.dataset.type === 'symbol') this.openSiblings(Number(crumb.dataset.index), crumb);
      else {
        // The tree reveals the active file, so make this editor the active one first.
        this.view.focus();
        if (mide.commands.has('tree-view:reveal-active-file')) mide.commands.run('tree-view:reveal-active-file');
      }
    }

    /** The symbols next to the one at `index` (the top level for the first), to jump between. */
    openSiblings(index, anchor) {
      const tracker = trackerFor(this.view);
      if (!tracker?.snapshot) return;
      const path = this.symbols || [];
      if (menu?.anchor === anchor) { closeMenu(true); return; }
      const siblings = index > 0 ? path[index - 1].children : tracker.snapshot.symbols;
      openMenu(anchor, tracker, siblings, path[index]);
    }

    /** Keyboard entry: the innermost symbol's list, or the top level. */
    focus() {
      const tracker = trackerFor(this.view);
      if (!tracker?.snapshot) return;
      const items = this.dom.querySelectorAll('.cm-crumb[data-type="symbol"]');
      if (items.length) this.openSiblings(items.length - 1, items[items.length - 1]);
      else {
        const file = this.dom.querySelector('.cm-crumb[data-type="file"]') || this.dom;
        openMenu(file, tracker, tracker.snapshot.symbols, null);
      }
    }

    destroy() { crumbs.delete(this); if (menu?.view === this.view) closeMenu(false); }
  }

  const breadcrumbsExtension = showPanel.of((view) => {
    const b = new Breadcrumbs(view);
    return { dom: b.dom, top: true, update: (u) => b.update(u), destroy: () => b.destroy() };
  });
  let breadcrumbsExt = null;
  mide.config.observe('outline.breadcrumbs', (on) => {
    const want = on !== false;
    if (want === !!breadcrumbsExt) return;
    breadcrumbsExt?.dispose();
    breadcrumbsExt = want ? mide.editor.addExtension(breadcrumbsExtension) : null;
    if (want) setTimeout(() => { for (const t of trackers) t.refresh(); }, 0);
  });
  mide.subscriptions.add({ dispose: () => breadcrumbsExt?.dispose() });

  // Paths: a tab that was just added, or a file renamed / saved under a new name.
  const recrumb = (item) => { for (const c of crumbs) if (c.view === item?.view) { c.editor = null; c.render(true); } };
  mide.workspace.onDidOpenItem((item) => { if (item?.type === 'editor') setTimeout(() => recrumb(item), 0); });
  mide.workspace.onDidUpdateEditor((editor, update) => { if (!update) recrumb(editor); });

  // ---------------------------------------------------------------------------
  // Outline view

  const outline = {
    editor: null,
    rows: [],
    cursor: -1,
    collapsedByPath: new Map(),
    stale: true,
    filter: h('input.input.outline-filter', { placeholder: 'Filter symbols', spellcheck: false }),
    list: h('div.outline-list', { tabIndex: 0 }),
    message: h('div.outline-message'),
    source: h('span.outline-source'),

    get collapsed() {
      const key = this.editor?.getPath() || this.editor?.id || '';
      if (!this.collapsedByPath.has(key)) this.collapsedByPath.set(key, new Set());
      return this.collapsedByPath.get(key);
    },

    setEditor(editor) {
      if (editor === this.editor) return;
      this.editor = editor;
      this.cursor = -1;
      trackerFor(editor?.view)?.refresh();
      this.render();
    },

    render() {
      if (!outlineVisible()) { this.stale = true; return; }
      this.stale = false;
      const tracker = trackerFor(this.editor?.view);
      const snap = tracker?.snapshot;
      outlineEl.dataset.source = snap?.source || '';
      this.source.textContent = snap ? (snap.source === 'lsp' ? 'language server' : 'syntax') : '';
      this.source.title = snap ? (snap.source === 'lsp' ? 'Symbols from the language server' : 'Symbols from the syntax tree (no language server for this file)') : '';
      this.rows = [];
      if (!this.editor) return this.show('No editor is open.');
      if (!snap) { tracker?.refresh(); return this.show('Looking for symbols…'); }
      if (!snap.symbols.length) return this.show('No symbols found in this file.');
      const q = this.filter.value.trim();
      const collapsed = this.collapsed;
      const out = [];
      const keyOf = (parents, s) => `${parents.map((p) => p.name).join('\u0000')}\u0000${s.kind}:${s.name}`;
      // While filtering: a symbol shows if it or anything inside it matches, all expanded.
      const walk = (list, parents, depth) => {
        let any = false;
        for (const s of list) {
          const m = q ? mide.ui.fuzzyMatch(q, s.name) : { indices: [] };
          const key = keyOf(parents, s);
          const start = out.length;
          const row = { sym: s, key, depth, parents, indices: m?.indices || [], hasChildren: s.children.length > 0 };
          out.push(row);
          const open = q || !collapsed.has(key);
          const childMatched = s.children.length && (open || q) ? walk(s.children, [...parents, s], depth + 1) : false;
          if (q && !m && !childMatched) { out.length = start; continue; }
          any = true;
        }
        return any;
      };
      walk(snap.symbols, [], 0);
      if (!out.length) return this.show(`No symbols match “${q}”.`);
      this.message.hidden = true;
      this.list.hidden = false;
      this.rows = out;
      this.list.replaceChildren(...out.map((row, i) => {
        const open = q || !collapsed.has(row.key);
        row.el = h('div.outline-row', {
          style: { paddingLeft: `${8 + row.depth * 14}px` },
          title: row.sym.detail ? `${row.sym.name} ${row.sym.detail}` : row.sym.name,
          onclick: (e) => {
            if (e.target.closest('.outline-twisty')) { this.toggle(row); return; }
            this.cursor = i;
            this.jump(row.sym);
          },
        },
        h('span.outline-twisty', { class: row.hasChildren ? (open ? 'open' : 'closed') : 'leaf' }, row.hasChildren ? icon('chevron', 12) : null),
        kindIcon(row.sym.kind),
        h('span.outline-name', mide.ui.highlightMatches(row.sym.name, row.indices)),
        row.sym.detail ? h('span.outline-detail', row.sym.detail) : null);
        return row.el;
      }));
      if (this.cursor >= out.length) this.cursor = -1;
      this.rows[this.cursor]?.el.classList.add('selected');
      this.highlight();
    },

    show(text) {
      this.message.textContent = text;
      this.message.hidden = false;
      this.list.hidden = true;
      this.list.replaceChildren();
    },

    /** Mark the symbol at the cursor (or its closest visible parent) and keep it in view. */
    highlight() {
      if (!outlineVisible() || !this.rows.length) return;
      const tracker = trackerFor(this.editor?.view);
      const path = tracker ? tracker.pathAt() : [];
      let target = null;
      for (let i = path.length - 1; i >= 0 && !target; i--) target = this.rows.find((r) => r.sym === path[i]) || null;
      const prev = this.list.querySelector('.outline-row.current');
      if (prev && prev !== target?.el) prev.classList.remove('current');
      if (!target) return;
      target.el.classList.add('current');
      if (mide.config.get('outline.followCursor') !== false && prev !== target.el) target.el.scrollIntoView({ block: 'nearest' });
    },

    toggle(row, open) {
      const collapsed = this.collapsed;
      if (!row.hasChildren) return;
      const isOpen = !collapsed.has(row.key);
      if ((open ?? !isOpen) === isOpen) return;
      if (isOpen) collapsed.add(row.key); else collapsed.delete(row.key);
      this.cursor = this.rows.indexOf(row);
      this.render();
    },

    setAll(open) {
      const collapsed = this.collapsed;
      collapsed.clear();
      const snap = trackerFor(this.editor?.view)?.snapshot;
      if (!open && snap) {
        for (const { sym, parents } of flatten(snap.symbols)) {
          if (sym.children.length) collapsed.add(`${parents.map((p) => p.name).join('\u0000')}\u0000${sym.kind}:${sym.name}`);
        }
      }
      this.render();
    },

    jump(sym) { trackerFor(this.editor?.view)?.jumpTo(sym); },

    onKey(e) {
      const rows = this.rows;
      if (!rows.length) return;
      const move = (i) => {
        rows[this.cursor]?.el.classList.remove('selected');
        this.cursor = Math.max(0, Math.min(rows.length - 1, i));
        rows[this.cursor].el.classList.add('selected');
        rows[this.cursor].el.scrollIntoView({ block: 'nearest' });
      };
      const row = rows[this.cursor];
      switch (e.key) {
        case 'ArrowDown': move(this.cursor + 1); break;
        case 'ArrowUp': move(this.cursor < 0 ? 0 : this.cursor - 1); break;
        case 'Home': move(0); break;
        case 'End': move(rows.length - 1); break;
        case 'ArrowRight': if (row) this.toggle(row, true); break;
        case 'ArrowLeft':
          if (row?.hasChildren && !this.collapsed.has(row.key) && !this.filter.value.trim()) this.toggle(row, false);
          else if (row?.parents.length) move(rows.findIndex((r) => r.sym === row.parents.at(-1)));
          break;
        case 'Enter': if (row) this.jump(row.sym); break;
        default: return;
      }
      e.preventDefault();
    },
  };

  outline.list.addEventListener('keydown', (e) => outline.onKey(e));
  outline.filter.addEventListener('input', () => { outline.cursor = -1; outline.render(); });
  outline.filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); outline.list.focus(); outline.onKey(e); }
    else if (e.key === 'Enter' && outline.rows.length) { e.preventDefault(); outline.jump(outline.rows[Math.max(0, outline.cursor)].sym); }
    else if (e.key === 'Escape' && outline.filter.value) { e.preventDefault(); e.stopPropagation(); outline.filter.value = ''; outline.render(); }
  });

  const outlineEl = h('div.outline-view',
    h('div.outline-header',
      h('span.outline-title', 'Outline'),
      outline.source,
      h('span.outline-spacer'),
      h('button.icon-btn', { title: 'Expand All', onclick: () => outline.setAll(true) }, icon('unfold', 14)),
      h('button.icon-btn', { title: 'Collapse All', onclick: () => outline.setAll(false) }, icon('collapse', 14))),
    h('div.outline-filter-row', outline.filter),
    outline.message,
    outline.list);

  mide.sidebar.addView({
    id: 'outline', title: 'Outline', icon: 'outline', order: 12, command: 'outline:show', element: outlineEl,
    focus: () => outline.filter.focus(),
    onShow: () => { trackerFor(outline.editor?.view)?.refresh(); if (outline.stale) outline.render(); else outline.highlight(); },
  });

  mide.workspace.observeActiveItem(() => {
    const editor = mide.workspace.getActiveEditor();
    if (editor) outline.setEditor(editor);
    else if (!mide.workspace.getItems().includes(outline.editor)) outline.setEditor(null);
  });
  mide.workspace.onDidCloseItem((item) => { if (item === outline.editor) outline.setEditor(mide.workspace.getActiveEditor()); });
  let highlightFrame = 0;
  mide.workspace.onDidUpdateEditor((editor, update) => {
    if (editor !== outline.editor || !update?.selectionSet || highlightFrame) return;
    highlightFrame = requestAnimationFrame(() => { highlightFrame = 0; outline.highlight(); });
  });
  mide.subscriptions.add({ dispose: () => cancelAnimationFrame(highlightFrame) });

  // ---------------------------------------------------------------------------
  // Commands

  const activeCrumbs = () => {
    const v = mide.workspace.getActiveEditor()?.view;
    return [...crumbs].find((c) => c.view === v) || null;
  };
  mide.commands.add({
    'outline:show': { title: 'Show Outline', run: () => { mide.sidebar.show('outline', { focus: true }); } },
    'outline:toggle-breadcrumbs': { title: 'Toggle Breadcrumbs', run: () => mide.config.set('outline.breadcrumbs', !breadcrumbsOn()) },
    'outline:focus-breadcrumbs': {
      title: 'Focus Breadcrumbs', when: () => !!activeCrumbs(),
      run: async () => { const c = activeCrumbs(); await trackerFor(c.view)?.ensure(); c.render(true); c.focus(); },
    },
    'outline:expand-all': { title: 'Expand All Symbols', run: () => outline.setAll(true) },
    'outline:collapse-all': { title: 'Collapse All Symbols', run: () => outline.setAll(false) },
  });

  mide.subscriptions.add({ dispose: () => { for (const t of trackers) clearTimeout(t.timer); } });
}
