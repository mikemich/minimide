// Debugger: breakpoints in a gutter, then step through a Python or JavaScript file and look at
// its variables. Talks the Debug Adapter Protocol to debugpy (Python) or to node-adapter.mjs
// (JavaScript, via Node's built-in inspector). Keys: Alt-F5 starts; while a session runs, F5
// continues and Shift-F5 stops (otherwise those keys belong to the Code Runner); F9 toggles a
// breakpoint; F10 / F11 / Shift-F11 step over, into and out.
import { DapClient } from './dap.js';
import { configFor, kindFor } from './launch.js';
import { editorParts } from './gutter.js';
import { createViews } from './views.js';

const ICONS = {
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 20v-9M8 13H4M20 13h-4M9 7L7 4M15 7l2-3M8 17l-3 2M16 17l3 2M8 10l-3-2M16 10l3-2"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  'step-over': '<path d="M4 13a8 8 0 0 1 15-3"/><path d="M20 5v5h-5"/><circle cx="12" cy="19" r="1.5"/>',
  'step-into': '<path d="M12 3v11M7 9l5 5 5-5"/><circle cx="12" cy="20" r="1.5"/>',
  'step-out': '<path d="M12 15V4M7 9l5-5 5 5"/><circle cx="12" cy="20" r="1.5"/>',
};

