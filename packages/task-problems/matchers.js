// Problem matchers: turn compiler, linter and test output into { file, line, column, severity,
// message, code } problems, one line at a time, so they show up while a task still runs. Plain
// functions over text (no editor API), so the unit tests run them on recorded output.
//
// Built in: gcc / clang / rustc --error-format=short / javac / mypy / shellcheck and anything else
// that prints `file:line[:col]: error|warning|note: message`; rustc and cargo's long form
// (`error[E…]: message` then ` --> file:line:col`); tsc (`file(line,col): error TS…` and the
// pretty `file:line:col - error TS…`); eslint stylish, unix and compact; Python tracebacks, warnings
// and pytest failures; flake8 / ruff / pylint (`file:line:col: CODE message`); go build, vet and test.

// CSI (colors, cursor moves), OSC (titles, hyperlinks) and the two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

const MAX_LINE = 4000; // longer lines are minified code or data, not messages

/** 'error' | 'warning' | 'info' from whatever word a tool uses. */
export function severityOf(word, fallback = 'error') {
  const w = String(word || '').toLowerCase();
  if (/^(fatal|error|err|e$|failed|failure)/.test(w)) return 'error';
  if (/^(warn|w$)/.test(w)) return 'warning';
  if (/^(note|info|i$|hint|remark|message|n$)/.test(w)) return 'info';
  return fallback;
}

/** A trailing `[code]` (clang's -Wflag, mypy's error code, shellcheck's SC1234) becomes the code. */
function splitCode(message, code) {
  const m = !code && /^(.*?)\s+\[([\w./:-]+)\]$/.exec(message);
  return m ? { message: m[1], code: m[2] } : { message, code };
}

const problem = (file, line, column, severity, message, code, matcher) => {
  const p = { file: file.trim(), line: +line, severity, message: message.trim(), matcher };
  if (+column) p.column = +column;
  if (code) p.code = code;
  return p;
};

// One-line formats, tried in order; the first that matches wins.
const LINE_MATCHERS = [
  // tsc (and MSBuild / csc): src/app.ts(3,7): error TS2322: Type …
  ['tsc', /^\s*(\S.*?)\((\d+)(?:,(\d+))?\): (fatal error|error|warning|info|message) ?([A-Z]+\d+)?: (.*)$/,
    (m) => problem(m[1], m[2], m[3], severityOf(m[4]), m[6], m[5])],
  // tsc --pretty: src/app.ts:3:7 - error TS2322: Type …
  ['tsc', /^(\S.*?):(\d+):(\d+) - (error|warning|message) (TS\d+): (.*)$/,
    (m) => problem(m[1], m[2], m[3], severityOf(m[4]), m[6], m[5])],
  // eslint -f unix: src/app.js:1:7: 'x' is assigned a value but never used. [Error/no-unused-vars]
  ['eslint', /^(\S.*?):(\d+):(\d+): (.*) \[(Error|Warning|Info)(?:\/(\S+))?\]$/,
    (m) => problem(m[1], m[2], m[3], severityOf(m[5]), m[4], m[6])],
  // eslint -f compact: src/app.js: line 1, col 7, Error - 'x' is assigned … (no-unused-vars)
  ['eslint', /^(\S.*?): line (\d+), col (\d+), (Error|Warning|Info) - (.*?)(?: \(([\w@/-]+)\))?$/,
    (m) => problem(m[1], m[2], m[3], severityOf(m[4]), m[5], m[6])],
  // gcc, clang, javac, mypy, rustc short, swiftc, shellcheck -f gcc and the generic form:
  // main.c:3:7: error: … / Main.java:5: error: … / src/main.rs:3:20: error[E0425]: …
  ['gcc', /^(\S.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|info|remark|hint)(?:\[([\w-]+)\])?\s*:\s*(.*)$/i,
    (m) => { const s = splitCode(m[6], m[5]); return problem(m[1], m[2], m[3], severityOf(m[4]), s.message, s.code); }],
  // flake8, ruff, pycodestyle: app.py:3:1: F401 'os' imported but unused · pylint: app.py:3:0: W0612: … (columns from 0)
  ['python-lint', /^(\S.*?):(\d+):(\d+): ([A-Z]+\d+)(:?)\s+(?:\[\*\]\s+)?(.*)$/,
    (m) => problem(m[1], m[2], m[5] ? +m[3] + 1 : m[3], /^[EF]/.test(m[4]) ? 'error' : 'warning', m[6], m[4])],
  // go build / vet / test: ./main.go:9:14: undefined: x · main_test.go:7: expected 3, got 2
  ['go', /^\s*(?:vet: )?(\S+\.go):(\d+)(?::(\d+))?: (.*)$/,
    (m) => problem(m[1], m[2], m[3], 'error', m[4])],
];

