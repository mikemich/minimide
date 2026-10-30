// Outline: a sidebar view of the file's symbols as a tree that follows the cursor, with a filter.
// The symbols come from the `symbols` service (the language server's, or the syntax tree's), which
// keeps them up to date for the active editor while the view is showing.

/** Every symbol, depth first, with its parent chain. */
function flatten(symbols, out = [], parents = []) {
  for (const s of symbols) {
    out.push({ sym: s, parents });
    flatten(s.children, out, [...parents, s]);
  }
  return out;
}

export function activate(mide) {
  const { h, icon, registerIcon, symbolIcon } = mide.ui;
  const symbols = mide.services.get('symbols');

  registerIcon('outline', '<path d="M4 6h3M4 12h3M4 18h3"/><path d="M10 6h10M13 12h7M13 18h7"/>');
  registerIcon('unfold', '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>');

  const outlineVisible = () => mide.sidebar.isActive('outline');
  mide.subscriptions.add(symbols.watch((editor) => outlineVisible() && editor === mide.workspace.getActiveEditor()));
  mide.subscriptions.add(symbols.onDidChange((editor) => { if (editor === outline.editor) outline.render(); }));

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
      if (editor) symbols.refresh(editor);
      this.render();
    },

    render() {
      if (!outlineVisible()) { this.stale = true; return; }
      this.stale = false;
      const snap = this.editor ? symbols.peek(this.editor) : null;
      outlineEl.dataset.source = snap?.source || '';
      this.source.textContent = snap ? (snap.source === 'lsp' ? 'language server' : 'syntax') : '';
      this.source.title = snap ? (snap.source === 'lsp' ? 'Symbols from the language server' : 'Symbols from the syntax tree (no language server for this file)') : '';
      this.rows = [];
      if (!this.editor) return this.show('No editor is open.');
      if (!snap) { symbols.refresh(this.editor); return this.show('Looking for symbols…'); }
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
        symbolIcon(row.sym.kind),
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
      const path = this.editor ? symbols.symbolPathAt(this.editor) : [];
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
      const snap = this.editor ? symbols.peek(this.editor) : null;
      if (!open && snap) {
        for (const { sym, parents } of flatten(snap.symbols)) {
          if (sym.children.length) collapsed.add(`${parents.map((p) => p.name).join('\u0000')}\u0000${sym.kind}:${sym.name}`);
        }
      }
      this.render();
    },

    jump(sym) { if (this.editor) symbols.reveal(this.editor, sym); },

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
    onShow: () => { if (outline.editor) symbols.refresh(outline.editor); if (outline.stale) outline.render(); else outline.highlight(); },
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

  mide.commands.add({
    'outline:show': { title: 'Show Outline', run: () => { mide.sidebar.show('outline', { focus: true }); } },
    'outline:expand-all': { title: 'Expand All Symbols', run: () => outline.setAll(true) },
    'outline:collapse-all': { title: 'Collapse All Symbols', run: () => outline.setAll(false) },
  });
}
