// Right-click menu for editors. Commands that can't run here (no language server, say) are left
// out; every entry shows its shortcut so the menu doubles as a way to learn them.
import { EditorView } from '@codemirror/view';

const GROUPS = [
  ['lsp:go-to-definition', 'lsp:peek-definition', 'lsp:find-references'],
  ['lsp:rename', 'lsp:code-actions', 'lsp:format-document'],
  [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
  ['editor:toggle-comment', 'code-image:copy'],
  [{ id: 'command-palette:toggle', label: 'Command Palette…' }],
];

export function editorContextMenu(app) {
  // Chromium's spell checker; tests swap in a fixed answer.
  app.spellLookup ??= (word) => window.native.spell?.check(word);
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      e.preventDefault();
      // Act on the word that was clicked, unless the click landed inside the selection.
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && !view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to)) {
        view.dispatch({ selection: { anchor: pos } });
      }
      view.focus();
      showEditorMenu(app, view, pos);
      return true;
    },
  });
}

/** The word around pos when the spell checker flags it, with its suggestions. */
async function misspelling(app, view, pos) {
  if (pos == null || view.contentDOM.getAttribute('spellcheck') !== 'true') return null;
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/\p{L}[\p{L}\p{M}'’]*/gu)) {
    const word = m[0].replace(/['’]+$/, '');
    const from = line.from + m.index;
    if (pos < from || pos > from + word.length) continue;
    const verdict = await app.spellLookup(word);
    return verdict?.misspelled ? { word, from, to: from + word.length, suggestions: verdict.suggestions.slice(0, 5) } : null;
  }
  return null;
}

/** The menu for the focused editor; pos is where it was right-clicked, if it was. */
export async function showEditorMenu(app, view = null, pos = null) {
  const items = [];
  const bad = await misspelling(app, view, pos);
  if (bad) {
    items.push(...bad.suggestions.map((s, i) => ({ id: `spell:${i}`, label: `Replace with "${s}"` })));
    if (!bad.suggestions.length) items.push({ id: 'spell:none', label: 'No spelling suggestions', enabled: false });
    items.push({ id: 'spell:add', label: 'Add to Dictionary' });
  }
  for (const group of GROUPS) {
    const entries = group.map((x) => (typeof x === 'string' ? { id: x } : x))
      .filter((x) => x.role || app.commands.isEnabled(x.id))
      .map((x) => (x.role ? x : { id: x.id, label: x.label || app.commands.get(x.id).title, accelerator: app.keymap.acceleratorFor(x.id) }));
    if (!entries.length) continue;
    if (items.length) items.push({ type: 'separator' });
    items.push(...entries);
  }
  const id = await window.native.menu.popup(items);
  if (!id) return;
  if (!id.startsWith('spell:')) return app.commands.run(id);
  if (id === 'spell:add') return window.native.spell.addWord(bad.word).catch((err) => app.ui.notify.error('Could not add the word', err.message));
  const replacement = bad.suggestions[Number(id.slice(6))];
  if (replacement != null && view.state.sliceDoc(bad.from, bad.to) === bad.word) {
    view.dispatch({ changes: { from: bad.from, to: bad.to, insert: replacement }, selection: { anchor: bad.from + replacement.length }, userEvent: 'input.complete' });
  }
}
