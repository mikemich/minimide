import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseProblems, ProblemParser, compileMatchers, stripAnsi, severityOf } from '../../packages/task-problems/matchers.js';
import { normalize, toDiagnostic } from '../../packages/task-problems/index.js';

// Output recorded from the real tools (clang, gcc, rustc, cargo, tsc, go, javac, python3; paths
// shortened to /home/dev/…), plus eslint, mypy, flake8, ruff, pylint and pytest in their documented formats.
const sample = (name) => readFileSync(new URL(`fixtures/task-problems/${name}.txt`, import.meta.url), 'utf8');
const brief = (list) => list.map((p) => [p.file, p.line, p.column ?? null, p.severity, p.message, p.code ?? null]);

test('clang: colors stripped, the -W flag becomes the code', () => {
  assert.deepEqual(brief(parseProblems(sample('clang'))), [
    ['main.c', 3, 7, 'error', "incompatible pointer to integer conversion initializing 'int' with an expression of type 'char[2]'", '-Wint-conversion'],
    ['main.c', 4, 18, 'error', "use of undeclared identifier 'y'", null],
    ['main.c', 5, 11, 'error', "expected ';' after return statement", null],
  ]);
});

test('gcc / clang notes are info', () => {
  assert.deepEqual(brief(parseProblems(sample('clang-note'))), [
    ['warn.c', 5, 17, 'error', "too many arguments to function call, expected single argument 'a', have 2 arguments", null],
    ['warn.c', 2, 5, 'info', "'f' declared here", null],
  ]);
});

test('rustc: the long form and --error-format=short', () => {
  const want = [['main.rs', 3, 20, 'error', 'cannot find value `x` in this scope', 'E0425']];
  assert.deepEqual(brief(parseProblems(sample('rustc'))), want);
  assert.deepEqual(brief(parseProblems(sample('rustc-short'))), want);
});

test('cargo: warnings and errors in color; the summary lines are not problems', () => {
  assert.deepEqual(brief(parseProblems(sample('cargo'))), [
    ['src/main.rs', 1, 5, 'warning', 'unused import: `std::collections::HashMap`', null],
    ['src/main.rs', 3, 18, 'error', 'mismatched types', 'E0308'],
  ]);
});

test('tsc: plain and --pretty output agree; related information is not a problem', () => {
  const want = [
    ['app.ts', 1, 7, 'error', "Type 'string' is not assignable to type 'number'.", 'TS2322'],
    ['app.ts', 2, 34, 'error', "Property 'lenght' does not exist on type 'string'. Did you mean 'length'?", 'TS2551'],
  ];
  assert.deepEqual(brief(parseProblems(sample('tsc'))), want);
  assert.deepEqual(brief(parseProblems(sample('tsc-pretty'))), want);
});

test('eslint: stylish, unix and compact', () => {
  assert.deepEqual(brief(parseProblems(sample('eslint-stylish'))), [
    ['/home/dev/demo/src/app.js', 1, 7, 'error', "'unused' is assigned a value but never used", 'no-unused-vars'],
    ['/home/dev/demo/src/app.js', 3, 1, 'warning', 'Unexpected console statement', 'no-console'],
    ['/home/dev/demo/src/app.js', 5, 12, 'error', 'Parsing error: Unexpected token )', null],
    ['/home/dev/demo/src/util.js', 2, 3, 'error', "'x' is not defined", 'no-undef'],
  ]);
  const want = [
    ['/home/dev/demo/src/app.js', 1, 7, 'error', "'unused' is assigned a value but never used.", 'no-unused-vars'],
    ['/home/dev/demo/src/app.js', 3, 1, 'warning', 'Unexpected console statement.', 'no-console'],
  ];
  assert.deepEqual(brief(parseProblems(sample('eslint-unix'))), want);
  assert.deepEqual(brief(parseProblems(sample('eslint-compact'))), want);
});

test('go: build, vet and test failures', () => {
  assert.deepEqual(brief(parseProblems(sample('go-build'))), [
    ['./main.go', 5, 2, 'error', '"os" imported and not used', null],
    ['./main.go', 9, 14, 'error', 'undefined: undefinedThing', null],
  ]);
  assert.deepEqual(brief(parseProblems(sample('go-vet'))), [['main.go', 6, 14, 'error', 'fmt.Printf format %d has arg "str" of wrong type string', null]]);
  assert.deepEqual(brief(parseProblems(sample('go-test'))), [['main_test.go', 7, null, 'error', 'expected 3, got 2', null]]);
});

