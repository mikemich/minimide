// The editor side of bookmarks: a narrow gutter (click a line to toggle), a faint tint on
// bookmarked lines, and a state field whose positions move with edits. A line that is deleted
// takes its bookmark with it; a line that is moved (Move Line Up / Down) takes it along.

export function editorParts(mide, { onClick, onContextMenu }) {
  const { StateField, StateEffect, RangeSet, Prec } = mide.cm.state;
  const { gutter, GutterMarker, Decoration, EditorView } = mide.cm.view;

  /** [{ line, label? }] for this editor's file: replaces every bookmark in the view. */
  const setMarks = StateEffect.define();

  class Marker extends GutterMarker {
    constructor(title) { super(); this.title = title; }
    eq(other) { return other.title === this.title; }
    toDOM() {
      const el = document.createElement('div');
      el.className = 'bm-marker bm';
      el.title = this.title;
      return el;
    }
  }
  class Spacer extends GutterMarker {
    toDOM() { const el = document.createElement('div'); el.className = 'bm-marker'; return el; }
  }
  const spacer = new Spacer();
  const lineAt = (doc, n) => doc.line(Math.max(1, Math.min(n, doc.lines))).from;
  const lineStart = (doc, pos) => doc.lineAt(Math.max(0, Math.min(pos, doc.length))).from;

  function build(marks) {
    const seen = new Set();
    marks = marks.filter((m) => !seen.has(m.pos) && seen.add(m.pos)).sort((a, b) => a.pos - b.pos);
    return {
      marks,
      markers: RangeSet.of(marks.map((m) => new Marker(m.label ? `Bookmark: ${m.label}` : 'Bookmark').range(m.pos))),
      deco: Decoration.set(marks.map((m) => Decoration.line({ class: 'cm-bookmark-line' }).range(m.pos))),
    };
  }

  /**
   * Where a bookmark on the old line starting at `pos` ends up: the new line start, or null when the
   * line was deleted. A change that removes the line but writes its text again (a moved line) keeps it.
   */
  function follow(tr, pos) {
    const old = tr.startState.doc;
    const line = old.lineAt(pos);
    const last = line.to >= old.length;
    let moved = null;
    let gone = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (gone) return;
      const covers = last ? fromA < line.from && toA >= line.to : fromA <= line.from && toA >= line.to + 1;
      if (!covers) return;
      gone = true;
      if (line.text.trim()) {
        let at = fromB;
        for (const text of inserted.toString().split('\n')) {
          if (text === line.text) { moved = at; break; }
          at += text.length + 1;
        }
      }
    });
    if (gone) return moved == null ? null : lineStart(tr.state.doc, moved);
    // Anchored after the line start: Enter at the start of a line carries its marker down with the text.
    return lineStart(tr.state.doc, tr.changes.mapPos(pos, 1));
  }

  const field = StateField.define({
    create: () => build([]),
    update(value, tr) {
      let { marks } = value;
      let changed = false;
      const doc = tr.state.doc;
      if (tr.docChanged) {
        marks = marks.map((m) => ({ ...m, pos: follow(tr, m.pos) })).filter((m) => m.pos != null);
        changed = true;
      }
      for (const e of tr.effects) {
        if (e.is(setMarks)) { marks = e.value.map((m) => ({ label: m.label, pos: lineAt(doc, m.line) })); changed = true; }
      }
      return changed ? build(marks) : value;
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.deco)],
  });

  const lineOf = (view, block) => view.state.doc.lineAt(block.from).number;
  const extension = [
    field,
    // Left of the line numbers (and right of the debugger's gutter, which is added first).
    Prec.high(gutter({
      class: 'cm-bookmark-gutter',
      markers: (view) => view.state.field(field).markers,
      initialSpacer: () => spacer,
      renderEmptyElements: true, // so an empty line shows a faint marker on hover
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

  /** The bookmarks of a view as { line, text, label? }, lines updated for edits since they were set. */
  function read(view) {
    const { doc } = view.state;
    return (view.state.field(field, false)?.marks || []).map((m) => {
      const line = doc.lineAt(m.pos);
      return { line: line.number, text: line.text.trim().slice(0, 200), ...(m.label ? { label: m.label } : {}) };
    });
  }

  return { extension, setMarks, read };
}
