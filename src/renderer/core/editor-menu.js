// Right-click menu for editors. Commands that can't run here (no language server, say) are left
// out; every entry shows its shortcut so the menu doubles as a way to learn them.
import { EditorView } from '@codemirror/view';

const GROUPS = [
  ['lsp:go-to-definition', 'lsp:peek-definition', 'lsp:find-references'],
  ['lsp:rename', 'lsp:code-actions', 'lsp:format-document'],
  [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
  ['editor:toggle-comment'],
  [{ id: 'command-palette:toggle', label: 'Command Palette…' }],
];

export function editorContextMenu(app) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      e.preventDefault();
      // Act on the word that was clicked, unless the click landed inside the selection.
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && !view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to)) {
        view.dispatch({ selection: { anchor: pos } });
      }
      view.focus();
      showEditorMenu(app);
      return true;
    },
  });
}

export async function showEditorMenu(app) {
  const items = [];
  for (const group of GROUPS) {
    const entries = group.map((x) => (typeof x === 'string' ? { id: x } : x))
      .filter((x) => x.role || app.commands.isEnabled(x.id))
      .map((x) => (x.role ? x : { id: x.id, label: x.label || app.commands.get(x.id).title, accelerator: app.keymap.acceleratorFor(x.id) }));
    if (!entries.length) continue;
    if (items.length) items.push({ type: 'separator' });
    items.push(...entries);
  }
  const id = await window.native.menu.popup(items);
  if (id) app.commands.run(id);
}
