// Line diff (Myers, O(ND)) reduced to gutter hunks.
// Returns [{ type: 'added'|'modified'|'deleted', line (1-based in b), count }].

export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = myers(a.slice(start, endA), b.slice(start, endB));
  const hunks = [];
  let ia = 0;
  let ib = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === '=') { ia++; ib++; i++; continue; }
    let del = 0;
    let ins = 0;
    const hunkStart = ib;
    while (i < ops.length && ops[i] !== '=') {
      if (ops[i] === '-') { del++; ia++; } else { ins++; ib++; }
      i++;
    }
    const line = start + hunkStart + 1;
    if (ins === 0) hunks.push({ type: 'deleted', line: line - 1 || 1, count: 0 });
    else if (del === 0) hunks.push({ type: 'added', line, count: ins });
    else {
      const mod = Math.min(del, ins);
      hunks.push({ type: 'modified', line, count: mod });
      if (ins > del) hunks.push({ type: 'added', line: line + mod, count: ins - mod });
    }
  }
  return hunks;
}

// Beyond this many edits the diff is reported as one modified block (keeps memory and time small).
const MAX_EDITS = 2000;

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return Array(m).fill('+');
  if (!m) return Array(n).fill('-');
  const max = Math.min(n + m, MAX_EDITS);
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace = []; // trace[d] = v[-d..d] before round d: O(D²) memory instead of O(D·(n+m))
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [...Array(n).fill('-'), ...Array(m).fill('+')];
}

function backtrack(trace, a, b, dEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const at = (k) => v[k + d];
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
