import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, encodeText } from '../../src/main/text-encoding.js';

const roundTrip = (bytes) => {
  const { text, ...meta } = decodeText(Buffer.from(bytes));
  return { text, meta, back: encodeText(text, meta) };
};

test('plain UTF-8 is read and written as is', () => {
  const r = roundTrip(Buffer.from('héllo ✓\n'));
  assert.deepEqual(r.meta, { encoding: 'utf8', bom: false });
  assert.equal(r.text, 'héllo ✓\n');
  assert.deepEqual(r.back.data, Buffer.from('héllo ✓\n'));
});

test('a UTF-8 byte order mark is dropped from the text and written back', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')]);
  const r = roundTrip(bytes);
  assert.equal(r.text, 'abc');
  assert.equal(r.meta.bom, true);
  assert.deepEqual(r.back.data, bytes);
});

test('a file that is not UTF-8 is read as Windows-1252 and written back byte for byte', () => {
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x81, 0x0a]);
  const r = roundTrip(bytes);
  assert.equal(r.meta.encoding, 'windows-1252');
  assert.equal(r.text.slice(0, 7), 'café “q');
  assert.deepEqual(r.back.data, bytes);
});

test('every byte value survives a Windows-1252 round trip', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const { text, encoding } = decodeText(bytes);
  assert.equal(encoding, 'windows-1252');
  assert.deepEqual(encodeText(text, { encoding }).data, bytes);
});

test('text Windows-1252 cannot hold is written as UTF-8 instead', () => {
  const out = encodeText('café ✓', { encoding: 'windows-1252' });
  assert.equal(out.encoding, 'utf8');
  assert.deepEqual(out.data, Buffer.from('café ✓'));
});

test('UTF-16 files with a byte order mark open as text and keep their encoding', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi\n', 'utf16le').swap16()]);
  for (const [bytes, encoding] of [[le, 'utf16le'], [be, 'utf16be']]) {
    const r = roundTrip(bytes);
    assert.equal(r.text, 'hi\n');
    assert.equal(r.meta.encoding, encoding);
    assert.deepEqual(r.back.data, bytes);
  }
});
