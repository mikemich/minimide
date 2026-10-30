// The tree the view, the gutter and the runs share: folder › file › suite › test. Scanned nodes
// come from discover.js; a listing or a run adds the ones a scan can't see (each-cases,
// parametrized ids, subtests). Results are kept by file and name, so they survive a rescan.
// Pure functions, so test/unit can drive them.

import { isCaseOf } from './discover.js';

const SEP = '\u0000';
export const keyOf = (path, names) => [path, ...names].join(SEP);

let seq = 0;

/** A node: { id, kind, name, line, end, children, parent, path, names, dynamic? }. */
export function node(fields) {
  return { id: `tx-${++seq}`, children: [], line: null, end: null, ...fields };
}

/** A file node with its scanned tests: `scanned` is [{ name, kind, line, end, children }]. */
export function fileNode({ path, rel, fw, runRoot, folder, scanned = [] }) {
  const file = node({ kind: 'file', name: rel, path, names: [], fw, runRoot, folder });
  const add = (parent, list) => {
    for (const s of list) {
      const n = node({ kind: s.kind, name: s.name, line: s.line, end: s.end ?? s.line, path, names: [...parent.names, s.name], parent });
      parent.children.push(n);
      add(n, s.children || []);
    }
  };
  add(file, scanned);
  return file;
}

/**
 * The node for `names` in a file, or null. With `add`, the missing part is created: under a
 * scanned family it belongs to (it.each('adds %s') › 'adds 1', test_x › test_x[1]), else under
 * the deepest node found. Created nodes get the line of the node they hang from.
 */
export function find(file, names, { add = false } = {}) {
  let at = file;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    let next = at.children.find((c) => c.name === name);
    if (!next) {
      const family = at.children.find((c) => isCaseOf(c.name, name));
      if (family) { next = family.children.find((c) => c.name === name); if (!next && !add) return null; at = family; }
    }
    if (!next) {
      if (!add) return null;
      next = node({ kind: i === names.length - 1 ? 'test' : 'suite', name, line: at.line ?? 1, end: at.end ?? at.line ?? 1, path: file.path, names: names.slice(0, i + 1), parent: at, dynamic: true });
      at.children.push(next);
    }
    at = next;
  }
  return at;
}

/** Every node under (and including) `n`, depth first. */
export function* walk(n) {
  yield n;
  for (const c of n.children) yield* walk(c);
}

/** The tests under these nodes that failed themselves (not only through a case or subtest). */
export function failedTests(nodes, results) {
  const out = [];
  for (const root of nodes) {
    for (const n of walk(root)) {
      if (n.kind !== 'test' || results.get(keyOf(n.path, n.names))?.status !== 'failed') continue;
      if (n.children.some((c) => results.get(keyOf(c.path, c.names))?.status === 'failed')) continue;
      out.push(n);
    }
  }
  return out;
}

/** 'running' | 'failed' | 'passed' | 'skipped' | null for a node, from `results` (key -> result) and `running` (set of keys). */
export function statusOf(n, results, running) {
  if (n.kind === 'test' || n.kind === 'suite') {
    const k = keyOf(n.path, n.names);
    if (running.has(k)) return 'running';
    const own = results.get(k)?.status || null;
    if (!n.children.length) return own;
    const kids = combine(n.children.map((c) => statusOf(c, results, running)));
    return combine([own, kids]);
  }
  const own = n.kind === 'file' ? results.get(keyOf(n.path, []))?.status || null : null;
  return combine([own, ...n.children.map((c) => statusOf(c, results, running))]);
}

/** One status for several: running wins, then failed; passed when something passed and nothing failed. */
export function combine(list) {
  if (list.includes('running')) return 'running';
  if (list.includes('failed')) return 'failed';
  if (list.includes('passed')) return 'passed';
  if (list.includes('skipped')) return 'skipped';
  return null;
}

/** Counts of the leaf results under these nodes: { passed, failed, skipped, total }. */
export function counts(nodes, results) {
  const out = { passed: 0, failed: 0, skipped: 0, total: 0 };
  const seen = new Set();
  for (const root of nodes) {
    for (const n of walk(root)) {
      if (n.kind !== 'test' || seen.has(n)) continue;
      seen.add(n);
      const r = results.get(keyOf(n.path, n.names));
      // A test whose cases ran is counted through its cases.
      if (!r || n.children.some((c) => results.has(keyOf(c.path, c.names)))) continue;
      out.total++;
      if (out[r.status] != null) out[r.status]++;
    }
  }
  return out;
}

/**
 * What a run of `nodes` asks the framework for, grouped by where it runs:
 * [{ fw, runRoot, folder, all, targets: [{ file (relative to runRoot), names, group }], nodes }].
 * A folder node runs everything in each of its roots.
 */
export function plan(nodes) {
  const groups = new Map();
  const groupFor = (file) => {
    const k = `${file.fw}${SEP}${file.runRoot}`;
    if (!groups.has(k)) groups.set(k, { fw: file.fw, runRoot: file.runRoot, folder: file.folder, all: false, targets: [], nodes: [], files: new Set() });
    return groups.get(k);
  };
  const fileOf = (n) => { while (n && n.kind !== 'file') n = n.parent; return n; };
  for (const n of nodes) {
    if (n.kind === 'folder') {
      for (const f of n.children) { const g = groupFor(f); g.all = true; g.nodes.push(f); g.files.add(f); }
      continue;
    }
    const file = fileOf(n);
    if (!file) continue;
    const g = groupFor(file);
    g.nodes.push(n);
    g.files.add(file);
    const rel = relative(file.runRoot, file.path);
    g.targets.push({ file: rel, names: n.kind === 'file' ? [] : n.names, group: n.kind !== 'test' || n.children.length > 0 });
  }
  for (const g of groups.values()) {
    // A whole file makes its narrower targets redundant.
    const whole = new Set(g.targets.filter((t) => !t.names.length).map((t) => t.file));
    g.targets = g.targets.filter((t) => !t.names.length || !whole.has(t.file));
    g.targets = [...new Map(g.targets.map((t) => [`${t.file}${SEP}${t.names.join(SEP)}`, t])).values()];
  }
  return [...groups.values()];
}

export function relative(root, path) {
  const r = root.replace(/\/+$/, '');
  return path === r ? '.' : path.startsWith(r + '/') ? path.slice(r.length + 1) : path;
}

/** The innermost scanned node whose lines hold `line` (1-based), or null. */
export function nodeAtLine(file, line) {
  let best = null;
  for (const n of walk(file)) {
    if (n === file || n.dynamic || n.line == null) continue;
    if (n.line <= line && line <= (n.end ?? n.line) && (!best || n.line >= best.line)) best = n;
  }
  return best;
}
