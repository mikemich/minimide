// Inlay hints (textDocument/inlayHint): parameter names and inferred types drawn inline as small
// muted widgets. Each editor asks its language server (through the lsp service) only for what it
// shows, again after edits (once typing pauses) and scrolling, and whenever the server sends
// workspace/inlayHint/refresh.

const EDIT_DELAY = 400;
const SCROLL_DELAY = 150;

/** Which side of its position a hint sits on: a parameter name before its argument, the rest after. */
export const hintSide = (hint) => (hint.kind === 2 ? -1 : 1);

/**
 * [{ pos, hint }] in the order CodeMirror needs them (by position, then side), so a type hint and a
 * parameter name at the same spot don't make the decorations fail to build.
 */
export const orderHints = (ranges) => [...ranges].sort((a, b) => a.pos - b.pos || hintSide(a.hint) - hintSide(b.hint));

export function activate(mide) {
  const { ViewPlugin, Decoration, WidgetType } = mide.cm.view;
  const { RangeSetBuilder } = mide.cm.state;
  const instances = new Set();
  const lsp = () => mide.services.get('lsp');
  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view) || null;

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
      const server = lsp();
      const entry = server?.documentFor?.(view);
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
          range: { start: server.toPosition(doc, from), end: server.toPosition(doc, to) },
        }, { timeout: 5000 });
      } catch { return; }
      // Typed or scrolled meanwhile: a newer request is on its way.
      if (mine !== this.seq || view.state.doc !== doc || !instances.has(this)) return;
      const ranges = orderHints((hints || [])
        .map((hint) => ({ pos: server.fromPosition(doc, hint.position), hint }))
        .filter(({ pos, hint }) => pos >= from && pos <= to && labelText(hint.label)));
      const builder = new RangeSetBuilder();
      // A parameter name sits before its argument: keep the cursor next to the code it labels.
      for (const { pos, hint } of ranges) builder.add(pos, pos, Decoration.widget({ widget: new HintWidget(hint), side: hintSide(hint) }));
      this.decorations = builder.finish();
      view.dispatch({});
    }

    destroy() { instances.delete(this); clearTimeout(this.timer); }
  }

  mide.editor.addExtension(ViewPlugin.fromClass(Hints, { decorations: (p) => p.decorations }), { largeFiles: false });

  /** Ask again in every editor (or only those served by `client`). */
  function refresh(client) {
    for (const p of instances) if (!client || lsp()?.documentFor?.(p.view)?.client === client) p.schedule(0);
  }

  // A server that just opened a document, or asks for its hints to be fetched again.
  mide.services.consume('lsp', (server) => {
    refresh();
    mide.subscriptions.add(
      server.onDidAttach((doc) => { for (const p of instances) if (editorFor(p.view)?.document === doc) p.schedule(0); }),
      server.onDidRequestRefresh((what, client) => { if (what === 'inlayHint') refresh(client); }),
    );
  });
}
