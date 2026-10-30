// Reading and writing text files without damaging them: a byte order mark is kept, UTF-16 files
// open as text, and a file that isn't valid UTF-8 is treated as Windows-1252 (every byte maps to a
// character and back), so saving never turns its accented letters into U+FFFD.

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const cp1252 = new TextDecoder('windows-1252');
let cp1252Reverse = null;

/** Windows-1252 as a char -> byte map, built from the decoder so it is exactly its inverse. */
function reverseTable() {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map();
    for (let b = 0; b < 256; b++) cp1252Reverse.set(cp1252.decode(Uint8Array.of(b)), b);
  }
  return cp1252Reverse;
}

/** A NUL byte near the start of a file that isn't UTF-16 means binary, so it isn't decoded at all. */
export function looksBinary(buf) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false;
  return buf.subarray(0, 8000).includes(0);
}

/** Decodes file bytes: { text, encoding: 'utf8' | 'utf16le' | 'utf16be' | 'windows-1252', bom }. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe && !((buf.length - 2) % 2)) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  if (buf[0] === 0xfe && buf[1] === 0xff && !((buf.length - 2) % 2)) {
    return { text: Buffer.from(buf.subarray(2)).swap16().toString('utf16le'), encoding: 'utf16be', bom: true };
  }
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  try { return { text: utf8Strict.decode(body), encoding: 'utf8', bom }; } catch {}
  return { text: cp1252.decode(buf), encoding: 'windows-1252', bom: false };
}

/**
 * Encodes text for writing. Windows-1252 can't hold every character: when the text has one that
 * doesn't fit, it is written as UTF-8 and `encoding` in the result says so.
 */
export function encodeText(text, { encoding = 'utf8', bom = false } = {}) {
  if (encoding === 'utf16le') return { data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), encoding, bom: true };
  if (encoding === 'utf16be') return { data: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]), encoding, bom: true };
  if (encoding === 'windows-1252') {
    const table = reverseTable();
    const out = Buffer.alloc(text.length);
    let ok = true;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) { out[i] = c; continue; } // ASCII is the same byte: skip the lookup, a big file is mostly that
      const b = table.get(text[i]);
      if (b === undefined) { ok = false; break; }
      out[i] = b;
    }
    if (ok) return { data: out, encoding, bom: false };
  }
  const body = Buffer.from(text, 'utf8');
  return { data: bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body, encoding: 'utf8', bom };
}
