// Debugger over the `dbgproj` fixture: breakpoints from the gutter and F9, breakpoints moving with
// edits and saved with the session, Restricted Mode, then a debug session in JavaScript (and in
// Python when debugpy is installed): stop at a breakpoint, read a variable, step, evaluate, finish.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const errs = [];
  const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); oe(...a); };
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(100); } return null; };
  const key = (target, code, k, mods = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...mods }));
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const state = () => app.packageState('debugger');
  const markerLines = (item) => {
    const view = item.view;
    return [...view.dom.querySelectorAll('.cm-debug-gutter .dbg-marker.bp')].map((el) => {
      const r = el.getBoundingClientRect();
      return view.state.doc.lineAt(view.lineBlockAtHeight(r.top + r.height / 2 - view.documentTop).from).number;
    });
  };
  const currentLine = (item) => {
    const el = item.view.dom.querySelector('.cm-debug-current');
    return el ? item.view.state.doc.lineAt(item.view.posAtDOM(el)).number : null;
  };
  // Click the debug gutter at the line's height (by position, not by counting gutter elements,
  // which can include spacers and lines rendered outside the viewport).
  const clickGutter = (item, line) => {
    const view = item.view;
    const gutter = view.dom.querySelector('.cm-debug-gutter');
    const g = gutter.getBoundingClientRect();
    const block = view.lineBlockAt(view.state.doc.line(line).from);
    const y = view.documentTop + block.top + block.height / 2;
    const target = document.elementFromPoint(g.left + g.width / 2, y) || gutter;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: g.left + g.width / 2, clientY: y }));
  };
  const consoleText = () => document.querySelector('.dbg-console-output')?.textContent || '';
  const out = { errors: [] };
  const root = await until(() => ws.project);

  // --- breakpoints in the editor ---------------------------------------------------
  const js = await ws.open(root + '/app.js');
  await wait(300);
  out.gutter = !!js.view.dom.querySelector('.cm-debug-gutter');
  clickGutter(js, 2);
  await wait(50);
  out.afterClick = markerLines(js);
  clickGutter(js, 2);
  await wait(50);
  out.afterSecondClick = markerLines(js);
  js.goToLine(7);
  key(js.view.contentDOM, 'F9', 'F9');
  await wait(50);
  out.afterF9 = markerLines(js);
  key(js.view.contentDOM, 'F9', 'F9');
  await wait(50);
  out.afterF9Again = markerLines(js);

  // A breakpoint on line 2 moves down when a line goes in above it, and back when it's removed.
  clickGutter(js, 2);
  js.view.dispatch({ changes: { from: 0, insert: '// a note\n' } });
  await wait(50);
  out.afterInsert = markerLines(js);
  await wait(500);
  out.listAfterInsert = text('.dbg-bp');
  js.view.dispatch({ changes: { from: 0, to: 10 } });
  await wait(500);
  out.afterRemove = markerLines(js);
  out.saved = JSON.stringify(state().breakpoints?.[root + '/app.js']);
  await ws.save(js);

  // --- Restricted Mode ---------------------------------------------------------------
  const isTrusted = app.trust.isTrusted;
  app.trust.isTrusted = () => false;
  await app.commands.run('debugger:start');
  out.untrustedNotice = !!(await until(() => [...document.querySelectorAll('.notification-title')].some((e) => /Restricted Mode/.test(e.textContent)), 3000));
  out.untrustedStatus = text('.dbg-status');
  app.trust.isTrusted = isTrusted;
  document.querySelectorAll('.notification').forEach((n) => n.remove());

  // --- a session -------------------------------------------------------------------------
  async function session(item, { varName, varValue, expr }) {
    const r = {};
    await ws.open(item.getPath());
    await wait(100);
    const startedAt = consoleText().length;
    await app.commands.run('debugger:start');
    r.stopped = (await until(() => /^Paused on breakpoint/.test(text('.dbg-status')) && text('.dbg-status'), 30000)) || text('.dbg-status');
    r.line = await until(() => currentLine(item), 5000);
    r.frame = text('.dbg-frame.selected .dbg-frame-name');
    r.value = await until(() => text(`.dbg-var[data-name="${varName}"] .dbg-var-value`), 5000);
    // F10 steps over.
    key(item.view.contentDOM, 'F10', 'F10');
    r.stepped = await until(() => text('.dbg-status') === 'Paused' && currentLine(item) !== r.line && currentLine(item), 10000);
    // The Debug Console evaluates in the paused frame.
    const input = document.querySelector('.dbg-console-input');
    input.value = expr;
    key(input, 'Enter', 'Enter');
    r.evaluated = await until(() => [...document.querySelectorAll('.dbg-eval-out')].pop()?.textContent, 5000);
    // Drop the breakpoint and run to the end.
    clickGutter(item, 2);
    await wait(300);
    key(item.view.contentDOM, 'F5', 'F5');
    r.ended = !!(await until(() => /^Not running/.test(text('.dbg-status')), 20000));
    r.output = consoleText().slice(startedAt);
    r.noCurrentLine = currentLine(item) == null;
    return r;
  }

  js.goToLine(1);
  out.node = await session(js, { varName: 'a', varValue: '0', expr: 'a + b * 10' });
  out.unverifiedAfter = !!js.view.dom.querySelector('.dbg-marker.unverified');

  // The same check the debugger makes: python3 from a login shell, as the app starts it.
  const python = app.config.get('debugger.python') || 'python3';
  const hasDebugpy = (await window.native.proc.exec(app.userInfo.shell || '/bin/sh', ['-lc', `${python} -c "import debugpy"`], {})).code === 0;
  if (hasDebugpy) {
    const py = await ws.open(root + '/app.py');
    await wait(300);
    clickGutter(py, 2);
    py.goToLine(1);
    out.python = await session(py, { varName: 'a', varValue: '0', expr: 'a + b * 10' });
  } else out.python = 'skipped';

  out.errors = errs.filter((e) => !/ResizeObserver/.test(e));
  return out;
})()
