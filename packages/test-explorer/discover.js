// Finding tests without running anything: which files hold tests, which framework runs them, and
// the describe / it / test, def test_ and func TestX blocks in a file, with their lines. Pure
// functions (no `mide`), so test/unit can feed them text.

export const FRAMEWORKS = { jest: 'Jest', vitest: 'Vitest', node: 'node:test', pytest: 'pytest', go: 'Go' };

const JS_EXT = /\.[cm]?[jt]sx?$/;

/**
 * What kind of test file a path (relative to its folder) looks like: 'js', 'js-node' (only a test
 * if it imports node:test: node --test's own file patterns are loose), 'py', 'go', or null.
 */
export function testFileKind(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (/_test\.go$/.test(base)) return 'go';
  if (/^test_.*\.py$|_test\.py$/.test(base)) return 'py';
  if (!JS_EXT.test(base) || /\.d\.[cm]?ts$/.test(base)) return null;
  if (/\.(test|spec)\.[^.]+$/.test(base) || /(^|\/)__tests__\//.test(rel)) return 'js';
  if (/^test\.[cm]?js$|^test-.+\.[cm]?js$|.[-_]test\.[cm]?js$/.test(base) || (/(^|\/)tests?\//.test(rel) && /\.[cm]?js$/.test(base))) return 'js-node';
  return null;
}

/** The framework a package.json asks for (`siblings`: names of the files next to it), or null. */
export function jsFramework(pkg, siblings = []) {
  if (!pkg || typeof pkg !== 'object') return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const scripts = Object.values(pkg.scripts || {}).filter((s) => typeof s === 'string').join('\n');
  if ('vitest' in deps || /\bvitest\b/.test(scripts) || siblings.some((f) => /^vitest\.(config|workspace)\./.test(f))) return 'vitest';
  if ('jest' in deps || 'ts-jest' in deps || 'babel-jest' in deps || pkg.jest || /\bjest\b/.test(scripts) || siblings.some((f) => /^jest\.config\./.test(f))) return 'jest';
  if (/\bnode\b[^\n&|;]*\s--test\b/.test(scripts)) return 'node';
  return null;
}

/** A test file's own say: it imports node:test, or vitest. */
export function frameworkFromImports(text) {
  if (/(?:from\s+|require\(\s*|import\(\s*)['"]node:test['"]/.test(text)) return 'node';
  if (/(?:from\s+|require\(\s*)['"]vitest['"]/.test(text)) return 'vitest';
  return null;
}

/** Files whose presence (or whose text mentioning pytest) says a folder uses pytest. */
export const PYTEST_MARKERS = /(^|\/)(pytest\.ini|conftest\.py)$/;
export const PYTEST_MAYBE = /(^|\/)(pyproject\.toml|setup\.cfg|tox\.ini|requirements[^/]*\.txt)$/;

/** The innermost directory (relative, '' for the folder) of `rel` that holds one of `names`. */
export function nearestRoot(rel, dirsWith) {
  let dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  for (;;) {
    if (dirsWith.has(dir)) return dir;
    if (!dir) return null;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

// --- JavaScript and TypeScript --------------------------------------------------------------

const SUITE_FNS = new Set(['describe', 'context', 'suite', 'fdescribe', 'xdescribe']);
const TEST_FNS = new Set(['it', 'test', 'fit', 'xit', 'xtest', 'bench']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'failing', 'shuffle', 'skipIf', 'runIf', 'each', 'for']);
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$/;

/**
 * describe / it / test calls with a literal name, as a tree:
 * [{ name, kind: 'suite' | 'test', line, end, children }] (end: the line the call closes on).
 * Nesting comes from the call's own parentheses, so strings, comments, template literals and
 * (most) regex literals are skipped. `t.test('name')` inside a test (node:test subtests)
 * counts too.
 */
export function scanJs(text) {
  const root = { children: [] };
  const stack = [{ node: root, depth: -1 }]; // open test calls and the paren depth they close at
  let depth = 0;
  let line = 1;
  let prev = ''; // last significant token, for telling a regex from a division
  const n = text.length;
  let i = 0;

  const skipString = (q) => { // i is at the opening quote
    i++;
    while (i < n && text[i] !== q) {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') { if (q !== '`') return; line++; } // an unterminated string ends with its line
      else if (q === '`' && text[i] === '$' && text[i + 1] === '{') { // ${ … } inside a template
        i += 2;
        let d = 1;
        while (i < n) {
          const c = text[i];
          if (c === '"' || c === "'" || c === '`') { skipString(c); continue; }
          if (c === '{') d++;
          else if (c === '}' && !--d) break;
          else if (c === '\n') line++;
          i++;
        }
      }
      i++;
    }
    i++;
  };
  const readString = () => { // a literal name at i, or null
    const q = text[i];
    if (q !== '"' && q !== "'" && q !== '`') return null;
    const start = i;
    skipString(q);
    const raw = text.slice(start + 1, i - 1);
    return q === '`' ? raw : raw.replace(/\\(.)/g, '$1');
  };
  const skipSpace = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) { if (text[i] === '\n') line++; i++; }
      if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
      if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; for (; i < stop; i++) if (text[i] === '\n') line++; continue; }
      return;
    }
  };
  /** Skips a balanced (…) or a template literal at i (the arguments of .each). */
  const skipGroup = () => {
    if (text[i] === '`') { skipString('`'); return true; }
    if (text[i] !== '(') return false;
    let d = 0;
    while (i < n) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') { skipString(c); continue; }
      if (c === '\n') line++;
      else if (c === '(') d++;
      else if (c === ')' && --d === 0) { i++; return true; }
      i++;
    }
    return false;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { skipSpace(); continue; }
    if (c === '"' || c === "'" || c === '`') { skipString(c); prev = 'str'; continue; }
    if (c === '/' && REGEX_BEFORE.test(prev)) { // a regex literal
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      prev = 'regex';
      continue;
    }
    if (c === '(') { depth++; prev = '('; i++; continue; }
    if (c === ')') {
      if (stack.length > 1 && stack[stack.length - 1].depth === depth) stack.pop().node.end = line;
      depth--; prev = ')'; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(text[i])) i++;
      const word = text.slice(start, i);
      const dotted = prev === '.';
      prev = word;
      const parent = stack[stack.length - 1].node;
      const isSuite = SUITE_FNS.has(word);
      const isSub = dotted && word === 'test' && parent.kind === 'test';
      if ((!isSuite && !TEST_FNS.has(word)) || (dotted && !isSub)) continue;
      const at = line;
      const save = { i, line };
      // .only / .skip / .each(table) / .each`table`
      skipSpace();
      let ok = true;
      while (text[i] === '.') {
        i++;
        skipSpace();
        const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40));
        if (!m || !MODIFIERS.has(m[0])) { ok = false; break; }
        i += m[0].length;
        skipSpace();
        if (text[i] === '(' && /^(each|for|skipIf|runIf)$/.test(m[0])) { skipGroup(); skipSpace(); }
        else if (text[i] === '`' && /^(each|for)$/.test(m[0])) { skipGroup(); skipSpace(); }
      }
      if (text[i] === '<') { // test<Type>(…)
        const close = text.indexOf('>', i);
        if (close > 0 && close - i < 80) { i = close + 1; skipSpace(); }
      }
      if (!ok || text[i] !== '(') { i = save.i; line = save.line; continue; }
      i++; // into the call
      depth++;
      prev = '(';
      skipSpace();
      const name = readString();
      if (name == null) continue;
      const node = { name, kind: isSuite ? 'suite' : 'test', line: at, children: [] };
      parent.children.push(node);
      stack.push({ node, depth });
      prev = 'str';
      continue;
    }
    if (/\d/.test(c)) { while (i < n && /[\w.]/.test(text[i])) i++; prev = 'num'; continue; }
    prev = c;
    i++;
  }
  for (const { node } of stack.slice(1)) node.end = line; // unclosed calls run to the end
  return root.children;
}

// --- Python (pytest) --------------------------------------------------------------------------

/** Test classes and test functions, nested by indentation: [{ name, kind, line, end, children }]. */
export function scanPython(text) {
  const root = { children: [], kind: 'module' };
  const stack = []; // { indent, node | null, kind: 'class' | 'def' }
  const lines = text.split('\n');
  let inString = null;
  let last = 0; // the last line with code, where a block that closes ends
  const close = (entry) => { if (entry.node) entry.node.end = Math.max(entry.node.line, last); };
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k];
    // Skip the inside of triple-quoted strings (docstrings that show example code).
    if (inString) { if (raw.includes(inString)) inString = null; continue; }
    const m = /^(\s*)(?:(class)\s+(\w+)|(?:async\s+)?(def)\s+(\w+))/.exec(raw);
    const triple = /("""|''')/.exec(raw);
    if (!m) {
      if (triple && raw.split(triple[1]).length === 2) inString = triple[1];
      const code = /^(\s*)\S/.exec(raw);
      if (code && !raw.trimStart().startsWith('#')) {
        // Code back at (or left of) a block's indentation closes it.
        const indent = code[1].replace(/\t/g, '        ').length;
        while (stack.length && stack[stack.length - 1].indent >= indent) close(stack.pop());
        last = k + 1;
      }
      continue;
    }
    const indent = m[1].replace(/\t/g, '        ').length;
    while (stack.length && stack[stack.length - 1].indent >= indent) close(stack.pop());
    last = k + 1;
    const top = stack[stack.length - 1];
    const parent = !top ? root : top.kind === 'class' ? top.node : null;
    if (m[2]) {
      const isTest = parent && /^Test/.test(m[3]);
      const node = isTest ? { name: m[3], kind: 'suite', line: k + 1, children: [] } : null;
      if (node) parent.children.push(node);
      stack.push({ indent, node, kind: 'class' });
    } else {
      const node = parent && /^test/.test(m[5]) ? { name: m[5], kind: 'test', line: k + 1, children: [] } : null;
      if (node) parent.children.push(node);
      stack.push({ indent, node, kind: 'def' });
    }
  }
  while (stack.length) close(stack.pop());
  // A Test class without tests isn't worth a row.
  const prune = (list) => list.filter((n) => n.kind === 'test' || (n.children = prune(n.children)).length);
  return prune(root.children);
}

// --- Go ----------------------------------------------------------------------------------------

/** How `go test` names a subtest: spaces become underscores. */
export const goName = (s) => s.replace(/\s/g, '_');

/** func TestX(t *testing.T) with its t.Run("…") subtests (one level): [{ name, kind, line, end, children }]. */
export function scanGo(text) {
  const out = [];
  const lines = text.split('\n');
  let current = null;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    const m = /^func\s+(Test(?![a-z])\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(l);
    if (m) { current = { name: m[1], kind: 'test', line: k + 1, children: [] }; out.push(current); continue; }
    if (/^\S/.test(l) && !/^\}/.test(l)) current = null;
    if (!current) continue;
    for (const r of l.matchAll(/\b\w+\.Run\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      current.children.push({ name: goName(r[1].replace(/\\(.)/g, '$1')), kind: 'test', line: k + 1, end: k + 1, children: [] });
    }
    if (/^\}/.test(l)) { current.end = k + 1; current = null; }
  }
  return out;
}

export function scanFor(kind, text) {
  if (kind === 'py') return scanPython(text);
  if (kind === 'go') return scanGo(text);
  return scanJs(text);
}

// --- what a listing or a result says about a test that the scan doesn't know --------------------

/** A scanned name that stands for many (it.each('adds %s'), test.each`…`('$a + $b')) as a RegExp, or null. */
export function namePattern(name) {
  if (!/%[sdifjoOp#]|\$\w/.test(name)) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/%[sdifjoOp#]/g, '.*?').replace(/\\\$[\w.]+/g, '.*?')}$`);
}

/** Is `name` (from a run or a listing) one case of the scanned `family` node: each-cases, parametrized pytest ids? */
export function isCaseOf(family, name) {
  if (family === name) return false;
  if (name.startsWith(family + '[') && name.endsWith(']')) return true;
  return !!namePattern(family)?.test(name);
}
