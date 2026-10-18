// Fonts: bundles open-source fonts (see licenses/) and adds pickers that preview
// each font live as you move through the list. fonts.css only declares the faces;
// the browser loads a file the first time something actually uses that font.
import catalog from './catalog.js';

const EDITOR_FALLBACK = '"SF Mono", Menlo, Consolas, monospace';
const SAMPLE = 'const greet = (name) => `Hello, ${name}!`; // 0O 1lI {} => !== ->';

export function activate(mide) {
  const { h, highlightMatches } = mide.ui;
  const root = document.documentElement.style;

  const editorFonts = () => catalog.filter((f) => f.kind === 'mono');
  const uiFonts = () => catalog.filter((f) => f.kind === 'sans');
  const editorStack = (family) => (family ? `"${family}", ${EDITOR_FALLBACK}` : EDITOR_FALLBACK);
  const firstFamily = (stack) => (stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const currentEditor = () => firstFamily(mide.config.get('editor.fontFamily'));
  const currentUi = () => firstFamily(mide.config.get('ui.fontFamily'));

  // Load the faces in use up front, so the terminal measures the real font, not a fallback.
  const preload = (stack) => document.fonts.load(`14px ${stack}`).catch(() => {});
  mide.config.observe('editor.fontFamily', (v) => preload(v));

  function picker({ id, placeholder, fonts, current, preview, choose, extra }) {
    let chosen = false;
    const items = [...extra, ...fonts.map((f) => ({ label: f.family, detail: f.description, family: f.family, ligatures: f.ligatures }))];
    // The list previews whatever is highlighted, so start on the current font.
    items.sort((a, b) => (b.family === current) - (a.family === current));
    mide.ui.selectList({
      id, placeholder,
      items: items.map((it) => ({ ...it, hint: it.family === current ? 'current' : it.ligatures ? 'ligatures' : '' })),
      filterKey: (it) => it.label,
      onHighlight: (it) => preview(it),
      onSelect: (it) => { chosen = true; choose(it); },
      onCancel: () => { if (!chosen) preview(null); },
      render: (it, indices) => h('div.select-row',
        h('div.select-text',
          h('div.select-label', { style: { fontSize: '15px', fontFamily: it.family ? `"${it.family}"` : null } }, highlightMatches(it.label, indices)),
          h('div.select-detail', it.detail)),
        it.hint ? h('kbd.select-hint', it.hint) : null),
    });
  }

  function selectEditorFont() {
    picker({
      id: 'fonts-editor', placeholder: 'Select an editor font (↑↓ to preview)',
      fonts: editorFonts(), current: currentEditor(),
      extra: [{ label: 'System Monospace', detail: 'SF Mono on macOS, Consolas on Windows', family: '', system: true }],
      preview: (it) => root.setProperty('--editor-font', it ? editorStack(it.family) : mide.config.get('editor.fontFamily')),
      choose: (it) => mide.config.set('editor.fontFamily', editorStack(it.family)),
    });
  }

  function selectUiFont() {
    const apply = (family) => (family ? root.setProperty('--ui-font', `"${family}", -apple-system, system-ui, sans-serif`) : root.removeProperty('--ui-font'));
    picker({
      id: 'fonts-ui', placeholder: 'Select a UI font (↑↓ to preview)',
      fonts: uiFonts(), current: currentUi(),
      extra: [{ label: 'System Font', detail: 'San Francisco on macOS, Segoe UI on Windows', family: '' }],
      preview: (it) => apply(it ? it.family : currentUi()),
      choose: (it) => mide.config.set('ui.fontFamily', it.family ? `"${it.family}"` : undefined),
    });
  }

  mide.commands.add({
    'fonts:select-editor-font': { title: 'Select Editor Font…', run: selectEditorFont },
    'fonts:select-ui-font': { title: 'Select UI Font…', run: selectUiFont },
    'fonts:toggle-ligatures': {
      title: 'Toggle Font Ligatures',
      run: () => mide.config.set('editor.fontLigatures', mide.config.get('editor.fontLigatures') === false),
    },
  });

  mide.services.provide('fonts', {
    list: () => catalog.slice(),
    editorFonts, uiFonts, editorStack, currentEditor, currentUi, sample: SAMPLE,
    setEditorFont: (family) => mide.config.set('editor.fontFamily', editorStack(family)),
    setUiFont: (family) => mide.config.set('ui.fontFamily', family ? `"${family}"` : undefined),
  });
}
