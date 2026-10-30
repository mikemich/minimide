// Merge conflicts over the `mcproj` fixture: a real repository in the middle of a merge. Detection and
// decorations, the four actions above each block (each one undoable edit), the commands, F7
// navigation, the status bar item, CRLF and diff3 files, edits that change what is detected, a
// big file, opening from source control at the first conflict and marking a resolved file.
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
  const service = () => app.packages.services.get('merge-conflicts');
  const bufferOf = (ed) => ed.view.state.doc.toString();
  const setText = (ed, text) => ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: text } });
  const rows = (ed) => [...ed.view.dom.querySelectorAll('.cm-mc-actions')];
  const button = (ed, index, action) => rows(ed)[index]?.querySelector(`[data-action="${action}"]`);
  const lineNo = (ed) => ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  const cursorAt = (ed, needle, offset = 0) => { ed.view.dispatch({ selection: { anchor: bufferOf(ed).indexOf(needle) + offset } }); };
  const undo = (ed) => ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ...MOD, bubbles: true, cancelable: true }));
  const key = (ed, k, extra = {}) => ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true, ...extra }));
  const count = (ed) => service().count(ed);
  const statusText = () => document.querySelector('.status-item[data-id="merge-conflicts"]')?.textContent ?? null;
  const statusShown = () => { const el = document.querySelector('.status-item[data-id="merge-conflicts"]'); return !!el && el.offsetParent !== null; };
  const toasts = () => [...document.querySelectorAll('.notification')].map((n) => ({ title: n.querySelector('.notification-title')?.textContent, buttons: [...n.querySelectorAll('.notification-actions button')].map((b) => b.textContent), el: n }));
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } };
  const close = async (item) => { if (item.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(item); };
  const unmerged = async () => (await gitOut('ls-files', '-u', '--', 'resolve.txt')).trim() !== '';
  const gitOut = async (...args) => (await native.proc.exec('git', args, { cwd: root })).stdout;

  const APP = {
    orig: '// app\nfunction a() {\n<<<<<<< HEAD\n  return 10;\n=======\n  return 100;\n>>>>>>> feature\n}\nconst mid = \'middle\';\n// padding 1\n// padding 2\n// padding 3\n// padding 4\n// padding 5\nfunction b() {\n<<<<<<< HEAD\n  return 20;\n=======\n  return 200;\n>>>>>>> feature\n}\n// end\n',
    head: '// app\nfunction a() {\n  return 10;\n}\nconst mid = \'middle\';\n// padding 1\n// padding 2\n// padding 3\n// padding 4\n// padding 5\nfunction b() {\n  return 20;\n}\n// end\n',
  };
  const PAD = '}\nconst mid = \'middle\';\n// padding 1\n// padding 2\n// padding 3\n// padding 4\n// padding 5\nfunction b() {\n';
  const MARK_A = '<<<<<<< HEAD\n  return 10;\n=======\n  return 100;\n>>>>>>> feature\n';
  const MARK_B = '<<<<<<< HEAD\n  return 20;\n=======\n  return 200;\n>>>>>>> feature\n';
  const top = '// app\nfunction a() {\n';
  const bottom = '}\n// end\n';
  const resolved = (a, b) => top + a + PAD + b + bottom;

  const out = {};
  await step('active', async () => ({ pkg: app.packages.packages.get('merge-conflicts')?.active, error: app.packages.packages.get('merge-conflicts')?.error?.message ?? null, service: !!service() }));
  out.active = results.active;

  // --- source control: the group, then a click on a row opens the file at its first conflict ---
  await step('sourceControl', async () => {
    await app.commands.run('source-control:show');
    const names = () => [...document.querySelectorAll('.sc-group')].filter((g) => g.querySelector('.sc-group-header span')?.textContent === 'Merge Conflicts').flatMap((g) => [...g.querySelectorAll('.sc-row .sc-name')].map((n) => n.textContent));
    const listed = await until(() => names().length === 5 && names());
    const row = [...document.querySelectorAll('.sc-row')].find((r) => r.querySelector('.sc-name')?.textContent === 'three.txt');
    row.click();
    const ed = await until(() => { const a = ws.getActiveEditor(); return a?.getPath() === `${root}/three.txt` && a.view && a; });
    const first = await until(() => ed && lineNo(ed) === 2 && ed);
    const rowTitle = row.querySelector('.sc-row-actions button')?.title;
    return { listed, opened: !!ed, line: ed ? lineNo(ed) : null, atFirst: !!first, rowTitle, conflicts: ed ? count(ed) : null };
  });
  out.sourceControl = results.sourceControl;
  await closeAll();

  // --- detection and decorations ---------------------------------------------------------
  const ed = await ws.open(`${root}/app.js`);
  await step('detect', async () => {
    await until(() => count(ed) === 2);
    await until(() => rows(ed).length === 2);
    const cls = (c) => ed.view.dom.querySelectorAll(`.cm-line.${c}`).length;
    return {
      buffer: bufferOf(ed) === APP.orig, count: count(ed), actionRows: rows(ed).length,
      buttons: [...rows(ed)[0].querySelectorAll('button')].map((b) => b.textContent),
      labels: rows(ed)[0].querySelector('.cm-mc-labels')?.textContent,
      ours: cls('cm-mc-ours'), theirs: cls('cm-mc-theirs'), base: cls('cm-mc-base'), markers: cls('cm-mc-marker'),
      ourBackground: getComputedStyle(ed.view.dom.querySelector('.cm-mc-ours')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      theirBackground: getComputedStyle(ed.view.dom.querySelector('.cm-mc-theirs')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      group: rows(ed)[0].getAttribute('role'), buttonLabel: button(ed, 1, 'both')?.getAttribute('aria-label'),
      status: await until(() => statusText() === '2 conflicts' && statusText()), statusVisible: statusShown(),
    };
  });
  out.detect = results.detect;

  // --- each action is one undoable edit -----------------------------------------------------
  const actionStep = (name, action, expected) => step(name, async () => {
    ed.view.focus();
    button(ed, 0, action).click();
    const after = bufferOf(ed);
    const second = bufferOf(ed) === after && (await until(() => count(ed) === 1));
    undo(ed);
    return { text: after === expected, count: !!second, restored: bufferOf(ed) === APP.orig, countAfterUndo: await until(() => count(ed) === 2) };
  });
  await actionStep('acceptCurrent', 'current', top + '  return 10;\n' + PAD + MARK_B + bottom);
  await actionStep('acceptIncoming', 'incoming', top + '  return 100;\n' + PAD + MARK_B + bottom);
  await actionStep('acceptBoth', 'both', top + '  return 10;\n  return 100;\n' + PAD + MARK_B + bottom); // current first
  for (const k of ['acceptCurrent', 'acceptIncoming', 'acceptBoth']) out[k] = results[k];

  await step('acceptSecondBlock', async () => {
    button(ed, 1, 'incoming').click();
    const r = { text: bufferOf(ed) === top + MARK_A + PAD + '  return 200;\n' + bottom };
    undo(ed);
    r.restored = bufferOf(ed) === APP.orig;
    return r;
  });
  out.acceptSecondBlock = results.acceptSecondBlock;

  // --- commands act on the conflict at the cursor ---------------------------------------------
  await step('commands', async () => {
    const r = {};
    cursorAt(ed, '  return 20;');
    await app.commands.run('merge-conflicts:accept-incoming');
    r.incomingAtCursor = bufferOf(ed) === top + MARK_A + PAD + '  return 200;\n' + bottom;
    undo(ed);
    cursorAt(ed, '  return 100;');
    await app.commands.run('merge-conflicts:accept-current');
    r.currentAtCursor = bufferOf(ed) === top + '  return 10;\n' + PAD + MARK_B + bottom;
    undo(ed);
    cursorAt(ed, 'function b');
    await app.commands.run('merge-conflicts:accept-both');
    r.bothOutside = bufferOf(ed) === APP.orig;
    r.toldWhy = !!(await until(() => toasts().some((t) => /cursor inside a merge conflict/.test(t.title))));
    document.querySelectorAll('.notification').forEach((n) => n.remove());
    await app.commands.run('merge-conflicts:accept-all-current');
    r.allCurrent = bufferOf(ed) === APP.head;
    r.noneLeft = await until(() => count(ed) === 0);
    r.statusHidden = await until(() => !statusShown());
    undo(ed);
    r.allCurrentUndone = bufferOf(ed) === APP.orig;
    await app.commands.run('merge-conflicts:accept-all-incoming');
    r.allIncoming = bufferOf(ed) === resolved('  return 100;\n', '  return 200;\n');
    undo(ed);
    r.allIncomingUndone = bufferOf(ed) === APP.orig;
    r.countBack = await until(() => count(ed) === 2);
    r.statusBack = await until(() => statusText() === '2 conflicts' && statusText());
    return r;
  });
  out.commands = results.commands;

  // --- navigation: commands, F7 and the status item ---------------------------------------------
  await step('navigation', async () => {
    const r = {};
    ed.view.focus();
    ed.view.dispatch({ selection: { anchor: 0 } });
    await app.commands.run('merge-conflicts:next');
    const l1 = lineNo(ed);
    await app.commands.run('merge-conflicts:next');
    const l2 = lineNo(ed);
    await app.commands.run('merge-conflicts:next');
    const l3 = lineNo(ed);
    r.next = [l1, l2, l3]; // wraps around
    await app.commands.run('merge-conflicts:previous');
    const p1 = lineNo(ed);
    await app.commands.run('merge-conflicts:previous');
    const p2 = lineNo(ed);
    r.previous = [p1, p2]; // wraps around too
    ed.view.dispatch({ selection: { anchor: 0 } });
    key(ed, 'F7');
    r.f7 = lineNo(ed);
    key(ed, 'F7');
    r.f7Again = lineNo(ed);
    key(ed, 'F7', { shiftKey: true });
    r.shiftF7 = lineNo(ed);
    cursorAt(ed, '  return 100;');
    await app.commands.run('merge-conflicts:next');
    r.nextFromInside = lineNo(ed);
    ed.view.dispatch({ selection: { anchor: 0 } });
    document.querySelector('.status-item[data-id="merge-conflicts"]').click();
    r.statusClick = lineNo(ed);
    r.statusTooltip = document.querySelector('.status-item[data-id="merge-conflicts"]').title;
    return r;
  });
  out.navigation = results.navigation;

  // --- compare ----------------------------------------------------------------------------------
  await step('compare', async () => {
    const r = {};
    button(ed, 0, 'compare').click();
    const item = await until(() => ws.allItems().find((i) => i.type === 'merge-conflict-compare'));
    r.opened = !!item;
    r.title = item?.getTitle();
    r.sides = await until(() => {
      const el = item.getElement();
      const a = el.querySelector('.cm-merge-a .cm-content'), b = el.querySelector('.cm-merge-b .cm-content');
      return a && b && [a.textContent.trim(), b.textContent.trim()];
    });
    r.headers = [...item.getElement().querySelectorAll('.mc-compare-side')].map((s) => s.textContent);
    r.unchanged = bufferOf(ed) === APP.orig;
    [...item.getElement().querySelectorAll('.mc-compare-actions button')].find((b) => b.textContent === 'Accept Incoming').click();
    r.closed = !!(await until(() => !ws.allItems().some((i) => i.type === 'merge-conflict-compare')));
    r.accepted = bufferOf(ed) === top + '  return 100;\n' + PAD + MARK_B + bottom;
    undo(ed);
    r.restored = bufferOf(ed) === APP.orig;
    return r;
  });
  out.compare = results.compare;

  // --- editing a block changes what is detected --------------------------------------------------
  await step('editing', async () => {
    const r = {};
    const eq = bufferOf(ed).indexOf('=======');
    ed.view.dispatch({ changes: { from: eq, to: eq + 8 } }); // drop the first "======="
    r.withoutSeparator = await until(() => count(ed) === 1) && await until(() => rows(ed).length === 1) && statusText();
    undo(ed);
    r.backToTwo = await until(() => count(ed) === 2);
    const end = bufferOf(ed).length;
    ed.view.dispatch({ changes: { from: end, insert: '<<<<<<< mine\nx\n=======\ny\n>>>>>>> theirs\n' } });
    r.added = await until(() => count(ed) === 3) && await until(() => statusText() === '3 conflicts' && statusText());
    r.addedLabels = await until(() => rows(ed)[2]?.querySelector('.cm-mc-labels')?.textContent);
    // Typing the markers one line at a time: nothing until the block closes.
    const blank = await ws.newFile();
    const stages = [];
    for (const line of ['<<<<<<< ours\n', 'one\n', '=======\n', 'two\n', '>>>>>>> theirs\n']) {
      blank.view.dispatch({ changes: { from: blank.view.state.doc.length, insert: line } });
      stages.push(count(blank));
    }
    r.typed = stages;
    // Deleting the whole block clears the decorations.
    setText(blank, 'plain\n');
    r.cleared = [count(blank), blank.view.dom.querySelectorAll('.cm-mc-actions').length];
    // A bare "<<<<<<<" is a start marker; "<<<<<<<x" is not.
    setText(blank, '<<<<<<<\na\n=======\nb\n>>>>>>>\n<<<<<<<x\nc\n=======\nd\n>>>>>>>y\n');
    r.bareMarkers = count(blank);
    // The end of the file, with and without a final line break.
    setText(blank, 'start\n<<<<<<< a\none\n=======\ntwo\n>>>>>>> b');
    blank.view.dispatch({ selection: { anchor: 10 } });
    await app.commands.run('merge-conflicts:accept-both');
    r.endWithoutNewline = bufferOf(blank);
    setText(blank, '<<<<<<< a\n=======\n>>>>>>> b\nrest\n');
    await app.commands.run('merge-conflicts:next');
    await app.commands.run('merge-conflicts:accept-both');
    r.emptySides = bufferOf(blank);
    setText(blank, '<<<<<<< a\n\n=======\n>>>>>>> b\nrest\n'); // one blank line is a side, not nothing
    await app.commands.run('merge-conflicts:next');
    await app.commands.run('merge-conflicts:accept-current');
    r.blankLineSide = bufferOf(blank);
    await close(blank);
    return r;
  });
  out.editing = results.editing;
  setText(ed, APP.orig);

  // --- files that only look like they have conflicts ---------------------------------------------
  await step('tricky', async () => {
    const t = await ws.open(`${root}/tricky.txt`);
    await until(() => count(t) === 1);
    const r = { count: count(t), actionRows: rows(t).length, labels: rows(t)[0]?.querySelector('.cm-mc-labels')?.textContent };
    cursorAt(t, 'current');
    await app.commands.run('merge-conflicts:accept-incoming');
    r.text = bufferOf(t).split('\n').slice(3).join('|');
    await close(t);
    return r;
  });
  out.tricky = results.tricky;

  // --- a CRLF file --------------------------------------------------------------------------------
  await step('crlf', async () => {
    const c = await ws.open(`${root}/crlf.txt`);
    const r = { count: await until(() => count(c) === 1) && 1, buffer: bufferOf(c).includes('\r') ? 'has CR' : 'LF only' };
    button(c, 0, 'both').click();
    r.text = bufferOf(c);
    undo(c);
    r.restored = bufferOf(c).startsWith('first\n<<<<<<<');
    button(c, 0, 'incoming').click();
    await ws.save(c);
    r.disk = JSON.stringify(await native.fs.read(`${root}/crlf.txt`));
    await close(c);
    return r;
  });
  out.crlf = results.crlf;

  // --- diff3 ----------------------------------------------------------------------------------------
  await step('diff3', async () => {
    const d = await ws.open(`${root}/diff3.txt`);
    const r = { count: await until(() => count(d) === 1) && 1 };
    r.base = d.view.dom.querySelectorAll('.cm-line.cm-mc-base').length;
    r.markers = d.view.dom.querySelectorAll('.cm-line.cm-mc-marker').length;
    r.labels = rows(d)[0].querySelector('.cm-mc-labels')?.textContent;
    button(d, 0, 'both').click();
    r.both = bufferOf(d);
    undo(d);
    button(d, 0, 'current').click();
    r.current = bufferOf(d);
    undo(d);
    button(d, 0, 'incoming').click();
    r.incoming = bufferOf(d);
    undo(d);
    r.restored = bufferOf(d).includes('||||||| base');
    await close(d);
    return r;
  });
  out.diff3 = results.diff3;

  // --- a big file stays quick ---------------------------------------------------------------------------
  await step('bigFile', async () => {
    const lines = [];
    for (let i = 0; i < 40000; i++) {
      if (i % 200 === 100) lines.push('<<<<<<< HEAD', `ours ${i}`, '=======', `theirs ${i}`, '>>>>>>> topic');
      else lines.push(`line ${i}`);
    }
    const big = await ws.newFile();
    big.view.dispatch({ changes: { from: 0, insert: lines.join('\n') + '\n' } });
    const found = await until(() => count(big) === 200 && count(big));
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) big.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    const perEdit = (performance.now() - t0) / 20;
    const t1 = performance.now();
    await app.commands.run('merge-conflicts:accept-all-current');
    const all = performance.now() - t1;
    const r = { found, fast: perEdit < 50, allFast: all < 2000, after: count(big), lines: big.view.state.doc.lines };
    await close(big);
    return r;
  });
  out.bigFile = results.bigFile;

  // --- no markers, no status item ----------------------------------------------------------------------------
  await step('noConflicts', async () => {
    const c = await ws.open(`${root}/clean.txt`);
    await until(() => ws.getActiveEditor() === c);
    const r = { count: count(c), status: statusText(), shown: statusShown(), actionRows: rows(c).length };
    await app.commands.run('merge-conflicts:next');
    r.nextDoesNothing = lineNo(c) === 1;
    r.commandHidden = !app.commands.list().some((cmd) => cmd.id === 'merge-conflicts:next');
    await ws.open(`${root}/app.js`);
    r.statusBackWithFile = await until(() => statusText() === '2 conflicts' && statusText());
    return r;
  });
  out.noConflicts = results.noConflicts;

  // --- mark resolved after the last marker is gone and the file is saved ------------------------------------------
  await step('markResolved', async () => {
    document.querySelectorAll('.notification').forEach((n) => n.remove());
    const r = {};
    const e = await ws.open(`${root}/resolve.txt`);
    await until(() => count(e) === 1);
    r.unmergedBefore = await unmerged();
    // Saving with a marker left in does not offer anything.
    button(e, 0, 'current').click();
    setText(e, bufferOf(e) + '<<<<<<< again\n');
    await ws.save(e);
    await wait(500);
    r.offeredWithMarkers = toasts().some((t) => /resolve\.txt/.test(t.title));
    setText(e, 'keep\nincoming changed it\nkeep too\n');
    await ws.save(e);
    const toast = await until(() => toasts().find((t) => /No conflict markers left in resolve\.txt/.test(t.title)));
    r.offer = toast?.buttons;
    r.stillUnmergedBeforeClick = await unmerged();
    [...toast.el.querySelectorAll('button')].find((b) => b.textContent === 'Mark as resolved').click();
    r.stagedAfter = !!(await until(async () => !(await unmerged())));
    r.stagedContent = await gitOut('show', ':resolve.txt');
    r.groupRows = await until(() => {
      const g = [...document.querySelectorAll('.sc-group')].find((x) => x.querySelector('.sc-group-header span')?.textContent === 'Merge Conflicts');
      const names = g ? [...g.querySelectorAll('.sc-name')].map((n) => n.textContent) : [];
      return !names.includes('resolve.txt') && names.length === 4 && names.join();
    });
    r.stagedRow = [...document.querySelectorAll('.sc-row .sc-name')].some((n) => n.textContent === 'resolve.txt');
    return r;
  });
  out.markResolved = results.markResolved;

  // The packages can be switched off and on again.
  await step('toggle', async () => {
    await ws.open(`${root}/app.js`);
    await app.packages.setEnabled('merge-conflicts', false);
    const off = await until(() => document.querySelectorAll('.cm-mc-actions').length === 0 && !app.commands.list().some((c) => c.id === 'merge-conflicts:next'));
    await app.packages.setEnabled('merge-conflicts', true);
    const on = await until(() => count(ws.getActiveEditor()) === 2 && document.querySelectorAll('.cm-mc-actions').length === 2);
    return { off: !!off, on: !!on };
  });
  out.toggle = results.toggle;

  app.sidebar.show('source-control');
  await ws.open(`${root}/app.js`);
  cursorAt(ws.getActiveEditor(), '  return 20;');
  await app.commands.run('merge-conflicts:next');
  await wait(300);
  out.errors = errors;
  out.totalErrors = errors.length;
  return out;
})()
