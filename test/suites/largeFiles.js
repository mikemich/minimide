// Large files over the `lfproj` fixture: big.js (50 MB, over editor.largeFileSize) and min.js (one 600 KB
// line) open with their heavy features off while normal.js keeps every one; editing and saving round-trip
// byte for byte; "Turn features on anyway" brings them back; huge.log (600 MB) is refused.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const results = {};
  const root = await until(() => ws.project);
  const home = app.userInfo.dir;
  const T = window.mideTest;
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };
  const symbols = app.packages.services.get('symbols');
  const dataUrl = (f) => window.native.fs.readDataUrl(`${root}/${f}`);
  const notifications = () => [...document.querySelectorAll('#notifications .notification')];
  const statusItem = () => document.querySelector('#statusbar .status-item[data-id="large-file"]');
  // The fake language server's log: which files each server process has opened.
  const opened = async (file) => {
    const text = await window.native.fs.read(`${home}/fake-lsp.json.events`).catch(() => '');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'open' && e.file === file).length;
  };
  const historyCount = async () => {
    const walk = async (dir) => { let n = 0; for (const e of await window.native.fs.readdir(dir).catch(() => [])) n += e.isDir ? await walk(e.path) : 1; return n; };
    return walk(`${home}/history`);
  };
  // The count once earlier saves have finished writing (on a slow machine they still are).
  const settledHistory = async () => {
    let last = await historyCount();
    for (let i = 0; i < 20; i++) { await wait(250); const n = await historyCount(); if (n === last) return n; last = n; }
    return last;
  };
  const open = async (f) => {
    const t0 = performance.now();
    const ed = await ws.open(`${root}/${f}`);
    const openMs = Math.round(performance.now() - t0);
    await frames();
    return { ed, openMs };
  };
  // Word completions offered after typing `prefix` on a new last line (undone afterwards).
  const wordCompletions = async (ed, prefix) => {
    const v = ed.view;
    v.focus();
    const end = v.state.doc.length;
    v.dispatch({ changes: { from: end, insert: '\n' + prefix }, selection: { anchor: end + 1 + prefix.length }, userEvent: 'input.type' });
    const words = () => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].filter((li) => li.querySelector('.cm-completionDetail')?.textContent === 'word').length;
    const n = (await until(words, 1500)) || 0;
    v.dispatch({ changes: { from: end, to: v.state.doc.length } });
    app.ui.closeModal?.();
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(100);
    return n;
  };
  // What is on in an editor: gutter markers and hints at the top, the rest scrolled into the middle of a
  // function at `line`, with the cursor after its first bracket; `prefix` starts a word in the file.
  const probe = async (ed, line, prefix = 'ite') => {
    const v = ed.view;
    ws.activePane.activate(ed);
    const count = (sel) => v.dom.querySelectorAll(sel).length;
    const top = { gitMarkers: count('.git-marker') > 0, inlayHints: count('.cm-inlay-hint') > 0 };
    const { from, text } = v.state.doc.line(line);
    v.dispatch({ selection: { anchor: from + text.search(/[([]/) + 1 } });
    v.scrollDOM.scrollTop = v.lineBlockAt(from).top + 3 * v.defaultLineHeight; // the function's first line just above the top
    await frames(); await wait(700); await frames();
    const syms = await symbols.getSymbols(ed);
    return {
      ...top,
      large: ed.isLarge(),
      status: !!statusItem(),
      highlighting: count('.cm-content [class*="tok-"]') > 0,
      bracketMatch: count('.cm-matchingBracket') > 0,
      bracketColors: count('[class*="cm-bracket-d"]') > 0,
      minimap: count('.cm-minimap-gutter') > 0,
      guides: count('.cm-indent-markers') > 0,
      colors: count('.cm-color-swatch') > 0,
      todos: count('.cm-todo') > 0,
      sticky: !!v.dom.querySelector('.cm-sticky:not([hidden]) .cm-sticky-line'),
      symbols: (syms?.symbols.length || 0) > 0,
      wrap: v.contentDOM.classList.contains('cm-lineWrapping'),
      words: (await wordCompletions(ed, prefix)) > 0,
    };
  };

  await step('normal', async () => {
    const { ed } = await open('normal.js');
    await until(() => opened('normal.js'), 4000);
    const ready = !!(await until(() => ed.view.dom.querySelector('.git-marker') && ed.view.dom.querySelector('.cm-inlay-hint'), 6000));
    const p = await probe(ed, 4 * 5 + 2);
    p.ready = ready;
    p.lsp = await opened('normal.js');
    // A save keeps a version in local history.
    const before = await historyCount();
    ed.view.dispatch({ changes: { from: 0, insert: '//\n' } });
    await ws.save(ed);
    p.history = (await until(async () => (await historyCount()) > before, 3000)) ? 'kept' : 'none';
    return p;
  });

  await step('big', async () => {
    const before = notifications().length;
    const { ed, openMs } = await open('big.js');
    const notice = notifications().slice(before).map((n) => n.querySelector('.notification-title')?.textContent);
    await wait(1500); // the language server, git and symbols would have had their chance
    const p = await probe(ed, Math.floor(ed.view.state.doc.lines / 2) - (Math.floor(ed.view.state.doc.lines / 2) % 5) + 1);
    p.lsp = await opened('big.js');
    p.notice = notice;
    p.openMs = openMs;
    p.lines = ed.view.state.doc.lines;
    return p;
  });

  await step('bigEdit', async () => {
    const ed = ws.getActiveEditor();
    const v = ed.view;
    const original = await window.native.fs.read(`${root}/big.js`);
    const mid = v.state.doc.line(Math.floor(v.state.doc.lines / 2)).from;
    const historyBefore = await settledHistory();
    // Type ten characters in the middle, a frame each, then save.
    v.focus();
    v.dispatch({ selection: { anchor: mid } });
    let t0 = performance.now();
    for (const ch of 'EDITED123 ') { const at = v.state.selection.main.head; v.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: 'input.type' }); await frames(); }
    const typeFrameMs = Math.round((performance.now() - t0) / 10);
    t0 = performance.now();
    await ws.save(ed);
    const saveMs = Math.round(performance.now() - t0);
    const afterEdit = await window.native.fs.read(`${root}/big.js`);
    const edited = afterEdit === original.slice(0, mid) + 'EDITED123 ' + original.slice(mid);
    const dirtyAfterSave = ed.isDirty();
    // Take the edit out and save again: the file is exactly what it was.
    v.dispatch({ changes: { from: mid, to: mid + 10 }, userEvent: 'delete' });
    const dirtyAfterDelete = ed.isDirty(); // differs from the last save
    await ws.save(ed);
    const back = await window.native.fs.read(`${root}/big.js`);
    await wait(300);
    return { edited, restored: back === original, dirtyAfterSave, dirtyAfterDelete, dirtyAtEnd: ed.isDirty(), history: (await settledHistory()) === historyBefore ? 'none' : 'kept', typeFrameMs, saveMs };
  });

  await step('min', async () => {
    const { ed, openMs } = await open('min.js');
    const p = await probe(ed, 1, 'va');
    p.lsp = await opened('min.js');
    p.openMs = openMs;
    // Edit the second line, save, then undo and save: the bytes (BOM, CRLF) are the same as before.
    const original = await dataUrl('min.js');
    const v = ed.view;
    const second = v.state.doc.line(2).from;
    v.dispatch({ changes: { from: second, insert: 'X' } });
    await ws.save(ed);
    const edited = await dataUrl('min.js');
    v.dispatch({ changes: { from: second, to: second + 1 } });
    await ws.save(ed);
    const bytes = atob((await dataUrl('min.js')).split(',')[1]);
    p.roundTrip = { changed: edited !== original, same: (await dataUrl('min.js')) === original, bom: bytes.slice(0, 3) === '\xef\xbb\xbf', crlf: bytes.endsWith('second line\r\n'), dirty: ed.isDirty() };
    return p;
  });

  await step('turnOn', async () => {
    const ed = ws.getActiveEditor();
    statusItem()?.click();
    const button = await until(() => [...document.querySelectorAll('#notifications .notification button')].filter((b) => b.textContent === 'Turn features on anyway').pop());
    button?.click();
    await until(() => !ed.isLarge());
    await until(() => ed.view.contentDOM.querySelector('[class*="tok-"]'), 4000);
    await until(() => opened('min.js'), 4000);
    const p = await probe(ed, 1, 'va');
    p.button = !!button;
    p.lsp = await opened('min.js');
    return p;
  });

  await step('tooLarge', async () => {
    const before = notifications().length;
    const t0 = performance.now();
    const item = await ws.open(`${root}/huge.log`);
    const ms = Math.round(performance.now() - t0);
    const notice = notifications().slice(before).map((n) => `${n.querySelector('.notification-title')?.textContent} / ${n.querySelector('.notification-detail')?.textContent}`);
    return { type: item?.type, message: item?.getElement().querySelector('p')?.textContent, notice, fast: ms < 1000, documents: [...ws.documents.keys()].some((p) => p.endsWith('huge.log')) };
  });

  await step('setting', async () => {
    for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); }
    await app.config.set('editor.largeFileSize', 0);
    const { ed } = await open('min.js');
    const off = { large: ed.isLarge(), status: !!statusItem() };
    await ws.closeItem(ed);
    await app.config.set('editor.largeFileSize', 10);
    const again = await open('min.js');
    return { off, on: again.ed.isLarge() };
  });

  for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); }
  results.totalErrors = errors.length;
  results.errors = errors;
  return results;
})()
