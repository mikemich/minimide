import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderHints, hintSide } from '../../packages/inlay-hints/index.js';

test('orderHints: by position, then a parameter name before a type hint at the same spot', () => {
  const type = { kind: 1, label: ': number' };
  const param = { kind: 2, label: 'value:' };
  const other = { label: '…' };
  const ordered = orderHints([{ pos: 9, hint: other }, { pos: 4, hint: type }, { pos: 4, hint: param }, { pos: 1, hint: type }]);
  assert.deepEqual(ordered.map((r) => [r.pos, r.hint.label]), [[1, ': number'], [4, 'value:'], [4, ': number'], [9, '…']]);
  // CodeMirror's RangeSetBuilder wants (from, startSide) never to go down.
  for (let i = 1; i < ordered.length; i++) {
    const [a, b] = [ordered[i - 1], ordered[i]];
    assert.ok(a.pos < b.pos || hintSide(a.hint) <= hintSide(b.hint));
  }
});
