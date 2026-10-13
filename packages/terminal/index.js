// Integrated terminal: xterm.js in the bottom panel, backed by a real PTY.
// Provides the "terminal" service: { run(command, opts), create(opts), focus() }.
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';
import { WebLinksAddon } from './vendor/addon-web-links.mjs';

const FILE_REF = /(?:^|[\s"'(\[])((?:~|\.{1,2})?\/?[\w@.\-+/]*[\w-]\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?/g;

export async function activate(mide) {
  const { h, icon } = mide.ui;
  const available = await mide.process.ptyAvailable();
  const sessions = [];
  let active = null;
  let seq = 0;

  const tabsEl = h('div.term-tabs');
  const body = h('div.term-body');
  const el = h('div.term-view',
    h('div.term-toolbar', tabsEl,
      h('div.term-actions',
        h('button.icon-btn', { title: 'New Terminal (Ctrl-Shift-`)', onclick: () => create({ focus: true }) }, icon('plus', 15)),
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
  function applyOptions() {
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
  function create({ command, cwd, title, focus = true, onExit } = {}) {
    if (!available) {
      mide.notify.error('Terminal unavailable', 'node-pty could not be loaded in this build.');
      return null;
    }
    const id = ++seq;
    const container = h('div.term-instance', { dataset: { keymapPassthrough: '' } });
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
    body.append(container);
    term.open(container);

    const session = {
      id, term, fitAddon, container, command,
      cwd: cwd || mide.workspace.project || mide.user.home,
      title: title || (command ? command.split(/\s+/)[0] : 'shell'),
      running: true,
      tab: null,
      proc: null,
    };
    term.registerLinkProvider(fileLinkProvider(session));
    sessions.push(session);
    start(session, { command, onExit });

    term.onData((data) => {
      if (session.running) session.proc.write(data);
      else if (data === '\r' && session.command) rerun(session);
    });
    term.onTitleChange((t) => { if (!session.command && t) { session.title = t.split(/[\s:]/)[0] || session.title; renderTabs(); } });
    term.onSelectionChange(() => {
      if (mide.config.get('terminal.copyOnSelect') && term.hasSelection()) mide.clipboard.write(term.getSelection());
    });
    term.onResize(({ cols, rows }) => session.proc?.resize(cols, rows));
    new ResizeObserver(() => fit(session)).observe(container);

    select(session);
    mide.panel.show('terminal');
    if (focus) requestAnimationFrame(() => term.focus());
    return session;
  }

  function start(session, { command, onExit } = {}) {
    const { term } = session;
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
      if (session.proc !== proc) return;
      session.running = false;
      session.exit = { code, signal };
      const secs = ((performance.now() - session.started) / 1000).toFixed(2);
      if (command) {
        const ok = code === 0 && !signal;
        term.write(`\r\n\x1b[${ok ? '32' : '31'}m${ok ? '✓' : '✗'} ${signal ? `stopped (${signal})` : `exited with code ${code}`} · ${secs}s\x1b[0m  \x1b[2mPress Enter to run again\x1b[0m\r\n`);
      } else {
        term.write(`\r\n\x1b[2m[shell exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      }
      renderTabs();
      onExit?.(code, signal);
    });
    renderTabs();
  }

  function rerun(session, command = session.command) {
    if (session.running) session.proc.kill();
    session.command = command;
    session.title = command.split(/\s+/)[0];
    session.term.reset();
    start(session, { command });
  }

  function fit(session) {
    if (!session.container.isConnected || session.container.hidden || !session.container.clientWidth) return;
    try { session.fitAddon.fit(); } catch {}
  }

  function select(session) {
    active = session;
    for (const s of sessions) s.container.hidden = s !== session;
    renderTabs();
    requestAnimationFrame(() => fit(session));
  }

  function closeSession(session) {
    if (session.running) session.proc.kill();
    session.term.dispose();
    session.container.remove();
    sessions.splice(sessions.indexOf(session), 1);
    if (active === session) active = sessions.at(-1) || null;
    if (active) select(active);
    else { renderTabs(); mide.panel.hide(); mide.workspace.getActiveItem()?.focus(); }
  }

  function renderTabs() {
    tabsEl.replaceChildren(...sessions.map((s) => h('div.term-tab', {
      class: [s === active ? 'active' : '', s.running ? 'running' : 'exited', s.exit && (s.exit.code || s.exit.signal) ? 'failed' : ''].join(' '),
      title: s.command || s.cwd,
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeSession(s); } },
      onclick: () => { select(s); s.term.focus(); },
    }, h('span.term-tab-dot'), h('span.term-tab-title', s.command ? `▶ ${s.title}` : s.title),
    h('button.term-tab-close', { title: 'Close', onclick: (e) => { e.stopPropagation(); closeSession(s); } }, icon('close', 11)))));
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
    id: 'terminal', title: 'Terminal', icon: 'terminal', order: 0, element: el,
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
    'terminal:kill': { title: 'Kill Active Terminal', when: () => !!active, run: () => closeSession(active) },
    'terminal:clear': { title: 'Clear Terminal', when: () => !!active, run: () => active.term.clear() },
    'terminal:next': { title: 'Next Terminal', when: () => sessions.length > 1, run: () => { select(sessions[(sessions.indexOf(active) + 1) % sessions.length]); active.term.focus(); } },
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
  mide.keymap.allowInPassthrough('terminal:toggle', 'terminal:new', 'command-palette:toggle');

  mide.services.provide('terminal', {
    /** Run a command in a reusable tab named `key` (default "run"). Returns the session. */
    run(command, { cwd, title, key = 'run', onExit } = {}) {
      let session = sessions.find((s) => s.key === key);
      if (session) {
        session.cwd = cwd || session.cwd;
        rerun(session, command);
        if (onExit) session.proc.onExit(onExit);
        if (title) session.title = title;
        select(session);
        mide.panel.show('terminal');
        renderTabs();
      } else {
        session = create({ command, cwd, title, onExit, focus: false });
        if (session) session.key = key;
      }
      if (session) requestAnimationFrame(() => session.term.focus());
      return session && {
        stop: () => session.running && session.proc.kill('SIGINT'),
        get running() { return session.running; },
      };
    },
    create: (opts) => !!create(opts),
    stop(key = 'run') {
      const s = sessions.find((x) => x.key === key);
      if (s?.running) { s.proc.kill('SIGINT'); return true; }
      return false;
    },
    isRunning: (key = 'run') => !!sessions.find((x) => x.key === key)?.running,
  });

  mide.subscriptions.add({ dispose: () => { for (const s of [...sessions]) { if (s.running) s.proc.kill(); s.term.dispose(); } } });
}
