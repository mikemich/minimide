// Status Bar items for the active editor. Other packages add their own via mide.statusBar.addItem().

export function activate(mide) {
  const { h } = mide.ui;
  const path = h('span.sb-path');
  const cursor = h('span');
  const indent = h('span');
  const eol = h('span');
  const lang = h('span');
  const pending = h('span.sb-pending');

  mide.statusBar.addItem({ id: 'file-path', element: path, align: 'left', priority: 10, tooltip: 'Click to copy relative path', onClick: () => mide.commands.run('file:copy-relative-path') });
  mide.statusBar.addItem({ id: 'pending-keys', element: pending, align: 'left', priority: 20 });
  mide.statusBar.addItem({ id: 'cursor', element: cursor, align: 'right', priority: 10, tooltip: 'Go to Line', onClick: () => mide.commands.run('editor:go-to-line') });
  mide.statusBar.addItem({ id: 'indent', element: indent, align: 'right', priority: 20, tooltip: 'Change indentation', onClick: () => mide.commands.run('editor:set-indentation') });
  mide.statusBar.addItem({ id: 'eol', element: eol, align: 'right', priority: 30 });
  mide.statusBar.addItem({ id: 'language', element: lang, align: 'right', priority: 40, tooltip: 'Select language mode', onClick: () => mide.commands.run('editor:set-language') });

  function update() {
    const item = mide.workspace.getActiveItem();
    const p = item?.getPath?.();
    path.textContent = p ? mide.workspace.relativePath(p).replace(mide.user.home, '~') : item ? item.getTitle() : '';
    path.classList.toggle('dirty', !!item?.isDirty?.());
    if (item?.type === 'editor' && item.view) {
      const c = item.getCursor();
      cursor.textContent = `Ln ${c.line}, Col ${c.col}` + (c.selections > 1 ? ` (${c.selections} selections)` : c.selected ? ` (${c.selected} selected)` : '');
      lang.textContent = item.getLanguageName();
      eol.textContent = item.document.lineEnding === '\r\n' ? 'CRLF' : 'LF';
      indent.textContent = `${mide.config.get('editor.softTabs') ? 'Spaces' : 'Tab Size'}: ${mide.config.get('editor.tabSize')}`;
    } else {
      cursor.textContent = lang.textContent = eol.textContent = indent.textContent = '';
    }
  }

  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
  mide.workspace.onDidChangeActiveItem(schedule);
  mide.workspace.onDidUpdateEditor((item) => { if (item === mide.workspace.getActiveItem()) schedule(); });
  mide.workspace.onDidSave(schedule);
  mide.config.onDidChange('editor.tabSize', schedule);
  mide.config.onDidChange('editor.softTabs', schedule);
  mide.keymap.onDidChangePending((keys) => { pending.textContent = keys ? `${mide.keymap.pretty(keys)} …` : ''; });
  update();

  mide.styles.add(`
    .sb-path.dirty::after { content: ' •'; color: var(--accent); }
    .sb-pending { color: var(--accent); font-weight: 500; }
  `);
}
