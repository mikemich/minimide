// Bookmarks after a restart (bookmarks ran first with the same home): they come back with the
// session, on the files they were set in, with their labels; a file that changed on disk while it was
// closed gets them back on the same text; renamed files and folders kept them; the view lists them.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
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

  const file = (n) => `${root}/${n}`;
  const run = (cmd) => app.commands.run(cmd);
  const lineOfBlock = (view, el) => {
    const r = el.getBoundingClientRect();
    return view.state.doc.lineAt(view.lineBlockAtHeight(r.top + r.height / 2 - view.documentTop).from).number;
  };
  const markerLines = (item) => [...item.view.dom.querySelectorAll('.cm-bookmark-gutter .bm-marker.bm')].map((el) => lineOfBlock(item.view, el));
  const markerTitle = (item, line) => [...item.view.dom.querySelectorAll('.cm-bookmark-gutter .bm-marker.bm')].find((m) => lineOfBlock(item.view, m) === line)?.title ?? null;
  const stored = () => app.packageState('bookmarks').bookmarks || {};
  const storedLines = (p) => (stored()[p] || []).map((m) => m.line);
  const cursorLine = (ed) => ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  const active = () => { const e = ws.getActiveEditor(); return e ? `${e.getPath().slice(root.length + 1)}:${cursorLine(e)}` : null; };
  const tree = () => [...document.querySelectorAll('.bm-view .bm-file, .bm-view .bm-row')].map((r) => (r.classList.contains('bm-file') ? r.querySelector('.bm-file-name').textContent : `  ${r.querySelector('.bm-name').textContent}@${r.querySelector('.bm-line').textContent}`));
  const out = {};

  await step('restored', async () => {
    await until(() => ws.allItems().length >= 2 && ws.allItems().every((i) => i.view), 15000);
    await wait(500);
    const r = { tabs: ws.allItems().map((i) => i.getTitle()).sort() };
    r.keys = Object.keys(stored()).map((p) => p.slice(root.length + 1)).sort();
    r.lines = Object.fromEntries(Object.entries(stored()).sort(([x], [y]) => (x < y ? -1 : 1)).map(([p, l]) => [p.slice(root.length + 1), l.map((m) => m.line)]));
    r.label = stored()[file('a.txt')]?.[0]?.label;
    const tab = (n) => until(() => ws.allItems().find((i) => i.getPath() === file(n) && i.view && markerLines(i).length === 1));
    const a = await tab('a.txt');
    await ws.open(file('a.txt')); // bring it to the front: hidden editors have no layout to measure
    await wait(300);
    r.aMarkers = a && markerLines(a);
    r.aTitle = a && markerTitle(a, 4);
    const b = await tab('b.txt');
    await ws.open(file('b.txt'));
    await wait(300);
    r.bMarkers = b && markerLines(b);
    return r;
  });
  out.restored = results.restored;

  await step('view', async () => {
    await run('bookmarks:show');
    await until(() => document.querySelectorAll('.bm-view .bm-file').length === 5);
    return { tree: tree() };
  });
  out.view = results.view;

  // ext.txt gained two lines at the top while it was closed: the bookmark is on the same text again.
  await step('changedOnDisk', async () => {
    const ed = await ws.open(file('ext.txt'));
    await until(() => ed.view && markerLines(ed).length === 1);
    const line = markerLines(ed)[0];
    return { savedBefore: 5, marker: markerLines(ed), text: ed.view.state.doc.line(line).text, saved: storedLines(file('ext.txt')) };
  });
  out.changedOnDisk = results.changedOnDisk;

  await step('renamed', async () => {
    const m = await ws.open(file('moved2.txt'));
    await until(() => markerLines(m).length === 1);
    await wait(300);
    const file1 = markerLines(m);
    const inner = await ws.open(file('sub2/inner.txt'));
    await until(() => markerLines(inner).length === 1);
    await wait(300);
    return { file: file1, folder: markerLines(inner), oldKeys: Object.keys(stored()).filter((p) => /moved\.txt|\/sub\//.test(p)) };
  });
  out.renamed = results.renamed;

  await step('navigate', async () => {
    const a = await ws.open(file('a.txt'));
    a.goToLine(1);
    const trail = [];
    for (let i = 0; i < 6; i++) { await run('bookmarks:next'); await wait(150); trail.push(active()); }
    return { trail };
  });
  out.navigate = results.navigate;

  out.errors = errors.slice();
  out.totalErrors = errors.length;
  return out;
})()