export function activate(mide) {
  for (const [name, svg] of Object.entries(ICONS)) mide.ui.registerIcon(name, svg);
  const { EditorView } = mide.cm.view;

  let session = null; // { client, config, state: 'starting'|'running'|'stopped', frames, frameId, scopes, … }
  let current = null; // { path, line, top }: where the editor shows the paused line
  let bps = new Map(); // path -> [{ line, condition?, verified?, message?, id? }]
  let watches = [];

  // --- breakpoints ---------------------------------------------------------------
  const parts = editorParts(mide, {
    onClick: (view, line) => { const p = pathOfView(view); if (p) toggleBreakpoint(p, line); },
    onContextMenu: (view, line) => { const p = pathOfView(view); if (p) breakpointMenu(p, line); },
  });
  mide.editor.addExtension(parts.extension);

  const editors = (path) => mide.workspace.getItems().filter((i) => i.type === 'editor' && i.view && (!path || i.getPath() === path));
  const pathOfView = (view) => {
    const item = editors().find((i) => i.view === view);
    if (!item?.getPath()) { mide.notify.info('Save the file to set breakpoints in it.'); return null; }
    return item.getPath();
  };
  const listFor = (path) => bps.get(path) || [];

  function load() {
    bps = new Map(Object.entries(mide.state.get('breakpoints') || {}).filter(([, l]) => Array.isArray(l) && l.length));
    watches = mide.state.get('watches') || [];
    for (const item of editors()) push(item);
    views.update();
  }

  function persist() {
    mide.state.set('breakpoints', Object.fromEntries([...bps].map(([p, list]) => [p, list.map(({ line, condition }) => (condition ? { line, condition } : { line }))])));
  }

  function push(item) {
    const path = item.getPath();
    item.view.dispatch({ effects: [
      parts.setBreakpoints.of(path ? listFor(path) : []),
      parts.setCurrent.of(current && current.path === path ? current : null),
    ] });
  }

  function setList(path, list) {
    const seen = new Set();
    list = list.filter((b) => !seen.has(b.line) && seen.add(b.line)).sort((a, b) => a.line - b.line);
    if (list.length) bps.set(path, list); else bps.delete(path);
    persist();
    for (const item of editors(path)) push(item);
    views.renderBreakpoints();
    if (session) scheduleSend(path);
  }

  function toggleBreakpoint(path, line) {
    const list = listFor(path);
    setList(path, list.some((b) => b.line === line) ? list.filter((b) => b.line !== line) : [...list, { line }]);
  }

  async function editCondition(path, line) {
    const bp = listFor(path).find((b) => b.line === line);
    const condition = await mide.ui.prompt({ title: `Stop at line ${line} only when this is true (empty: always)`, value: bp?.condition || '', placeholder: 'x > 10' });
    if (condition == null) return;
    setList(path, [...listFor(path).filter((b) => b.line !== line), { line, ...(condition.trim() ? { condition: condition.trim() } : {}) }]);
  }

  async function breakpointMenu(path, line) {
    const has = listFor(path).some((b) => b.line === line);
    const choice = await mide.ui.contextMenu(has
      ? [{ id: 'condition', label: 'Edit Condition…' }, { id: 'remove', label: 'Remove Breakpoint' }]
      : [{ id: 'add', label: 'Add Breakpoint' }, { id: 'condition', label: 'Add Conditional Breakpoint…' }]);
    if (choice === 'add' || choice === 'remove') toggleBreakpoint(path, line);
    else if (choice === 'condition') editCondition(path, line);
  }

  // Edits move breakpoints along with their lines (the gutter maps them); keep our copy in step.
  const editTimers = new Map();
  mide.workspace.onDidUpdateEditor((item, update) => {
    const path = item.getPath?.();
    if (!update?.docChanged || !path || !item.view || !bps.has(path)) return;
    const moved = parts.read(item.view);
    const before = listFor(path);
    if (moved.length === before.length && moved.every((b, i) => b.line === before[i].line)) return;
    bps.set(path, moved);
    clearTimeout(editTimers.get(path));
    editTimers.set(path, setTimeout(() => setList(path, parts.read(item.view)), 300));
  });
  mide.workspace.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => item.view && push(item), 0); });
  mide.workspace.onDidChangeProject(() => { if (session) stop(); load(); });

  // --- the session -------------------------------------------------------------------
  const sendTimers = new Map();
  function scheduleSend(path) {
    clearTimeout(sendTimers.get(path));
    sendTimers.set(path, setTimeout(() => session && sendBreakpoints(session, path), 150));
  }

  async function sendBreakpoints(s, path) {
    const list = listFor(path);
    try {
      const r = await s.client.request('setBreakpoints', {
        source: { path, name: mide.path.basename(path) },
        breakpoints: list.map(({ line, condition }) => (condition ? { line, condition } : { line })),
      });
      if (s !== session || bps.get(path) !== list) return;
      list.forEach((b, i) => {
        const v = r.breakpoints?.[i];
        Object.assign(b, { verified: v ? v.verified !== false : false, message: v?.message, id: v?.id });
      });
      setList(path, list);
    } catch (err) {
      views.log(`Couldn't set breakpoints in ${mide.path.basename(path)}: ${err.message}\n`, 'stderr');
    }
  }

  function clearVerified() {
    for (const list of bps.values()) for (const b of list) { delete b.verified; delete b.message; delete b.id; }
    for (const item of editors()) push(item);
  }

  async function start() {
    if (session) return restart();
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return mide.notify.info('Open a Python or JavaScript file to debug it.');
    if (!kindFor(editor.getPath() || '')) {
      return mide.notify.info('Debugging works for Python and JavaScript files', editor.getPath() ? 'Run other files with F5 (Code Runner).' : 'Save the file with a .py or .js name first.');
    }
    if (editor.isDirty() && !await mide.workspace.save(editor)) return;
    const path = editor.getPath();
    // Debugging runs the folder's code (and debugpy can import from it): trusted folders only.
    if (!mide.workspace.isTrusted(path)) {
      mide.notify.info('Debugging is off in Restricted Mode', 'Trust this folder to run its programs under the debugger.', {
        actions: [{ label: 'Trust Folder…', run: async () => { if (await mide.workspace.requestTrust()) start(); } }],
      });
      return false;
    }
    const config = await configFor(mide, path);
    if (config) await launch(config, path);
  }

  async function launch(config, path) {
    const s = { config, path, state: 'starting', frames: [], scopes: [], stderr: '' };
    session = s;
    current = null;
    views.update();
    views.note(`Debugging ${mide.path.basename(path)}`);
    mide.sidebar.show('debug');
    mide.panel.show('debug-console');
    let resolveInit;
    const initialized = new Promise((r) => { resolveInit = r; });
    s.client = new DapClient(mide, config.argv, {
      cwd: config.cwd,
      onEvent: (name, body) => (name === 'initialized' ? resolveInit() : onEvent(s, name, body)),
      onStderr: (data) => { s.stderr = (s.stderr + data).slice(-4000); },
      onExit: () => {
        if (s.ended) return;
        if (!s.stopping && !s.terminated) {
          const why = s.stderr.trim().split('\n').pop();
          mide.notify.error('The debugger stopped unexpectedly', why || 'Its process exited. Try starting again.');
        }
        end(s);
      },
    });
    try {
      s.caps = await s.client.request('initialize', {
        clientID: 'minimide', clientName: 'Minimide', adapterID: config.kind, locale: 'en',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true,
      });
      // debugpy answers `launch` only after configurationDone, so don't wait for it here.
      const launched = s.client.request('launch', config.args, { timeout: 30000 });
      launched.catch(() => {});
      await Promise.race([initialized, launched.then(() => initialized)]);
      for (const p of bps.keys()) await sendBreakpoints(s, p);
      const filters = (s.caps.exceptionBreakpointFilters || []).filter((f) => f.default).map((f) => f.filter);
      if (s.caps.exceptionBreakpointFilters) await s.client.request('setExceptionBreakpoints', { filters });
      if (s.caps.supportsConfigurationDoneRequest) await s.client.request('configurationDone');
      await launched;
      if (s.state === 'starting') { s.state = 'running'; views.update(); }
    } catch (err) {
      if (s.ended) return;
      mide.notify.error("Couldn't start debugging", err.message);
      s.stopping = true;
      end(s);
    }
  }

  async function onEvent(s, name, body) {
    if (s.ended) return;
    if (name === 'output') {
      if (body.category !== 'telemetry' && body.output) views.log(body.output, body.category === 'stderr' ? 'stderr' : body.category === 'console' || body.category === 'important' ? 'console' : 'stdout');
    } else if (name === 'stopped') {
      s.state = 'stopped';
      s.threadId = body.threadId ?? s.threadId ?? 1;
      s.stopReason = body.reason;
      s.stopText = body.text || body.description;
      await loadStack(s);
    } else if (name === 'continued') {
      resumed(s);
    } else if (name === 'breakpoint' && body.breakpoint?.id != null) {
      for (const [path, list] of bps) {
        const b = list.find((x) => x.id === body.breakpoint.id);
        if (!b) continue;
        b.verified = body.breakpoint.verified !== false;
        if (body.breakpoint.line) b.line = body.breakpoint.line;
        setList(path, list);
      }
    } else if (name === 'exited') {
      views.note(`Program exited with code ${body.exitCode}`);
    } else if (name === 'terminated') {
      s.terminated = true;
      end(s);
    }
  }

  async function loadStack(s) {
    let frames = [];
    try {
      frames = (await s.client.request('stackTrace', { threadId: s.threadId, startFrame: 0, levels: 100 })).stackFrames || [];
    } catch (err) {
      views.log(`${err.message}\n`, 'stderr');
    }
    if (s !== session || s.state !== 'stopped') return;
    s.frames = frames;
    // Show the innermost frame that is in a file (not Node's internals).
    await selectFrame(frames.find((f) => f.source?.path) || frames[0], s);
  }

  async function selectFrame(frame, s = session) {
    if (!s || !frame) { views.update(); return; }
    s.frameId = frame.id;
    current = frame.source?.path ? { path: frame.source.path, line: frame.line, top: frame === s.frames[0] } : null;
    for (const item of editors()) push(item);
    if (current) reveal(current.path, current.line);
    try {
      s.scopes = (await s.client.request('scopes', { frameId: frame.id })).scopes || [];
    } catch { s.scopes = []; }
    if (s === session) views.update();
  }

  async function reveal(path, line) {
    // Don't take the keyboard from the Debug Console while you type there.
    const typing = document.activeElement?.closest?.('.dbg-console');
    const item = await mide.workspace.open(path, { focus: !typing });
    if (!item?.view) return;
    push(item);
    const doc = item.view.state.doc;
    item.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(Math.min(line, doc.lines)).from, { y: 'center' }) });
  }

  function resumed(s) {
    s.state = 'running';
    s.frames = [];
    s.scopes = [];
    s.frameId = null;
    current = null;
    for (const item of editors()) push(item);
    views.update();
  }

  function end(s) {
    if (s.ended) return;
    s.ended = true;
    if (!s.client.exited) {
      // Let the adapter shut down cleanly; make sure it's gone either way.
      s.client.request('disconnect', { terminateDebuggee: true }, { timeout: 1500 }).catch(() => {}).finally(() => s.client.kill());
    }
    if (session !== s) return;
    session = null;
    current = null;
    clearVerified();
    views.note('Debugging ended');
    views.update();
  }

  async function stop() {
    const s = session;
    if (!s) return;
    s.stopping = true;
    if (s.caps?.supportsTerminateRequest && !s.client.exited) {
      await s.client.request('terminate', {}, { timeout: 2000 }).catch(() => {});
      // Give the program a moment to end on its own (its `terminated` event ends the session).
      await new Promise((r) => setTimeout(r, 300));
    }
    end(s);
  }

  async function restart() {
    const s = session;
    if (!s) return start();
    await stop();
    await launch(s.config, s.path);
  }

  // Continue and the steps. The next `stopped` event may arrive before the answer (a quick
  // step): only clear the paused state if nothing stopped since.
  async function step(command) {
    const s = session;
    if (!s || s.state !== 'stopped') return;
    s.state = 'running';
    try {
      await s.client.request(command, { threadId: s.threadId });
      if (session === s && s.state === 'running') resumed(s);
    } catch (err) {
      s.state = 'stopped';
      views.log(`${err.message}\n`, 'stderr');
    }
  }

  async function pause() {
    const s = session;
    try {
      const threadId = s.threadId ?? (await s.client.request('threads')).threads?.[0]?.id ?? 1;
      await s.client.request('pause', { threadId });
    } catch (err) {
      views.log(`${err.message}\n`, 'stderr');
    }
  }

  async function evaluate(expression, context) {
    const s = session;
    if (!s) throw new Error('Start debugging to evaluate expressions.');
    if (s.state !== 'stopped' && context !== 'repl') throw new Error('Not paused.');
    const r = await s.client.request('evaluate', { expression, context, ...(s.state === 'stopped' && s.frameId != null ? { frameId: s.frameId } : {}) });
    return r;
  }

  // --- views ---------------------------------------------------------------------------
  const views = createViews(mide, {
    session: () => session,
    selectFrame: (f) => selectFrame(f),
    variables: async (ref) => (session ? (await session.client.request('variables', { variablesReference: ref })).variables || [] : []),
    evaluate,
    watches: () => watches,
    addWatch: async () => {
      const expr = await mide.ui.prompt({ title: 'Watch an expression', placeholder: 'e.g. total / count' });
      if (!expr?.trim()) return;
      watches = [...watches, expr.trim()];
      mide.state.set('watches', watches);
      views.renderWatch();
    },
    removeWatch: (i) => { watches = watches.filter((_, j) => j !== i); mide.state.set('watches', watches); views.renderWatch(); },
    allBreakpoints: () => [...bps].sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, list]) => list.map((b) => ({ path, ...b }))),
    toggleBreakpoint,
    removeAllBreakpoints: () => { for (const p of [...bps.keys()]) setList(p, []); },
    goTo: (path, line) => mide.workspace.open(path, { line }),
  });
  mide.sidebar.addView({ id: 'debug', title: 'Debug', icon: 'bug', order: 20, command: 'debugger:show', element: views.sidebar });
  mide.panel.addView({ id: 'debug-console', title: 'Debug Console', icon: 'bug', order: 25, command: 'debugger:show-console', element: views.console, focus: views.focusConsole });

  // --- commands --------------------------------------------------------------------------
  const active = () => !!session;
  const paused = () => session?.state === 'stopped';
  mide.commands.add({
    'debugger:start': { title: 'Start Debugging', run: start },
    'debugger:continue': { title: 'Continue', when: active, run: () => step('continue') },
    'debugger:pause': { title: 'Pause', when: () => session?.state === 'running', run: pause },
    'debugger:step-over': { title: 'Step Over', when: paused, run: () => step('next') },
    'debugger:step-into': { title: 'Step Into', when: paused, run: () => step('stepIn') },
    'debugger:step-out': { title: 'Step Out', when: paused, run: () => step('stepOut') },
    'debugger:stop': { title: 'Stop Debugging', when: active, run: stop },
    'debugger:restart': { title: 'Restart Debugging', when: active, run: restart },
    'debugger:toggle-breakpoint': {
      title: 'Toggle Breakpoint',
      run: () => {
        const editor = mide.workspace.getActiveEditor();
        if (!editor?.view) return;
        const p = pathOfView(editor.view);
        if (p) toggleBreakpoint(p, editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
      },
    },
    'debugger:edit-condition': {
      title: 'Edit Breakpoint Condition…',
      run: () => {
        const editor = mide.workspace.getActiveEditor();
        const p = editor?.view && pathOfView(editor.view);
        if (p) editCondition(p, editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number);
      },
    },
    'debugger:remove-all-breakpoints': { title: 'Remove All Breakpoints', run: () => { for (const p of [...bps.keys()]) setList(p, []); } },
    'debugger:show': { title: 'Show Debug View', run: () => mide.sidebar.show('debug', { focus: true }) },
    'debugger:show-console': { title: 'Show Debug Console', run: () => mide.panel.show('debug-console', { focus: true }) },
    'debugger:clear-console': { title: 'Clear Debug Console', run: () => views.clearConsole() },
  });
  // F-keys work inside the terminal anyway; these keep stepping usable from there too.
  mide.keymap.allowInPassthrough('debugger:continue', 'debugger:stop', 'debugger:step-over', 'debugger:step-into', 'debugger:step-out');

  load();

  // Disabling the package or closing the window ends the program too.
  return () => { if (session) { const s = session; s.stopping = true; end(s); s.client.kill(); } };
}
