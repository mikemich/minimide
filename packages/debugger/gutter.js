// The editor side of the debugger: a breakpoint gutter (click to toggle), red dots that move
// with edits, and the line where the program is paused (highlighted, with an arrow).

export function editorParts(mide, { onClick, onContextMenu }) {
  const { StateField, StateEffect, RangeSet, Prec } = mide.cm.state;
  const { gutter, GutterMarker, Decoration, EditorView } = mide.cm.view;

  /** [{ line, condition?, verified? }] for this editor's file. */
  const setBreakpoints = StateEffect.define();
  /** { line, top } where the program is paused (top: the innermost frame), or null. */
  const setCurrent = StateEffect.define();

  class Marker extends GutterMarker {
    constructor(cls, title) { super(); this.cls = cls; this.title = title; }
    eq(other) { return other.cls === this.cls && other.title === this.title; }
    toDOM() {
      const el = document.createElement('div');
      el.className = this.cls;
      if (this.title) el.title = this.title;
      return el;
    }
  }
  const spacer = new Marker('dbg-marker');
  const lineAt = (doc, n) => doc.line(Math.max(1, Math.min(n, doc.lines))).from;
  const lineStart = (doc, pos) => doc.lineAt(Math.max(0, Math.min(pos, doc.length))).from;

  function build(doc, bps, current) {
    const seen = new Set();
    bps = bps.filter((b) => !seen.has(b.pos) && seen.add(b.pos));
    const byPos = new Map(bps.map((b) => [b.pos, b]));
    if (current && !byPos.has(current.pos)) byPos.set(current.pos, null);
    const markers = [...byPos.keys()].sort((a, b) => a - b).map((pos) => {
      const b = byPos.get(pos);
      const cls = ['dbg-marker', b && 'bp', b?.verified === false && 'unverified', b?.condition && 'conditional', current?.pos === pos && (current.top ? 'arrow' : 'arrow frame')];
      const title = b ? (b.condition ? `Breakpoint if ${b.condition}` : b.verified === false ? `Breakpoint (not bound${b.message ? `: ${b.message}` : ' yet'})` : 'Breakpoint') : null;
      return new Marker(cls.filter(Boolean).join(' '), title).range(pos);
    });
    const deco = current ? Decoration.set([Decoration.line({ class: current.top ? 'cm-debug-current' : 'cm-debug-frame' }).range(current.pos)]) : Decoration.none;
    return { bps, current, markers: RangeSet.of(markers), deco };
  }

  const field = StateField.define({
    create: () => ({ bps: [], current: null, markers: RangeSet.empty, deco: Decoration.none }),
    update(value, tr) {
      let { bps, current } = value;
      let changed = false;
      const doc = tr.state.doc;
      if (tr.docChanged) {
        // Anchored after the line start: Enter at the start of a line carries its dot down with the text.
        bps = bps.map((b) => ({ ...b, pos: lineStart(doc, tr.changes.mapPos(b.pos, 1)) }));
        if (current) current = { ...current, pos: lineStart(doc, tr.changes.mapPos(current.pos, 1)) };
        changed = true;
      }
      for (const e of tr.effects) {
        if (e.is(setBreakpoints)) { bps = e.value.map((b) => ({ ...b, pos: lineAt(doc, b.line) })); changed = true; }
        if (e.is(setCurrent)) { current = e.value && { ...e.value, pos: lineAt(doc, e.value.line) }; changed = true; }
      }
      return changed ? build(doc, bps, current) : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  const lineOf = (view, block) => view.state.doc.lineAt(block.from).number;
  const extension = [
    field,
    // Leftmost, like other editors.
    Prec.high(gutter({
      class: 'cm-debug-gutter',
      markers: (view) => view.state.field(field).markers,
      initialSpacer: () => spacer,
      renderEmptyElements: true, // so an empty line shows a faint dot on hover
      domEventHandlers: {
        mousedown(view, block, event) {
          if (event.button !== 0) return false;
          onClick(view, lineOf(view, block));
          return true;
        },
        contextmenu(view, block, event) {
          event.preventDefault();
          onContextMenu(view, lineOf(view, block));
          return true;
        },
      },
    })),
  ];

  /** The breakpoints of a view, with lines updated for edits since they were set. */
  function read(view) {
    const { doc } = view.state;
    return view.state.field(field, false)?.bps.map(({ pos, ...b }) => ({ ...b, line: doc.lineAt(pos).number })) || [];
  }

  return { extension, setBreakpoints, setCurrent, read };
}
