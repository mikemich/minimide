// Editor Guides: scope-aware indent guides and rainbow brackets.

const BRACKETS = { '(': 1, '[': 1, '{': 1, ')': -1, ']': -1, '}': -1 };
const COLORS = 6;
const MAX_DOC = 400_000; // skip rainbow brackets in very large files

export async function activate(mide) {
  const { indentationMarkers } = await mide.cm.extras.indentationMarkers();
  const { ViewPlugin, Decoration } = mide.cm.view;
  const { syntaxTree } = mide.cm.language;
  const { RangeSetBuilder } = mide.cm.state;

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

  // --- rainbow brackets ----------------------------------------------------
  const marks = Array.from({ length: COLORS }, (_, i) => Decoration.mark({ class: `rainbow-${i}` }));

  function build(view) {
    const builder = new RangeSetBuilder();
    const { state } = view;
    if (state.doc.length > MAX_DOC) return builder.finish();
    const tree = syntaxTree(state);
    const viewport = view.visibleRanges;
    if (!viewport.length) return builder.finish();
    const end = viewport[viewport.length - 1].to;
    let depth = 0;
    // Walk syntax tokens from the top so depth is right; only decorate what's visible.
    tree.iterate({
      to: end,
      enter: (node) => {
        const ch = node.to - node.from === 1 ? state.sliceDoc(node.from, node.to) : '';
        const dir = BRACKETS[ch];
        if (!dir || node.type.isError) return;
        if (dir < 0) depth = Math.max(0, depth - 1);
        if (viewport.some((r) => node.from >= r.from && node.to <= r.to)) builder.add(node.from, node.to, marks[depth % COLORS]);
        if (dir > 0) depth++;
      },
    });
    return builder.finish();
  }

  const rainbowPlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  }, { decorations: (v) => v.decorations });

  let rainbow = null;
  const applyRainbow = () => {
    rainbow?.dispose();
    rainbow = mide.config.get('editor-guides.rainbowBrackets') ? mide.editor.addExtension(rainbowPlugin) : null;
  };

  for (const key of ['editor-guides.indentGuides', 'editor-guides.highlightActiveScope']) mide.config.onDidChange(key, applyGuides);
  mide.config.onDidChange('editor-guides.rainbowBrackets', applyRainbow);
  mide.commands.add('editor-guides:toggle-rainbow-brackets', 'Toggle Rainbow Brackets', () =>
    mide.config.set('editor-guides.rainbowBrackets', !mide.config.get('editor-guides.rainbowBrackets')));
  mide.commands.add('editor-guides:toggle-indent-guides', 'Toggle Indent Guides', () =>
    mide.config.set('editor-guides.indentGuides', !mide.config.get('editor-guides.indentGuides')));
  mide.subscriptions.add({ dispose: () => { guides?.dispose(); rainbow?.dispose(); } });
  applyGuides();
  applyRainbow();

  mide.styles.add(`
    :root { --guide: color-mix(in srgb, var(--fg) 9%, transparent); --guide-active: color-mix(in srgb, var(--fg) 26%, transparent); }
    .rainbow-0, .rainbow-0 * { color: #e5c07b !important; }
    .rainbow-1, .rainbow-1 * { color: #c678dd !important; }
    .rainbow-2, .rainbow-2 * { color: #61afef !important; }
    .rainbow-3, .rainbow-3 * { color: #56b6c2 !important; }
    .rainbow-4, .rainbow-4 * { color: #98c379 !important; }
    .rainbow-5, .rainbow-5 * { color: #e06c75 !important; }
  `);
}
