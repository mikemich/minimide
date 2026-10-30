// Reading what test runners report: Jest / Vitest JSON, JUnit XML (pytest, node:test), `go test
// -json`, and the lists their own discovery prints. Every result comes back as
// { path, names: [suite…, test], status: 'passed' | 'failed' | 'skipped', duration (ms), message,
// details, expected, actual, line }. Pure functions, fed recorded output by test/unit.

const STATUS = { passed: 'passed', pass: 'passed', failed: 'failed', fail: 'failed', pending: 'skipped', skipped: 'skipped', skip: 'skipped', todo: 'skipped', disabled: 'skipped', focused: 'passed' };

export const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const isAbs = (p) => /^(\/|[A-Za-z]:[\\/])/.test(p);
const join = (root, p) => (!p ? null : isAbs(p) ? p.replace(/\\/g, '/') : `${root.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`);

/** The first lines worth reading of a failure: no stack frames, at most `max` lines. */
export function summarize(text, max = 8) {
  const lines = stripAnsi(text).split('\n').filter((l) => !/^\s*at\s|^\s*at$|node:internal|^\s*\^+\s*$/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();
  const out = [];
  for (const l of lines) {
    if (out.length >= max) { out.push('…'); break; }
    if (!l.trim() && !out[out.length - 1]?.trim()) continue;
    out.push(l.replace(/\s+$/, ''));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/** Expected and received values from an assertion message, in the forms Jest, Vitest, node:assert, pytest and Go tests print. */
export function expectedActual(text) {
  const t = stripAnsi(text);
  let m;
  const exp = /^\s*Expected(?: value)?:\s*(.+)$/m.exec(t);
  const rec = /^\s*Received(?: value)?:\s*(.+)$/m.exec(t);
  if (exp && rec) return { expected: exp[1].trim(), actual: rec[1].trim() };
  const a = /^\s*actual:\s*(.+?),?\s*$/m.exec(t);
  const e = /^\s*expected:\s*(.+?),?\s*$/m.exec(t);
  if (a && e) return { expected: e[1], actual: a[1] };
  if ((m = /\bexpected (.+?) to (?:be|equal|deeply equal|strictly equal|deep equal|eql) (.+?)(?:\s+\/\/.*)?$/m.exec(t))) return { expected: m[2], actual: m[1] };
  if ((m = /^(?:E\s+)?(?:AssertionError: )?assert (.+?) == (.+?)\s*$/m.exec(t))) return { expected: m[2], actual: m[1] };
  if ((m = /\bgot:?\s+(.+?),?\s+want(?:ed)?:?\s+(.+?)\s*$/im.exec(t))) return { expected: m[2], actual: m[1] };
  return {};
}

function result(fields, text) {
  const details = stripAnsi(text || '').replace(/\s+$/, '');
  return { message: details ? summarize(details) : '', details, ...(fields.status === 'failed' ? expectedActual(details) : {}), ...fields };
}

// --- Jest and Vitest ----------------------------------------------------------------------------

/** `jest --json` / `vitest --reporter=json`: { files: [{ path, status, message }], tests }. */
export function parseJestJson(text, root = '') {
  const data = JSON.parse(text);
  const files = [];
  const tests = [];
  for (const f of data.testResults || []) {
    const path = join(root, f.name || f.testFilePath);
    const cases = f.assertionResults || [];
    // A file that failed without any test results couldn't run (a syntax error, a missing import).
    if (f.status === 'failed' && !cases.length) files.push(result({ path, status: 'failed' }, f.message || f.failureMessage || 'The test file failed to run.'));
    for (const a of cases) {
      tests.push(result({
        path, names: [...(a.ancestorTitles || []), a.title], status: STATUS[a.status] || 'skipped',
        duration: typeof a.duration === 'number' ? a.duration : null, line: a.location?.line ?? null,
      }, (a.failureMessages || []).join('\n')));
    }
  }
  return { files, tests };
}

// --- JUnit XML (pytest, node:test) --------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENTITIES[e] ?? all));

/** A small XML reader: elements as { name, attrs, children, text }. Enough for test reports. */
export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] != null) top.text += decode(m[6]);
  }
  return root;
}

/** The module path pytest puts in front of a class name: tests/test_x.py -> tests.test_x */
const pyModule = (file) => file.replace(/\.py$/, '').replace(/[\\/]/g, '.');

/**
 * JUnit XML. `style` 'pytest': names come from classname (minus the module) and name, the file
 * from the file attribute (junit_family=xunit1) or else from classname; lines are 0-based.
 * 'node': names are the nested testsuite names (describe blocks) and the testcase name.
 */