const RUST_HEADER = /^(error|warning)(?:\[(\w+)\])?: (.*)$/;
const RUST_ARROW = /^\s*--> (.+?):(\d+):(\d+)$/;
const STYLISH_FILE = /^(?:[A-Za-z]:)?[^\s:][^:]*\.[A-Za-z0-9]+$|^\/.*\.[A-Za-z0-9]+$/;
const STYLISH_ENTRY = /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.*?)(?:\s{2,}(\S+))?\s*$/;
const PY_FRAME = /^\s*File "(.+)", line (\d+)(?:, in .*)?$/;
const PY_EXCEPTION = /^([A-Za-z_][\w.]*)(?::\s?(.*))?$/;
const PY_LOCATION = /^(\S.*?\.py):(\d+): (.+)$/; // pytest (`tests/t.py:5: AssertionError`) and warnings
const CARET = /^(\s*)\^[\s~^]*$/;

/**
 * Compile user matchers from config: { name: "regex" } or { name: { pattern, severity, flags } },
 * with named groups file, line and optionally column, severity, message and code.
 * Returns { matchers, errors } where errors are readable sentences.
 */
export function compileMatchers(config) {
  const matchers = [];
  const errors = [];
  if (config == null) return { matchers, errors };
  if (typeof config !== 'object' || Array.isArray(config)) return { matchers, errors: ['Matchers must be an object: { "name": "regex with (?<file>…) and (?<line>…)" }.'] };
  for (const [name, def] of Object.entries(config)) {
    const spec = typeof def === 'string' ? { pattern: def } : def;
    if (!spec || typeof spec.pattern !== 'string') { errors.push(`“${name}” needs a "pattern" string.`); continue; }
    let re;
    try { re = new RegExp(spec.pattern, String(spec.flags || '').replace(/[gy]/g, '')); } catch (err) { errors.push(`“${name}” is not a valid regular expression: ${err.message}`); continue; }
    const groups = new Set([...spec.pattern.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1]));
    const missing = ['file', 'line'].filter((g) => !groups.has(g));
    if (missing.length) { errors.push(`“${name}” has no ${missing.map((g) => `(?<${g}>…)`).join(' or ')} group.`); continue; }
    if (re.test('')) { errors.push(`“${name}” matches an empty line, so it would match everything.`); continue; }
    if (spec.severity != null && !['error', 'warning', 'info'].includes(spec.severity)) { errors.push(`“${name}”: severity must be "error", "warning" or "info".`); continue; }
    matchers.push({ name, re, severity: spec.severity || 'error' });
  }
  return { matchers, errors };
}

/** Reads output line by line; line() and end() return the problems found so far that are new. */
export class ProblemParser {
  constructor({ matchers = [] } = {}) {
    this.custom = matchers; // from compileMatchers()
    this.rust = null;       // a rustc header waiting for its --> line
    this.stylish = null;    // the file eslint stylish lists problems under
    this.tb = null;         // Python traceback frames
    this.pytestE = [];      // pytest's `E   …` lines, the message of the failure after them
    this.caret = null;      // { problem, wait }: a problem without a column, before its source and ^ lines
  }

