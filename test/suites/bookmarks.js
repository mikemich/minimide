// Bookmarks over the `bmproj` fixture: toggling from the command, the key and the gutter, markers on
// the right lines (left of the line numbers and of the debugger's gutter), a label, bookmarks that move
// with edits and are dropped with their line, next / previous in a file and across files, the sidebar
// view (list, jump, remove, filter), Go to Bookmark, clearing, bookmarks that find their line again
// after a change on disk, and following renames. It ends by saving the session for bookmarksRestore.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const root = await until(() => ws.project);
  const results = {};
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };

  // --- helpers ---------------------------------------------------------------------
  const file = (n) => `${root}/${n}`;
  const run = (cmd) => app.commands.run(cmd);
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } };
  const lineOfBlock = (view, el) => {
    const r = el.getBoundingClientRect();
    return view.state.doc.lineAt(view.lineBlockAtHeight(r.top + r.height / 2 - view.documentTop).from).number;
  };
  const markerLines = (item) => [...item.view.dom.querySelectorAll('.cm-bookmark-gutter .bm-marker.bm')].map((el) => lineOfBlock(item.view, el));
  const tintedLines = (item) => [...item.view.dom.querySelectorAll('.cm-bookmark-line')].map((el) => item.view.state.doc.lineAt(item.view.posAtDOM(el)).number);
  const markerTitle = (item, line) => {
    const el = [...item.view.dom.querySelectorAll('.cm-bookmark-gutter .bm-marker.bm')].find((m) => lineOfBlock(item.view, m) === line);
    return el?.title ?? null;
  };
  const clickGutter = (item, line) => {
    const view = item.view;
    const gutter = view.dom.querySelector('.cm-bookmark-gutter');
    const g = gutter.getBoundingClientRect();
    const block = view.lineBlockAt(view.state.doc.line(line).from);
    const y = view.documentTop + block.top + block.height / 2;
    const target = document.elementFromPoint(g.left + g.width / 2, y) || gutter;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: g.left + g.width / 2, clientY: y }));
  };
  const stored = () => app.packageState('bookmarks').bookmarks || {};
  const storedLines = (p) => (stored()[p] || []).map((m) => m.line);
  const open = async (name, line) => { const ed = await ws.open(file(name)); await wait(150); if (line) ed.goToLine(line); return ed; };
  const cursorLine = (ed) => ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  const active = () => { const e = ws.getActiveEditor(); return e ? `${e.getPath().slice(root.length + 1)}:${cursorLine(e)}` : null; };
  const lineStart = (ed, n) => ed.view.state.doc.line(n).from;
  const box = () => document.querySelector('.select-list .select-input');
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const view = () => document.querySelector('.bm-view');
  const rows = () => [...document.querySelectorAll('.bm-view .bm-row')].map((r) => `${r.querySelector('.bm-name').textContent}@${r.querySelector('.bm-line').textContent}`);
  const files = () => [...document.querySelectorAll('.bm-view .bm-file')].map((f) => `${f.querySelector('.bm-file-name').textContent}:${f.querySelector('.bm-count').textContent}`);
  const tree = () => [...document.querySelectorAll('.bm-view .bm-file, .bm-view .bm-row')].map((r) => (r.classList.contains('bm-file') ? r.querySelector('.bm-file-name').textContent : `  ${r.querySelector('.bm-name').textContent}@${r.querySelector('.bm-line').textContent}`));
  const sorted = (l) => [...l].sort((a, b) => a - b);

  await closeAll();
  const out = {};

  // --- toggling ------------------------------------------------------------------------
  await step('toggle', async () => {
    const a = await open('a.txt', 3);
    const r = {};
    r.gutter = !!a.view.dom.querySelector('.cm-bookmark-gutter');
    r.empty = markerLines(a);
    await run('bookmarks:toggle');
    await until(() => markerLines(a).length === 1);
    r.command = markerLines(a);
    r.tinted = tintedLines(a);
    r.saved = storedLines(file('a.txt'));
    r.savedText = stored()[file('a.txt')]?.[0]?.text;
    await run('bookmarks:toggle');
    await until(() => markerLines(a).length === 0);
    r.commandOff = markerLines(a);
    r.savedOff = storedLines(file('a.txt'));
    // The key: ⌘⌥K (Ctrl+Alt+K elsewhere).
    a.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', altKey: true, ...MOD, bubbles: true, cancelable: true }));
    await until(() => markerLines(a).length === 1);
    r.key = markerLines(a);
    // The gutter.
    clickGutter(a, 6);
    await until(() => markerLines(a).length === 2);
    r.gutterOn = markerLines(a);
    clickGutter(a, 6);
    await until(() => markerLines(a).length === 1);
    r.gutterOff = markerLines(a);
    clickGutter(a, 6);
    await until(() => markerLines(a).length === 2);
    r.both = markerLines(a);
    // Several lines at once: all get one, and toggling again takes them all away.
    a.view.dispatch({ selection: { anchor: lineStart(a, 8), head: a.view.state.doc.line(9).to } });
    await run('bookmarks:toggle');
    await until(() => markerLines(a).length === 4);
    r.multi = markerLines(a);
    await run('bookmarks:toggle');
    await until(() => markerLines(a).length === 2);
    r.multiOff = markerLines(a);
    a.goToLine(3);
    r.titleDefault = markerTitle(a, 3);
    // Left of the line numbers, and right of the debugger's gutter.
    const x = (sel) => a.view.dom.querySelector(sel)?.getBoundingClientRect().left;
    r.order = x('.cm-bookmark-gutter') > x('.cm-debug-gutter') && x('.cm-bookmark-gutter') < x('.cm-lineNumbers');
    return r;
  });
  out.toggle = results.toggle;

  // --- a label -------------------------------------------------------------------------------
  await step('label', async () => {
    const a = ws.getActiveEditor();
    a.goToLine(10);
    const done = run('bookmarks:toggle-with-label');
    const input = await until(() => document.querySelector('.prompt input.select-input'));
    const title = document.querySelector('.prompt-message')?.textContent;
    typeInto(input, 'Check me');
    enter(input);
    await done;
    await until(() => markerLines(a).includes(10));
    return { markers: markerLines(a), title, markerTitle: markerTitle(a, 10), saved: stored()[file('a.txt')].find((m) => m.line === 10)?.label };
  });
  out.label = results.label;

  // --- bookmarks move with edits ------------------------------------------------------------------
  await step('edits', async () => {
    const a = ws.getActiveEditor();
    const r = { start: markerLines(a) }; // 3, 6, 10
    a.view.dispatch({ changes: { from: 0, insert: '// new first line\n' } });
    await wait(50);
    r.afterInsert = markerLines(a);
    r.savedAfterInsert = storedLines(file('a.txt'));
    r.titleStillThere = markerTitle(a, 11);
    // Typing inside a bookmarked line keeps it, and its saved text follows.
    a.view.dispatch({ changes: { from: a.view.state.doc.line(4).to, insert: ' (edited)' } });
    await wait(50);
    r.afterTyping = markerLines(a);
    r.savedText = stored()[file('a.txt')].find((m) => m.line === 4)?.text;
    // Enter at the start of a bookmarked line pushes the line, and its bookmark, down.
    a.view.dispatch({ changes: { from: lineStart(a, 7), insert: '\n' }, selection: { anchor: lineStart(a, 7) + 1 } });
    await wait(50);
    r.afterEnter = markerLines(a);
    a.view.dispatch({ changes: { from: lineStart(a, 7), to: lineStart(a, 8) } }); // take that blank line out again
    await wait(50);
    // Deleting the bookmarked line takes its bookmark with it.
    a.view.dispatch({ changes: { from: lineStart(a, 4), to: lineStart(a, 5) } });
    await wait(50);
    r.afterDelete = markerLines(a);
    r.savedAfterDelete = storedLines(file('a.txt'));
    // Move Line Down carries the bookmark along.
    a.goToLine(6);
    await run('editor:move-line-down');
    await wait(50);
    r.afterMove = markerLines(a);
    a.goToLine(7);
    await run('editor:move-line-up');
    await wait(50);
    r.afterMoveBack = markerLines(a);
    // The last line of a file.
    const last = a.view.state.doc.lines;
    clickGutter(a, last);
    await until(() => markerLines(a).includes(last));
    r.lastMarked = markerLines(a).includes(last);
    a.view.dispatch({ changes: { from: a.view.state.doc.line(last).from - 1, to: a.view.state.doc.length } });
    await wait(50);
    r.afterLastDeleted = markerLines(a);
    r.final = sorted(storedLines(file('a.txt')));
    return r;
  });
  out.edits = results.edits;

  // --- more files, then next / previous ------------------------------------------------------------------
  await step('moreFiles', async () => {
    const b = await open('b.txt');
    clickGutter(b, 2); clickGutter(b, 7);
    const c = await open('c.txt');
    clickGutter(c, 4);
    await until(() => storedLines(file('c.txt')).length === 1);
    return { b: storedLines(file('b.txt')), c: storedLines(file('c.txt')), a: storedLines(file('a.txt')) };
  });
  out.moreFiles = results.moreFiles;

  await step('nextPrevInFile', async () => {
    const a = await open('a.txt', 1);
    const marks = storedLines(file('a.txt')); // 5 and 9
    const seen = [];
    const hop = async (cmd, from) => { await run(cmd); await until(() => cursorLine(a) !== from); return cursorLine(a); };
    let at = 1;
    for (let i = 0; i < 3; i++) { at = await hop('bookmarks:next-in-file', at); seen.push(at); }
    const prev = [];
    for (let i = 0; i < 3; i++) { at = await hop('bookmarks:previous-in-file', at); prev.push(at); }
    return { marks, next: seen, previous: prev, stayedInFile: active().startsWith('a.txt') };
  });
  out.nextPrevInFile = results.nextPrevInFile;

  await step('nextPrevAcrossFiles', async () => {
    const a = await open('a.txt', 1);
    const trail = [];
    for (let i = 0; i < 6; i++) { await run('bookmarks:next'); await wait(150); trail.push(active()); }
    const back = [];
    for (let i = 0; i < 6; i++) { await run('bookmarks:previous'); await wait(150); back.push(active()); }
    return { next: trail, previous: back };
  });
  out.nextPrevAcrossFiles = results.nextPrevAcrossFiles;

  // --- the sidebar view ----------------------------------------------------------------------------------------
  await step('sidebar', async () => {
    await run('bookmarks:show');
    await until(() => view() && files().length === 3);
    const r = { shown: app.sidebar.activeId, tree: tree() };
    // Jump.
    const target = [...document.querySelectorAll('.bm-view .bm-row')].find((x) => x.dataset.path === file('b.txt') && x.dataset.line === '7');
    target.click();
    await until(() => active() === 'b.txt:7');
    r.jumped = active();
    r.jumpedTitle = target.title;
    // Filter by text, by file and by label.
    const filter = document.querySelector('.bm-filter');
    typeInto(filter, 'charlie');
    await until(() => files().length === 1);
    r.filterFile = tree();
    typeInto(filter, 'check me');
    await until(() => rows().length === 1 && files().length === 1);
    r.filterLabel = tree();
    typeInto(filter, 'line 7');
    await until(() => rows().length === 1);
    r.filterText = tree();
    typeInto(filter, 'nothing-like-this');
    await until(() => document.querySelector('.bm-empty'));
    r.filterNone = document.querySelector('.bm-empty')?.textContent;
    typeInto(filter, '');
    await until(() => files().length === 3);
    // Collapse a file by clicking it.
    document.querySelector('.bm-file[data-path$="/b.txt"]').click();
    await until(() => !rows().some((x) => x.endsWith('@2')));
    r.collapsed = tree();
    document.querySelector('.bm-file[data-path$="/b.txt"]').click();
    await until(() => rows().length === 5);
    // Remove from the list: the editor's marker goes too.
    const b = ws.allItems().find((i) => i.getPath() === file('b.txt'));
    const before = markerLines(b);
    document.querySelector('.bm-row[data-path$="/b.txt"][data-line="2"] .bm-remove').click();
    await until(() => rows().length === 4);
    r.removed = { tree: tree(), markersBefore: before, markersAfter: markerLines(b), saved: storedLines(file('b.txt')) };
    return r;
  });
  out.sidebar = results.sidebar;

  // --- Go to Bookmark… ------------------------------------------------------------------------------------------------
  await step('goTo', async () => {
    await open('a.txt', 1);
    await run('bookmarks:go-to');
    const input = await until(box);
    await until(() => document.querySelector('.select-item .select-label'));
    const r = { prefix: input.value, badge: document.querySelector('.select-mode')?.textContent };
    r.items = [...document.querySelectorAll('.select-item')].map((i) => `${i.querySelector('.select-label').textContent} | ${i.querySelector('.select-detail')?.textContent}`);
    typeInto(input, '!charlie');
    await until(() => document.querySelectorAll('.select-item').length === 1);
    r.filtered = [...document.querySelectorAll('.select-item .select-label')].map((l) => l.textContent);
    enter(input);
    await until(() => active() === 'c.txt:4');
    r.picked = active();
    // The same list from the ⌘P box with the "!" prefix.
    await wait(300);
    app.quickOpen.open('!');
    await until(() => document.querySelector('.select-item'));
    r.viaPrefix = document.querySelectorAll('.select-item').length;
    app.ui.closeModal();
    return r;
  });
  out.goTo = results.goTo;

  // --- clearing ---------------------------------------------------------------------------------------------------------------
  await step('clear', async () => {
    const a = await open('a.txt', 1);
    const r = { before: storedLines(file('a.txt')) };
    await run('bookmarks:clear-file');
    await until(() => markerLines(a).length === 0);
    r.afterFile = { markers: markerLines(a), saved: storedLines(file('a.txt')), others: storedLines(file('c.txt')) };
    // Cancel keeps them, Remove clears every file.
    await T.answers('confirm', 1);
    await run('bookmarks:clear-all');
    r.cancelled = Object.keys(stored()).length;
    await T.answers('confirm', 0);
    await run('bookmarks:clear-all');
    await until(() => Object.keys(stored()).length === 0);
    r.afterAll = Object.keys(stored());
    await until(() => document.querySelector('.bm-empty'));
    r.emptyMessage = document.querySelector('.bm-empty')?.textContent;
    return r;
  });
  out.clear = results.clear;

  // --- the menus --------------------------------------------------------------------------------------------------
  await step('menus', async () => {
    const a = await open('a.txt', 1);
    const shape = (items) => items.map((i) => (i.type === 'separator' ? '|' : i.role || i.label)).join(',');
    const rightClick = async (target, line, x) => {
      const coords = a.view.coordsAtPos(a.view.state.doc.line(line).from + 2);
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x ?? coords.left + 1, clientY: (coords.top + coords.bottom) / 2 }));
      await wait(250);
    };
    const r = {};
    // The editor's right-click menu: Toggle Bookmark acts on the clicked line.
    await T.answers('menu', 'bookmarks:toggle');
    await rightClick(a.view.contentDOM, 2);
    r.editorMenu = (await T.menus()).shown[0]?.filter((i) => i.label === 'Toggle Bookmark').map((i) => i.label);
    await until(() => markerLines(a).includes(2));
    r.byMenu = markerLines(a);
    // The gutter's: Edit Label / Remove Bookmark when there is one, Add Bookmark when there is not.
    const rightClickGutter = async (line) => {
      const gutter = a.view.dom.querySelector('.cm-bookmark-gutter');
      const g = gutter.getBoundingClientRect();
      const block = a.view.lineBlockAt(a.view.state.doc.line(line).from);
      const y = a.view.documentTop + block.top + block.height / 2;
      const target = document.elementFromPoint(g.left + g.width / 2, y) || gutter;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: g.left + g.width / 2, clientY: y }));
      await wait(250);
    };
    await T.answers('menu', null, null);
    await rightClickGutter(2);
    r.gutterMenuOn = shape((await T.menus()).shown[0] || []);
    await rightClickGutter(5);
    r.gutterMenuOff = shape((await T.menus()).shown[0] || []);
    clickGutter(a, 2);
    await until(() => !markerLines(a).includes(2));
    r.afterRemove = markerLines(a);
    return r;
  });
  out.menus = results.menus;

  // --- finding the line again after a change on disk ---------------------------------------------------------------------
  await step('reanchor', async () => {
    const c = await open('c.txt');
    clickGutter(c, 4); // "charlie line 4"
    await until(() => storedLines(file('c.txt')).length === 1);
    const r = { before: markerLines(c) };
    // A clean open file reloads from disk; two lines went in above the bookmarked one, one more below.
    await native.fs.write(file('c.txt'), 'new one\nnew two\ncharlie line 1\ncharlie line 2\ncharlie line 3\ncharlie line 4\ncharlie line 5\nextra\ncharlie line 6\n');
    await until(() => c.view.state.doc.line(1).text === 'new one');
    await wait(300);
    r.afterReload = markerLines(c);
    r.saved = storedLines(file('c.txt'));
    r.text = c.view.state.doc.line(markerLines(c)[0] || 1).text;
    return r;
  });
  out.reanchor = results.reanchor;

  // --- the state for the restart ----------------------------------------------------------------------------------------------------
  await step('prepare', async () => {
    const r = {};
    await closeAll();
    await T.answers('confirm', 0);
    await run('bookmarks:clear-all');
    await until(() => Object.keys(stored()).length === 0);
    // A closed file that changes on disk before the next start: two lines go in above its bookmark.
    const ext = await open('ext.txt');
    clickGutter(ext, 5); // "ext line 5"
    await until(() => storedLines(file('ext.txt')).length === 1);
    await ws.closeItem(ext);
    await native.fs.write(file('ext.txt'), 'x1\nx2\n' + (await native.fs.read(file('ext.txt'))));
    // Open files keep their bookmarks and label.
    const a = await open('a.txt', 4);
    const done = run('bookmarks:toggle-with-label');
    const input = await until(() => document.querySelector('.prompt input.select-input'));
    typeInto(input, 'Persist me'); enter(input);
    await done;
    const b = await open('b.txt');
    clickGutter(b, 6);
    await until(() => storedLines(file('b.txt')).length === 1);
    // Renames: a file and a folder.
    const m = await open('moved.txt');
    clickGutter(m, 2);
    await until(() => storedLines(file('moved.txt')).length === 1);
    await ws.closeItem(m);
    await native.fs.rename(file('moved.txt'), file('moved2.txt'));
    ws.renamePath(file('moved.txt'), file('moved2.txt'));
    const inner = await open('sub/inner.txt');
    clickGutter(inner, 3);
    await until(() => storedLines(file('sub/inner.txt')).length === 1);
    await ws.closeItem(inner);
    await native.fs.rename(file('sub'), file('sub2'));
    ws.renamePath(file('sub'), file('sub2'));
    await until(() => storedLines(file('sub2/inner.txt')).length === 1);
    r.keys = Object.keys(stored()).map((p) => p.slice(root.length + 1)).sort();
    r.oldKeysGone = !stored()[file('moved.txt')] && !stored()[file('sub/inner.txt')];
    // A renamed file that is open: the editor keeps its marker, the list its entry.
    const open2 = await open('moved2.txt');
    await wait(150);
    r.openRenamedMarkers = markerLines(open2);
    await ws.closeItem(open2);
    await ws.open(file('a.txt'));
    await ws.open(file('b.txt'));
    await run('bookmarks:show');
    await until(() => files().length === 5);
    r.tree = tree();
    app.saveSession(); await app.persistState();
    return r;
  });
  out.prepare = results.prepare;

  out.errors = errors.slice();
  out.totalErrors = errors.length;
  return out;
})()
