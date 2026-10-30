// Bracket pair colors: (), [] and {} get a color by nesting depth, so matching pairs are easy to see.
// Only the visible lines get marks, but the depth is counted from the start of the file, so a
// bracket opened above the screen still colors the one that closes it below.
import { ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { largeFile } from './large-files.js';

const LEVELS = 6;
// Counting from the top of a very large file on every scroll would be too slow.
const MAX_LENGTH = 1_000_000;
const BRACKET = /[()[\]{}]/g;
const OPEN = '([{';
const marks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: `cm-bracket-d${i}` }));

/** Brackets inside strings and comments don't nest. */
function inStringOrComment(tree, pos) {
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (/String|Comment|RegExp/.test(node.name)) return true;
  }
  return false;
}

function build(view) {
  const builder = new RangeSetBuilder();
  const { state } = view;
  if (state.doc.length > MAX_LENGTH || state.facet(largeFile)) return builder.finish();
  const { from, to } = view.viewport;
  const tree = syntaxTree(state);
  const text = state.sliceDoc(0, to);
  let depth = 0;
  for (const m of text.matchAll(BRACKET)) {
    const pos = m.index;
    if (inStringOrComment(tree, pos)) continue;
    if (OPEN.includes(m[0])) {
      if (pos >= from) builder.add(pos, pos + 1, marks[depth % LEVELS]);
      depth++;
    } else if (depth > 0) {
      // A closing bracket takes the color of the one it closes. A stray one stays plain.
      depth--;
      if (pos >= from) builder.add(pos, pos + 1, marks[depth % LEVELS]);
    }
  }
  return builder.finish();
}

export const bracketPairColors = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }

  update(update) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
      || update.startState.facet(largeFile) !== update.state.facet(largeFile)) {
      this.decorations = build(update.view);
    }
  }
}, { decorations: (v) => v.decorations });