test('javac: the column comes from the ^ under the source line', () => {
  assert.deepEqual(brief(parseProblems(sample('javac'))), [
    ['src/demo/Main.java', 5, 17, 'error', 'incompatible types: String cannot be converted to int', null],
    ['src/demo/Main.java', 6, 28, 'error', 'cannot find symbol', null],
  ]);
});

test('Python tracebacks: the innermost frame, with the outer ones to fall back on', () => {
  const [one] = parseProblems(sample('python-traceback'));
  assert.deepEqual(brief([one]), [['/home/dev/demo/app.py', 2, null, 'error', 'ZeroDivisionError: division by zero', null]]);
  assert.deepEqual(one.alternatives, [{ file: '/home/dev/demo/app.py', line: 6 }, { file: '/home/dev/demo/app.py', line: 9 }]);
  const [two] = parseProblems(sample('python-traceback-two-files'));
  assert.deepEqual([two.file, two.line, two.message, two.alternatives], ['/home/dev/demo/helper.py', 2, "KeyError: 'missing'", [{ file: '/home/dev/demo/main.py', line: 3 }]]);
  const [lib] = parseProblems(sample('python-library'));
  assert.equal(lib.file, '/usr/lib/python3.15/json/decoder.py');
  assert.equal(lib.alternatives.at(-1).file, '<string>');
  assert.match(lib.message, /^json\.decoder\.JSONDecodeError: Expecting property name/);
});

test('Python: a SyntaxError (no Traceback header) and warnings', () => {
  assert.deepEqual(brief(parseProblems(sample('python-syntax'))), [['/home/dev/demo/broken.py', 1, null, 'error', 'SyntaxError: invalid syntax', null]]);
  assert.deepEqual(brief(parseProblems(sample('python-warning'))), [['/home/dev/demo/warn.py', 6, null, 'warning', 'DeprecationWarning: old() is deprecated', null]]);
});

test('pytest: each failure at its line, with the E line as the message; frames in between are skipped', () => {
  assert.deepEqual(brief(parseProblems(sample('pytest'))), [
    ['tests/test_calc.py', 6, null, 'error', 'AssertionError: assert 3 == 4', null],
    ['src/calc.py', 5, null, 'error', "ValueError: invalid literal for int() with base 10: 'x'", null],
  ]);
});

test('mypy: notes are info, the [code] at the end becomes the code', () => {
  assert.deepEqual(brief(parseProblems(sample('mypy'))), [
    ['app.py', 5, null, 'error', 'Incompatible types in assignment (expression has type "str", variable has type "int")', 'assignment'],
    ['app.py', 9, null, 'info', 'Revealed type is "builtins.int"', null],
    ['lib/util.py', 12, 5, 'error', 'Missing return statement', 'return'],
  ]);
});

test('flake8, ruff and pylint: CODE message (pylint counts columns from 0)', () => {
  assert.deepEqual(brief(parseProblems(sample('flake8'))), [
    ['app.py', 1, 1, 'error', "'os' imported but unused", 'F401'],
    ['app.py', 3, 80, 'error', 'line too long (88 > 79 characters)', 'E501'],
    ['app.py', 7, 1, 'warning', 'blank line at end of file', 'W391'],
  ]);
  assert.deepEqual(brief(parseProblems(sample('ruff'))), [
    ['app.py', 1, 8, 'error', '`os` imported but unused', 'F401'],
    ['app.py', 4, 5, 'error', 'Ambiguous variable name: `l`', 'E741'],
  ]);
  assert.deepEqual(brief(parseProblems(sample('pylint'))), [
    ['app.py', 1, 1, 'warning', 'Missing module docstring (missing-module-docstring)', 'C0114'],
    ['app.py', 3, 5, 'warning', "Unused variable 'x' (unused-variable)", 'W0612'],
    ['app.py', 5, 1, 'error', "Undefined variable 'y' (undefined-variable)", 'E0602'],
  ]);
});

test('the generic file:line[:col]: severity: message form', () => {
  assert.deepEqual(brief(parseProblems('build.sh:3: error: missing fi\nconfig/app.yml:12:4: warning: duplicate key\nlib/x.swift:1:2: note: here\n')), [
    ['build.sh', 3, null, 'error', 'missing fi', null],
    ['config/app.yml', 12, 4, 'warning', 'duplicate key', null],
    ['lib/x.swift', 1, 2, 'info', 'here', null],
  ]);
});

test('ordinary output, progress bars and summaries are not problems', () => {
  const text = [
    '> demo@1.0.0 build', '> node build.js', 'Compiling 12 files…', '[=====>    ] 50%\r[==========] 100%', 'Done in 0.42s.',
    'See https://example.com:8080/docs for details', 'error: could not compile `demo`', 'Found 2 errors in the same file, starting at: app.ts:1',
    '12:30:01 INFO server started', 'warning: in the working copy of \'a.txt\', LF will be replaced by CRLF',
  ].join('\n');
  assert.deepEqual(parseProblems(text), []);
});

