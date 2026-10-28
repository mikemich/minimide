// Editor Guides: scope-aware indent guides. (Bracket colors are built in: editor.bracketPairColors.)

export async function activate(mide) {
  const { indentationMarkers } = await mide.cm.extras.indentationMarkers();

  // --- indent guides -------------------------------------------------------
  let guides = null;
  const applyGuides = () => {
    guides?.dispose();
    guides = null;
    if (!mide.config.get('editor-guides.indentGuides')) return;
    const active = mide.config.get('editor-guides.highlightActiveScope');
    guides = mide.editor.addExtension(indentationMarkers({
      highlightActiveBlock: active,
      markerType: 'codeOnly',
      thickness: 1,
      activeThickness: 1,
      colors: {
        light: 'var(--guide)', dark: 'var(--guide)',
        activeLight: 'var(--guide-active)', activeDark: 'var(--guide-active)',
      },
    }));
  };

  for (const key of ['editor-guides.indentGuides', 'editor-guides.highlightActiveScope']) mide.config.onDidChange(key, applyGuides);
  mide.commands.add('editor-guides:toggle-indent-guides', 'Toggle Indent Guides', () =>
    mide.config.set('editor-guides.indentGuides', !mide.config.get('editor-guides.indentGuides')));
  mide.subscriptions.add({ dispose: () => guides?.dispose() });
  applyGuides();
  // Rainbow brackets moved into the editor as Bracket Pair Colors: carry the old choice over once.
  if (mide.config.get('editor-guides.rainbowBrackets')) {
    await mide.config.set('editor.bracketPairColors', true);
    await mide.config.set('editor-guides.rainbowBrackets', undefined);
  }

  mide.styles.add(`
    :root { --guide: color-mix(in srgb, var(--fg) 9%, transparent); --guide-active: color-mix(in srgb, var(--fg) 26%, transparent); }
  `);
}
