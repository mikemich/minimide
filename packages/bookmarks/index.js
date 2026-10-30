// Bookmarks: mark lines to come back to. They show in a narrow gutter, move with edits, are saved
// per project (by file path and line, with the line's text so they find their line again if the
// file changed outside the editor), follow renames, and are listed in a sidebar view and in the
// quick-open box ("!"). Toggle with ⌘⌥K; ⌘K ⌘N / ⌘K ⇧⌘N jump to the next / previous one, in any file.
import { editorParts } from './gutter.js';

const FLAG = '<path d="M6 3h12v18l-6-4-6 4z"/>';
const MAX_SCAN = 200000; // lines: above this, a changed file keeps its bookmarks at their line numbers

export function activate(mide) {
  const { h, icon, fileIcon, registerIcon } = mide.ui;
  const ws = mide.workspace;
  registerIcon('bookmark', FLAG);

  /** path -> [{ line, text, label? }], sorted by line. The truth for files that are not open; open editors write back to it. */
  let marks = new Map();

  const byLine = (a, b) => a.line - b.line;
  const cmpPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const plain = ({ line, text, label }) => ({ line, text, ...(label ? { label } : {}) });
  const same = (a, b) => a.length === b.length && a.every((m, i) => m.line === b[i].line && m.text === b[i].text && (m.label || '') === (b[i].label || ''));
  const rel = (path) => ws.relativePath(path) || path;

  // --- editors -----------------------------------------------------------------
  const parts = editorParts(mide, {
    onClick: (view, line) => { const item = itemOf(view); if (item) toggle(item, [line]); },
    onContextMenu: (view, line) => { const item = itemOf(view); if (item) gutterMenu(item, line); },
  });
  mide.editor.addExtension(parts.extension);

  const editors = (path) => ws.getItems().filter((i) => i.type === 'editor' && i.view && (!path || i.getPath() === path));
  const itemOf = (view) => {
    const item = editors().find((i) => i.view === view);
    if (!item?.getPath()) { mide.notify.info('Save the file to bookmark lines in it.'); return null; }
    return item;
  };

  const lineText = (doc, line) => doc.line(line).text.trim().slice(0, 200);

  /**
   * Where each saved bookmark belongs in this text: its line if that line still reads the same, else
   * the nearest line with the same text, else the line number it had (kept inside the file).
   */
  function anchor(doc, list) {
    const out = [];
    const seen = new Set();
    for (const m of list) {
      let line = Math.max(1, Math.min(m.line, doc.lines));
      if (m.text && lineText(doc, line) !== m.text && doc.lines <= MAX_SCAN) {
        for (let d = 1; d < doc.lines; d++) {
          const up = line - d;
          const down = line + d;
          if (down <= doc.lines && lineText(doc, down) === m.text) { line = down; break; }
          if (up >= 1 && lineText(doc, up) === m.text) { line = up; break; }
          if (up < 1 && down > doc.lines) break;
        }
      }
      if (seen.has(line)) continue;
      seen.add(line);
      out.push({ ...m, line, text: lineText(doc, line) });
    }
    return out.sort(byLine);
  }

  /** Brings one editor in line with the saved bookmarks of its file (re-anchoring them to its text first). */
  function push(item) {
    const path = item.getPath();
    if (!item.view) return;
    const list = path ? marks.get(path) || [] : [];
    if (list.length) {
      const anchored = anchor(item.view.state.doc, list);
      if (!same(anchored, list)) { marks.set(path, anchored); persist(); render(); }
    }
    item.view.dispatch({ effects: parts.setMarks.of(path ? marks.get(path) || [] : []) });
  }

  function setList(path, list, { redraw = true } = {}) {
    list = [...new Map(list.map((m) => [m.line, plain(m)])).values()].sort(byLine);
    if (list.length) marks.set(path, list); else marks.delete(path);
    persist();
    if (redraw) for (const item of editors(path)) push(item);
    render();
  }

  // Edits move bookmarks along with their lines (the state field maps them); keep our copy in step.
  ws.onDidUpdateEditor((item, update) => {
    const path = item.getPath?.();
    if (!update?.docChanged || !path || !item.view || !marks.has(path)) return;
    const moved = parts.read(item.view);
    if (!same(moved, marks.get(path))) setList(path, moved, { redraw: false });
  });
  ws.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => push(item), 0); });
  // The file changed on disk and is about to be reloaded: find the bookmarks again by their text afterwards.
  ws.onWillReload((doc) => {
    const path = doc.path;
    const saved = path && marks.get(path)?.map((m) => ({ ...m }));
    if (!saved?.length) return;
    setTimeout(() => {
      marks.set(path, saved);
      for (const item of editors(path)) push(item);
      persist();
      render();
    }, 0);
  });
  ws.onDidRenamePath((from, to) => {
    const moved = [...marks].filter(([path]) => path === from || path.startsWith(`${from}/`));
    if (!moved.length) return;
    for (const [path, list] of moved) { marks.delete(path); marks.set(to + path.slice(from.length), list); }
    persist();
    render();
  });

  // --- saved with the project ------------------------------------------------------
  function load() {
    const saved = mide.state.get('bookmarks') || {};
    marks = new Map(Object.entries(saved)
      .map(([path, list]) => [path, (Array.isArray(list) ? list : []).filter((m) => Number.isInteger(m?.line) && m.line >= 1)
        .map((m) => plain({ line: m.line, text: typeof m.text === 'string' ? m.text : '', label: typeof m.label === 'string' ? m.label : '' })).sort(byLine)])
      .filter(([, list]) => list.length));
    for (const item of editors()) push(item);
    render();
  }
  const persist = () => mide.state.set('bookmarks', Object.fromEntries([...marks].map(([path, list]) => [path, list.map(plain)])));
  ws.onDidChangeProject(() => load());

  // --- toggling ------------------------------------------------------------------------
  const listFor = (path) => marks.get(path) || [];
  const cursorLines = (view) => [...new Set(view.state.selection.ranges.flatMap((r) => {
    const a = view.state.doc.lineAt(r.from).number;
    let b = view.state.doc.lineAt(r.to).number;
    if (b > a && r.to === view.state.doc.line(b).from) b--; // a selection that ends at a line start doesn't include that line
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }))];
  const textOf = (item, line) => lineText(item.view.state.doc, line);

  /** Removes the bookmarks on these lines if every one has one, else puts them on the lines that lack one. */
  function toggle(item, lines, label = '') {
    const path = item.getPath();
    const list = listFor(path);
    const have = new Set(list.map((m) => m.line));
    if (lines.every((l) => have.has(l))) return setList(path, list.filter((m) => !lines.includes(m.line)));
    setList(path, [...list, ...lines.filter((l) => !have.has(l)).map((line) => ({ line, text: textOf(item, line), ...(label ? { label } : {}) }))]);
  }

  async function labelLine(item, line) {
    const path = item.getPath();
    const existing = listFor(path).find((m) => m.line === line);
    const label = await mide.ui.prompt({ title: `Label for the bookmark on line ${line} (empty: none)`, value: existing?.label || '', placeholder: 'Check this later' });
    if (label == null) return;
    const text = label.trim();
    if (existing) setList(path, listFor(path).map((m) => (m.line === line ? { ...m, label: text } : m)));
    else toggle(item, [line], text);
  }

  async function gutterMenu(item, line) {
    const has = listFor(item.getPath()).some((m) => m.line === line);
    const choice = await mide.ui.contextMenu(has
      ? [{ id: 'label', label: 'Edit Label…' }, { id: 'toggle', label: 'Remove Bookmark' }]
      : [{ id: 'toggle', label: 'Add Bookmark' }, { id: 'label', label: 'Add Bookmark with Label…' }]);
    if (choice === 'toggle') toggle(item, [line]);
    else if (choice === 'label') labelLine(item, line);
  }

  const activeEditor = () => { const e = ws.getActiveEditor(); return e?.view && e.getPath() ? e : null; };
  function withActive(fn) {
    const editor = ws.getActiveEditor();
    if (!editor?.view) return;
    const item = editor.getPath() ? editor : itemOf(editor.view);
    if (item) fn(item);
  }

  // --- moving between bookmarks ---------------------------------------------------------
  /** Every bookmark: { path, line, text, label? }, in file path order and then line order. */
  const all = () => [...marks].sort(([a], [b]) => cmpPath(a, b)).flatMap(([path, list]) => list.map((m) => ({ path, ...m })));

  async function go(path, line, { pending } = {}) {
    if (!await mide.fs.stat(path)) {
      mide.notify.warn(`${rel(path)} is gone`, 'Its bookmarks were removed.');
      setList(path, []);
      return null;
    }
    const editor = await ws.open(path, { line, col: 0, ...(pending === false ? { pending: false } : {}) });
    editor?.view?.focus();
    return editor;
  }

  function step(direction, inFile) {
    const editor = activeEditor();
    const here = editor && { path: editor.getPath(), line: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number };
    let list = all();
    if (inFile) list = here ? list.filter((m) => m.path === here.path) : [];
    if (!list.length) return mide.notify.info(inFile ? 'No bookmarks in this file.' : 'No bookmarks yet.', inFile ? undefined : 'Toggle one on a line with the gutter or the Toggle Bookmark command.');
    const after = (m) => (here ? cmpPath(m.path, here.path) || m.line - here.line : direction);
    const target = direction > 0
      ? list.find((m) => after(m) > 0) || list[0]
      : [...list].reverse().find((m) => after(m) < 0) || list[list.length - 1];
    return go(target.path, target.line, { pending: false });
  }

  // --- clearing ----------------------------------------------------------------------------
  function clearFile() {
    const path = ws.getActiveEditor()?.getPath();
    if (path && marks.has(path)) setList(path, []);
    else mide.notify.info('No bookmarks in this file.');
  }

  async function clearAll() {
    const count = all().length;
    if (!count) return mide.notify.info('No bookmarks to clear.');
    const choice = await mide.ui.confirm({
      type: 'question', message: `Remove all ${count} bookmark${count === 1 ? '' : 's'}?`, detail: 'This clears the bookmarks in every file of this project.', buttons: ['Remove', 'Cancel'],
    });
    if (choice !== 0) return;
    for (const path of [...marks.keys()]) setList(path, []);
  }

  // --- the Bookmarks view ----------------------------------------------------------------------
  const filterInput = h('input.input.bm-filter', { placeholder: 'Filter bookmarks', spellcheck: false, 'aria-label': 'Filter bookmarks' });
  const listEl = h('div.bm-list', { role: 'list' });
  const view = h('div.bm-view',
    h('div.bm-header',
      h('span.bm-title', 'Bookmarks'),
      h('span.bm-spacer'),
      h('button.icon-btn.bm-clear', { title: 'Clear All Bookmarks', 'aria-label': 'Clear all bookmarks', onclick: () => clearAll() }, icon('trash', 14))),
    h('div.bm-filter-row', filterInput),
    listEl);
  const collapsed = new Set();
  let rendering = 0;

  function emptyText() {
    const key = mide.keymap.bindingsFor('bookmarks:toggle')[0];
    return `No bookmarks yet. Click the gutter beside a line${key ? `, or press ${mide.keymap.pretty(key)},` : ''} to add one.`;
  }

  function render() {
    if (rendering) return;
    rendering = requestAnimationFrame(draw);
  }

  function draw() {
    rendering = 0;
    const q = filterInput.value.trim().toLowerCase();
    const rows = [];
    for (const [path, list] of [...marks].sort(([a], [b]) => cmpPath(rel(a), rel(b)))) {
      const name = rel(path);
      const fileMatch = !q || name.toLowerCase().includes(q);
      const shown = list.filter((m) => fileMatch || (m.label || '').toLowerCase().includes(q) || m.text.toLowerCase().includes(q));
      if (!shown.length) continue;
      const open = q ? true : !collapsed.has(path);
      const base = name.slice(name.lastIndexOf('/') + 1);
      const dir = name.slice(0, Math.max(0, name.length - base.length - 1));
      rows.push(h('div.bm-file', {
        role: 'listitem', tabIndex: 0, title: path, dataset: { path }, 'aria-expanded': String(open),
        onclick: () => { if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path); draw(); },
        onkeydown: rowKeys,
      },
      h('span.bm-twisty', { class: open ? 'open' : '' }, icon('chevron', 12)),
      fileIcon(base),
      h('span.bm-file-name', base),
      dir ? h('span.bm-file-dir', dir) : null,
      h('span.bm-count', String(list.length))));
      if (open) for (const m of shown) rows.push(row(path, m));
    }
    if (!rows.length) {
      listEl.replaceChildren(h('div.bm-empty', marks.size && q ? `No bookmarks match “${filterInput.value.trim()}”.` : emptyText()));
      return;
    }
    listEl.replaceChildren(...rows);
  }

  function row(path, m) {
    const jump = () => go(path, m.line);
    return h('div.bm-row', {
      role: 'listitem', tabIndex: 0, dataset: { path, line: String(m.line) }, title: `${rel(path)}:${m.line}`, onclick: jump, onkeydown: rowKeys,
    },
    icon('bookmark', 12),
    h('span.bm-name', m.label || m.text || '(empty line)'),
    m.label && m.text ? h('span.bm-text', m.text) : null,
    h('span.bm-line', String(m.line)),
    h('button.icon-btn.bm-remove', {
      title: 'Remove Bookmark', 'aria-label': `Remove the bookmark on line ${m.line}`,
      onclick: (e) => { e.stopPropagation(); setList(path, listFor(path).filter((x) => x.line !== m.line)); },
    }, icon('close', 12)));
  }

  function rowKeys(e) {
    const rowEl = e.currentTarget;
    const items = [...listEl.querySelectorAll('.bm-file, .bm-row')];
    const i = items.indexOf(rowEl);
    if (e.key === 'ArrowDown') items[i + 1]?.focus();
    else if (e.key === 'ArrowUp') (i > 0 ? items[i - 1] : filterInput).focus();
    else if (e.key === 'Enter' || e.key === ' ') rowEl.click();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && rowEl.classList.contains('bm-row')) {
      const path = rowEl.dataset.path;
      setList(path, listFor(path).filter((x) => x.line !== Number(rowEl.dataset.line)));
      (items[i + 1] || items[i - 1] || filterInput).focus();
    } else return;
    e.preventDefault();
  }

  filterInput.addEventListener('input', () => draw());
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); listEl.querySelector('.bm-file, .bm-row')?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); listEl.querySelector('.bm-row')?.click(); }
    else if (e.key === 'Escape' && filterInput.value) { e.preventDefault(); e.stopPropagation(); filterInput.value = ''; draw(); }
  });
  mide.subscriptions.add({ dispose: () => cancelAnimationFrame(rendering) });

  mide.sidebar.addView({ id: 'bookmarks', title: 'Bookmarks', icon: 'bookmark', order: 25, command: 'bookmarks:show', element: view, focus: () => filterInput.focus(), onShow: () => draw() });

  // --- Go to Bookmark… ("!" in the quick-open box) -------------------------------------------------
  mide.ui.addQuickOpenMode({
    prefix: '!', title: 'Bookmarks', short: 'bookmarks', description: 'Jump to a bookmark', order: 35,
    placeholder: 'Jump to a bookmark',
    filterKey: (it) => `${it.label} ${it.detail}`,
    items: () => all().map((m) => ({ label: m.label || m.text || '(empty line)', detail: `${rel(m.path)}:${m.line}${m.label && m.text ? `  ${m.text}` : ''}`, bookmark: m })),
    onSelect: (item) => { if (item.bookmark) go(item.bookmark.path, item.bookmark.line); },
  });

  // --- commands ---------------------------------------------------------------------------------------
  const hasAny = () => marks.size > 0;
  mide.commands.add({
    'bookmarks:toggle': { title: 'Toggle Bookmark', when: () => !!ws.getActiveEditor()?.view, run: () => withActive((item) => toggle(item, cursorLines(item.view))) },
    'bookmarks:toggle-with-label': {
      title: 'Toggle Bookmark with Label…', when: () => !!ws.getActiveEditor()?.view,
      run: () => withActive((item) => labelLine(item, item.view.state.doc.lineAt(item.view.state.selection.main.head).number)),
    },
    'bookmarks:next': { title: 'Next Bookmark', run: () => step(1, false) },
    'bookmarks:previous': { title: 'Previous Bookmark', run: () => step(-1, false) },
    'bookmarks:next-in-file': { title: 'Next Bookmark in File', when: () => !!activeEditor(), run: () => step(1, true) },
    'bookmarks:previous-in-file': { title: 'Previous Bookmark in File', when: () => !!activeEditor(), run: () => step(-1, true) },
    'bookmarks:go-to': { title: 'Go to Bookmark…', run: () => mide.ui.quickOpen('!') },
    'bookmarks:clear-file': { title: 'Clear Bookmarks in File', when: () => !!ws.getActiveEditor()?.getPath(), run: clearFile },
    'bookmarks:clear-all': { title: 'Clear All Bookmarks', when: hasAny, run: clearAll },
    'bookmarks:show': { title: 'Show Bookmarks', run: () => mide.sidebar.show('bookmarks', { focus: true }) },
  });

  load();
}
