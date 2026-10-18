// Git Blame: current-line blame, shown faintly at the end of the line.

export function activate(mide) {
  const { Decoration, WidgetType, EditorView } = mide.cm.view;
  const { StateField, StateEffect } = mide.cm.state;

  const setBlame = StateEffect.define();
  const field = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      for (const e of tr.effects) if (e.is(setBlame)) return e.value;
      return tr.docChanged || tr.selection ? Decoration.none : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  class BlameWidget extends WidgetType {
    constructor(text, title) { super(); this.text = text; this.title = title; }
    eq(o) { return o.text === this.text; }
    toDOM() {
      const el = document.createElement('span');
      el.className = 'cm-blame';
      el.textContent = this.text;
      el.title = this.title;
      return el;
    }
  }

  mide.editor.addExtension(field);

  const roots = new Map(); // dir -> repo root | null
  async function repoRoot(dir) {
    if (!roots.has(dir)) {
      roots.set(dir, mide.process.exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir }).then((r) => (r.code === 0 ? r.stdout.trim() : null)));
    }
    return roots.get(dir);
  }

  async function blameLine(path, line) {
    const root = await repoRoot(mide.path.dirname(path));
    if (!root) return null;
    const r = await mide.process.exec('git', ['blame', '--porcelain', '-L', `${line},${line}`, '--', path], { cwd: root, timeout: 5000 });
    if (r.code !== 0) return null;
    const info = {};
    const lines = r.stdout.split('\n');
    info.hash = lines[0]?.split(' ')[0];
    for (const l of lines) {
      const sp = l.indexOf(' ');
      if (sp > 0) info[l.slice(0, sp)] = l.slice(sp + 1);
    }
    return info;
  }

  function relative(seconds) {
    const diff = Date.now() / 1000 - seconds;
    const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [s, name] of units) if (diff >= s) { const n = Math.floor(diff / s); return `${n} ${name}${n > 1 ? 's' : ''} ago`; }
    return 'just now';
  }

  function describe(info) {
    if (!info?.hash) return null;
    if (/^0+$/.test(info.hash)) return { text: 'You · Not committed yet', title: 'Uncommitted change' };
    const when = relative(Number(info['author-time']));
    const summary = mide.config.get('git-blame.showSummary') && info.summary ? ` · ${info.summary.length > 60 ? info.summary.slice(0, 57) + '…' : info.summary}` : '';
    return {
      text: `${info.author}, ${when}${summary}`,
      title: `${info.hash.slice(0, 8)} · ${info.author} <${(info['author-mail'] || '').replace(/[<>]/g, '')}>\n${new Date(Number(info['author-time']) * 1000).toLocaleString()}\n\n${info.summary || ''}`,
      info,
    };
  }

  let timer = null;
  let seq = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(update, 250);
  }

  async function update() {
    const editor = mide.workspace.getActiveEditor();
    const my = ++seq;
    if (!editor?.view || !mide.config.get('git-blame.inline')) return;
    const path = editor.getPath();
    // Blame describes the file on disk, so line numbers only match when there are no unsaved edits.
    if (!path || editor.isDirty() || !editor.view.hasFocus) return;
    const { state } = editor.view;
    const line = state.doc.lineAt(state.selection.main.head);
    if (!state.selection.main.empty || !line.text.trim()) return;
    const d = describe(await blameLine(path, line.number));
    if (!d || my !== seq || !editor.view) return;
    const current = editor.view.state.doc.lineAt(editor.view.state.selection.main.head);
    if (current.number !== line.number) return;
    editor.view.dispatch({ effects: setBlame.of(Decoration.set([Decoration.widget({ widget: new BlameWidget(d.text, d.title), side: 1 }).range(current.to)])) });
  }

  mide.workspace.onDidUpdateEditor((editor, u) => { if (editor === mide.workspace.getActiveEditor() && (u?.selectionSet || u?.focusChanged)) schedule(); });
  mide.workspace.onDidChangeActiveItem(schedule);
  mide.workspace.onDidSave(() => { roots.clear(); schedule(); });
  mide.config.onDidChange('git-blame.showSummary', () => schedule());
  mide.config.onDidChange('git-blame.inline', (on) => {
    if (on) { schedule(); return; }
    for (const i of mide.workspace.getItems()) {
      if (i.type === 'editor' && i.view) i.view.dispatch({ effects: setBlame.of(Decoration.none) });
    }
  });

  mide.commands.add('git-blame:show-line', 'Show Blame for Current Line', async () => {
    const editor = mide.workspace.getActiveEditor();
    if (!editor?.getPath()) return;
    const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
    const d = describe(await blameLine(editor.getPath(), line));
    if (!d) return mide.notify.info('No blame information for this line', 'The file may be untracked or outside a git repository.');
    mide.notify.info(d.text, d.title, d.info?.hash && !/^0+$/.test(d.info.hash) ? { actions: [{ label: 'Copy commit hash', run: () => mide.clipboard.write(d.info.hash) }] } : {});
  });
  mide.commands.add('git-blame:toggle', 'Toggle Inline Blame', () => mide.config.set('git-blame.inline', !mide.config.get('git-blame.inline')));

  mide.styles.add(`
    .cm-blame { margin-left: 3em; color: var(--fg-subtle); opacity: 0.75; font-style: italic; font-size: 0.9em; white-space: nowrap; pointer-events: auto; user-select: none; }
  `);
}
