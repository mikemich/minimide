// Split terminals and per-task terminal tabs over the `rproj` fixture. Needs python3 on PATH.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const errs = [];
  const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); oe(...a); };
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(100); } return null; };
  const key = (target, code, k, mods = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...mods }));
  const group = () => [...document.querySelectorAll('.term-group')].find((g) => !g.hidden);
  const splits = () => [...(group()?.querySelectorAll('.term-instance') || [])];
  const text = (inst) => inst?.querySelector('.xterm-rows')?.innerText || '';
  const type = (inst, line) => {
    const ta = inst.querySelector('textarea'); ta.focus();
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); // an unfocused test window doesn't send it
    const dt = new DataTransfer(); dt.setData('text/plain', line);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    key(ta, 'Enter', 'Enter', { keyCode: 13 });
  };
  const focusedIndex = () => splits().findIndex((s) => s.contains(document.activeElement));
  const fitted = (inst) => { const sc = inst.querySelector('.xterm-screen'); return !!sc && sc.offsetWidth > 0 && sc.offsetWidth <= inst.clientWidth && inst.clientWidth - sc.offsetWidth < 30; };
  const allFitted = () => splits().length > 0 && splits().every(fitted);
  const tabTitles = () => [...document.querySelectorAll('.term-tab-title')].map((e) => e.textContent);
  const tabFor = (title) => [...document.querySelectorAll('.term-tab')].find((t) => t.querySelector('.term-tab-title').textContent === title);
  const status = (title) => tabFor(title)?.querySelector('.term-tab-status')?.textContent || '';
  const count = (hay, needle) => hay.split(needle).length - 1;
  const out = {};

  const root = await until(() => ws.project);
  app.sidebar.show?.();

  // --- splits --------------------------------------------------------------
  await app.commands.run('terminal:new');
  await until(() => splits().length === 1 && text(splits()[0]).length > 0, 10000);
  await wait(800);
  await app.commands.run('terminal:split');
  out.splitMade = !!(await until(() => splits().length === 2, 5000));
  out.oneTab = document.querySelectorAll('.term-tab').length === 1;
  await wait(1000);
  out.focusMovesToNewSplit = focusedIndex() === 1;
  type(splits()[1], 'echo BBB$((2+1))');
  type(splits()[0], 'echo AAA$((1+1))');
  out.outputA = !!(await until(() => /^AAA2$/m.test(text(splits()[0]))));
  out.outputB = !!(await until(() => /^BBB3$/m.test(text(splits()[1]))));
  out.outputsSeparate = !text(splits()[0]).includes('BBB3') && !text(splits()[1]).includes('AAA2');

  // focus next / previous (and wrapping)
  await wait(300);
  await app.commands.run('terminal:focus-next-split');
  out.nextWorks = (await until(() => focusedIndex() === 1, 2000)) === true;
  await app.commands.run('terminal:focus-previous-split');
  out.prevWorks = (await until(() => focusedIndex() === 0, 2000)) === true;
  await app.commands.run('terminal:focus-previous-split');
  out.wrapWorks = (await until(() => focusedIndex() === 1, 2000)) === true;

  // resize: the panel's width follows the sidebar
  out.fitted = !!(await until(allFitted, 3000));
  const before = splits().map((s) => s.clientWidth);
  app.sidebar.size = 520; app.sidebar.applySize?.(); app.sidebar.emit?.('changed');
  window.dispatchEvent(new Event('resize'));
  out.fittedAfterResize = !!(await until(() => splits()[0].clientWidth !== before[0] && allFitted(), 4000));
  // drag the divider to the right
  const divider = group().querySelector('.term-divider');
  const w0 = splits()[0].clientWidth, x0 = divider.getBoundingClientRect().left;
  divider.dispatchEvent(new MouseEvent('mousedown', { clientX: x0, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x0 + 40 }));
  window.dispatchEvent(new MouseEvent('mouseup', {}));
  out.dividerDragWorks = (await until(() => splits()[0].clientWidth > w0 + 20, 2000)) === true;
  out.fittedAfterDrag = !!(await until(allFitted, 3000));

  // closing one split keeps the other (and it stays alive)
  const survivor = splits()[1];
  splits()[0].querySelector('.term-split-close').click();
  await wait(500);
  out.closeKeepsOther = !!(await until(() => splits().length === 1 && splits()[0] === survivor, 3000));
  type(splits()[0], 'echo CCC$((3+4))');
  out.otherStillLive = !!(await until(() => /^CCC7$/m.test(text(splits()[0]))));
  if (!out.otherStillLive) out.survivorText = text(splits()[0]).slice(-400); // to see why, on CI

  // exiting a split's shell removes the split
  await app.commands.run('terminal:split');
  await until(() => splits().length === 2, 5000);
  await wait(1000);
  type(splits()[1], 'exit');
  out.exitRemovesSplit = !!(await until(() => splits().length === 1, 8000));

  // at most four side by side
  for (let i = 0; i < 4; i++) { await app.commands.run('terminal:split'); await wait(150); }
  out.maxFour = splits().length === 4;
  out.tabsAfterSplits = document.querySelectorAll('.term-tab').length;
  for (const b of [...group().querySelectorAll('.term-split-close')].slice(1)) b.click();
  await until(() => splits().length === 1, 3000);
  document.querySelectorAll('.notification-close').forEach((b) => b.click());

  // --- task tabs -----------------------------------------------------------
  const runTask = async (name) => {
    await app.commands.run('runner:run-task');
    const item = await until(() => [...document.querySelectorAll('.select-item')].find((e) => e.textContent.includes(name)));
    item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  };
  await runTask('npm run greet');
  await until(() => tabFor('Task: npm run greet') && status('Task: npm run greet') === '✓', 15000);
  const greetOnce = count(text(splits()[0]), 'task-ran-ok');
  await runTask('npm run slow');
  await until(() => tabFor('Task: npm run slow'), 5000);
  out.taskTabs = tabTitles().filter((t) => t.startsWith('Task:'));
  out.okMarker = !!(await until(() => status('Task: npm run slow') === '✓', 15000)) && status('Task: npm run greet') === '✓';

  // re-running reuses (and clears) its tab
  await runTask('npm run greet');
  await until(() => count(text(splits()[0]), 'task-ran-ok') > 0, 15000);
  await until(() => status('Task: npm run greet') === '✓', 15000);
  out.taskReused = tabTitles().filter((t) => t === 'Task: npm run greet').length === 1 && tabTitles().filter((t) => t.startsWith('Task:')).length === 2;
  out.taskCleared = count(text(splits()[0]), 'task-ran-ok') === greetOnce;

  // a failing task shows its exit code
  await runTask('npm run boom');
  out.failMarker = (await until(() => status('Task: npm run boom'), 15000)) || '';

  // restarting a running task asks first
  const pid = () => text(splits()[0]).match(/beginning-(\d+)/)?.[1];
  await runTask('npm run slow');
  const p1 = await until(pid, 15000);
  await T.answers('confirm', 1); // Cancel
  await runTask('npm run slow');
  await wait(800);
  out.cancelKeepsRunning = !!p1 && pid() === p1 && tabFor('Task: npm run slow')?.classList.contains('running');
  await T.answers('confirm', 0); // Restart
  await runTask('npm run slow');
  out.restartRestarts = !!(await until(() => pid() && pid() !== p1, 8000));
  await until(() => status('Task: npm run slow') === '✓', 15000);

  // a long task that finishes out of sight tells you; one you're watching doesn't
  await app.config.set('runner.notifyAfter', 1);
  const notes = () => [...document.querySelectorAll('.notification')].filter((n) => /slow/.test(n.textContent));
  document.querySelectorAll('.notification-close').forEach((b) => b.click());
  await wait(400);
  await runTask('npm run slow');
  await until(() => status('Task: npm run slow') === '' && tabFor('Task: npm run slow')?.classList.contains('running'), 5000);
  await app.commands.run('terminal:new'); // looking elsewhere now
  await wait(300);
  out.notifiedWhenHidden = !!(await until(() => notes().some((n) => /finished/.test(n.textContent)), 12000));
  const show = notes()[0]?.querySelector('.notification-actions button');
  show?.click();
  out.showButtonWorks = !!(await until(() => tabFor('Task: npm run slow')?.classList.contains('active'), 3000));
  document.querySelectorAll('.notification-close').forEach((b) => b.click());
  await wait(400);
  await runTask('npm run slow'); // stays visible this time
  await until(() => status('Task: npm run slow') === '✓', 15000);
  await wait(500);
  out.quietWhenVisible = notes().length === 0;

  // F5 on a file gets its own tab; Stop reaches the most recent task even from another tab
  await ws.open(root + '/loop.py');
  await app.commands.run('runner:run-file');
  await until(() => tabFor('Task: loop.py')?.classList.contains('running'), 5000);
  out.runFileTab = tabTitles().find((t) => t === 'Task: loop.py');
  await wait(800);
  await app.commands.run('terminal:new');
  await wait(500);
  await app.commands.run('runner:stop');
  out.stopTargetsRecentTask = !!(await until(() => tabFor('Task: loop.py') && !tabFor('Task: loop.py').classList.contains('running'), 6000));
  out.stoppedMarker = status('Task: loop.py').startsWith('✗');

  out.errs = errs;
  return out;
})()
