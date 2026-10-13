// Run Panel: a lightweight command runner in the bottom panel. Not a full PTY
// terminal; great for builds, tests, scripts and git. Output paths are clickable.

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const FILE_REF = /((?:\.{0,2}\/)?[\w@.\-/]+\.[A-Za-z0-9]+)(?::(\d+))(?::(\d+))?/g;

export function activate(mide) {
  const { h, icon } = mide.ui;
  let proc = null;
  let cwd = null;
  let history = [];
  let hIndex = -1;
  let partial = '';
  let flushTimer = null;
  let style = {};
  try { history = JSON.parse(localStorage.getItem('run-panel:history') || '[]'); } catch {}

  const output = h('div.run-output', { tabIndex: 0 });
  const input = h('input.run-input', { placeholder: 'Run a command (↑ for history)…', spellcheck: false });
  const cwdLabel = h('span.run-cwd');
  const status = h('span.run-status');
  const stopBtn = h('button.icon-btn', { title: 'Stop (Ctrl-C)', onclick: () => stop(), disabled: true }, icon('stop', 13));
  const el = h('div.run-panel',
    h('div.run-toolbar', cwdLabel, status, h('div.run-actions',
      stopBtn,
      h('button.icon-btn', { title: 'Clear', onclick: () => clear() }, icon('trash', 14)))),
    output,
    h('div.run-input-row', h('span.run-prompt', '❯'), input));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value;
      input.value = '';
      if (proc) { proc.write(value + '\n'); append(value + '\n', 'stdin'); return; }
      if (value.trim()) run(value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hIndex < history.length - 1) input.value = history[++hIndex] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hIndex = Math.max(-1, hIndex - 1);
      input.value = hIndex >= 0 ? history[hIndex] : '';
    } else if (e.key === 'c' && e.ctrlKey && proc) {
      e.preventDefault();
      stop();
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      clear();
    }
  });

  function setCwd(dir) {
    cwd = dir || mide.workspace.project || mide.user.home;
    cwdLabel.textContent = cwd.replace(mide.user.home, '~');
    cwdLabel.title = cwd;
  }

  function run(command, opts = {}) {
    if (proc) { mide.notify.warn('A command is already running', 'Stop it first (Ctrl-C).'); return; }
    if (opts.cwd) setCwd(opts.cwd);
    if (!cwd) setCwd();
    history = [command, ...history.filter((c) => c !== command)].slice(0, 100);
    hIndex = -1;
    try { localStorage.setItem('run-panel:history', JSON.stringify(history)); } catch {}
    mide.panel.show('run-panel');
    style = {};
    output.append(h('div.run-command', h('span.run-prompt', '❯'), ' ', command));
    const started = performance.now();
    status.textContent = 'running…';
    status.className = 'run-status running';
    stopBtn.disabled = false;
    // cd builtin: change the panel's working directory.
    const cd = /^\s*cd(?:\s+(.*))?$/.exec(command);
    if (cd) {
      const target = (cd[1] || '~').trim().replace(/^~/, mide.user.home);
      const next = target.startsWith('/') ? target : `${cwd}/${target}`;
      mide.fs.stat(next).then((s) => {
        if (s?.isDir) setCwd(normalize(next)); else append(`cd: no such directory: ${cd[1]}\n`, 'stderr');
        finish(0, null, started);
      });
      return;
    }
    proc = mide.process.spawn(command, {
      cwd,
      onData: (data, stream) => append(data, stream),
      onExit: (code, signal) => { proc = null; finish(code, signal, started); },
    });
  }

  function finish(code, signal, started) {
    flush(true);
    const secs = ((performance.now() - started) / 1000).toFixed(secsPrecision(started));
    status.textContent = signal ? `stopped (${signal})` : code === 0 ? `done in ${secs}s` : `exit ${code} · ${secs}s`;
    status.className = `run-status ${code === 0 && !signal ? 'ok' : 'fail'}`;
    stopBtn.disabled = true;
    output.append(h('div.run-separator'));
    scroll();
  }

  function secsPrecision(started) { return performance.now() - started < 10000 ? 2 : 1; }
  function stop() { proc?.kill(); }
  function clear() { output.replaceChildren(); partial = ''; }

  function append(text, stream) {
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    partial += text.replace(/\r\n/g, '\n');
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) output.append(renderLine(line, stream));
    clearTimeout(flushTimer);
    if (partial) flushTimer = setTimeout(() => flush(false, stream), 80);
    trim();
    if (atBottom) scroll();
  }

  function flush(final, stream) {
    if (!partial) return;
    output.append(renderLine(partial, stream));
    partial = '';
    if (!final) scroll();
  }

  function trim() {
    const max = mide.config.get('run-panel.maxLines');
    while (output.childElementCount > max) output.firstElementChild.remove();
  }

  function scroll() { output.scrollTop = output.scrollHeight; }

  // Render one line: ANSI SGR colors + clickable file references.
  function renderLine(line, stream) {
    const row = h(`div.run-line.${stream || 'stdout'}`);
    line = line.replace(/\r/g, '');
    const parts = line.split(/(\x1b\[[0-9;]*m)/);
    for (const part of parts) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) { applySgr(m[1]); continue; }
      const clean = part.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
      if (!clean) continue;
      const span = h('span');
      if (style.fg) span.dataset.fg = style.fg;
      if (style.bold) span.classList.add('bold');
      if (style.dim) span.classList.add('dim');
      linkify(span, clean);
      row.append(span);
    }
    if (!row.childNodes.length) row.append('​');
    return row;
  }

  function applySgr(codes) {
    for (const c of (codes || '0').split(';').map(Number)) {
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c >= 30 && c <= 37) style.fg = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) style.fg = ANSI_COLORS[c - 90];
      else if (c === 39) style.fg = null;
    }
  }

  function linkify(span, text) {
    let last = 0;
    for (const m of text.matchAll(FILE_REF)) {
      span.append(text.slice(last, m.index));
      const [whole, file, line, col] = m;
      const link = h('a.run-link', {
        href: '#',
        title: 'Open file',
        onclick: async (e) => {
          e.preventDefault();
          const full = file.startsWith('/') ? file : normalize(`${cwd}/${file}`);
          if (await mide.fs.stat(full)) mide.workspace.open(full, { line: +line, col: col ? +col - 1 : 0 });
          else mide.notify.warn(`File not found: ${file}`);
        },
      }, whole);
      span.append(link);
      last = m.index + whole.length;
    }
    span.append(text.slice(last));
  }

  function normalize(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    return '/' + out.join('/');
  }

  mide.panel.addView({
    id: 'run-panel', title: 'Run', icon: 'terminal', order: 0, element: el,
    focus: () => input.focus(),
    onShow: () => { if (!cwd) setCwd(); },
  });

  mide.commands.add({
    'run-panel:focus': { title: 'Focus Run Panel', run: () => { mide.panel.show('run-panel'); input.focus(); } },
    'run-panel:toggle': { title: 'Toggle Run Panel', run: () => mide.panel.toggle('run-panel') },
    'run-panel:rerun': { title: 'Re-run Last Command', run: () => (history[0] ? run(history[0]) : mide.commands.run('run-panel:focus')) },
    'run-panel:stop': { title: 'Stop Running Command', run: () => stop(), when: () => !!proc },
    'run-panel:clear': { title: 'Clear Output', run: () => clear() },
    'run-panel:run': {
      title: 'Run Command…',
      run: (opts = {}) => {
        if (opts.command) return run(opts.command, opts);
        if (opts.cwd) setCwd(opts.cwd);
        mide.panel.show('run-panel');
        input.focus();
      },
    },
  });

  mide.workspace.onDidChangeProject((root) => { if (!proc) setCwd(root); });
  mide.subscriptions.add({ dispose: () => proc?.kill() });
}