  line(raw) {
    const text = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const out = [];
    const emit = (p) => { if (p && p.line > 0 && p.file) out.push(p); return p; };

    // javac (and others) show the source line and a ^ under the column after a problem without one.
    if (this.caret) {
      const c = CARET.exec(text);
      if (c && this.caret.wait === 0) { this.caret.problem.column = c[1].length + 1; this.caret = null; return out; }
      if (--this.caret.wait < 0) this.caret = null;
    }

    if (this.rust) {
      const m = RUST_ARROW.exec(text);
      const header = this.rust;
      this.rust = null;
      if (m) { emit(problem(m[1], m[2], m[3], header.severity, header.message, header.code, 'rustc')); return out; }
    }

    if (this.tb) {
      const frame = PY_FRAME.exec(text);
      if (frame) { this.tb.frames.push({ file: frame[1], line: +frame[2] }); return out; }
      if (/^\s/.test(text) || !text.trim()) return out; // source lines, ^~~ markers
      const exc = this.tb.frames.length && PY_EXCEPTION.exec(text);
      const frames = this.tb.frames;
      this.tb = null;
      if (exc) {
        const last = frames.at(-1);
        const p = problem(last.file, last.line, 0, /Warning$/.test(exc[1]) ? 'warning' : 'error', text, null, 'python');
        if (frames.length > 1) p.alternatives = frames.slice(0, -1).reverse();
        emit(p);
        return out;
      }
    }
    if (text.startsWith('Traceback (most recent call last)')) { this.tb = { frames: [] }; return out; }
    const frame = PY_FRAME.exec(text);
    if (frame) { this.tb = { frames: [{ file: frame[1], line: +frame[2] }] }; return out; } // a SyntaxError has no header

    for (const m of this.custom) {
      const g = m.re.exec(text)?.groups;
      if (!g?.file || !g.line) continue;
      emit(problem(g.file, g.line, g.column, g.severity ? severityOf(g.severity, m.severity) : m.severity, g.message || text, g.code, m.name));
      return out;
    }

    const header = RUST_HEADER.exec(text);
    if (header) { this.rust = { severity: severityOf(header[1]), code: header[2], message: header[3] }; return out; }

    if (this.stylish) {
      const e = STYLISH_ENTRY.exec(text);
      if (e) { emit(problem(this.stylish, e[1], e[2], severityOf(e[3]), e[4], e[5], 'eslint')); return out; }
      this.stylish = null;
    }

    if (/^_{3,}|^={3,}/.test(text)) this.pytestE = [];
    const pe = /^E\s{2,}(.*)$/.exec(text);
    if (pe) { this.pytestE.push(pe[1]); return out; }

    for (const [name, re, make] of LINE_MATCHERS) {
      const m = re.exec(text);
      if (!m) continue;
      const p = emit({ ...make(m), matcher: name });
      if (p && !p.column && name === 'gcc') this.caret = { problem: p, wait: 1 };
      return out;
    }

    const py = PY_LOCATION.exec(text);
    if (py && !/^in \S+$/.test(py[3])) { // `file.py:3: in helper` is a frame of a pytest traceback, not the failure
      const kind = /^([A-Za-z_][\w.]*)(?::\s?(.*))?$/.exec(py[3]);
      let message = py[3];
      if (kind && !kind[2] && this.pytestE.length) message = this.pytestE[0].startsWith(kind[1]) ? this.pytestE[0] : `${kind[1]}: ${this.pytestE[0]}`;
      this.pytestE = [];
      emit(problem(py[1], py[2], 0, kind && /Warning$/.test(kind[1]) ? 'warning' : 'error', message, null, 'python'));
      return out;
    }

    // eslint stylish: a file's path on its own line, then indented `line:col  severity  message  rule` rows.
    if (STYLISH_FILE.test(text) && !/\s{2}/.test(text)) this.stylish = text.trim();
    return out;
  }

  /** The output ended: nothing more is coming for a pending header or traceback. */
  end() {
    this.rust = this.stylish = this.tb = this.caret = null;
    this.pytestE = [];
    return [];
  }
}

/** Every problem in a whole output (for tests and finished output). */
export function parseProblems(text, options) {
  const parser = new ProblemParser(options);
  const out = [];
  for (const line of stripAnsi(text).split('\n')) {
    const cr = line.replace(/\r$/, '');
    out.push(...parser.line(cr.slice(cr.lastIndexOf('\r') + 1)));
  }
  out.push(...parser.end());
  return out;
}