test('problems come out as their line is read, so a running task shows them', () => {
  const parser = new ProblemParser();
  assert.deepEqual(parser.line('Building…'), []);
  const [p] = parser.line('src/a.c:4:2: error: oops');
  assert.deepEqual([p.file, p.line, p.column], ['src/a.c', 4, 2]);
  assert.deepEqual(parser.line('error[E0425]: cannot find value `x` in this scope'), []); // waits for its --> line
  assert.equal(parser.line(' --> src/main.rs:3:20')[0].message, 'cannot find value `x` in this scope');
  // javac's column arrives two lines later and is filled in on the problem already handed out.
  const [j] = parser.line('Main.java:5: error: cannot find symbol');
  assert.equal(j.column, undefined);
  parser.line('        System.out.println(y);');
  parser.line('                           ^');
  assert.equal(j.column, 28);
});

test('stripAnsi removes colors, cursor moves and hyperlinks', () => {
  assert.equal(stripAnsi('\x1b[1;31merror\x1b[0m: \x1b]8;;https://gcc.gnu.org/x\x07-Wunused\x1b]8;;\x07\x1b[K'), 'error: -Wunused');
});

test('severity words', () => {
  assert.deepEqual(['fatal error', 'Error', 'WARNING', 'warn', 'note', 'Info', 'hint', 'weird'].map((w) => severityOf(w)), ['error', 'error', 'warning', 'warning', 'info', 'info', 'info', 'error']);
});

test('custom matchers: named groups, a default severity, tried before the built-in ones', () => {
  const { matchers, errors } = compileMatchers({
    mylint: '^LINT (?<file>\\S+) @ (?<line>\\d+)(?:,(?<column>\\d+))? (?<severity>\\w+) (?<message>.*)$',
    quiet: { pattern: '^(?<file>[\\w/.]+\\.cfg) line (?<line>\\d+)$', severity: 'warning' },
    gccish: { pattern: '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): error: (?<message>.*)$', severity: 'info' },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(brief(parseProblems('LINT src/a.js @ 4,2 warn too long\nconf/app.cfg line 7\nsrc/b.c:1:1: error: mine first\n', { matchers })), [
    ['src/a.js', 4, 2, 'warning', 'too long', null],
    ['conf/app.cfg', 7, null, 'warning', 'conf/app.cfg line 7', null],
    ['src/b.c', 1, 1, 'info', 'mine first', null],
  ]);
});

test('custom matchers: bad ones are reported, good ones still work', () => {
  const { matchers, errors } = compileMatchers({
    broken: '^(?<file>[^:]+:(?<line>\\d+)',
    nofile: '^(?<path>\\S+):(?<line>\\d+)$',
    empty: '(?<file>x)?(?<line>\\d)*',
    nopattern: { severity: 'error' },
    badseverity: { pattern: '^(?<file>\\S+):(?<line>\\d+)$', severity: 'fatal' },
    fine: '^(?<file>\\S+)#(?<line>\\d+)$',
  });
  assert.deepEqual(matchers.map((m) => m.name), ['fine']);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /^“broken” is not a valid regular expression: /);
  assert.equal(errors[1], '“nofile” has no (?<file>…) group.');
  assert.equal(errors[2], '“empty” matches an empty line, so it would match everything.');
  assert.equal(errors[3], '“nopattern” needs a "pattern" string.');
  assert.match(errors[4], /^“badseverity”: severity must be/);
  assert.deepEqual(compileMatchers(['x']).errors.length, 1);
  assert.deepEqual(compileMatchers(undefined), { matchers: [], errors: [] });
});

test('paths and diagnostics', () => {
  assert.equal(normalize('/home/dev/demo/./src/../lib//a.c'), '/home/dev/demo/lib/a.c');
  assert.deepEqual(toDiagnostic({ line: 3, column: 7, severity: 'warning', message: 'm', code: 'X1' }, 'npm run build'),
    { range: { start: { line: 2, character: 6 }, end: { line: 2, character: 6 } }, severity: 2, message: 'm', source: 'npm run build', code: 'X1' });
  // Without a column, the whole line.
  assert.deepEqual(toDiagnostic({ line: 1, severity: 'error', message: 'm' }, 't').range, { start: { line: 0, character: 0 }, end: { line: 0, character: Number.MAX_SAFE_INTEGER } });
});
