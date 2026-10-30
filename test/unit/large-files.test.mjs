import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { isLargeText, hasLongLine, isLargeFile, largeFile, LONG_LINE, formatSize } from '../../src/renderer/core/large-files.js';

const MB = 1024 * 1024;

test('a file over the size setting is large, and 0 turns large files off', () => {
  assert.equal(isLargeText('small', 11 * MB, 10), true);
  assert.equal(isLargeText('small', 9 * MB, 10), false);
  assert.equal(isLargeText('small', 900 * MB, 0), false);
});

test('one line over 200 KB makes a small file large', () => {
  const long = 'x'.repeat(LONG_LINE + 1);
  assert.equal(hasLongLine(`a\n${long}\nb\n`), true);
  assert.equal(hasLongLine(`a\n${'x'.repeat(LONG_LINE)}\nb\n`), false);
  assert.equal(hasLongLine(('y'.repeat(1000) + '\n').repeat(1000)), false);
  assert.equal(hasLongLine(`one\r${long}\rthree\r`), true); // old Mac line ends
  assert.equal(hasLongLine(('z'.repeat(1000) + '\r').repeat(1000)), false);
  assert.equal(isLargeText(`a\n${long}`, LONG_LINE + 3, 10), true);
});

test('isLargeFile reads documents, editors, views and states', () => {
  const state = EditorState.create({ extensions: largeFile.of(true) });
  assert.equal(isLargeFile(state), true);
  assert.equal(isLargeFile({ state }), true); // a view
  assert.equal(isLargeFile(EditorState.create()), false);
  assert.equal(isLargeFile({ large: true, path: '/a' }), true); // a Document
  assert.equal(isLargeFile({ document: { large: false } }), false); // an EditorItem
  assert.equal(isLargeFile(null), false);
});

test('sizes read as people say them', () => {
  assert.equal(formatSize(600 * MB), '600 MB');
  assert.equal(formatSize(1.5 * MB), '1.5 MB');
  assert.equal(formatSize(300 * 1024), '300 KB');
});
