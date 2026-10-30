// Changes between two versions of a file, and the patches `git apply --cached` takes to put some of
// them in the index. A version is a list of lines that keep their line endings ('a\r\n', 'b\n', and a
// last line without one), so CRLF files and a missing final newline come out byte for byte.

/** 'a\nb' -> ['a\n', 'b']. */
export const toLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];

/** The line ending most lines use ('\r\n' or '\n'), or null when no line has one. */
export function eolOf(lines) {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) if (l.endsWith('\r\n')) crlf++; else if (l.endsWith('\n')) lf++;
  return crlf || lf ? (crlf > lf ? '\r\n' : '\n') : null;
}

/** Changes from `a` to `b`: [{ oldStart, oldCount, newStart, newCount }], 0-based line indexes. */
export function hunks(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = editScript(a.slice(start, endA), b.slice(start, endB));
  const out = [];
  let ia = start;
  let ib = start;
  for (let i = 0; i < ops.length;) {
    if (ops[i] === '=') { ia++; ib++; i++; continue; }
    const h = { oldStart: ia, oldCount: 0, newStart: ib, newCount: 0 };
    for (; i < ops.length && ops[i] !== '='; i++) {
      if (ops[i] === '-') { h.oldCount++; ia++; } else { h.newCount++; ib++; }
    }
    out.push(h);
  }
  return out;
}

/** `a` with each edit ({ oldStart, oldCount, lines }) made. A line that ends up with another after it gets a line ending. */
export function apply(a, edits) {
  const out = [];
  let pos = 0;
  for (const e of [...edits].sort((x, y) => x.oldStart - y.oldStart)) {
    out.push(...a.slice(pos, e.oldStart), ...e.lines);
    pos = e.oldStart + e.oldCount;
  }
  out.push(...a.slice(pos));
  const eol = eolOf(out) || eolOf(a) || '\n';
  for (let i = 0; i < out.length - 1; i++) if (!out[i].endsWith('\n')) out[i] += eol;
  return out;
}

/** `a` with the given hunks (from hunks(a, b)) taken from `b`. */
export const applyHunks = (a, b, list) => apply(a, list.map((h) => ({ oldStart: h.oldStart, oldCount: h.oldCount, lines: b.slice(h.newStart, h.newStart + h.newCount) })));

/** The same change seen from the other side: hunks(b, a). */
export const invert = (h) => ({ oldStart: h.newStart, oldCount: h.newCount, newStart: h.oldStart, newCount: h.oldCount });

/**
 * `a` with only the changed lines of `b` that fall in lines from..to of `b` (0-based, inclusive).
 * Inside a hunk the old and new lines pair up in order: a picked new line replaces its old partner,
 * an unpicked one leaves it. Removed lines with no partner go with the hunk's last line (or, for a
 * hunk that only removes, with the lines just above and below where they were).
 */
export function selectLines(a, b, list, from, to) {
  const edits = [];
  for (const h of list) {
    const picked = (i) => h.newStart + i >= from && h.newStart + i <= to;
    const tail = h.newCount ? picked(h.newCount - 1) : from <= h.newStart && to >= h.newStart - 1;
    const lines = [];
    let touched = false;
    for (let i = 0; i < Math.max(h.oldCount, h.newCount); i++) {
      const take = i < h.newCount ? picked(i) : tail;
      if (take) touched = true;
      if (i < h.oldCount && !take) lines.push(a[h.oldStart + i]);
      if (i < h.newCount && take) lines.push(b[h.newStart + i]);
    }
    if (touched) edits.push({ oldStart: h.oldStart, oldCount: h.oldCount, lines });
  }
  return apply(a, edits);
}

/**
 * The other way round: `b` with its changed lines in from..to (0-based, inclusive) put back the way
 * they are in `a`, pairing lines the same way. unselectLines(a, b, list, 0, Infinity) is `a`.
 */
export function unselectLines(a, b, list, from, to) {
  const edits = [];
  for (const h of list) {
    const picked = (i) => h.newStart + i >= from && h.newStart + i <= to;
    const tail = h.newCount ? picked(h.newCount - 1) : from <= h.newStart && to >= h.newStart - 1;
    const lines = [];
    let touched = false;
    for (let i = 0; i < Math.max(h.oldCount, h.newCount); i++) {
      const take = i < h.newCount ? picked(i) : tail;
      if (take) touched = true;
      if (i < h.oldCount && take) lines.push(a[h.oldStart + i]);
      if (i < h.newCount && !take) lines.push(b[h.newStart + i]);
    }
    if (touched) edits.push({ oldStart: h.newStart, oldCount: h.newCount, lines });
  }
  return apply(b, edits);
}

// Git quotes a name with a quote, backslash or control character in it ("a/tab\there").
function quote(name) {
  if (!/["\\\x00-\x1f\x7f]/.test(name)) return name;
  const esc = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return `"${name.replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] || `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

/**
 * A unified diff that turns `a` into `b` for the file at `path` (relative to the repository, with
 * forward slashes), or '' when they are the same. `a` must be exactly what the index holds.
 */
export function patch(path, a, b, { context = 3 } = {}) {
  const list = hunks(a, b);
  if (!list.length) return '';
  const out = [`diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}`, `--- ${quote(`a/${path}`)}`, `+++ ${quote(`b/${path}`)}`];
  const line = (sign, text) => (text.endsWith('\n') ? `${sign}${text.slice(0, -1)}` : `${sign}${text}\n\\ No newline at end of file`);
  const range = (start, count) => (count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`);
  for (let i = 0; i < list.length;) {
    // Hunks whose context would touch go in one block.
    let j = i;
    while (j + 1 < list.length && list[j + 1].oldStart - (list[j].oldStart + list[j].oldCount) <= 2 * context) j++;
    const first = list[i];
    const last = list[j];
    const oldFrom = Math.max(0, first.oldStart - context);
    const oldTo = Math.min(a.length, last.oldStart + last.oldCount + context);
    const newFrom = first.newStart - (first.oldStart - oldFrom);
    const newTo = last.newStart + last.newCount + (oldTo - last.oldStart - last.oldCount);
    out.push(`@@ -${range(oldFrom, oldTo - oldFrom)} +${range(newFrom, newTo - newFrom)} @@`);
    let pos = oldFrom;
    for (const h of list.slice(i, j + 1)) {
      for (; pos < h.oldStart; pos++) out.push(line(' ', a[pos]));
      for (let k = 0; k < h.oldCount; k++) out.push(line('-', a[h.oldStart + k]));
      for (let k = 0; k < h.newCount; k++) out.push(line('+', b[h.newStart + k]));
      pos = h.oldStart + h.oldCount;
    }
    for (; pos < oldTo; pos++) out.push(line(' ', a[pos]));
    i = j + 1;
  }
  return out.join('\n') + '\n';
}

// Myers' O(ND) diff over lines: a list of '=', '-' and '+'. Past MAX_EDITS it gives up and calls the
// whole range one change (keeps time and memory small on files that changed completely).
const MAX_EDITS = 2000;

function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return Array(m).fill('+');
  if (!m) return Array(n).fill('-');
  const max = Math.min(n + m, MAX_EDITS);
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
  }
  return [...Array(n).fill('-'), ...Array(m).fill('+')];
}

function backtrack(trace, n, m, dEnd) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const at = (k) => trace[d][k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
    if (x === prevX) { ops.push('+'); y--; } else { ops.push('-'); x--; }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}
