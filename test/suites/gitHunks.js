// Git hunks over the `hkproj` fixture: a click on a change marker opens a peek with the change, Stage puts
// just that change in the index (checked with git itself), Revert puts it back in the editor. The middle
// change of several, CRLF lines, a file without a final newline, a file already partly staged, an
// untracked file, an unsaved buffer, the keys and the peek's roles, Stage / Unstage Change in Source
// Control's diffs, and turning the package off and on.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const MAC = navigator.platform.toLowerCase().includes('mac');
  const MOD = MAC ? { metaKey: true } : { ctrlKey: true };
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
  const service = () => app.packages.services.get('git-hunks');
  const git = async (...args) => (await native.proc.exec('git', args, { cwd: root })).stdout;
  const index = (name) => git('show', `:${name}`);
  const disk = (name) => native.fs.read(`${root}/${name}`);
  const lines = (name, n, swap = {}) => Array.from({ length: n }, (_, i) => swap[i + 1] ?? `${name} ${i + 1}`).join('\n') + '\n';
  const peek = (ed) => ed.view.dom.querySelector('.hunk-peek');
  const peekTitle = (ed) => peek(ed)?.querySelector('.hunk-title')?.textContent ?? null;
  const peekLines = (ed, kind) => [...(peek(ed)?.querySelectorAll(`.hunk-${kind} .hunk-text`) || [])].map((e) => e.textContent);
  const peekButton = (ed, action) => peek(ed)?.querySelector(`[data-action="${action}"]`);
  const lineNo = (ed) => ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  const markers = (ed) => ed.view.dom.querySelectorAll('.cm-git-gutter .git-marker').length;
  const toasts = () => [...document.querySelectorAll('.notification')].map((n) => n.querySelector('.notification-title')?.textContent);
  const dismissToasts = () => { for (const b of document.querySelectorAll('.notification .notification-close, .notification [aria-label="Dismiss notification"]')) b.click(); };
  const open = async (name) => {
    const ed = await ws.open(`${root}/${name}`);
    await until(() => ed.view && markers(ed) > 0);
    return ed;
  };
  /** A click on the git gutter beside `line`, the way a mouse does it. */
  const clickMarker = (ed, line) => {
    const gutter = ed.view.dom.querySelector('.cm-gutter.cm-git-gutter');
    const block = ed.view.lineBlockAt(ed.view.state.doc.line(line).from);
    const rect = gutter.getBoundingClientRect();
    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 1, clientY: ed.view.documentTop + block.top + block.height / 2 }));
  };
  const key = (target, k, code, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...extra }));
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } };
  const scRow = (group, name) => {
    const g = [...document.querySelectorAll('.sc-group')].find((x) => x.querySelector('.sc-group-header span')?.textContent === group);
    return g && [...g.querySelectorAll('.sc-row')].find((r) => r.querySelector('.sc-name')?.textContent === name);
  };
  const diffButtons = (item) => [...(item?.element.querySelectorAll('.sc-hunk-btn') || [])];

  const out = {};
  await step('active', async () => ({
    pkg: app.packages.packages.get('git-hunks')?.active, error: app.packages.packages.get('git-hunks')?.error?.message ?? null,
    service: Object.keys(service() || {}).sort(), markerHook: typeof app.packages.services.get('git-status')?.onDidClickMarker,
    keys: ['git-hunks:show', 'git-hunks:next', 'git-hunks:previous'].map((id) => app.keymap.bindingsFor(id).length > 0),
  }));
  out.active = results.active;

  // --- the middle of three changes, from a click on its marker ----------------------------
  await step('middle', async () => {
    const ed = await open('mid.txt');
    clickMarker(ed, 15);
    const shown = await until(() => peekTitle(ed) === 'Change 2 of 3' && document.activeElement === peek(ed));
    const p = peek(ed);
    const r = {
      shown: !!shown, role: p?.getAttribute('role'), label: p?.getAttribute('aria-label'), focused: document.activeElement === p,
      removed: peekLines(ed, 'removed'), added: peekLines(ed, 'added'), note: !!p?.querySelector('.hunk-note'),
      buttons: [...(p?.querySelectorAll('button') || [])].map((b) => b.getAttribute('aria-label')),
      groups: [...(p?.querySelectorAll('[role="group"]') || [])].map((g) => g.getAttribute('aria-label')),
    };
    peekButton(ed, 'stage').click();
    const want = lines('line', 30).replace('line 15\n', 'line fifteen\nline fifteen and a half\n');
    r.staged = !!(await until(async () => (await index('mid.txt')) === want));
    r.diskKept = (await disk('mid.txt')) === lines('line', 30).replace('line 2\n', 'line two\n').replace('line 15\n', 'line fifteen\nline fifteen and a half\n').replace('line 28\n', '');
    r.movedOn = await until(() => peekTitle(ed) === 'Change 2 of 2' && peekLines(ed, 'removed').join() === 'line 28' && peekTitle(ed));
    key(peek(ed), 'Escape', 'Escape');
    r.closed = !!(await until(() => !peek(ed)));
    r.editorFocused = document.activeElement === ed.view.contentDOM;
    // A second click on the open change's marker closes it again.
    clickMarker(ed, 2);
    r.reopened = await until(() => peekTitle(ed));
    clickMarker(ed, 2);
    r.toggledOff = !!(await until(() => !peek(ed)));
    return r;
  });
  out.middle = results.middle;

  // --- keys: next / previous change, show at cursor, Escape in the editor ----------------------
  await step('keys', async () => {
    const ed = ws.getActiveEditor();
    ed.view.dispatch({ selection: { anchor: 0 } });
    ed.view.focus();
    const r = {};
    key(ed.view.contentDOM, 'F3', 'F3', { altKey: true });
    r.next = await until(() => peekTitle(ed) === 'Change 1 of 2' && [peekTitle(ed), lineNo(ed)]);
    key(document.activeElement, 'F3', 'F3', { altKey: true });
    r.nextAgain = await until(() => peekTitle(ed) === 'Change 2 of 2' && [peekTitle(ed), lineNo(ed)]);
    key(document.activeElement, 'F3', 'F3', { altKey: true });
    r.wraps = await until(() => peekTitle(ed) === 'Change 1 of 2' && peekTitle(ed));
    key(document.activeElement, 'F3', 'F3', { altKey: true, shiftKey: true });
    r.previous = await until(() => peekTitle(ed) === 'Change 2 of 2' && peekTitle(ed));
    peekButton(ed, 'previous').click();
    r.previousButton = await until(() => peekTitle(ed) === 'Change 1 of 2' && peekTitle(ed));
    peekButton(ed, 'close').click();
    r.closeButton = !!(await until(() => !peek(ed)));
    // ⌘⌥G shows the change at the cursor, and closes it again.
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(2).from } });
    ed.view.focus();
    key(ed.view.contentDOM, MAC ? '©' : 'g', 'KeyG', { altKey: true, ...MOD });
    r.atCursor = await until(() => peekTitle(ed) === 'Change 1 of 2' && peekLines(ed, 'added').join());
    ed.view.focus();
    key(ed.view.contentDOM, 'Escape', 'Escape');
    r.escapeInEditor = !!(await until(() => !peek(ed)));
    return r;
  });
  out.keys = results.keys;
  await closeAll();

  // --- CRLF: the staged line keeps its line end, the other change stays out ---------------------
  await step('crlf', async () => {
    const ed = await open('crlf.txt');
    service().show(ed, 10);
    const shown = await until(() => peekTitle(ed) === 'Change 2 of 2' && peekLines(ed, 'added').join());
    const removed = peekLines(ed, 'removed');
    peekButton(ed, 'stage').click();
    const want = lines('row', 12).replace(/\n/g, '\r\n').replace('row 10\r\n', 'ROW 10\r\n');
    const staged = await until(async () => (await index('crlf.txt')) === want);
    return { shown, removed, staged: !!staged, index: JSON.stringify(await index('crlf.txt')).includes('\\r\\nROW 10\\r\\n'), left: await until(() => peekTitle(ed)) };
  });
  out.crlf = results.crlf;
  await closeAll();

  // --- no final newline: the last change, then the rest with Stage Selected Lines ---------------
  await step('noNewline', async () => {
    const ed = await open('nonl.txt');
    service().show(ed, 4);
    const shown = await until(() => peekTitle(ed) === 'Change 2 of 2' && { removed: peekLines(ed, 'removed'), added: peekLines(ed, 'added'), noNewline: [...peek(ed).querySelectorAll('.hunk-eof')].map((e) => e.closest('.hunk-lines').classList.contains('hunk-removed') ? 'removed' : 'added') });
    peekButton(ed, 'stage').click();
    const last = await until(async () => (await index('nonl.txt')) === 'a\nb\nc\nd' && 'a\nb\nc\nd');
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(1).from } });
    await app.commands.run('git-hunks:stage');
    const all = await until(async () => (await index('nonl.txt')) === 'A\nb\nc\nd' && 'A\nb\nc\nd');
    return { shown, last, all, peekClosed: !!(await until(() => !peek(ed))) };
  });
  out.noNewline = results.noNewline;
  await closeAll();

  // --- a file with one change staged already ------------------------------------------------
  await step('partial', async () => {
    const ed = await open('partial.txt');
    dismissToasts();
    // Line 2's marker (against the last commit) is a change that is staged already.
    clickMarker(ed, 2);
    const told = await until(() => toasts().includes('No unstaged change on this line.'));
    clickMarker(ed, 18);
    const shown = await until(() => peekTitle(ed) === 'Change 2 of 2' && peekTitle(ed));
    peekButton(ed, 'stage').click();
    const want = lines('p', 20, { 2: 'P 2', 18: 'P 18' });
    const staged = await until(async () => (await index('partial.txt')) === want);
    return { told: !!told, shown, staged: !!staged, left: await until(() => peekTitle(ed) === 'Change 1 of 1' && peekLines(ed, 'added').join()) };
  });
  out.partial = results.partial;
  dismissToasts();
  await closeAll();

  // --- an untracked file: some of its lines ---------------------------------------------------
  await step('untracked', async () => {
    const before = (await git('status', '--porcelain', '--', 'new.txt')).trim();
    const ed = await open('new.txt');
    ed.view.dispatch({ selection: { anchor: 0, head: ed.view.state.doc.line(3).from } }); // lines 1–2
    await app.commands.run('git-hunks:stage');
    const staged = await until(async () => (await index('new.txt')) === 'x\ny\n' && 'x\ny\n');
    const after = (await git('status', '--porcelain', '--', 'new.txt')).trim();
    service().show(ed, 3);
    const rest = await until(() => peekTitle(ed) === 'Change 1 of 1' && peekLines(ed, 'added').join());
    return { before, staged, after, rest };
  });
  out.untracked = results.untracked;
  await closeAll();

  // --- Stage Change in Source Control's diff ----------------------------------------------------
  await step('sourceControlStage', async () => {
    await app.commands.run('source-control:show');
    const row = await until(() => scRow('Changes', 'scstage.txt'));
    row.click();
    const item = await until(() => { const i = ws.getActiveItem(); return i?.type === 'diff' && diffButtons(i).length === 2 && i; });
    const r = { buttons: diffButtons(item).map((b) => b.textContent), labels: diffButtons(item).map((b) => b.getAttribute('aria-label')) };
    diffButtons(item)[1].click();
    r.staged = !!(await until(async () => (await index('scstage.txt')) === lines('s', 20, { 15: 'S 15' })));
    r.after = (await until(() => diffButtons(item).length === 1 && 1)) || diffButtons(item).length;
    r.stagedListed = !!(await until(() => scRow('Staged Changes', 'scstage.txt')));
    // The inline layout has the button too.
    item.toggleLayout();
    r.inline = (await until(() => item.element.querySelector('.cm-mergeView') == null && diffButtons(item).length === 1 && 1)) || 0;
    diffButtons(item)[0].click();
    r.allStaged = !!(await until(async () => (await index('scstage.txt')) === (await disk('scstage.txt'))));
    item.toggleLayout();
    return r;
  });
  out.sourceControlStage = results.sourceControlStage;
  await closeAll();

  // --- Unstage Change in the staged diff ------------------------------------------------------
  await step('unstage', async () => {
    const row = await until(() => scRow('Staged Changes', 'unstage.txt'));
    row.click();
    const item = await until(() => { const i = ws.getActiveItem(); return i?.type === 'diff' && diffButtons(i).length === 2 && i; });
    const r = { buttons: diffButtons(item).map((b) => b.textContent) };
    diffButtons(item)[0].click();
    r.index = !!(await until(async () => (await index('unstage.txt')) === lines('u', 20, { 15: 'U 15' })));
    r.diskKept = (await disk('unstage.txt')) === lines('u', 20, { 3: 'U 3', 15: 'U 15' });
    r.after = (await until(() => diffButtons(item).length === 1 && 1)) || diffButtons(item).length;
    r.backInChanges = !!(await until(() => scRow('Changes', 'unstage.txt')));
    // And the new file's staged lines: unstaging all of them makes it untracked again.
    scRow('Staged Changes', 'new.txt')?.click();
    const newDiff = await until(() => { const i = ws.getActiveItem(); return i?.type === 'diff' && i.kind === 'staged' && i.entry.path === 'new.txt' && diffButtons(i).length === 1 && i; });
    diffButtons(newDiff)[0].click();
    r.newUntracked = (await until(async () => { const s = (await git('status', '--porcelain', '--', 'new.txt')).trim(); return s === '?? new.txt' && s; })) || (await git('status', '--porcelain', '--', 'new.txt')).trim();
    return r;
  });
  out.unstage = results.unstage;
  await closeAll();

  // --- an unsaved buffer: the peek says so, and Stage uses the editor's text -------------------
  await step('dirty', async () => {
    const ed = await ws.open(`${root}/dirty.txt`);
    await until(() => ed.view);
    const line = ed.view.state.doc.line(4);
    ed.view.dispatch({ changes: { from: line.from, to: line.to, insert: 'DIRTY 4' }, selection: { anchor: line.from } });
    await app.commands.run('git-hunks:show');
    const note = await until(() => peek(ed)?.querySelector('.hunk-note')?.textContent);
    peekButton(ed, 'stage').click();
    const staged = await until(async () => (await index('dirty.txt')) === lines('d', 10, { 4: 'DIRTY 4' }));
    return { note, staged: !!staged, diskKept: (await disk('dirty.txt')) === lines('d', 10), stillDirty: ed.isDirty(), peekClosed: !!(await until(() => !peek(ed))) };
  });
  out.dirty = results.dirty;
  await closeAll();

  // --- Revert: one edit in the editor, undone with ⌘Z -----------------------------------------
  await step('revert', async () => {
    const ed = await open('revert.txt');
    clickMarker(ed, 5);
    await until(() => peekTitle(ed) === 'Change 1 of 1');
    peekButton(ed, 'revert').click();
    const reverted = await until(() => ed.view.state.doc.toString() === lines('r', 10));
    const r = { reverted: !!reverted, closed: !!(await until(() => !peek(ed))), indexKept: (await index('revert.txt')) === lines('r', 10) };
    key(ed.view.contentDOM, 'z', 'KeyZ', MOD);
    r.undone = ed.view.state.doc.toString() === lines('r', 10, { 5: 'R 5' });
    return r;
  });
  out.revert = results.revert;
  await closeAll();

  // --- turning the package off leaves nothing behind; on again, it all comes back ----------------
  await step('toggle', async () => {
    const ed = await open('toggle.txt');
    clickMarker(ed, 5);
    await until(() => peek(ed));
    await app.commands.run('source-control:show');
    (await until(() => scRow('Changes', 'mid.txt'))).click();
    const diff = await until(() => { const i = ws.getActiveItem(); return i?.type === 'diff' && diffButtons(i).length === 2 && i; });
    const r = { before: { peek: !!peek(ed), diffButtons: diffButtons(diff).length } };
    await app.packages.setEnabled('git-hunks', false);
    await until(() => diffButtons(diff).length === 0);
    // Whether the package's stylesheet applies: a probe element gets the peek's 3px left border.
    const rules = () => { const probe = document.body.appendChild(document.createElement('div')); probe.className = 'hunk-peek'; const on = getComputedStyle(probe).borderLeftWidth === '3px'; probe.remove(); return on; };
    r.off = {
      peeks: document.querySelectorAll('.hunk-peek').length, diffButtons: diffButtons(diff).length, service: !!service(),
      commands: app.commands.list().filter((c) => c.id.startsWith('git-hunks:')).length, styles: rules(),
    };
    await ws.openItem(ed);
    await until(() => ws.getActiveEditor() === ed);
    clickMarker(ed, 5);
    await wait(400);
    r.off.clickOpens = !!peek(ed);
    await app.packages.setEnabled('git-hunks', true);
    r.on = { service: !!(await until(() => service())), styles: !!(await until(() => rules())) };
    clickMarker(ed, 5);
    r.on.clickOpens = !!(await until(() => peek(ed)));
    await ws.openItem(diff);
    r.on.diffButtons = (await until(() => diffButtons(diff).length === 2 && 2)) || diffButtons(diff).length;
    return r;
  });
  out.toggle = results.toggle;

  // For the screenshot: a peek open in the editor.
  const last = await open('toggle.txt');
  if (!peek(last)) clickMarker(last, 5); // (it may still be open from the last step; a click would close it)
  await until(() => peek(last));
  await wait(200);

  out.errors = errors;
  out.totalErrors = errors.length;
  return out;
})()
