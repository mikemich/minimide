// Fuzzy matcher tuned for paths and command names.
// Returns { score, indices } or null. Higher scores are better.

export function fuzzyMatch(query, text) {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const indices = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    // Prefer a match at a word boundary ahead, otherwise take the next occurrence.
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== ch) continue;
      if (found < 0) found = j;
      if (isBoundary(text, j)) { found = j; break; }
      if (j === prev + 1) break;
    }
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 5;
    if (isBoundary(text, found)) s += 4;
    if (found > lastSlash) s += 2;
    if (text[found] === query[qi]) s += 0.5;
    score += s;
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= text.length * 0.02;
  if (t.endsWith(q) || t.slice(lastSlash + 1).startsWith(q)) score += 6;
  return { score, indices };
}

function isBoundary(text, i) {
  if (i === 0) return true;
  const p = text[i - 1];
  const c = text[i];
  return p === '/' || p === '\\' || p === '-' || p === '_' || p === '.' || p === ' ' || p === ':' || (p === p.toLowerCase() && c !== c.toLowerCase());
}

export function fuzzyFilter(query, items, key = (x) => x, limit = 200) {
  if (!query) return items.slice(0, limit).map((item) => ({ item, indices: [] }));
  const out = [];
  for (const item of items) {
    const m = fuzzyMatch(query, key(item));
    if (m) out.push({ item, score: m.score, indices: m.indices });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export function highlightMatches(text, indices) {
  const frag = document.createDocumentFragment();
  if (!indices?.length) { frag.append(text); return frag; }
  const set = new Set(indices);
  let buf = '';
  let inMatch = false;
  const flush = () => {
    if (!buf) return;
    if (inMatch) { const m = document.createElement('mark'); m.textContent = buf; frag.append(m); } else frag.append(buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) { flush(); inMatch = m; }
    buf += text[i];
  }
  flush();
  return frag;
}
