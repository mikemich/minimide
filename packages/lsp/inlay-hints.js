// Inlay hints (textDocument/inlayHint): parameter names and inferred types drawn inline as small
// muted widgets. Each editor asks only for what it shows, again after edits (once typing pauses)
// and scrolling, and whenever the server sends workspace/inlayHint/refresh.
import { toPosition, fromPosition } from './util.js';

const EDIT_DELAY = 400;
const SCROLL_DELAY = 150;

/** `entryFor(view)` is the tracked document for an editor view (or null). Returns { extension, refresh(client?) }. */
export function inlayHints(mide, entryFor) {
  const { ViewPlugin, Decoration, WidgetType } = mide.cm.view;
  const { RangeSetBuilder } = mide.cm.state;
  const instances = new Set();
  const enabled = () => !!mide.config.get('lsp.inlayHints');

  const labelText = (label) => (typeof label === 'string' ? label : (label || []).map((p) => p.value).join(''));
  const tooltipText = (t) => (t == null ? '' : typeof t === 'string' ? t : t.value || '');

  class HintWidget extends WidgetType {
    constructor(hint) {
      super();
      this.text = labelText(hint.label);
      this.kind = hint.kind === 1 ? 'type' : hint.kind === 2 ? 'parameter' : 'other';
      this.padLeft = !!hint.paddingLeft;
      this.padRight = !!hint.paddingRight;
      const parts = Array.isArray(hint.label) ? hint.label.map((p) => tooltipText(p.tooltip)).filter(Boolean) : [];
      this.title = [tooltipText(hint.tooltip), ...parts].filter(Boolean).join('\n');
    }
    eq(o) { return o.text === this.text && o.kind === this.kind && o.padLeft === this.padLeft && o.padRight === this.padRight && o.title === this.title; }
    toDOM() {
      const el = document.createElement('span');
      el.className = `cm-inlay-hint cm-inlay-hint-${this.kind}${this.padLeft ? ' cm-inlay-pad-left' : ''}${this.padRight ? ' cm-inlay-pad-right' : ''}`;
      el.textContent = this.text;
      if (this.title) el.title = this.title;
      return el;
    }
    ignoreEvent() { return false; }
  }

  class Hints {
    constructor(view) {
      this.view = view;
      this.decorations = Decoration.none;
      this.timer = null;
      this.seq = 0;
      instances.add(this);
      this.schedule(0);
    }

    update(u) {
      if (u.docChanged) {
        this.decorations = this.decorations.map(u.changes);
        this.schedule(EDIT_DELAY);
      } else if (u.viewportChanged) this.schedule(SCROLL_DELAY);
    }

    schedule(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fetch(), delay);
    }

    clear() {
      this.seq++;
      if (this.decorations.size) { this.decorations = Decoration.none; this.view.dispatch({}); }
    }

    async fetch() {
      const { view } = this;
      const entry = enabled() ? entryFor(view) : null;
      if (!entry?.client.capabilities.inlayHintProvider) return this.clear();
      const mine = ++this.seq;
      const doc = view.state.doc;
      // Whole lines of the viewport (what is drawn, plus CodeMirror's margin above and below).
      const from = doc.lineAt(view.viewport.from).from;
      const to = doc.lineAt(view.viewport.to).to;
      let hints;
      try {
        hints = await entry.client.request('textDocument/inlayHint', {
          textDocument: { uri: entry.uri },
          range: { start: toPosition(doc, from), end: toPosition(doc, to) },
        }, { timeout: 5000 });
      } catch { return; }
      // Typed or scrolled meanwhile: a newer request is on its way.
      if (mine !== this.seq || view.state.doc !== doc || !instances.has(this)) return;
      const ranges = (hints || [])
        .map((hint) => ({ pos: fromPosition(doc, hint.position), hint }))
        .filter(({ pos, hint }) => pos >= from && pos <= to && labelText(hint.label))
        .sort((a, b) => a.pos - b.pos);
      const builder = new RangeSetBuilder();
      // A parameter name sits before its argument: keep the cursor next to the code it labels.
      for (const { pos, hint } of ranges) builder.add(pos, pos, Decoration.widget({ widget: new HintWidget(hint), side: hint.kind === 2 ? -1 : 1 }));
      this.decorations = builder.finish();
      view.dispatch({});
    }

    destroy() { instances.delete(this); clearTimeout(this.timer); }
  }

  const extension = ViewPlugin.fromClass(Hints, { decorations: (p) => p.decorations });

  /** Ask again in every editor (or only those served by `client`). */
  function refresh(client) {
    for (const p of instances) if (!client || entryFor(p.view)?.client === client) p.schedule(0);
  }

  mide.config.onDidChange('lsp.inlayHints', () => refresh());
  mide.styles.add(`
    .cm-inlay-hint {
      display: inline-block; padding: 0 4px; margin: 0 1px; border-radius: 4px; vertical-align: baseline;
      font-family: var(--editor-font); font-size: 0.86em; line-height: 1.35; font-style: normal; font-weight: normal;
      color: var(--fg-muted); background: color-mix(in srgb, var(--fg-subtle) 16%, transparent);
      user-select: none; cursor: default;
    }
    .cm-inlay-hint-parameter { color: var(--fg-subtle); }
    .cm-inlay-pad-left { margin-left: 0.45em; }
    .cm-inlay-pad-right { margin-right: 0.45em; }
  `);
  return { extension, refresh };
}
