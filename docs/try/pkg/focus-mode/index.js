// Focus Mode: typewriter scrolling and paragraph dimming.

export function activate(mide) {
  const { EditorView, ViewPlugin, Decoration } = mide.cm.view;
  const { EditorState, RangeSetBuilder, Transaction } = mide.cm.state;

  // Every cursor move scrolls the cursor line to the middle of the editor.
  const typewriter = [
    // Only the user's own typing/keyboard moves re-center: not mouse selection (the text would slide
    // under the pointer) and not edits synced in from another split of the same file.
    EditorState.transactionExtender.of((tr) => {
      const event = tr.annotation(Transaction.userEvent);
      if (!event || event.startsWith('select.pointer') || !(tr.selection || tr.docChanged)) return null;
      return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: 'center' }) };
    }),
    EditorView.theme({ '.cm-content': { paddingTop: '40vh !important', paddingBottom: '40vh !important' } }),
  ];

  // Fade every line outside the paragraph (blank-line separated block) holding the cursor.
  const dimmed = Decoration.line({ class: 'cm-focus-dim' });
  function paragraphAround(doc, pos) {
    let start = doc.lineAt(pos).number;
    let end = start;
    if (!doc.line(start).text.trim()) return [start, end];
    while (start > 1 && doc.line(start - 1).text.trim()) start--;
    while (end < doc.lines && doc.line(end + 1).text.trim()) end++;
    return [start, end];
  }
  const dim = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = this.build(u.view); }
    build(view) {
      const builder = new RangeSetBuilder();
      if (!view.hasFocus) return builder.finish();
      const { doc } = view.state;
      const [a, b] = paragraphAround(doc, view.state.selection.main.head);
      for (const { from, to } of view.visibleRanges) {
        for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
          if (n < a || n > b) builder.add(doc.line(n).from, doc.line(n).from, dimmed);
        }
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });

  const exts = {};
  const apply = (key, ext) => (on) => {
    exts[key]?.dispose();
    exts[key] = on ? mide.editor.addExtension(ext) : null;
  };
  mide.config.observe('focus-mode.typewriter', apply('typewriter', typewriter));
  mide.config.observe('focus-mode.dim', apply('dim', dim));
  mide.commands.add('focus-mode:toggle-typewriter', 'Toggle Typewriter Scrolling', () => mide.config.set('focus-mode.typewriter', !mide.config.get('focus-mode.typewriter')));
  mide.commands.add('focus-mode:toggle-dim', 'Toggle Paragraph Dimming', () => mide.config.set('focus-mode.dim', !mide.config.get('focus-mode.dim')));
  mide.subscriptions.add({ dispose: () => Object.values(exts).forEach((e) => e?.dispose()) });

  mide.styles.add(`
    .cm-line.cm-focus-dim { opacity: 0.3; transition: opacity 0.25s ease; }
    .cm-line { transition: opacity 0.25s ease; }
  `);
}
