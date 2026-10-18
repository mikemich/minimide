// Runner and terminal over the `rproj` fixture: interactive Python, C, package.json tasks, stop,
// a plain shell and keyboard passthrough. Needs python3 and cc on PATH.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const errs = [];
  const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); oe(...a); };
  const app = window.minimide, ws = app.workspace;
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(100); } return null; };
  const key = (target, code, k, mods = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...mods }));
  const visibleTerm = () => [...document.querySelectorAll('.term-instance')].find((e) => !e.hidden);
  const termText = () => visibleTerm()?.querySelector('.xterm-rows')?.innerText || '';
  const type = (text) => { const ta = visibleTerm().querySelector('textarea'); ta.focus(); const dt = new DataTransfer(); dt.setData('text/plain', text); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
  const enter = () => key(visibleTerm().querySelector('textarea'), 'Enter', 'Enter', { keyCode: 13 });
  const out = {};
  const root = await until(() => ws.project);
  await ws.open(root + '/hello.py');
  await wait(200);
  out.runButton = !!document.querySelector('.pane.active .runner-action');
  key(window, 'F5', 'F5');
  out.prompt = !!(await until(() => termText().includes("What's your name?")));
  type('Mike'); await wait(100); enter();
  out.python = (await until(() => termText().match(/Hello, Mike! 2\+2=4/)?.[0])) || termText().slice(-200);
  out.pyExit = !!(await until(() => termText().includes('exited with code 0')));
  out.buttonBackToPlay = !!(await until(() => document.querySelector('.pane.active .runner-action .icon-play'), 3000));
  await ws.open(root + '/calc.c');
  await wait(200);
  await app.commands.run('runner:run-file');
  out.c = (await until(() => termText().match(/C says 42/)?.[0], 30000)) || termText().slice(-200);
  await app.commands.run('runner:run-task');
  const item = await until(() => [...document.querySelectorAll('.select-item')].find((e) => e.textContent.includes('greet')));
  item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  out.task = (await until(() => termText().match(/task-ran-ok/)?.[0])) || termText().slice(-200);
  // Stop a long-running program with runner:stop (Ctrl-C semantics).
  await ws.open(root + '/loop.py');
  await app.commands.run('runner:run-file');
  await until(() => document.querySelector('.term-tab.active.running'), 5000);
  await wait(800);
  await app.commands.run('runner:stop');
  out.stopWorks = !!(await until(() => /stopped|exited with code/.test(termText()), 5000));
  await app.commands.run('terminal:new');
  await wait(1200);
  type('echo shell-$((6*7))'); await wait(100); enter();
  out.shell = (await until(() => termText().match(/shell-42/)?.[0])) || termText().slice(-200);
  const ta = visibleTerm().querySelector('textarea');
  const sidebarBefore = app.sidebar.visible;
  // Ctrl-B belongs to the program in the terminal, not to "toggle sidebar".
  key(ta, 'KeyB', 'b', { ctrlKey: true });
  out.ctrlBPassedThrough = app.sidebar.visible === sidebarBefore;
  key(ta, 'Escape', 'Escape');
  await wait(100);
  out.escapeKeptPanel = app.panel.visible;
  // Reserved shortcuts still work inside the terminal: ⌘P on macOS, Ctrl-Shift-P elsewhere.
  if (isMac) key(ta, 'KeyP', 'p', { metaKey: true });
  else key(ta, 'KeyP', 'P', { ctrlKey: true, shiftKey: true });
  out.cmdPStillWorks = !!(await until(() => document.querySelector('.select-list'), 2000));
  app.ui.closeModal();
  out.errs = errs;
  return out;
})()
