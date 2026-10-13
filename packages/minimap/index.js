// Minimap: @replit/codemirror-minimap, themed with Minimide's CSS variables.

export async function activate(mide) {
  const { showMinimap } = await mide.cm.extras.minimap();
  let ext = null;
  let visible = true;

  const create = () => {
    const dom = document.createElement('div');
    dom.className = 'mide-minimap';
    return { dom };
  };
  const apply = () => {
    ext?.dispose();
    ext = null;
    if (!visible) return;
    const config = {
      create,
      displayText: mide.config.get('minimap.display'),
      showOverlay: mide.config.get('minimap.showOverlay'),
    };
    ext = mide.editor.addExtension(showMinimap.compute([], () => config));
  };

  mide.config.onDidChange('minimap.display', apply);
  mide.config.onDidChange('minimap.showOverlay', apply);
  mide.commands.add('minimap:toggle', 'Toggle Minimap', () => { visible = !visible; apply(); });
  mide.subscriptions.add({ dispose: () => ext?.dispose() });
  apply();

  mide.styles.add(`
    .cm-minimap-gutter { background: var(--bg); border-left: 1px solid var(--border); }
    .cm-minimap-overlay { background: var(--fg) !important; opacity: 0.06 !important; border-radius: 2px; }
    .cm-minimap-overlay-container:hover .cm-minimap-overlay { opacity: 0.12 !important; }
  `);
}
