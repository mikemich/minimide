// Color Preview: swatches before color literals; hex swatches open a color picker.

const COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\([^()\n]{3,60}\)/g;
const STYLE_LANGS = /css|scss|sass|less|html|vue|svelte/i;

export function activate(mide) {
  const { ViewPlugin, Decoration, WidgetType } = mide.cm.view;
  const { RangeSetBuilder, StateField, StateEffect } = mide.cm.state;

  // The color being edited is tracked through document changes, so typing elsewhere while the
  // (non-modal) picker is open never makes it overwrite the wrong text.
  const setPicking = StateEffect.define();
  const picking = StateField.define({
    create: () => null,
    update(range, tr) {
      for (const e of tr.effects) if (e.is(setPicking)) return e.value;
      if (!range || !tr.docChanged) return range;
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, -1);
      return to > from ? { from, to } : null; // the color text was deleted
    },
  });
  let activeInput = null;
  const closePicker = () => { activeInput?.remove(); activeInput = null; };

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
      closePicker();
      const input = document.createElement('input');
      activeInput = input;
      input.type = 'color';
      const hex = this.color.length === 4 ? '#' + [...this.color.slice(1)].map((c) => c + c).join('') : this.color;
      input.value = hex.toLowerCase();
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.append(input);
      view.dispatch({ effects: setPicking.of({ from: this.from, to: this.to }) });
      input.addEventListener('input', () => {
        const range = view.dom.isConnected ? view.state.field(picking, false) : null;
        if (!range) return closePicker(); // tab closed or the color was deleted
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: input.value },
          effects: setPicking.of({ from: range.from, to: range.from + input.value.length }),
          userEvent: 'input.color',
        });
      });
      const done = () => { if (activeInput === input) closePicker(); if (view.dom.isConnected) view.dispatch({ effects: setPicking.of(null) }); };
      input.addEventListener('change', done);
      // The system picker isn't focusable, so treat the window regaining focus as "dismissed".
      window.addEventListener('focus', () => setTimeout(done, 300), { once: true });
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

  const instances = new Set();
  mide.editor.addExtension([picking, ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.decorations = build(view); instances.add(this); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
    destroy() { instances.delete(this); }
  }, { decorations: (v) => v.decorations })], { largeFiles: false });
  // Apply the "Show In" setting immediately.
  mide.config.onDidChange('color-preview.languages', () => {
    for (const p of instances) { p.decorations = build(p.view); p.view.dispatch({}); }
  });
  mide.subscriptions.add({ dispose: closePicker });

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
