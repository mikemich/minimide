// Todos: keyword highlighting in comments plus a project-wide sidebar list.

export function activate(mide) {
  const { ViewPlugin, Decoration } = mide.cm.view;
  const { RangeSetBuilder } = mide.cm.state;
  const { syntaxTree } = mide.cm.language;
  const { h, icon, fileIcon, registerIcon } = mide.ui;
  registerIcon('checklist', '<path d="M4 6l1.5 1.5L8 5"/><path d="M4 12l1.5 1.5L8 11"/><path d="M4 18l1.5 1.5L8 17"/><path d="M11 6h9M11 12h9M11 18h9"/>');

  const keywords = () => (mide.config.get('todos.keywords') || []).filter(Boolean);
  const regex = () => new RegExp(`\\b(${keywords().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b:?`, 'g');
  const kind = (k) => (/FIXME|BUG/.test(k) ? 'fix' : /HACK|XXX/.test(k) ? 'hack' : /NOTE/.test(k) ? 'note' : 'todo');

  // --- highlighting --------------------------------------------------------
  function inComment(state, pos) {
    const tree = syntaxTree(state);
    if (!tree.length) return true; // plain text / no parser: highlight anywhere
    for (let node = tree.resolveInner(pos, 1); node; node = node.parent) if (/comment/i.test(node.name)) return true;
    return false;
  }

  function build(view) {
    const builder = new RangeSetBuilder();
    if (!keywords().length) return builder.finish();
    const re = regex();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      for (const m of text.matchAll(re)) {
        const start = from + m.index;
        if (!inComment(view.state, start)) continue;
        builder.add(start, start + m[0].length, Decoration.mark({ class: `cm-todo cm-todo-${kind(m[1])}` }));
      }
    }
    return builder.finish();
  }

  const instances = new Set();
  mide.editor.addExtension(ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.decorations = build(view); instances.add(this); }
    update(u) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view); }
    destroy() { instances.delete(this); }
  }, { decorations: (v) => v.decorations }));
  mide.config.onDidChange('todos.keywords', () => {
    for (const p of instances) { p.decorations = build(p.view); p.view.dispatch({}); }
    if (mide.sidebar.isActive('todos')) refresh();
  });

  // --- sidebar list --------------------------------------------------------
  const summary = h('div.todos-summary');
  const list = h('div.todos-list');
  const filterBtns = h('div.todos-filters');
  let filter = null;
  let results = [];
  const el = h('div.todos-view',
    h('div.todos-header', h('span.todos-title', 'Todos'),
      h('button.icon-btn', { title: 'Refresh', onclick: () => refresh() }, icon('refresh', 14))),
    filterBtns, summary, list);

  async function refresh() {
    if (!mide.workspace.project) { summary.textContent = 'Open a folder to list its todos.'; list.replaceChildren(); return; }
    summary.textContent = 'Scanning…';
    const words = keywords().filter(Boolean);
    if (!words.length) { results = []; return render(); }
    const escaped = words.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const res = await mide.project.search(`\\b(${escaped.join('|')})\\b`, { regex: true, caseSensitive: true, maxResults: 5000 });
    results = res.results || [];
    render();
  }

  function render() {
    const re = regex();
    const counts = {};
    const rows = [];
    for (const r of results) {
      const matches = [];
      for (const m of r.matches) {
        const found = [...m.text.matchAll(re)][0];
        if (!found) continue;
        counts[found[1]] = (counts[found[1]] || 0) + 1;
        if (filter && found[1] !== filter) continue;
        const text = m.text.slice(found.index + found[0].length).replace(/^[\s:(-]+|\*\/\s*$|-->\s*$/g, '').trim();
        matches.push({ ...m, keyword: found[1], note: text || '(no description)' });
      }
      if (matches.length) rows.push({ file: r.file, matches });
    }
    filterBtns.replaceChildren(...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
      h('button.todos-chip', { class: `${filter === k ? 'active' : ''} k-${kind(k)}`, onclick: () => { filter = filter === k ? null : k; render(); } }, `${k} ${n}`)));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    summary.textContent = total ? `${total} item${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}` : 'Nothing to do. 🎉';
    list.replaceChildren(...rows.map(({ file, matches }) => {
      const rel = mide.workspace.relativePath(file);
      return h('div.todos-file',
        h('div.todos-file-name', { title: rel }, fileIcon(rel), h('span', rel)),
        ...matches.map((m) => h('div.todos-item', {
          onclick: () => mide.workspace.open(file, { line: m.line, col: m.col }),
          title: m.text.trim(),
        }, h(`span.todos-kw.k-${kind(m.keyword)}`, m.keyword), h('span.todos-note', m.note), h('span.todos-line', String(m.line)))));
    }));
  }

  mide.sidebar.addView({ id: 'todos', title: 'Todos', icon: 'checklist', order: 20, command: 'todos:show', element: el, onShow: refresh });
  mide.workspace.onDidSave(() => { if (mide.sidebar.isActive('todos')) refresh(); });
  mide.workspace.onDidChangeFolders(() => { results = []; if (mide.sidebar.isActive('todos')) refresh(); });
  mide.commands.add('todos:show', 'Show Todos', () => { mide.sidebar.show('todos', { focus: true }); refresh(); });

  mide.styles.add(`
    .cm-todo { font-weight: 700; border-radius: 3px; padding: 0 2px; }
    .cm-todo-todo { color: var(--c-yellow); background: color-mix(in srgb, var(--c-yellow) 14%, transparent); }
    .cm-todo-fix { color: var(--c-red); background: color-mix(in srgb, var(--c-red) 14%, transparent); }
    .cm-todo-hack { color: var(--c-orange); background: color-mix(in srgb, var(--c-orange) 14%, transparent); }
    .cm-todo-note { color: var(--c-blue); background: color-mix(in srgb, var(--c-blue) 14%, transparent); }
    .cm-todo * { color: inherit !important; }
    .todos-view { display: flex; flex-direction: column; height: 100%; }
    .todos-header { flex: none; display: flex; align-items: center; justify-content: space-between; height: 34px; padding: 0 6px 0 14px; }
    .todos-title { font-size: 0.82em; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-muted); }
    .todos-filters { flex: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 6px; }
    .todos-chip { border: 1px solid var(--border-strong); background: transparent; border-radius: 10px; padding: 1px 8px; font-size: 0.82em; color: var(--fg-muted); }
    .todos-chip.active { background: var(--bg-selected); color: var(--fg-strong); }
    .todos-summary { flex: none; padding: 0 14px 6px; color: var(--fg-subtle); font-size: 0.9em; }
    .todos-list { flex: 1; overflow: auto; padding-bottom: 20px; }
    .todos-file-name { display: flex; align-items: center; gap: 6px; padding: 6px 12px 2px; color: var(--fg-strong); font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .todos-item { display: flex; align-items: baseline; gap: 8px; padding: 3px 12px 3px 32px; cursor: pointer; }
    .todos-item:hover { background: var(--bg-hover); }
    .todos-kw { flex: none; font-size: 0.72em; font-weight: 700; padding: 0 5px; border-radius: 3px; }
    .k-todo { color: var(--c-yellow); } .k-fix { color: var(--c-red); } .k-hack { color: var(--c-orange); } .k-note { color: var(--c-blue); }
    .todos-kw.k-todo { background: color-mix(in srgb, var(--c-yellow) 15%, transparent); }
    .todos-kw.k-fix { background: color-mix(in srgb, var(--c-red) 15%, transparent); }
    .todos-kw.k-hack { background: color-mix(in srgb, var(--c-orange) 15%, transparent); }
    .todos-kw.k-note { background: color-mix(in srgb, var(--c-blue) 15%, transparent); }
    .todos-note { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
    .todos-line { flex: none; color: var(--fg-subtle); font-size: 0.85em; font-variant-numeric: tabular-nums; }
  `);
}
