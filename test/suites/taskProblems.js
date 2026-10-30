// Problems from task output over the `tpproj` fixture: the `check` task prints compiler-like errors,
// other.js (run with F5) one more, and the fake language server flags `lsp-error` in src/app.ts. They
// share the Problems view and the editor's underlines; clicking a row and F8 / Shift-F8 jump to them; a
// task's problems are replaced when it runs again; custom matchers, list-only mode, Clear, and turning
// lsp or task-problems off and on again.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, native = window.native;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const root = await until(() => ws.project);
  const out = {};
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { out[name] = await fn(); } catch (e) { out[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) out[name] = [out[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };

  // --- helpers ---------------------------------------------------------------------
  const svc = () => app.packages.services.get('diagnostics');
  const term = () => app.packages.services.get('terminal');
  const parent = root.slice(0, root.lastIndexOf('/'));
  const rel = (p) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p.startsWith(parent + '/') ? '../' + p.slice(parent.length + 1) : p);
  const SEV = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
  /** Every problem the core knows, as "file:line:col source severity message", sorted. */
  const known = (source) => svc().all().flatMap(({ path, list }) => list.filter((d) => !source || d.source === source)
    .map((d) => `${rel(path)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source} ${SEV[d.severity]} ${d.message}`)).sort();
  /** The Problems view's rows: "file line:col source: message". */
  const rows = () => [...document.querySelectorAll('.lsp-problem-file')].flatMap((f) => {
    const name = f.querySelector('.lsp-problem-file-name').textContent;
    return [...f.querySelectorAll('.lsp-problem')].map((r) => `${name} ${r.querySelector('.lsp-problem-pos').textContent} ${r.querySelector('.lsp-problem-src')?.textContent || ''}: ${r.querySelector('.lsp-problem-msg').textContent}`);
  }).sort();
  /** What an editor underlines, by severity and line: "error@2:n". */
  const marks = (ed) => {
    const by = new Map();
    for (const el of ed.view.contentDOM.querySelectorAll('.cm-lintRange')) {
      const sev = [...el.classList].find((c) => c.startsWith('cm-lintRange-')).slice('cm-lintRange-'.length);
      const key = `${sev}@${ed.view.state.doc.lineAt(ed.view.posAtDOM(el)).number}`;
      by.set(key, (by.get(key) || '') + el.textContent);
    }
    return [...by].map(([k, v]) => `${k}:${v}`).sort();
  };
  const gutterMarks = (ed) => ed.view.dom.querySelectorAll('.cm-lint-marker').length;
  const editor = async (n) => { const ed = await ws.open(`${root}/${n}`); await until(() => ed.view); await wait(80); return ed; };
  const cursorAt = (ed) => `${ed.getPath().split('/').pop()}:${ed.getCursor().line}:${ed.getCursor().col}`;
  const settle = async (fn) => { let last = JSON.stringify(fn()); for (let i = 0; i < 10; i++) { await wait(250); const now = JSON.stringify(fn()); if (now === last) return; last = now; } };

  /** Run a task from ⌘⇧B's list and wait for it to finish. */
  const runTask = async (name) => {
    await app.commands.run('runner:run-task');
    const item = await until(() => [...document.querySelectorAll('.select-item')].find((e) => e.querySelector('.select-label')?.textContent === name));
    item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await until(() => term().isRunning(`task:${name}`), 3000);
    await until(() => !term().isRunning(`task:${name}`));
    await wait(400); // problems are added once their file is found
  };
  const press = async (key, mods = {}) => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...mods }));
    await wait(250);
  };

  const ts = await editor('src/app.ts');
  await until(() => document.querySelector('.lsp-status[data-state="ready"]'), 15000);
  app.panel.show('problems');

  await step('lspAlone', async () => ({ rows: await until(() => rows().length === 1 && rows()) || rows(), marks: marks(ts) }));

  // --- the first run --------------------------------------------------------------------------
  await step('firstRun', async () => {
    await runTask('check');
    await until(() => known('check').length === 5);
    await settle(rows);
    const rowEls = [...document.querySelectorAll('.lsp-problem')];
    return {
      problems: known('check'),
      rows: rows(),
      // Reachable with Tab, Enter opens it, and its text names it.
      accessible: rowEls.length > 0 && rowEls.every((r) => r.tabIndex === 0 && r.innerText.trim().length > 0),
      marks: marks(ts), gutter: gutterMarks(ts),
      counts: svc().counts(),
      status: document.querySelector('.lsp-counts')?.textContent,
    };
  });

  // A second task, run with F5, has its own label.
  await step('secondTask', async () => {
    await editor('other.js');
    await app.commands.run('runner:run-file');
    await until(() => known('other.js').length === 1);
    await editor('src/app.ts');
    await until(() => marks(ts).length === 4);
    await until(() => rows().length === 7);
    return { problems: known('other.js'), marks: marks(ts), sources: [...new Set(rows().map((r) => r.split(' ')[2].replace(':', '')))].sort() };
  });

  // --- jumping ----------------------------------------------------------------------------------
  await step('jump', async () => {
    const row = [...document.querySelectorAll('.lsp-problem')].find((r) => r.textContent.includes("expected ';'"));
    row.click();
    const ed = await until(() => { const a = ws.getActiveEditor(); return a?.getPath() === `${root}/lib/util.c` && a; });
    await wait(200);
    return { at: ed && cursorAt(ed), marks: ed ? await until(() => marks(ed).length && marks(ed)) : null };
  });

  await step('nextPrevious', async () => {
    const ed = await editor('src/app.ts');
    ed.view.dispatch({ selection: { anchor: 0 } });
    ed.view.focus();
    const seen = [];
    for (const [key, mods] of [['F8'], ['F8'], ['F8'], ['F8', { shiftKey: true }], ['F8'], ['F8']]) {
      await press(key, mods);
      seen.push(cursorAt(ws.getActiveEditor()));
    }
    // From the last problem in app.ts, the next file's first problem, in the Problems view's order.
    const files = svc().all().map((f) => f.path);
    const next = files[(files.indexOf(`${root}/src/app.ts`) + 1) % files.length];
    await press('F8');
    return { seen, nextFile: ws.getActiveEditor()?.getPath() === next };
  });

  // The language server publishing again (after an edit) leaves the task's problems alone.
  await step('lspRepublishes', async () => {
    const ed = await editor('src/app.ts');
    const before = (await native.fs.read(`${app.userInfo.dir}/fake-lsp.json`)).length;
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: '// lsp-error again\n' } });
    const lsp = await until(() => known('fake').length === 2 && known('fake'));
    await wait(300);
    const r = { lsp, marks: marks(ed), task: known('check').length };
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length - '// lsp-error again\n'.length, to: ed.view.state.doc.length } });
    await until(() => known('fake').length === 1);
    r.logged = before > 0;
    return r;
  });

  // --- running again --------------------------------------------------------------------------
  await step('rerun', async () => {
    await native.fs.write(`${root}/mode.txt`, 'short\n');
    await runTask('check');
    await until(() => known('check').length === 1);
    await settle(() => marks(ts));
    return { check: known('check'), other: known('other.js'), lsp: known('fake'), marks: marks(ts) };
  });

  // Problems stay until the task runs again.
  await step('kept', async () => { await wait(1500); return known('check'); });

  // --- custom matchers ------------------------------------------------------------------------
  await step('customMatchers', async () => {
    for (const n of document.querySelectorAll('.notification')) n.remove();
    await app.config.set('task-problems.matchers', { mine: '^CHECK (?<file>\\S+)#(?<line>\\d+) (?<message>.*)$', broken: '^(?<file>[^:]+:(?<line>\\d+)' });
    const note = await until(() => [...document.querySelectorAll('.notification')].find((n) => /matcher/.test(n.textContent)));
    await native.fs.write(`${root}/mode.txt`, 'full\n');
    await runTask('check');
    await until(() => known('check').length === 6);
    return { reported: note?.textContent.includes('“broken” is not a valid regular expression') || note?.textContent || null, mine: known('check').filter((p) => p.includes('format of my own')) };
  });

  // --- list only ------------------------------------------------------------------------------
  await step('listOnly', async () => {
    await app.config.set('task-problems.showInEditor', false);
    await settle(() => marks(ts));
    const off = { marks: marks(ts), gutter: gutterMarks(ts), listed: known('check').length };
    await app.config.set('task-problems.showInEditor', true);
    await settle(() => marks(ts));
    return { off, on: marks(ts) };
  });

  // --- Clear Task Problems ------------------------------------------------------------------------
  await step('clear', async () => {
    const enabled = app.commands.isEnabled('task-problems:clear');
    await app.commands.run('task-problems:clear');
    await settle(rows);
    return { enabled, left: known(), rows: rows(), marks: marks(ts), enabledAfter: app.commands.isEnabled('task-problems:clear') };
  });

  // --- the language servers off: task problems still in editors, and in their own list -------------
  await step('lspOff', async () => {
    await runTask('check');
    await until(() => known('check').length === 6);
    await app.packages.setEnabled('lsp', false);
    await settle(() => marks(ts));
    const off = { marks: marks(ts), gutter: gutterMarks(ts), view: !!document.querySelector('.lsp-problems'), known: known().length };
    await app.commands.run('task-problems:list');
    off.listed = (await until(() => document.querySelectorAll('.select-item').length)) || 0;
    app.ui.closeModal();
    await app.packages.setEnabled('lsp', true);
    await until(() => document.querySelector('.lsp-status[data-state="ready"]'), 15000);
    await until(() => known('fake').length === 1);
    app.panel.show('problems');
    await settle(rows);
    return { off, rowsOn: rows().length, marksOn: marks(ts) };
  });

  // --- task-problems off and on again ------------------------------------------------------------
  await step('packageOff', async () => {
    await app.packages.setEnabled('task-problems', false);
    await settle(() => marks(ts));
    const off = { known: known(), marks: marks(ts), commands: ['task-problems:clear', 'task-problems:list'].filter((id) => app.commands.has(id)) };
    await runTask('check'); // the runner and terminal don't need it
    off.afterRun = known().length;
    off.ran = /✗/.test([...document.querySelectorAll('.term-tab')].find((t) => t.textContent.includes('Task: check'))?.textContent || '');
    await app.packages.setEnabled('task-problems', true);
    await wait(300);
    const on = { known: known().length, commands: ['task-problems:clear', 'task-problems:list'].filter((id) => app.commands.has(id)).length };
    await runTask('check');
    await until(() => known('check').length === 6);
    await settle(() => marks(ts));
    on.afterRun = known('check').length;
    on.marks = marks(ts);
    return { off, on };
  });

  out.errors = errors;
  out.totalErrors = errors.length;
  return out;
})()
