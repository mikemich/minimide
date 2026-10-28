// A small line diff for the "what will change" preview.

/** Line-by-line differences as [{ type: 'same' | 'add' | 'del', text }], by longest common subsequence. */
export function lineDiff(before, after) {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  // Trim what both ends share, so the table only covers the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const out = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > 4_000_000) {
    // Too big for a table: show the middle as one removal and one addition.
    for (const text of x) out.push({ type: 'del', text });
    for (const text of y) out.push({ type: 'add', text });
  } else {
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { out.push({ type: 'same', text: x[i] }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) out.push({ type: 'del', text: x[i++] });
      else out.push({ type: 'add', text: y[j++] });
    }
    while (i < x.length) out.push({ type: 'del', text: x[i++] });
    while (j < y.length) out.push({ type: 'add', text: y[j++] });
  }
  for (const text of a.slice(endA)) out.push({ type: 'same', text });
  return out;
}

/** Keep `context` unchanged lines around each change and replace longer runs with a { type: 'gap', count } row. */
export function collapse(lines, context = 2) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (gap) { out.push({ type: 'gap', count: gap }); gap = 0; } out.push(l); } else gap++;
  });
  if (gap) out.push({ type: 'gap', count: gap });
  return out;
}

export function summarize(lines) {
  let added = 0;
  let removed = 0;
  for (const l of lines) { if (l.type === 'add') added++; else if (l.type === 'del') removed++; }
  return { added, removed };
}
