// Vim Mode: @replit/codemirror-vim wired into Minimide.

export async function activate(mide) {
  const { vim, Vim, getCM } = await mide.cm.extras.vim();
  const { EditorView, gutter, GutterMarker } = mide.cm.view;
  const { Prec } = mide.cm.state;
  const { h } = mide.ui;

  // While Vim is on, Ctrl-key combos belong to Vim (Ctrl-D, Ctrl-V, Ctrl-R…), as in a terminal.
  mide.editor.addExtension([
    Prec.highest(vim({ status: false })),
    EditorView.editorAttributes.of({ 'data-keymap-passthrough': '', class: 'vim-enabled' }),
  ]);
  mide.keymap.allowInPassthrough('tab:next', 'tab:previous', 'terminal:toggle', 'command-palette:toggle', 'navigate:back', 'navigate:forward');

  // Ex commands mapped onto Minimide commands.
  const ex = (name, prefix, fn) => Vim.defineEx(name, prefix, fn);
  ex('write', 'w', () => mide.commands.run('file:save'));
  ex('wall', 'wa', () => mide.commands.run('file:save-all'));
  ex('quit', 'q', () => mide.commands.run('tab:close'));
  ex('qall', 'qa', () => mide.commands.run('tab:close-all'));
  ex('wq', 'wq', async () => { if (await mide.commands.run('file:save')) mide.commands.run('tab:close'); });
  ex('xit', 'x', async () => { if (await mide.commands.run('file:save')) mide.commands.run('tab:close'); });
  ex('edit', 'e', (_cm, params) => {
    const file = params.args?.[0];
    if (!file) return mide.commands.run('file:revert');
    const base = mide.workspace.getActiveFolder() || mide.path.dirname(mide.workspace.getActiveEditor()?.getPath() || mide.user.home);
    mide.workspace.open(file.startsWith('/') ? file : `${base}/${file}`);
  });
  ex('vsplit', 'vs', () => mide.commands.run('pane:split-right'));
  ex('tabnext', 'tabn', () => mide.commands.run('tab:next'));
  ex('tabprevious', 'tabp', () => mide.commands.run('tab:previous'));
  ex('terminal', 'term', () => mide.commands.run('terminal:toggle'));
  Vim.map('gt', ':tabnext<CR>', 'normal');
  Vim.map('gT', ':tabprevious<CR>', 'normal');

  // Optional jj/jk escape.
  let mappedEscape = null;
  mide.config.observe('vim-mode.insertModeEscape', (seq) => {
    if (mappedEscape) { try { Vim.unmap(mappedEscape, 'insert'); } catch {} mappedEscape = null; }
    if (seq && seq.length >= 2) { Vim.map(seq, '<Esc>', 'insert'); mappedEscape = seq; }
  });
  // Vim's mappings are global: remove ours when the package is switched off.
  mide.subscriptions.add({ dispose: () => { if (mappedEscape) { try { Vim.unmap(mappedEscape, 'insert'); } catch {} } } });

  // System clipboard integration for the unnamed register.
  const register = Vim.getRegisterController();
  const unnamed = register.unnamedRegister;
  const originalSetText = unnamed.setText.bind(unnamed);
  unnamed.setText = (text, linewise, blockwise) => {
    originalSetText(text, linewise, blockwise);
    if (mide.config.get('vim-mode.useSystemClipboard') && text) mide.clipboard.write(Array.isArray(text) ? text.join('\n') : text);
  };
  mide.subscriptions.add({ dispose: () => { unnamed.setText = originalSetText; } });

  // Relative line numbers: our own gutter, redrawn whenever the cursor moves (the built-in
  // line-number gutter only redraws on document changes). It replaces the normal column visually.
  class NumberMarker extends GutterMarker {
    constructor(text, current) { super(); this.text = text; this.current = current; }
    eq(o) { return o.text === this.text && o.current === this.current; }
    toDOM() { const el = document.createElement('div'); el.textContent = this.text; if (this.current) el.className = 'vim-current'; return el; }
  }
  const relativeGutter = gutter({
    class: 'cm-vim-relative',
    lineMarker(view, line) {
      const n = view.state.doc.lineAt(line.from).number;
      const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
      return new NumberMarker(n === cur ? String(n) : String(Math.abs(n - cur)), n === cur);
    },
    lineMarkerChange: (u) => u.selectionSet || u.docChanged,
    initialSpacer: (view) => new NumberMarker(String(view.state.doc.lines), false),
  });
  let relative = null;
  mide.config.observe('vim-mode.relativeLineNumbers', (on) => {
    relative?.dispose();
    relative = on ? mide.editor.addExtension([relativeGutter, EditorView.editorAttributes.of({ class: 'vim-relative' })]) : null;
  });

  // Mode indicator in the status bar. Clicking it explains the modes and offers a way out.
  const badge = h('span.vim-mode-badge');
  const turnOff = () => mide.packages.setEnabled('vim-mode', false);
  const menu = async () => {
    const id = await mide.ui.contextMenu([
      { id: 'insert', label: 'Start Typing (i)' },
      { id: 'help', label: 'How Vim Mode Works' },
      { type: 'separator' },
      { id: 'off', label: 'Turn Off Vim Mode' },
    ]);
    if (id === 'insert') { const view = mide.workspace.getActiveEditor()?.view; if (view) { Vim.handleKey(getCM(view), 'i', 'mapping'); view.focus(); } }
    else if (id === 'help') showTip();
    else if (id === 'off') turnOff();
  };
  mide.statusBar.addItem({ id: 'vim-mode', element: badge, align: 'left', priority: 1, tooltip: 'Vim mode: click for help or to turn it off', onClick: menu });

  // Vim's Normal mode surprises people who switched it on to try it: keys run commands instead of
  // typing, and Backspace only moves left. Say so once.
  function showTip() {
    mide.notify.info('Vim mode is on', 'You start in Normal mode, where keys are commands: Backspace moves left and letters don\'t type. Press i to type and Esc to go back. The badge in the bottom-left corner shows the mode.', {
      timeout: 0,
      actions: [{ label: 'Got It', run: () => {} }, { label: 'Turn Off Vim Mode', run: turnOff }],
    });
  }
  try {
    const key = `vim-mode.tipShown:${mide.user.dir}`; // per settings folder, so test runs don't use it up
    if (!localStorage.getItem(key)) { localStorage.setItem(key, '1'); setTimeout(showTip, 1200); }
  } catch {}

  function modeOf(view) {
    const state = view && getCM(view)?.state?.vim;
    if (!state) return null;
    if (state.insertMode) return 'insert';
    if (state.visualBlock) return 'visual block';
    if (state.visualLine) return 'visual line';
    if (state.visualMode) return 'visual';
    return 'normal';
  }
  function render() {
    const mode = modeOf(mide.workspace.getActiveEditor()?.view);
    badge.textContent = mode ? mode.toUpperCase() : '';
    badge.dataset.mode = mode || '';
  }

  const attached = new WeakSet();
  function attach(editor) {
    const cm = editor?.view && getCM(editor.view);
    if (!cm || attached.has(cm)) return;
    attached.add(cm);
    cm.on('vim-mode-change', () => { if (editor === mide.workspace.getActiveEditor()) render(); });
  }
  const attachAll = () => { for (const item of mide.workspace.getItems()) if (item.type === 'editor') attach(item); render(); };

  mide.workspace.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => attach(item), 0); });
  mide.workspace.onDidChangeActiveItem(() => { attach(mide.workspace.getActiveEditor()); render(); });
  mide.workspace.onDidUpdateEditor((editor) => { if (editor === mide.workspace.getActiveEditor()) render(); });
  setTimeout(attachAll, 0);

  mide.styles.add(`
    .vim-mode-badge { font-weight: 700; font-size: 0.85em; letter-spacing: 0.06em; padding: 1px 7px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
    .vim-mode-badge:empty { display: none; }
    .vim-mode-badge[data-mode="insert"] { background: color-mix(in srgb, var(--success) 22%, transparent); color: var(--success); }
    .vim-mode-badge[data-mode^="visual"] { background: color-mix(in srgb, var(--c-magenta) 22%, transparent); color: var(--c-magenta); }
    .vim-enabled .cm-fat-cursor { background: color-mix(in srgb, var(--cursor) 70%, transparent) !important; color: var(--bg) !important; }
    .vim-enabled:not(.cm-focused) .cm-fat-cursor { background: none !important; outline: 1px solid var(--cursor); }
    .vim-enabled .cm-vim-panel { padding: 4px 10px; font-family: var(--editor-font); background: var(--bg-sidebar); }
    .vim-relative .cm-lineNumbers { display: none; }
    .cm-vim-relative .cm-gutterElement { padding: 0 6px 0 18px; min-width: 44px; text-align: right; color: var(--gutter-fg); }
    .cm-vim-relative .vim-current { color: var(--gutter-fg-active); }
    .vim-enabled .cm-vim-panel input { background: transparent; border: 0; outline: none; color: var(--fg-strong); font-family: var(--editor-font); }
  `);
}
