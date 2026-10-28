// Emmet abbreviations (Tab in HTML and CSS; plain Tab and snippets untouched elsewhere), and the
// Markdown preview scrolling with the editor, over the `emproj` fixture.
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
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { out[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
  };

  const tab = (view) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  /** Replace line `n` (1-based) with `text`, put the cursor at its end and press Tab. */
  const typeAndTab = async (ed, n, text) => {
    const v = ed.view, line = v.state.doc.line(n);
    v.dispatch({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + text.length } });
    v.focus();
    tab(v);
    await wait(150);
    return v.state.doc.toString();
  };

  // --- Emmet in HTML ---------------------------------------------------------------
  await step('html', async () => {
    const ed = await ws.open(root + '/page.html');
    await until(() => app.packages.services.get('emmet')); // loaded after the first HTML file opens
    const v = ed.view;
    const r = {};
    r.loaded = !!app.packages.services.get('emmet');

    let doc = await typeAndTab(ed, 4, 'ul>li*2');
    r.expanded = doc.split('\n').slice(3, -3).join('\n'); // the lines the abbreviation became
    r.cursorInFirstLi = /<li>$/.test(v.state.sliceDoc(0, v.state.selection.main.head).split('\n').pop()) && v.state.sliceDoc(v.state.selection.main.head).startsWith('</li>');
    await app.commands.run('history:undo').catch(() => {});
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '<!doctype html>\n<html>\n<body>\n  \n</body>\n</html>\n' } });

    doc = await typeAndTab(ed, 4, '  div#app');
    r.id = doc.split('\n')[3].trim();

    // A prose word is not turned into a tag; Tab indents as usual.
    doc = await typeAndTab(ed, 4, '  hello');
    r.proseWordKept = !doc.includes('<hello') && doc.split('\n')[3].trim() === 'hello' && doc.split('\n')[3].length > 7; // indented instead

    // At the start of an empty line Tab still indents.
    doc = await typeAndTab(ed, 4, '');
    r.indentKept = doc.split('\n')[3].trim() === '' && doc.split('\n')[3].length > 0;

    // Inside a tag, in the middle of attributes, nothing is expanded.
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '<div cl></div>\n' }, selection: { anchor: 7 } });
    tab(v); await wait(100);
    r.insideTag = v.state.doc.toString().includes('<div cl') && !v.state.doc.toString().includes('<cl');

    // JavaScript inside <script> is left alone too.
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '<script>\nfoo.bar\n</script>\n' }, selection: { anchor: 16 } });
    tab(v); await wait(100);
    r.inScript = !v.state.doc.toString().includes('<foo') && v.state.doc.toString().includes('foo.bar');
    return r;
  });

  // --- Emmet in CSS ----------------------------------------------------------------
  await step('css', async () => {
    const ed = await ws.open(root + '/style.css');
    await wait(500);
    const doc = await typeAndTab(ed, 2, '  m10');
    const r = { margin: doc.split('\n')[1].trim(), doc };
    // Outside a rule, Tab does not make a declaration out of a selector.
    const v = ed.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'body\n' }, selection: { anchor: 4 } });
    tab(v); await wait(100);
    r.outsideBlock = !v.state.doc.toString().includes(':');
    return r;
  });

  await step('scss', async () => {
    const ed = await ws.open(root + '/style.scss');
    await wait(500);
    return { margin: (await typeAndTab(ed, 2, '  m10')).split('\n')[1].trim() };
  });

  await step('jsx', async () => {
    const ed = await ws.open(root + '/view.jsx');
    await wait(500);
    const v = ed.view;
    const r = { inside: (await typeAndTab(ed, 3, '    p.note')).split('\n')[2].trim() };
    // Plain JavaScript in the same file is left alone.
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'const x = 1;\nfoo.bar\n' }, selection: { anchor: 20 } });
    tab(v); await wait(100);
    r.outsideJsx = !v.state.doc.toString().includes('<foo');
    return r;
  });

  // --- elsewhere: snippets win, Tab indents -------------------------------------------
  await step('js', async () => {
    const ed = await ws.open(root + '/app.js');
    await wait(300);
    const r = {};
    const v = ed.view;
    let doc = await typeAndTab(ed, 1, 'log');
    r.snippetWins = doc.split('\n')[0];
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'foo.bar\nx' }, selection: { anchor: 7 } });
    tab(v); await wait(100);
    r.plainTabIndents = v.state.doc.toString() !== 'foo.bar\nx' && !v.state.doc.toString().includes('<');
    return r;
  });
  await step('txt', async () => {
    const ed = await ws.open(root + '/notes.txt');
    await wait(200);
    const doc = await typeAndTab(ed, 1, 'ul>li');
    return { plainTabIndents: doc !== 'ul>li\n' && !doc.includes('<'), doc };
  });

  // --- setting off + commands ---------------------------------------------------------
  await step('disabled', async () => {
    const ed = await ws.open(root + '/page.html');
    await wait(200);
    await app.config.set('emmet.enabled', false);
    const doc = await typeAndTab(ed, 1, 'div#x');
    await app.config.set('emmet.enabled', true);
    return { untouched: !doc.includes('<div'), doc };
  });
  await step('commands', async () => {
    const ed = await ws.open(root + '/page.html');
    await wait(200);
    const v = ed.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '<div><p>x</p></div>' }, selection: { anchor: 8 } });
    const selected = () => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    await app.commands.run('emmet:balance-outward'); await wait(100);
    const first = selected();
    await app.commands.run('emmet:balance-outward'); await wait(100);
    const second = selected();
    await app.commands.run('emmet:balance-inward'); await wait(100);
    return { listed: ['emmet:expand', 'emmet:wrap', 'emmet:balance-outward', 'emmet:balance-inward'].every((c) => app.commands.has(c)), balance: [first, second, selected()].join(' | ') };
  });
  await step('wrap', async () => {
    const ed = await ws.open(root + '/page.html');
    await wait(200);
    const v = ed.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '<p>hello</p>' }, selection: { anchor: 3, head: 8 } });
    await app.commands.run('emmet:wrap');
    const input = await until(() => document.querySelector('.emmet-wrap-with-abbreviation input'));
    if (!input) return { box: false };
    input.value = 'span.hi';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(100);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(100);
    return { box: true, doc: v.state.doc.toString(), closed: !document.querySelector('.emmet-wrap-with-abbreviation') };
  });

  // --- Markdown preview scrolling ------------------------------------------------------
  await step('md', async () => {
    const r = {};
    const ed = await ws.open(root + '/long.md');
    await wait(500);
    await app.commands.run('markdown-preview:toggle');
    const body = await until(() => document.querySelector('.markdown-body'));
    const scroller = body.parentElement;
    await wait(500);
    const v = ed.view;
    r.previewHasLines = body.querySelectorAll(':scope > [data-line]').length > 40 && body.querySelector('h2[data-line="3"]')?.textContent === 'Section 1';

    // Editor -> preview: scroll the editor so a heading far down is at its top.
    const lineOf = (title) => { for (let n = 1; n <= v.state.doc.lines; n++) if (v.state.doc.line(n).text === title) return n; return 0; };
    const topOf = (el) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const heading = (title) => [...body.querySelectorAll('h2')].find((h) => h.textContent === title);
    const target = lineOf('## Section 30');
    const lb = v.lineBlockAt(v.state.doc.line(target).from);
    v.scrollDOM.scrollTop = lb.top + v.documentPadding.top;
    await until(() => Math.abs(topOf(heading('Section 30'))) < 40, 3000);
    r.editorToPreviewTop = Math.round(topOf(heading('Section 30')));
    r.editorToPreview = Math.abs(topOf(heading('Section 30'))) < 40 && scroller.scrollTop > 1000;

    // Preview -> editor: scroll the preview to another heading and see the editor follow.
    await wait(300);
    scroller.scrollTop += topOf(heading('Section 12'));
    await until(() => { const top = v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop - v.documentPadding.top).from).number; return Math.abs(top - lineOf('## Section 12')) <= 2; }, 3000);
    const topLine = v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop - v.documentPadding.top).from).number;
    r.previewToEditorLine = topLine - lineOf('## Section 12');
    r.previewToEditor = Math.abs(topLine - lineOf('## Section 12')) <= 2;

    // No feedback loop: after it settles, nothing keeps moving.
    await wait(300);
    const settled = [scroller.scrollTop, v.scrollDOM.scrollTop];
    await wait(400);
    r.stable = Math.abs(scroller.scrollTop - settled[0]) < 2 && Math.abs(v.scrollDOM.scrollTop - settled[1]) < 2;

    // Clicking a block in the preview puts the editor's cursor on its first line.
    const h = heading('Section 12');
    h.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(100);
    r.clickLine = v.state.doc.lineAt(v.state.selection.main.head).number - lineOf('## Section 12');
    r.clickMovesCursor = r.clickLine === 0;

    // Switched off, the two stay where they are.
    await app.config.set('markdown-preview.syncScroll', false);
    const before = scroller.scrollTop;
    v.scrollDOM.scrollTop = 0;
    await wait(400);
    r.offStaysPut = Math.abs(scroller.scrollTop - before) < 2;
    await app.config.set('markdown-preview.syncScroll', true);
    return r;
  });

  out.totalErrors = errors.length;
  if (errors.length) out.errs = errors.slice(0, 5);
  return out;
})()
