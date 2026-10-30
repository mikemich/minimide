// Test Explorer over the `txproj` fixture: discovery (a syntax scan, then the frameworks' own
// lists), the Testing view as a tree, run buttons in the gutter, running one test, a file, all
// tests, the failed ones, the test at the cursor and the last run again, with Jest (a fake),
// node:test, pytest (a fake) and Go (when installed); failures under their line with expected and
// received, the output panel, the status bar, cancelling, keyboard use, a folder nobody trusted
// (found, never run) and switching the package off and on.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
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

  // --- helpers ---------------------------------------------------------------------------
  const fixtures = root.replace(/\/[^/]+$/, '');
  const file = (n) => `${root}/${n}`;
  const run = (cmd) => app.commands.run(cmd);
  const hasGo = !!app.config.get('test-explorer.goCommand'); // the fixture sets it when go is installed
  const view = () => document.querySelector('.tx-view');
  const rowsEl = () => [...view().querySelectorAll('.tx-row')];
  const rowText = (r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.querySelector('.tx-name').textContent}`;
  const treeText = () => rowsEl().map(rowText);
  const rowFor = (name, kind) => rowsEl().find((r) => r.querySelector('.tx-name').textContent === name && (!kind || r.dataset.kind === kind));
  const statusOf = (name, kind) => { const r = rowFor(name, kind); return r ? ['passed', 'failed', 'skipped', 'running'].find((s) => r.classList.contains(s)) || 'none' : 'missing'; };
  const statuses = (names) => Object.fromEntries(names.map((n) => [n, statusOf(n)]));
  const running = () => app.commands.isEnabled('test-explorer:cancel');
  const finished = async (ms = 60000) => { await until(running, 1500); return !!(await until(() => !running(), ms)); };
  const calls = async () => (await native.fs.read(`${fixtures}/txcalls.log`).catch(() => '')).split('\n').filter(Boolean);
  const notes = () => [...document.querySelectorAll('.notification')].map((n) => n.textContent);
  const clearNotes = () => { for (const n of document.querySelectorAll('.notification')) n.remove(); };
  const lineOfBlock = (v, el) => { const r = el.getBoundingClientRect(); return v.state.doc.lineAt(v.lineBlockAtHeight(r.top + r.height / 2 - v.documentTop).from).number; };
  const gutter = (ed) => [...ed.view.dom.querySelectorAll('.cm-test-gutter .tx-run')].map((el) => `${lineOfBlock(ed.view, el)}:${el.className.replace('tx-run ', '')}`);
  const inline = (ed) => [...ed.view.dom.querySelectorAll('.tx-inline')].map((el) => ({ line: ed.view.state.doc.lineAt(ed.view.posAtDOM(el)).number, text: el.textContent }));
  const clickGutter = (ed, line) => {
    const el = [...ed.view.dom.querySelectorAll('.cm-test-gutter .tx-run')].find((m) => lineOfBlock(ed.view, m) === line);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  };
  const statusItem = () => document.querySelector('#statusbar .status-item[data-id="test-explorer"]');
  const outputText = () => document.querySelector('.tx-output')?.textContent || '';
  const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

  const pyTests = ['test_add', 'test_mul_fails', 'test_param[1]', 'test_param[2]', 'test_skip_me'];
  const jsTests = ['adds', 'multiplies', 'later', 'upper', 'lower', 'numbers', 'words'];
  const goTests = ['TestAdd', 'ok', 'bad_case'];

  // --- discovery ------------------------------------------------------------------------------
  await step('discover', async () => {
    await run('test-explorer:show');
    // The scan fills the view; pytest's list then adds the parametrized cases.
    await until(() => rowFor('test_param[2]'), 20000);
    await until(() => !/Looking/.test(view().querySelector('.tx-summary').textContent), 20000);
    return {
      shown: app.sidebar.isActive('test-explorer'), tree: treeText(),
      fileDirs: rowsEl().filter((r) => r.dataset.kind === 'file').map((r) => r.querySelector('.tx-dir')?.textContent || ''),
      titles: ['math.test.js', 'check.test.mjs', 'test_calc.py', 'calc_test.go'].map((n) => rowFor(n, 'file')?.title.replace(/^.*\(/, '(')),
      listed: (await calls()).map((l) => l.slice(fixtures.length + 1)),
      statusHidden: statusItem()?.hidden,
    };
  });

  // --- the gutter, and running one test from it ------------------------------------------------------
  let math;
  await step('runOne', async () => {
    math = await ws.open(file('src/math.test.js'));
    await until(() => gutter(math).length === 4);
    const before = gutter(math);
    clickGutter(math, 4);
    const done = await finished();
    const call = (await calls()).pop().slice(fixtures.length + 1);
    return { before, done, call, after: gutter(math), statuses: statuses(['adds', 'multiplies', 'later', 'math']), statusBar: statusItem()?.getAttribute('aria-label') };
  });

  // --- everything -----------------------------------------------------------------------------------------
  await step('runAll', async () => {
    clearNotes();
    await run('test-explorer:run-all');
    const done = await finished(120000);
    await wait(300);
    const go = hasGo ? statuses(goTests) : 'no go';
    return {
      done, js: statuses(jsTests), py: statuses(pyTests), go,
      folder: statusOf('txproj', 'folder'), files: statuses(['math.test.js', 'strings.test.js', 'check.test.mjs', 'test_calc.py']),
      tree: treeText(),
      durations: !!rowFor('adds').querySelector('.tx-duration'),
      gutter: gutter(math), inline: inline(math),
      summary: view().querySelector('.tx-summary').textContent,
      statusBar: statusItem()?.getAttribute('aria-label'), statusShown: !statusItem()?.hidden,
      output: ['node_modules/.bin/jest', 'fake-pytest.mjs', ' --test --test-reporter=spec', ...(hasGo ? ["go' test -json"] : [])].filter((s) => !outputText().includes(s)),
      notes: notes(),
    };
  });

  // --- the details of a failure, and the keyboard -----------------------------------------------------
  await step('details', async () => {
    const tree = view().querySelector('.tx-tree');
    tree.focus();
    const failed = rowFor('multiplies');
    failed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await wait(100);
    const d = view().querySelector('.tx-details');
    const out = {
      shown: !d.hidden, title: d.querySelector('.tx-details-title')?.textContent,
      values: [...d.querySelectorAll('.tx-details-values > div')].map((x) => x.textContent),
      buttons: [...d.querySelectorAll('button')].map((b) => b.textContent),
      activeDescendant: tree.getAttribute('aria-activedescendant') === failed.id, selected: failed.getAttribute('aria-selected'),
    };
    key(tree, 'ArrowDown');
    out.down = rowsEl().find((r) => r.id === tree.getAttribute('aria-activedescendant'))?.querySelector('.tx-name').textContent;
    key(tree, 'ArrowLeft');
    out.parent = rowsEl().find((r) => r.id === tree.getAttribute('aria-activedescendant'))?.querySelector('.tx-name').textContent;
    key(tree, 'ArrowLeft');
    out.collapsed = rowFor('math').getAttribute('aria-expanded');
    key(tree, 'ArrowRight');
    out.expanded = rowFor('math').getAttribute('aria-expanded');
    key(tree, 'ArrowDown'); key(tree, 'ArrowDown');
    key(tree, 'Enter');
    await until(() => ws.getActiveEditor()?.view.state.doc.lineAt(ws.getActiveEditor().view.state.selection.main.head).number === 7);
    const ed = ws.getActiveEditor();
    out.opened = `${ed.getPath().slice(root.length + 1)}:${ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number}`;
    out.roles = [tree.getAttribute('role'), tree.getAttribute('aria-label'), rowFor('adds').getAttribute('role'), rowFor('adds').getAttribute('aria-level'), rowFor('math').getAttribute('aria-expanded')];
    out.unnamedButtons = [...view().querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim()).length;
    // Filtering keeps the matches with their parents.
    const filter = view().querySelector('.tx-filter');
    filter.value = 'mul';
    filter.dispatchEvent(new Event('input'));
    out.filtered = treeText();
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    return out;
  });

  // --- the failed ones, the test at the cursor, a file, the last run again ---------------------------------
  await step('runFailed', async () => {
    const before = (await calls()).length;
    await run('test-explorer:run-failed');
    const done = await finished();
    return {
      done, jestCalls: (await calls()).slice(before).map((l) => l.slice(fixtures.length + 1)),
      js: statuses(['adds', 'multiplies', 'words']), py: statuses(['test_add', 'test_mul_fails']), ...(hasGo ? { go: statuses(['TestAdd', 'bad_case']) } : {}),
    };
  });

  await step('runAtCursor', async () => {
    const ed = await ws.open(file('src/strings.test.js'));
    await wait(200);
    ed.goToLine(6);
    const before = (await calls()).length;
    await run('test-explorer:run-at-cursor');
    const done = await finished();
    return { done, call: (await calls()).slice(before).map((l) => l.slice(fixtures.length + 1)), statuses: statuses(['upper', 'lower']) };
  });

  await step('runFile', async () => {
    const ed = await ws.open(file('tools/check.test.mjs'));
    await wait(300);
    await run('test-explorer:run-file');
    const done = await finished();
    const out = outputText();
    await run('test-explorer:rerun');
    const again = await finished();
    return {
      done, again, command: /node'? --test .*tools\/check\.test\.mjs/.test(out), gutter: gutter(ed),
      inline: inline(ed).map((i) => [i.line, /words failed|cat|dog/.test(i.text)]), statuses: statuses(['numbers', 'words']),
    };
  });

  // --- typing moves the run buttons, a cancelled run ------------------------------------------------------------
  await step('edits', async () => {
    const ed = await ws.open(file('src/math.test.js'));
    await wait(200);
    ed.view.dispatch({ changes: { from: 0, insert: '// a new first line\n' } });
    const moved = await until(() => gutter(ed)[0]?.startsWith('4:') && gutter(ed));
    await wait(700); // and once the scan catches up, they stay there
    const rescanned = gutter(ed);
    ed.view.dispatch({ changes: { from: 0, to: '// a new first line\n'.length } });
    await ws.save(ed);
    return { moved, rescanned, inlineLine: inline(ed).map((i) => i.line) };
  });

  await step('cancel', async () => {
    await app.config.set('test-explorer.jestCommand', `FAKE_JEST_DELAY=20000 '${root}/node_modules/.bin/jest'`);
    await ws.open(file('src/strings.test.js'));
    await wait(200);
    const t = Date.now();
    run('test-explorer:run-file');
    const started = await until(running, 5000);
    await wait(150);
    const spinning = [statusOf('upper'), view().querySelector('.tx-summary').textContent, statusItem()?.getAttribute('aria-label'), !view().querySelector('.tx-cancel').hidden];
    await wait(500);
    await run('test-explorer:cancel');
    const stopped = !!(await until(() => !running(), 5000));
    await app.config.set('test-explorer.jestCommand', '');
    await wait(150);
    return { started: !!started, spinning, stopped, quick: Date.now() - t < 10000, after: statuses(['upper', 'lower']), output: /Cancelled/.test(outputText()), statusBar: statusItem()?.getAttribute('aria-label') };
  });

  // --- a folder nobody trusted: its tests show, nothing runs there ------------------------------------------------
  await step('untrusted', async () => {
    const other = `${fixtures}/txuntrusted`;
    await T.answers('openFolder', other);
    await T.answers('confirm', 2); // "Restricted Mode"
    await run('project:add-folder');
    await until(() => ws.folders.includes(other));
    const found = await until(() => rowFor('never runs here'), 10000);
    clearNotes();
    const before = await calls();
    await run('test-explorer:run-all');
    await finished();
    const ed = await ws.open(`${other}/src/u.test.js`);
    await until(() => gutter(ed).length === 1);
    clickGutter(ed, 1);
    await wait(800);
    const after = await calls();
    return {
      trusted: app.trust.isTrusted(other), found: !!found, folderNote: rowFor('txuntrusted', 'folder')?.textContent.includes('Restricted Mode'),
      refused: notes().some((n) => /Restricted Mode/.test(n)), status: statusOf('never runs here'),
      callsInUntrusted: after.filter((l) => l.startsWith(`${other} `)).length, otherCalls: after.length > before.length,
    };
  });

  // --- switching the package off and on --------------------------------------------------------------------------------
  await step('disableEnable', async () => {
    const ed = await ws.open(file('src/math.test.js'));
    await wait(200);
    const present = () => ({
      view: !!view(), output: !!document.querySelector('.tx-output-view'), status: !!statusItem(), gutter: !!ed.view.dom.querySelector('.cm-test-gutter'),
      markers: ed.view.dom.querySelectorAll('.tx-run').length, inline: ed.view.dom.querySelectorAll('.tx-inline').length,
      commands: app.commands.list().filter((c) => c.id.startsWith('test-explorer:')).length, styles: document.querySelectorAll('[data-pkg="test-explorer"]').length,
    });
    const before = present();
    await app.packages.setEnabled('test-explorer', false);
    await wait(200);
    const off = present();
    await app.packages.setEnabled('test-explorer', true);
    await until(() => ed.view.dom.querySelectorAll('.tx-run').length === 4, 10000);
    await wait(300);
    return { before, off, on: present(), tree: !!(await until(() => rowFor('adds'), 10000)) };
  });

  // Leave the view on screen for the screenshot.
  await step('screenshot', async () => {
    await run('test-explorer:run-all');
    await finished(120000);
    app.sidebar.show('test-explorer');
    const ed = await ws.open(file('src/math.test.js'));
    return !!ed;
  });

  results.hasGo = hasGo;
  results.totalErrors = errors.length;
  return results;
})()
