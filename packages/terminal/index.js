// Integrated terminal: xterm.js in the bottom panel, backed by a real PTY.
// A tab holds a group of 1-4 terminals side by side (splits), each its own shell.
// Provides the "terminal" service: { run(command, opts), create(opts), stop(key), isRunning(key), … }.
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';
import { WebLinksAddon } from './vendor/addon-web-links.mjs';

const MAX_SPLITS = 4;
const FILE_REF = /(?:^|[\s"'(\[])((?:~|\.{1,2})?\/?[\w@.\-+/]*[\w-]\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?/g;

export async function activate(mide) {
  const { h, icon } = mide.ui;
  const available = await mide.process.ptyAvailable();
  const sessions = []; // every terminal, across all tabs
  const groups = [];   // the tabs: { el, splits: [session], focused }
  let active = null;   // the focused terminal
  let seq = 0;

  const tabsEl = h('div.term-tabs');
  const body = h('div.term-body');
  const el = h('div.term-view',
    h('div.term-toolbar', tabsEl,
      h('div.term-actions',
        h('button.icon-btn', { title: 'New Terminal (Ctrl-Shift-`)', onclick: () => create({ focus: true }) }, icon('plus', 15)),
        h('button.icon-btn', { title: 'Split Terminal', dataset: { command: 'terminal:split' }, onclick: () => split() }, icon('split', 15)),
        h('button.icon-btn', { title: 'Clear', onclick: () => active?.term.clear() }, icon('refresh', 14)),
        h('button.icon-btn', { title: 'Kill Terminal', onclick: () => active && closeSession(active) }, icon('trash', 14)))),
    body);

  // --- theme & font --------------------------------------------------------
  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }
  function theme() {
    const fg = cssVar('--fg', '#c5cad3');
    return {
      background: cssVar('--bg', '#1e2128'),
      foreground: fg,
      cursor: cssVar('--cursor', '#6aa8ff'),
      cursorAccent: cssVar('--bg', '#1e2128'),
      selectionBackground: cssVar('--selection', 'rgba(106,168,255,0.25)'),
      black: cssVar('--fg-subtle', '#5a6170'), brightBlack: cssVar('--fg-muted', '#878fa0'),
      red: cssVar('--c-red', '#f07178'), brightRed: cssVar('--c-red', '#f07178'),
      green: cssVar('--c-green', '#a3d385'), brightGreen: cssVar('--c-green', '#a3d385'),
      yellow: cssVar('--c-yellow', '#f0c674'), brightYellow: cssVar('--c-yellow', '#f0c674'),
      blue: cssVar('--c-blue', '#6aa8ff'), brightBlue: cssVar('--c-blue', '#6aa8ff'),
      magenta: cssVar('--c-magenta', '#c792ea'), brightMagenta: cssVar('--c-magenta', '#c792ea'),
      cyan: cssVar('--c-cyan', '#7fd6d0'), brightCyan: cssVar('--c-cyan', '#7fd6d0'),
      white: fg, brightWhite: cssVar('--fg-strong', '#eef1f5'),
    };
  }
  const fontSize = () => mide.config.get('terminal.fontSize') || mide.config.get('editor.fontSize');
  // xterm measures the cell size when the font is set, so wait until the font has loaded.
  const fontReady = () => document.fonts.load(`${fontSize()}px ${mide.config.get('editor.fontFamily')}`).catch(() => {});
  async function applyOptions() {
    await fontReady();
    for (const s of sessions) {
      s.term.options.theme = theme();
      s.term.options.fontFamily = mide.config.get('editor.fontFamily');
      s.term.options.fontSize = fontSize();
      s.term.options.cursorStyle = mide.config.get('terminal.cursorStyle');
      s.term.options.scrollback = mide.config.get('terminal.scrollback');
      fit(s);
    }
  }
  // Theme stylesheets load asynchronously, so re-read colours once they settle.
  mide.packages.onDidChange(() => setTimeout(applyOptions, 50));
  for (const key of ['editor.fontFamily', 'editor.fontSize', 'terminal.fontSize', 'terminal.cursorStyle', 'terminal.scrollback']) {
    mide.config.onDidChange(key, () => applyOptions());
  }

  // --- sessions ------------------------------------------------------------
  function create({ command, cwd, title, focus = true, onExit, group } = {}) {
    if (!available) {
      mide.notify.error('Terminal unavailable', 'node-pty could not be loaded in this build.');
      return null;
    }
    const id = ++seq;
    const container = h('div.term-instance', { dataset: { keymapPassthrough: '' } });
    const tab = group || newGroup();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: mide.config.get('terminal.cursorStyle'),
      fontFamily: mide.config.get('editor.fontFamily'),
      fontSize: fontSize(),
      lineHeight: 1.2,
      scrollback: mide.config.get('terminal.scrollback'),
      theme: theme(),
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((_e, url) => mide.shell.openExternal(url)));
    tab.el.append(container);
    term.open(container);
    // A bundled font may still be loading on first use; re-measure once it's ready.
    if (!document.fonts.check(`${fontSize()}px ${mide.config.get('editor.fontFamily')}`)) {
      fontReady().then(() => { term.options.fontFamily = 'monospace'; term.options.fontFamily = mide.config.get('editor.fontFamily'); fit(session); });
    }

    const session = {
      id, term, fitAddon, container, command,
      cwd: cwd || mide.workspace.project || mide.user.home,
      title: title || (command ? command.split(/\s+/)[0] : 'shell'),
      running: true,
      group: tab,
      fixedTitle: !!title,
      proc: null,
    };
    container.append(h('button.term-split-close', { title: 'Close this terminal', onclick: () => closeSession(session) }, icon('close', 11)));
    container.addEventListener('focusin', () => { if (active !== session) select(session); });
    addSplit(tab, session);
    term.registerLinkProvider(fileLinkProvider(session));
    sessions.push(session);
    start(session, { command, onExit });

    term.onData((data) => {
      if (session.running) session.proc.write(data);
      else if (data === '\r' && session.command) rerun(session);
    });
    term.onTitleChange((t) => { if (!session.command && !session.fixedTitle && t) { session.title = t.split(/[\s:]/)[0] || session.title; renderTabs(); } });
    term.onSelectionChange(() => {
      if (mide.config.get('terminal.copyOnSelect') && term.hasSelection()) mide.clipboard.write(term.getSelection());
    });
    term.onResize(({ cols, rows }) => session.proc?.resize(cols, rows));
    // Fit on the next frame: resizing the terminal inside the observer callback causes a resize loop.
    let fitFrame = 0;
    session.resizeObserver = new ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => fit(session)); });
    session.resizeObserver.observe(container);

    select(session);
    mide.panel.show('terminal');
    if (focus) requestAnimationFrame(() => term.focus());
    return session;
  }

  function start(session, { command, onExit } = {}) {
    const { term } = session;
    if (onExit) session.onExit = onExit; // kept for Enter-to-rerun
    session.running = true;
    session.exit = null;
    if (command) term.write(`\x1b[2m${session.cwd.replace(mide.user.home, '~')}\x1b[0m\r\n\x1b[1;34m❯\x1b[0m \x1b[1m${command}\x1b[0m\r\n`);
    const proc = mide.process.spawnPty({
      command,
      cwd: session.cwd,
      cols: term.cols,
      rows: term.rows,
      shell: mide.config.get('terminal.shell') || undefined,
    });
    session.proc = proc;
    session.started = performance.now();
    proc.ready.then((info) => { if (!command && info?.shell) { session.title = info.shell; renderTabs(); } })
      .catch((err) => { term.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`); session.running = false; renderTabs(); });
    proc.onData((data) => term.write(data));
    proc.onExit((code, signal) => {
      if (session.proc !== proc || session.closed) return;
      session.running = false;
      session.exit = { code, signal };
      const secs = ((performance.now() - session.started) / 1000).toFixed(2);
      if (command) {
        const ok = code === 0 && !signal;
        term.write(`\r\n\x1b[${ok ? '32' : '31'}m${ok ? '✓' : '✗'} ${signal ? `stopped (${signal})` : `exited with code ${code}`} · ${secs}s\x1b[0m  \x1b[2mPress Enter to run again\x1b[0m\r\n`);
      } else {
        term.write(`\r\n\x1b[2m[shell exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      }
      // Exiting a shell that has neighbours closes its split; a lone one stays to show the message.
      if (!command && session.group.splits.length > 1) closeSession(session); else renderTabs();
      session.onExit?.(code, signal, (performance.now() - session.started) / 1000);
      mide.workspace.refreshPaneActions(); // e.g. the runner's ■ goes back to ▶
    });
    renderTabs();
    mide.workspace.refreshPaneActions();
  }

  /** Stop like Ctrl-C does (reaches the whole foreground job), then force it if it ignores that. */
  function interrupt(session) {
    if (!session.running) return false;
    const proc = session.proc;
    proc.write('\x03');
    setTimeout(() => { if (session.proc === proc && session.running) proc.kill('SIGTERM'); }, 1500);
    return true;
  }

  function rerun(session, command = session.command) {
    if (session.running) session.proc.kill();
    session.command = command;
    if (!session.fixedTitle) session.title = command.split(/\s+/)[0];
    session.term.reset();
    start(session, { command, onExit: session.onExit });
  }

  function fit(session) {
    if (!session.container.isConnected || session.container.hidden || !session.container.clientWidth) return;
    try { session.fitAddon.fit(); } catch {}
  }

  function select(session) {
    active = session;
    const tab = session.group;
    tab.focused = session;
    for (const g of groups) g.el.hidden = g !== tab;
    for (const s of sessions) { s.container.hidden = s.group !== tab; s.container.classList.toggle('focused', s === session); }
    renderTabs();
    requestAnimationFrame(() => tab.splits.forEach(fit));
  }

  // --- tabs and splits -----------------------------------------------------
  function newGroup() {
    const tab = { el: h('div.term-group'), splits: [], focused: null };
    groups.push(tab);
    body.append(tab.el);
    return tab;
  }

  /** Put a terminal at the end of a tab, behind a draggable divider; every split gets an equal share. */
  function addSplit(tab, session) {
    if (tab.splits.length) {
      session.divider = h('div.term-divider', { onmousedown: (e) => dragDivider(e, session.divider) });
      tab.el.insertBefore(session.divider, session.container);
    }
    tab.splits.push(session);
    equalize(tab);
  }

  function equalize(tab) {
    for (const s of tab.splits) s.container.style.flex = '1 1 0px';
    tab.el.classList.toggle('split', tab.splits.length > 1);
  }

  /** Drag a divider: the two terminals beside it trade width, the rest stay put. */
  function dragDivider(e, divider) {
    e.preventDefault();
    const find = (node) => sessions.find((s) => s.container === node);
    const a = find(divider.previousElementSibling), b = find(divider.nextElementSibling);
    if (!a || !b) return;
    for (const s of a.group.splits) s.container.style.flex = `${s.container.offsetWidth} 1 0px`; // px act as weights
    const start = e.clientX, wa = a.container.offsetWidth, total = wa + b.container.offsetWidth, min = 80;
    document.body.classList.add('resizing-h');
    const move = (ev) => {
      const w = Math.max(min, Math.min(total - min, wa + ev.clientX - start));
      a.container.style.flex = `${w} 1 0px`;
      b.container.style.flex = `${total - w} 1 0px`;
    };
    const up = () => {
      document.body.classList.remove('resizing-h');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function split() {
    if (!active) return create();
    if (active.group.splits.length >= MAX_SPLITS) return mide.notify.info(`${MAX_SPLITS} terminals side by side is the most that fits.`);
    return create({ cwd: active.cwd, group: active.group });
  }

  function stepSplit(by) {
    const { splits } = active.group;
    const next = splits[(splits.indexOf(active) + by + splits.length) % splits.length];
    select(next);
    next.term.focus();
  }

  function closeSession(session) {
    const tab = session.group;
    const i = tab.splits.indexOf(session);
    const wasActive = active === session;
    session.closed = true;
    session.resizeObserver?.disconnect();
    if (session.running) session.proc.kill();
    session.term.dispose();
    session.container.remove();
    // Drop the divider beside it: its own, or the next one's when it was the first.
    if (session.divider) session.divider.remove();
    else if (tab.splits[i + 1]) { tab.splits[i + 1].divider.remove(); tab.splits[i + 1].divider = null; }
    tab.splits.splice(i, 1);
    sessions.splice(sessions.indexOf(session), 1);
    if (tab.splits.length) {
      equalize(tab);
      if (wasActive) { select(tab.splits[Math.min(i, tab.splits.length - 1)]); active.term.focus(); } else renderTabs();
      return;
    }
    tab.el.remove();
    groups.splice(groups.indexOf(tab), 1);
    if (wasActive) active = groups.at(-1)?.focused || null;
    if (active) select(active);
    else { renderTabs(); if (wasActive) { mide.panel.hide(); mide.workspace.getActiveItem()?.focus(); } }
  }

  const closeGroup = (tab) => { for (const s of [...tab.splits]) closeSession(s); };

  function renderTabs() {
    tabsEl.replaceChildren(...groups.map((g) => {
      const lead = g.splits.find((s) => s.command);
      const exit = lead?.running ? null : lead?.exit;
      const failed = g.splits.some((s) => s.exit && (s.exit.code || s.exit.signal));
      return h('div.term-tab', {
        class: [g === active?.group ? 'active' : '', g.splits.some((s) => s.running) ? 'running' : 'exited', failed ? 'failed' : ''].join(' '),
        title: lead?.command || g.focused?.cwd || '',
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeGroup(g); } },
        onclick: () => { select(g.focused); g.focused.term.focus(); },
      }, h('span.term-tab-dot'), h('span.term-tab-title', g.splits.map((s) => s.title).join(' | ')),
      exit ? h('span.term-tab-status', { class: exit.code || exit.signal ? 'fail' : 'ok' }, exit.code || exit.signal ? `✗ ${exit.signal ? 'stopped' : exit.code}` : '✓') : null,
      h('button.term-tab-close', { title: 'Close', onclick: (e) => { e.stopPropagation(); closeGroup(g); } }, icon('close', 11)));
    }));
  }

  // Clickable file paths like src/app.js:12:5 in any output.
  function fileLinkProvider(session) {
    const exists = new Map();
    const resolve = (p) => {
      if (p.startsWith('~')) return mide.user.home + p.slice(1);
      if (p.startsWith('/')) return p;
      const parts = [];
      for (const seg of `${session.cwd}/${p}`.split('/')) {
        if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
      }
      return '/' + parts.join('/');
    };
    return {
      provideLinks(y, callback) {
        const line = session.term.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const candidates = [];
        for (const m of text.matchAll(FILE_REF)) {
          const start = m.index + m[0].indexOf(m[1]);
          const full = m[1] + (m[2] ? `:${m[2]}` : '') + (m[3] ? `:${m[3]}` : '');
          candidates.push({ path: resolve(m[1]), line: m[2], col: m[3], start, length: full.length, text: full });
        }
        if (!candidates.length) return callback(undefined);
        Promise.all(candidates.map(async (c) => {
          if (!exists.has(c.path)) exists.set(c.path, mide.fs.stat(c.path).then((s) => !!s?.isFile));
          return (await exists.get(c.path)) ? c : null;
        })).then((found) => {
          const links = found.filter(Boolean).map((c) => ({
            range: { start: { x: c.start + 1, y }, end: { x: c.start + c.length, y } },
            text: c.text,
            decorations: { underline: true, pointerCursor: true },
            activate: () => mide.workspace.open(c.path, c.line ? { line: +c.line, col: c.col ? +c.col - 1 : 0 } : {}),
          }));
          callback(links.length ? links : undefined);
        });
      },
    };
  }

  // --- panel, commands, service ------------------------------------------
  mide.panel.addView({
    id: 'terminal', title: 'Terminal', icon: 'terminal', order: 0, command: 'terminal:toggle', element: el,
    focus: () => { if (!sessions.length) create(); else active?.term.focus(); },
    onShow: () => { if (active) requestAnimationFrame(() => fit(active)); },
  });

  const focusedInTerminal = () => !!document.activeElement?.closest?.('.term-view');
  const toggle = () => {
    if (mide.panel.isActive('terminal') && focusedInTerminal()) {
      mide.panel.hide();
      mide.workspace.getActiveItem()?.focus();
    } else if (!sessions.length) create();
    else { mide.panel.show('terminal'); requestAnimationFrame(() => active?.term.focus()); }
  };

  const dirOfActive = () => {
    const p = mide.workspace.getActiveItem()?.getPath?.();
    return p ? mide.path.dirname(p) : mide.workspace.project;
  };

  mide.commands.add({
    'terminal:toggle': { title: 'Toggle Terminal', run: toggle },
    'terminal:new': { title: 'New Terminal', run: (opts = {}) => create({ cwd: opts.cwd }) },
    'terminal:new-here': { title: 'New Terminal in File’s Folder', run: (opts = {}) => create({ cwd: opts.cwd || dirOfActive() }) },
    'terminal:split': { title: 'Terminal: Split', run: split },
    'terminal:focus-next-split': { title: 'Terminal: Focus Next Split', when: () => active?.group.splits.length > 1, run: () => stepSplit(1) },
    'terminal:focus-previous-split': { title: 'Terminal: Focus Previous Split', when: () => active?.group.splits.length > 1, run: () => stepSplit(-1) },
    'terminal:kill': { title: 'Kill Active Terminal', when: () => !!active, run: () => closeSession(active) },
    'terminal:clear': { title: 'Clear Terminal', when: () => !!active, run: () => active.term.clear() },
    'terminal:next': { title: 'Next Terminal', when: () => groups.length > 1, run: () => { select(groups[(groups.indexOf(active.group) + 1) % groups.length].focused); active.term.focus(); } },
    'terminal:run-selection': {
      title: 'Run Selected Text in Terminal',
      when: () => !!mide.workspace.getActiveEditor(),
      run: () => {
        const editor = mide.workspace.getActiveEditor();
        let text = editor.getSelectedText();
        if (!text) {
          const { state } = editor.view;
          text = state.doc.lineAt(state.selection.main.head).text;
        }
        const target = active?.running && !active.command ? active : create({ focus: false });
        if (!target) return;
        mide.panel.show('terminal');
        select(target);
        target.proc.write(text.replace(/\n/g, '\r') + '\r');
      },
    },
  });
  // Toggling the terminal must work while typing in it.
  mide.keymap.allowInPassthrough('terminal:toggle', 'terminal:new', 'terminal:split', 'command-palette:toggle');

  mide.services.provide('terminal', {
    /** Run a command in a reusable tab named `key` (default "run"). Returns the session. */
    run(command, { cwd, title, key = 'run', onExit } = {}) {
      let session = sessions.find((s) => s.key === key);
      if (session) {
        session.cwd = cwd || session.cwd;
        if (onExit) session.onExit = onExit;
        if (title) { session.title = title; session.fixedTitle = true; }
        rerun(session, command);
        select(session);
        mide.panel.show('terminal');
        renderTabs();
      } else {
        session = create({ command, cwd, title, onExit, focus: false });
        if (session) session.key = key;
      }
      if (session) requestAnimationFrame(() => session.term.focus());
      return session && {
        stop: () => interrupt(session),
        get running() { return session.running; },
      };
    },
    create: (opts) => !!create(opts),
    stop(key = 'run') {
      const s = sessions.find((x) => x.key === key);
      return s ? interrupt(s) : false;
    },
    isRunning: (key = 'run') => !!sessions.find((x) => x.key === key)?.running,
    /** Key of the focused terminal, if it was started with one (e.g. a task). */
    activeKey: () => active?.key,
    /** Bring a keyed terminal to the front and focus it. */
    show(key) {
      const s = sessions.find((x) => x.key === key);
      if (!s) return false;
      select(s);
      mide.panel.show('terminal');
      requestAnimationFrame(() => s.term.focus());
      return true;
    },
    /** Is that terminal on screen right now? */
    isVisible(key) {
      const s = sessions.find((x) => x.key === key);
      return !!s && mide.panel.isActive('terminal') && active?.group === s.group;
    },
  });

  mide.subscriptions.add({ dispose: () => { for (const s of [...sessions]) { s.resizeObserver?.disconnect(); if (s.running) s.proc.kill(); s.term.dispose(); s.container.remove(); } for (const g of groups) g.el.remove(); } });
}
