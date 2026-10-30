// The editor side of the Test Explorer: a run button beside each test and suite (its icon shows
// the last result), and each failure's message under the failing test's line. Both move with
// edits until the file is scanned again.

export function editorParts(mide, { onRun, onMenu }) {
  const { StateField, StateEffect, RangeSet } = mide.cm.state;
  const { gutter, GutterMarker, Decoration, EditorView, WidgetType } = mide.cm.view;

  /** { marks: [{ line, status, title, id }], failures: [{ line, title, message, expected, actual }] } for a view. */
  const setTests = StateEffect.define();

  class Marker extends GutterMarker {
    constructor(m) { super(); this.m = m; }
    eq(other) { return other.m.status === this.m.status && other.m.title === this.m.title && other.m.id === this.m.id; }
    toDOM() {
      const el = document.createElement('div');
      el.className = `tx-run ${this.m.status || 'none'}`;
      el.title = this.m.title;
      el.dataset.id = this.m.id;
      return el;
    }
  }

  class Failure extends WidgetType {
    constructor(f) { super(); this.f = f; }
    eq(other) { return JSON.stringify(other.f) === JSON.stringify(this.f); }
    toDOM() {
      const { h } = mide.ui;
      const f = this.f;
      return h('div.tx-inline', { role: 'note', 'aria-label': `${f.title} failed` },
        h('div.tx-inline-title', f.title),
        f.message ? h('pre.tx-inline-message', f.message) : null,
        f.expected != null || f.actual != null ? h('div.tx-inline-values',
          h('span.tx-inline-expected', h('span.tx-inline-label', 'Expected '), String(f.expected ?? '')),
          h('span.tx-inline-actual', h('span.tx-inline-label', 'Received '), String(f.actual ?? ''))) : null);
    }
    ignoreEvent() { return false; }
  }

  const lineAt = (doc, n) => doc.line(Math.max(1, Math.min(n, doc.lines)));

  function build(doc, value) {
    const seen = new Set();
    const marks = value.marks.filter((m) => m.line >= 1 && m.line <= doc.lines && !seen.has(m.line) && seen.add(m.line))
      .sort((a, b) => a.line - b.line);
    const failures = value.failures.filter((f) => f.line >= 1 && f.line <= doc.lines).sort((a, b) => a.line - b.line);
    return {
      value,
      markers: RangeSet.of(marks.map((m) => new Marker(m).range(lineAt(doc, m.line).from))),
      deco: Decoration.set(failures.map((f) => Decoration.widget({ widget: new Failure(f), block: true, side: 1 }).range(lineAt(doc, f.line).to))),
    };
  }

  const empty = { marks: [], failures: [] };
  const field = StateField.define({
    create: (state) => build(state.doc, empty),
    update(v, tr) {
      for (const e of tr.effects) if (e.is(setTests)) return build(tr.state.doc, e.value);
      if (!tr.docChanged) return v;
      // Until the next scan, keep everything on its line as text moves.
      const move = (line) => tr.state.doc.lineAt(tr.changes.mapPos(tr.startState.doc.line(Math.min(line, tr.startState.doc.lines)).from, 1)).number;
      return build(tr.state.doc, {
        marks: v.value.marks.map((m) => ({ ...m, line: move(m.line) })),
        failures: v.value.failures.map((f) => ({ ...f, line: move(f.line) })),
      });
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  const lineOf = (view, block) => view.state.doc.lineAt(block.from).number;
  const markAt = (view, line) => view.state.field(field).value.marks.find((m) => m.line === line);
  const extension = [
    field,
    gutter({
      class: 'cm-test-gutter',
      markers: (view) => view.state.field(field).markers,
      domEventHandlers: {
        mousedown(view, block, event) {
          const m = markAt(view, lineOf(view, block));
          if (event.button !== 0 || !m) return false;
          onRun(m.id);
          return true;
        },
        contextmenu(view, block, event) {
          const m = markAt(view, lineOf(view, block));
          if (!m) return false;
          event.preventDefault();
          onMenu(m.id);
          return true;
        },
      },
    }),
  ];

  return { extension, setTests };
}
