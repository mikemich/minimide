// Color Preview: swatches before color literals; hex swatches open a color picker.

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\([^()\n]{3,60}\)/g;
const STYLE_LANGS = /css|scss|sass|less|html|vue|svelte/i;

export function activate(mide) {
  const { ViewPlugin, Decoration, WidgetType } = mide.cm.view;
  const { RangeSetBuilder } = mide.cm.state;

  // Accept only strings the browser itself parses as colors.
  const probe = new Option().style;
  const isColor = (s) => { probe.color = ''; probe.color = s; return probe.color !== ''; };

  class Swatch extends WidgetType {
    constructor(color, from, to) { super(); Object.assign(this, { color, from, to }); }
    eq(other) { return other.color === this.color && other.from === this.from; }
    toDOM(view) {
      const el = document.createElement('span');
      el.className = 'cm-color-swatch';
      el.style.setProperty('--swatch', this.color);
      const editable = this.color.startsWith('#') && (this.color.length === 7 || this.color.length === 4);
      el.title = editable ? `${this.color}: click to change` : this.color;
      if (editable) {
        el.classList.add('editable');
        el.addEventListener('mousedown', (e) => { e.preventDefault(); this.pick(view); });
      }
      return el;
    }
    pick(view) {
      const input = document.createElement('input');
      input.type = 'color';
      const hex = this.color.length === 4 ? '#' + [...this.color.slice(1)].map((c) => c + c).join('') : this.color;
      input.value = hex.toLowerCase();
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.append(input);
      let from = this.from;
      let to = this.to;
      input.addEventListener('input', () => {
        view.dispatch({ changes: { from, to, insert: input.value }, userEvent: 'input.color' });
        to = from + input.value.length;
      });
      input.addEventListener('change', () => input.remove());
      input.addEventListener('blur', () => input.remove());
      input.click();
    }
    ignoreEvent() { return false; }
  }

  function build(view) {
    const builder = new RangeSetBuilder();
    const editor = mide.workspace.getItems().find((i) => i.view === view);
    if (mide.config.get('color-preview.languages') === 'styles' && !STYLE_LANGS.test(editor?.getLanguageName() || '')) return builder.finish();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      for (const m of text.matchAll(COLOR_RE)) {
        if (!isColor(m[0])) continue;
        const start = from + m.index;
        builder.add(start, start, Decoration.widget({ widget: new Swatch(m[0], start, start + m[0].length), side: -1 }));
      }
    }
    return builder.finish();
  }

  mide.editor.addExtension(ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  }, { decorations: (v) => v.decorations }));

  mide.styles.add(`
    .cm-color-swatch {
      display: inline-block; width: 0.8em; height: 0.8em; margin: 0 0.3em 0 0.1em; vertical-align: -0.05em;
      border-radius: 3px; background: linear-gradient(var(--swatch), var(--swatch)), repeating-conic-gradient(#999 0 25%, #fff 0 50%) 50% / 6px 6px;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--fg) 25%, transparent);
    }
    .cm-color-swatch.editable { cursor: pointer; }
    .cm-color-swatch.editable:hover { transform: scale(1.2); }
  `);
}
