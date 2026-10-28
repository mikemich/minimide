// The Debug sidebar view (toolbar, call stack, variables, watch, breakpoints) and the Debug
// Console panel view (the program's output, plus a box to evaluate expressions while paused).

export function createViews(mide, ctrl) {
  const { h, icon } = mide.ui;

  // --- sidebar -------------------------------------------------------------------
  const toolbar = h('div.dbg-toolbar');
  const status = h('div.dbg-status');
  const stackList = h('div.dbg-list');
  const varsList = h('div.dbg-list');
  const watchList = h('div.dbg-list');
  const bpList = h('div.dbg-list');
  const collapsed = new Set();

  function section(id, title, list, actions = []) {
    const el = h('div.dbg-section',
      h('div.dbg-section-header', { onclick: (e) => { if (!e.target.closest('button')) toggleSection(id, el); } },
        icon('chevron', 12), h('span', title), h('div.dbg-section-actions', actions)),
      list);
    el.classList.toggle('collapsed', collapsed.has(id));
    return el;
  }
  function toggleSection(id, el) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    el.classList.toggle('collapsed', collapsed.has(id));
  }
  const smallBtn = (name, title, run) => h('button.icon-btn', { title, onclick: run }, icon(name, 14));

  const element = h('div.dbg-view',
    h('div.dbg-header', h('span.dbg-title', 'Debug'), toolbar),
    status,
    h('div.dbg-body',
      section('stack', 'Call Stack', stackList),
      section('vars', 'Variables', varsList),
      section('watch', 'Watch', watchList, [smallBtn('plus', 'Add expression', () => ctrl.addWatch())]),
      section('bps', 'Breakpoints', bpList, [smallBtn('trash', 'Remove all breakpoints', () => ctrl.removeAllBreakpoints())])));

  const button = (id, name, title, enabled = true) => h('button.icon-btn', {
    title, disabled: !enabled, dataset: { command: id }, onclick: () => mide.commands.run(id),
  }, icon(name, 15));

  function renderToolbar() {
    const s = ctrl.session();
    if (!s) {
      toolbar.replaceChildren(button('debugger:start', 'play', 'Start Debugging'));
      return;
    }
    const paused = s.state === 'stopped';
    toolbar.replaceChildren(
      paused ? button('debugger:continue', 'play', 'Continue') : button('debugger:pause', 'pause', 'Pause', s.state === 'running'),
      button('debugger:step-over', 'step-over', 'Step Over', paused),
      button('debugger:step-into', 'step-into', 'Step Into', paused),
      button('debugger:step-out', 'step-out', 'Step Out', paused),
      button('debugger:restart', 'refresh', 'Restart'),
      button('debugger:stop', 'stop', 'Stop'));
  }

  function renderStatus() {
    const s = ctrl.session();
    const text = !s ? 'Not running. Set breakpoints, then start debugging.'
      : s.state === 'starting' ? 'Starting…'
      : s.state === 'running' ? 'Running'
      : s.stopReason === 'exception' ? `Paused on exception${s.stopText ? `: ${s.stopText}` : ''}`
      : `Paused${s.stopReason === 'breakpoint' ? ' on breakpoint' : s.stopReason === 'step' ? '' : s.stopReason ? ` (${s.stopReason})` : ''}`;
    status.textContent = text;
    status.className = `dbg-status ${s?.state || 'idle'}`;
  }

  function renderStack() {
    const s = ctrl.session();
    if (!s?.frames?.length) { stackList.replaceChildren(h('div.dbg-empty', s?.state === 'running' ? 'Running…' : 'Not paused.')); return; }
    stackList.replaceChildren(...s.frames.map((f) => h('div.dbg-row.dbg-frame', {
      class: [f.id === s.frameId && 'selected', !f.source?.path && 'subtle'].filter(Boolean).join(' '),
      title: f.source?.path ? `${f.source.path}:${f.line}` : f.name,
      onclick: () => ctrl.selectFrame(f),
    }, h('span.dbg-frame-name', f.name), h('span.dbg-frame-loc', f.source ? `${f.source.name || mide.path.basename(f.source.path || '')}:${f.line}` : ''))));
  }

  // Variables: scopes, then values that expand on click (children load when opened).
  const expanded = new Set();
  let varsGen = 0;

  function varRow(v, depth, key, gen) {
    const expandable = v.variablesReference > 0;
    const children = h('div.dbg-children');
    const row = h('div.dbg-row.dbg-var', { style: { paddingLeft: `${6 + depth * 12}px` }, dataset: { name: v.name } },
      h('span.dbg-twisty', expandable ? icon('chevron', 11) : null),
      h('span.dbg-var-name', v.name),
      v.value != null ? [h('span.dbg-sep', ':'), h('span.dbg-var-value', { title: v.value }, v.value)] : null);
    const wrap = h('div.dbg-node', row, children);
    const load = async () => {
      children.replaceChildren(h('div.dbg-empty', { style: { paddingLeft: `${18 + depth * 12}px` } }, 'Loading…'));
      const list = await ctrl.variables(v.variablesReference).catch((err) => [{ name: 'Error', value: err.message, variablesReference: 0 }]);
      if (gen !== varsGen) return;
      children.replaceChildren(...(list.length ? list.map((c) => varRow(c, depth + 1, `${key}/${c.name}`, gen)) : [h('div.dbg-empty', { style: { paddingLeft: `${18 + depth * 12}px` } }, 'No values')]));
    };
    if (expandable) {
      row.classList.add('expandable');
      const setOpen = (open) => {
        wrap.classList.toggle('open', open);
        if (open) { expanded.add(key); load(); } else { expanded.delete(key); children.replaceChildren(); }
      };
      row.addEventListener('click', () => setOpen(!expanded.has(key)));
      if (expanded.has(key)) setOpen(true);
    }
    return wrap;
  }

  function renderVariables() {
    const gen = ++varsGen;
    const s = ctrl.session();
    if (!s?.scopes?.length) { varsList.replaceChildren(h('div.dbg-empty', 'Not paused.')); return; }
    // The innermost scope starts open; after that, what you opened stays open while you step.
    if (!s.scopes.some((sc) => expanded.has(sc.name))) expanded.add(s.scopes[0].name);
    varsList.replaceChildren(...s.scopes.map((sc) => varRow({ name: sc.name, variablesReference: sc.variablesReference }, 0, sc.name, gen)));
  }

  async function renderWatch() {
    const s = ctrl.session();
    const watches = ctrl.watches();
    if (!watches.length) { watchList.replaceChildren(h('div.dbg-empty', 'Add an expression to see its value while paused.')); return; }
    const rows = await Promise.all(watches.map(async (expr, i) => {
      let value = null, error = false;
      if (s?.state === 'stopped') {
        try { value = (await ctrl.evaluate(expr, 'watch')).result; } catch (err) { value = err.message; error = true; }
      }
      return h('div.dbg-row.dbg-watch',
        h('span.dbg-var-name', expr), value != null ? [h('span.dbg-sep', ':'), h(`span.dbg-var-value${error ? '.error' : ''}`, { title: value }, value)] : null,
        h('button.icon-btn.dbg-row-action', { title: 'Remove', onclick: () => ctrl.removeWatch(i) }, icon('close', 12)));
    }));
    watchList.replaceChildren(...rows);
  }

  function renderBreakpoints() {
    const all = ctrl.allBreakpoints();
    if (!all.length) { bpList.replaceChildren(h('div.dbg-empty', 'Click left of a line number, or press F9, to add one.')); return; }
    bpList.replaceChildren(...all.map(({ path, line, condition, verified }) => h('div.dbg-row.dbg-bp', {
      title: `${mide.workspace.relativePath(path)}:${line}${condition ? ` if ${condition}` : ''}`,
      onclick: () => ctrl.goTo(path, line),
    }, h('span.dbg-bp-dot', { class: [verified === false && 'unverified', condition && 'conditional'].filter(Boolean).join(' ') }),
    h('span.dbg-bp-file', mide.path.basename(path), h('span.dbg-bp-line', `:${line}`)),
    condition ? h('span.dbg-bp-cond', condition) : null,
    h('button.icon-btn.dbg-row-action', { title: 'Remove', onclick: (e) => { e.stopPropagation(); ctrl.toggleBreakpoint(path, line); } }, icon('close', 12)))));
  }

  // --- console ---------------------------------------------------------------------
  const output = h('div.dbg-console-output');
  const input = h('input.dbg-console-input', { type: 'text', spellcheck: false, placeholder: 'Evaluate an expression while paused (Enter)' });
  const consoleEl = h('div.dbg-console', output, h('div.dbg-console-input-row', h('span.dbg-prompt', '›'), input));
  const history = [];
  let historyAt = 0;

  function append(el) {
    const atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
    output.append(el);
    while (output.childNodes.length > 3000) output.firstChild.remove();
    if (atEnd) output.scrollTop = output.scrollHeight;
  }
  const log = (text, category = 'stdout') => append(h(`span.dbg-out.${category}`, text));
  const note = (text) => append(h('div.dbg-note', text));

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!history.length) return;
      e.preventDefault();
      historyAt = Math.max(0, Math.min(history.length, historyAt + (e.key === 'ArrowUp' ? -1 : 1)));
      input.value = history[historyAt] ?? '';
      return;
    }
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const expr = input.value.trim();
    input.value = '';
    if (history[history.length - 1] !== expr) history.push(expr);
    historyAt = history.length;
    append(h('div.dbg-eval-in', expr));
    try {
      const r = await ctrl.evaluate(expr, 'repl');
      append(h('div.dbg-eval-out', r.result));
    } catch (err) {
      append(h('div.dbg-eval-out.error', err.message));
    }
  });

  function update() {
    renderToolbar();
    renderStatus();
    renderStack();
    renderVariables();
    renderWatch();
    renderBreakpoints();
  }

  return {
    sidebar: element,
    console: consoleEl,
    focusConsole: () => input.focus(),
    clearConsole: () => output.replaceChildren(),
    update, renderBreakpoints, renderWatch, log, note,
  };
}