export function parseJunit(text, { root = '', style = 'pytest' } = {}) {
  const tests = [];
  const visit = (el, suites) => {
    for (const c of el.children) {
      if (c.name === 'testsuites') visit(c, suites);
      else if (c.name === 'testsuite') visit(c, style === 'node' ? [...suites, c.attrs.name] : suites);
      else if (c.name === 'testcase') tests.push(testcase(c, suites));
    }
  };
  const testcase = (c, suites) => {
    const failure = c.children.find((x) => x.name === 'failure' || x.name === 'error');
    const skipped = c.children.find((x) => x.name === 'skipped');
    const status = failure ? 'failed' : skipped ? 'skipped' : 'passed';
    const duration = c.attrs.time != null && !Number.isNaN(Number(c.attrs.time)) ? Math.round(Number(c.attrs.time) * 1000 * 10) / 10 : null;
    let path = join(root, c.attrs.file);
    let names;
    let line = null;
    if (style === 'node') {
      names = [...suites, c.attrs.name];
    } else {
      const parts = (c.attrs.classname || '').split('.').filter(Boolean);
      let classes;
      if (c.attrs.file) {
        const mod = pyModule(c.attrs.file);
        classes = (c.attrs.classname || '').startsWith(mod) ? (c.attrs.classname || '').slice(mod.length).split('.').filter(Boolean) : [];
      } else {
        // No file attribute (xunit2): the module is the part up to the last test_x / x_test name.
        let k = parts.length - 1;
        while (k >= 0 && !/^test_|_test$/.test(parts[k])) k--;
        if (k < 0) k = parts.length - 1;
        classes = parts.slice(k + 1);
        path = join(root, `${parts.slice(0, k + 1).join('/')}.py`);
      }
      names = [...classes, c.attrs.name];
      if (c.attrs.line != null && c.attrs.line !== '') line = Number(c.attrs.line) + 1;
    }
    const el = failure || skipped;
    const text = el ? [el.attrs.message, el.text].filter((s) => s && s.trim()).join('\n') : '';
    // node:test writes message="true" for a plain skip.
    const why = status === 'skipped' ? [el.attrs.message, el.text].find((s) => s && s.trim() && s !== 'true') || '' : text;
    return result({ path, names, status, duration, line }, why);
  };
  visit(parseXml(text), []);
  return { files: [], tests };
}

// --- go test -json ----------------------------------------------------------------------------------

/** One line of `go test -json`, or null when it isn't an event (build output can be plain text). */
export function goEvent(line) {
  if (!line.startsWith('{')) return null;
  try { const e = JSON.parse(line); return e && typeof e.Action === 'string' ? e : null; } catch { return null; }
}

const GO_NOISE = /^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (PASS|FAIL|SKIP):)/;

/** `go test -json`: { tests: [{ pkg, names, … }], packages: [{ pkg, status, message }], output } (output: what go test would have printed). */
export function parseGoJson(text) {
  const tests = new Map();
  const packages = new Map();
  let output = '';
  for (const raw of text.split('\n')) {
    const e = goEvent(raw);
    if (!e) { if (raw.trim()) output += raw + '\n'; continue; }
    if (e.Output) output += e.Output;
    const pkg = (e.Package || e.ImportPath || '').replace(/ \[.*\]$/, '');
    if (!e.Test) {
      if (!packages.has(pkg)) packages.set(pkg, { pkg, status: null, output: '' });
      const p = packages.get(pkg);
      if (e.Output) p.output += e.Output;
      if (e.Action === 'build-fail') p.status = 'failed';
      else if (STATUS[e.Action]) p.status = STATUS[e.Action];
      continue;
    }
    const key = `${pkg}\u0000${e.Test}`;
    if (!tests.has(key)) tests.set(key, { pkg, names: e.Test.split('/'), status: null, duration: null, output: '' });
    const t = tests.get(key);
    if (e.Action === 'output') t.output += e.Output || '';
    else if (STATUS[e.Action]) { t.status = STATUS[e.Action]; if (typeof e.Elapsed === 'number') t.duration = Math.round(e.Elapsed * 1000); }
  }
  const out = [];
  for (const t of tests.values()) {
    if (!t.status) continue;
    const body = t.output.split('\n').filter((l) => l.trim() && !GO_NOISE.test(l)).map((l) => l.replace(/^ {4}/, '')).join('\n');
    const at = /\b\w+_test\.go:(\d+):/.exec(body);
    out.push({ ...result({ pkg: t.pkg, names: t.names, status: t.status, duration: t.duration, line: at ? Number(at[1]) : null }, body), output: t.output });
  }
  const pkgs = [...packages.values()].filter((p) => p.status).map((p) => ({ pkg: p.pkg, status: p.status, message: p.status === 'failed' ? p.output.trim() : '' }));
  return { tests: out, packages: pkgs, output };
}

// --- what the frameworks list ----------------------------------------------------------------------

/** `vitest list --json`: [{ path, names }] (Vitest joins suite and test names with " > "). */
export function parseVitestList(text, root = '') {
  const start = text.search(/^\s*\[/m);
  if (start < 0) return [];
  const list = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1));
  return list.filter((t) => t && t.name && t.file).map((t) => ({ path: join(root, t.file), names: t.name.split(' > ') }));
}

/** `jest --listTests --json` (or without --json, one path a line): absolute paths. */
export function parseJestList(text, root = '') {
  const start = text.search(/^\s*\[/m);
  if (start >= 0) {
    try { return JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)).map((p) => join(root, p)); } catch {}
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => isAbs(l)).map((p) => join(root, p));
}

/** `pytest --collect-only -q`: node ids as [{ path, names }]. */
export function parsePytestCollect(text, root = '') {
  const out = [];
  for (const l of stripAnsi(text).split('\n')) {
    const m = /^(\S[^:]*?\.py)::(.+?)\s*$/.exec(l);
    if (m) out.push({ path: join(root, m[1]), names: m[2].split('::') });
  }
  return out;
}

/** `go test -list . ./...`: [{ pkg, names }] (the names come before each package's ok line). */
export function parseGoList(text) {
  const out = [];
  let names = [];
  for (const l of text.split('\n')) {
    const ok = /^(?:ok|\?|FAIL)\s+(\S+)/.exec(l);
    if (ok) { if (names.length) out.push({ pkg: ok[1], names }); names = []; }
    else if (/^Test(?![a-z])\w*$/.test(l.trim())) names.push(l.trim());
  }
  return out;
}

/** The module path in a go.mod. */
export const goModule = (text) => /^\s*module\s+(\S+)/m.exec(text || '')?.[1] || null;
