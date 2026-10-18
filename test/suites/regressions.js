// Regression checks for bugs fixed after the QA pass, over the `qb` fixture: shortcuts in the
// editor, AZERTY undo, pane handling, unsaved-changes prompts, broken config, project replace with
// regexes and `$`, save-as onto an open file, snippets with `${}` text, markdown preview safety
// and a catastrophic regex search.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const results = {};
  const root = await until(() => ws.project);
  const T = window.mideTest;
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 200); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };
  const read = (p) => window.native.fs.read(root + '/' + p);
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } while (ws.panes.length > 1) ws.removePane(ws.panes[ws.panes.length - 1]); };

  await step('cmdShiftShortcutsInEditor', async () => {
    await closeAll();
    const ed = await ws.open(root + '/lines.txt');
    ed.view.focus();
    ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ...MOD, shiftKey: true, bubbles: true, cancelable: true }));
    const palette = !!(await until(() => document.querySelector('.select-list'), 1500));
    app.ui.closeModal();
    ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', shiftKey: false, bubbles: true, cancelable: true }));
    await wait(100);
    return { paletteOpened: palette, plainTypingNotIntercepted: !document.querySelector('.select-list') };
  });

  await step('azertyCmdZ', async () => {
    // AZERTY: the key labelled Z sits at physical KeyW. Mod-Z must mean undo (z), not close tab (w).
    const ed = ws.getActiveEditor();
    const tabsBefore = ws.allItems().length;
    ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyW', ...MOD, bubbles: true, cancelable: true }));
    await wait(150);
    return { tabStillOpen: ws.allItems().length === tabsBefore };
  });

  await step('previewTabInSplitKeepsPane', async () => {
    await closeAll();
    await ws.open(root + '/lines.txt');
    const right = ws.splitRight(ws.activePane, null);
    await ws.open(root + '/price.txt', { pane: right, pending: true });
    await ws.open(root + '/target.txt', { pane: right, pending: true });
    return { panes: ws.panes.length, rightPaneStillListed: ws.panes.includes(right), rightItems: right.items.map((i) => i.getTitle()) };
  });

  await step('closePaneWithThreePanes', async () => {
    await closeAll();
    await ws.open(root + '/lines.txt');
    const p2 = ws.splitRight(ws.activePane, null); await ws.open(root + '/price.txt', { pane: p2 });
    const p3 = ws.splitRight(ws.activePane, null); await ws.open(root + '/target.txt', { pane: p3 });
    ws.setActivePane(ws.panes[1]);
    await ws.closeActivePane();
    return { panesLeft: ws.panes.length, titles: ws.allItems().map((i) => i.getTitle()) };
  });

  await step('reloadAsksAboutUnsaved', async () => {
    await closeAll();
    const ed = await ws.open(root + '/lines.txt');
    ed.view.dispatch(ed.view.state.replaceSelection('DIRTY '));
    await T.answers('confirm', 2); // Cancel
    await app.commands.run('window:reload');
    await wait(300);
    const survived = ws.allItems().includes(ed) && ed.isDirty();
    await T.answers('confirm', 1); await ws.closeItem(ed);
    return { cancelKeptEdits: survived };
  });

  await step('brokenConfigNotOverwritten', async () => {
    const file = app.userInfo.dir + '/config.json';
    const original = await window.native.fs.read(file);
    const broken = '{ "editor": { "fontSize": 15, }, "keepMe": true oops';
    await window.native.fs.write(file, broken);
    await wait(900);
    await app.config.set('editor.fontSize', 18);
    await wait(300);
    const after = await window.native.fs.read(file);
    await window.native.fs.write(file, original); await wait(700);
    await app.config.set('editor.fontSize', undefined);
    return { fileUntouched: after === broken };
  });

  await step('saveAsOntoOpenFile', async () => {
    await closeAll();
    const target = await ws.open(root + '/target.txt');
    const ed = ws.newFile();
    await wait(50);
    ed.view.dispatch(ed.view.state.replaceSelection('NEW CONTENT\n'));
    await T.answers('saveAs', root + '/target.txt');
    await ws.save(ed);
    const docs = [...ws.documents.keys()].filter((p) => p.endsWith('target.txt')).length;
    return { oldTabClosed: !ws.allItems().includes(target), oneDocument: docs === 1, disk: JSON.stringify(await read('target.txt')) };
  });

  await step('deletedFileMarkedUnsaved', async () => {
    await closeAll();
    const ed = await ws.open(root + '/gone.txt');
    await window.native.fs.trash(root + '/gone.txt');
    const flagged = await until(() => ed.isDirty() && ed.getTitle().includes('deleted'), 4000);
    await T.answers('confirm', 1); await ws.closeItem(ed);
    return { markedUnsaved: !!flagged };
  });

  await step('snippetSelectionWithDollarBraces', async () => {
    await closeAll();
    await window.native.fs.write(app.userInfo.dir + '/snippets.json', '{ "*": { "Wrap": { "prefix": "wrapit", "body": "try {\\n$TM_SELECTED_TEXT\\n}" } } }');
    const ed = await ws.open(root + '/lines.txt');
    await ws.open(app.userInfo.dir + '/snippets.json'); await ws.save(); await wait(400);
    await ws.open(root + '/lines.txt');
    ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: 'x = `${name}` + #{y} + $1' } });
    ed.view.dispatch({ selection: { anchor: 0, head: ed.view.state.doc.length } });
    await app.commands.run('snippets:insert');
    const input = await until(() => document.querySelector('.select-list .select-input'));
    input.value = 'wrapit'; input.dispatchEvent(new Event('input'));
    (await until(() => document.querySelector('.select-item')))?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(300);
    const text = ed.getText();
    await T.answers('confirm', 1); await ws.closeItem(ed);
    return { literalPreserved: text === 'try {\nx = `${name}` + #{y} + $1\n}', text: JSON.stringify(text) };
  });

  await step('duplicateBinarySafe', async () => {
    await window.native.fs.copy(root + '/pic.png', root + '/pic copy.png');
    const a = await window.native.fs.readDataUrl(root + '/pic.png');
    const b = await window.native.fs.readDataUrl(root + '/pic copy.png');
    return { identical: a === b && a.length > 1000 };
  });

  await step('markdownRemoteImageBlockedAndAnchors', async () => {
    await closeAll();
    await ws.open(root + '/doc.md');
    await app.commands.run('markdown-preview:toggle');
    await wait(400);
    const body = document.querySelector('.markdown-body');
    return { remoteBlocked: !body.querySelector('img') && body.textContent.includes('remote image blocked'), headingId: body.querySelector('h1')?.id ?? null };
  });

  await step('previewClosesWithSource', async () => {
    const md = ws.allItems().find((i) => i.getTitle() === 'doc.md');
    await ws.closeItem(md);
    await wait(200);
    return { previewGone: !ws.allItems().some((i) => i.type === 'markdown-preview') };
  });

  // Runs late: replacing \s+ across the project rewrites every fixture file with whitespace.
  await step('replaceAllRegexDoesNotJoinLines', async () => {
    await closeAll();
    await app.commands.run('find-in-project:show-replace');
    const q = document.querySelector('.fip-query');
    const regexBtn = [...document.querySelectorAll('.fip-toggle')].find((b) => b.textContent === '.*');
    if (!regexBtn.classList.contains('on')) regexBtn.click();
    q.value = '\\s+'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => document.querySelectorAll('.fip-match').length > 0);
    document.querySelector('.fip-replace').value = '_';
    await T.answers('confirm', 0);
    [...document.querySelectorAll('.fip-replace-row .btn')][0].click();
    await wait(1200);
    regexBtn.click(); // literal mode for the next check
    const lines = await read('lines.txt');
    q.value = 'cost'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => document.querySelectorAll('.fip-match').length > 0);
    document.querySelector('.fip-replace').value = '$$5';
    await T.answers('confirm', 0);
    [...document.querySelectorAll('.fip-replace-row .btn')][0].click();
    await wait(1200);
    return { lines: JSON.stringify(lines), literalDollar: JSON.stringify(await read('price.txt')) };
  });

  await step('searchCatastrophicRegexDoesNotFreeze', async () => {
    await window.native.fs.write(root + '/minified.txt', 'a'.repeat(40) + '!');
    const t0 = performance.now();
    const res = await window.native.project.search(root, '(a+)+$', { regex: true });
    const ms = Math.round(performance.now() - t0);
    const tick = await new Promise((r) => { const s = performance.now(); setTimeout(() => r(Math.round(performance.now() - s)), 0); });
    return { resultOrTimeout: res.error ? 'stopped: ' + res.error.slice(0, 40) : `${res.results.length} files`, ms, uiResponsive: tick < 200 };
  });

  results.totalErrors = errors.length;
  return results;
})()
