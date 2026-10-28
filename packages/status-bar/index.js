// Status Bar items for the active editor. Other packages add their own via mide.statusBar.addItem().

// Words are runs of non-space characters, so "1,234" and "a-b" count once each.
const countWords = (text) => (text.match(/\S+/g) || []).length;
const PROSE = ['Markdown', 'Plain Text'];
const WORDS_PER_MINUTE = 230;

export function activate(mide) {
  const { h } = mide.ui;
  const path = h('span.sb-path');
  const cursor = h('span');
  const indent = h('span');
  const eol = h('span');
  const lang = h('span');
  const words = h('span.sb-words');
  const pending = h('span.sb-pending');
  let wordItem = null;

  mide.statusBar.addItem({ id: 'file-path', element: path, align: 'left', priority: 10, tooltip: 'Click to copy relative path', onClick: () => mide.commands.run('file:copy-relative-path') });
  mide.statusBar.addItem({ id: 'pending-keys', element: pending, align: 'left', priority: 20 });
  mide.statusBar.addItem({ id: 'cursor', element: cursor, align: 'right', priority: 10, tooltip: 'Go to Line', command: 'editor:go-to-line', onClick: () => mide.commands.run('editor:go-to-line') });
  mide.statusBar.addItem({ id: 'indent', element: indent, align: 'right', priority: 20, tooltip: 'Change indentation', onClick: () => mide.commands.run('editor:set-indentation') });
  mide.statusBar.addItem({ id: 'eol', element: eol, align: 'right', priority: 30 });
  mide.statusBar.addItem({ id: 'language', element: lang, align: 'right', priority: 40, tooltip: 'Select language mode', onClick: () => mide.commands.run('editor:set-language') });

  // The whole-document count is cached per document. While typing it waits for a 200 ms pause,
  // so a long file isn't counted on every key.
  let counted = { doc: null, count: 0 };
  let typing = false;
  let pauseTimer = 0;
  const totalWords = (doc) => {
    if (counted.doc !== doc && !typing) counted = { doc, count: countWords(doc.toString()) };
    return counted.count;
  };
  const wordsText = (item) => {
    const { state } = item.view;
    const total = totalWords(state.doc);
    const selected = state.selection.ranges.filter((r) => !r.empty).map((r) => state.sliceDoc(r.from, r.to)).join('\n');
    if (selected) return `${countWords(selected).toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'word' : 'words'}`;
    const minutes = Math.max(1, Math.ceil(total / WORDS_PER_MINUTE));
    return `${total.toLocaleString()} ${total === 1 ? 'word' : 'words'}` + (total ? ` · ${minutes} min read` : '');
  };

  function update() {
    const item = mide.workspace.getActiveItem();
    const p = item?.getPath?.();
    const home = mide.user.home;
    const rel = p ? mide.workspace.relativePath(p) : '';
    path.textContent = p ? (rel === home || rel.startsWith(home + '/') ? '~' + rel.slice(home.length) : rel) : item ? item.getTitle() : '';
    path.classList.toggle('dirty', !!item?.isDirty?.());
    // Word count only for prose: hidden by removing the item, since an empty one still takes its padding.
    const prose = item?.type === 'editor' && item.view && PROSE.includes(item.getLanguageName());
    if (prose && !wordItem) wordItem = mide.statusBar.addItem({ id: 'word-count', element: words, align: 'right', priority: 15, tooltip: 'Words and reading time' });
    else if (!prose && wordItem) { wordItem.dispose(); wordItem = null; }
    if (prose) words.textContent = wordsText(item);

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
  mide.workspace.onDidUpdateEditor((item, change) => {
    if (change?.docChanged) {
      typing = true;
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => { typing = false; schedule(); }, 200);
    }
    if (item === mide.workspace.getActiveItem()) schedule();
  });
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
