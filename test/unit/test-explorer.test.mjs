import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { testFileKind, jsFramework, frameworkFromImports, nearestRoot, scanJs, scanPython, scanGo, namePattern, isCaseOf } from '../../packages/test-explorer/discover.js';
import { runCommand, goRunCommand, listCommand, fullNamePattern, pytestId, posixQuote, winQuote } from '../../packages/test-explorer/frameworks.js';
import { parseJestJson, parseJunit, parseGoJson, parseVitestList, parseJestList, parsePytestCollect, parseGoList, expectedActual, summarize, goModule } from '../../packages/test-explorer/parse.js';
import { fileNode, find, statusOf, counts, plan, nodeAtLine, failedTests, keyOf, node } from '../../packages/test-explorer/model.js';

// Outputs recorded from the real tools (node:test 26, go 1.25) or written in the shape they print.
const fixture = (name) => readFileSync(new URL(`fixtures/test-explorer/${name}`, import.meta.url), 'utf8');
const listings = Object.fromEntries(fixture('listings.txt').split(/^### /m).filter(Boolean).map((s) => [s.slice(0, s.indexOf('\n')), s.slice(s.indexOf('\n') + 1)]));
const brief = (tests) => tests.map((t) => [t.names.join(' › '), t.status]);
const tree = (nodes) => nodes.map((n) => (n.children.length ? [`${n.kind} ${n.name}@${n.line}-${n.end}`, tree(n.children)] : `${n.kind} ${n.name}@${n.line}-${n.end}`));

// --- discovery --------------------------------------------------------------------------------------

test('testFileKind: the file names each framework runs', () => {
  const kinds = Object.fromEntries(['src/a.test.js', 'src/a.spec.tsx', 'b.test.mjs', 'src/__tests__/c.js', 'test/d.js', 'tests/e.cjs', 'test.js', 'test-f.mjs', 'g_test.js',
    'types.d.ts', 'src/app.js', 'test_calc.py', 'calc_test.py', 'calc.py', 'math_test.go', 'math.go', 'README.md'].map((f) => [f, testFileKind(f)]));
  assert.deepEqual(kinds, {
    'src/a.test.js': 'js', 'src/a.spec.tsx': 'js', 'b.test.mjs': 'js', 'src/__tests__/c.js': 'js', 'test/d.js': 'js-node', 'tests/e.cjs': 'js-node', 'test.js': 'js-node',
    'test-f.mjs': 'js-node', 'g_test.js': 'js-node', 'types.d.ts': null, 'src/app.js': null, 'test_calc.py': 'py', 'calc_test.py': 'py', 'calc.py': null,
    'math_test.go': 'go', 'math.go': null, 'README.md': null,
  });
});

test('jsFramework: dependencies, scripts and config files; Vitest wins over Jest', () => {
  assert.equal(jsFramework({ devDependencies: { jest: '^29' } }), 'jest');
  assert.equal(jsFramework({ devDependencies: { 'ts-jest': '^29' } }), 'jest');
  assert.equal(jsFramework({ scripts: { test: 'jest --coverage' } }), 'jest');
  assert.equal(jsFramework({}, ['jest.config.ts']), 'jest');
  assert.equal(jsFramework({ devDependencies: { vitest: '^2', jest: '^29' } }), 'vitest');
  assert.equal(jsFramework({ scripts: { test: 'vitest run' } }), 'vitest');
  assert.equal(jsFramework({}, ['vitest.config.mts']), 'vitest');
  assert.equal(jsFramework({ scripts: { test: 'node --test test/' } }), 'node');
  assert.equal(jsFramework({ scripts: { test: 'mocha' } }), null);
  assert.equal(jsFramework(null), null);
  assert.equal(frameworkFromImports("import { test } from 'node:test';"), 'node');
  assert.equal(frameworkFromImports("const test = require('node:test');"), 'node');
  assert.equal(frameworkFromImports("import { it, expect } from 'vitest'"), 'vitest');
  assert.equal(frameworkFromImports("import x from 'jest-thing'"), null);
});

test('nearestRoot and goModule', () => {
  const dirs = new Set(['', 'web', 'web/app']);
  assert.equal(nearestRoot('web/app/src/x.test.js', dirs), 'web/app');
  assert.equal(nearestRoot('web/y.test.js', dirs), 'web');
  assert.equal(nearestRoot('lib/z.test.js', dirs), '');
  assert.equal(nearestRoot('lib/z.test.js', new Set(['web'])), null);
  assert.equal(goModule('// comment\nmodule example.com/gm\n\ngo 1.22\n'), 'example.com/gm');
  assert.equal(goModule(''), null);
});

test('scanJs: suites, tests, modifiers, each, subtests, lines and ends; strings, comments and regexes are skipped', () => {
  const text = [
    "import { describe, it, test } from 'vitest';", // 1
    "describe('math', () => {", // 2
    "  it('adds', () => {", // 3
    '    expect(add(1, 2)).toBe(3); // it("not a test")', // 4
    '  });', // 5
    "  it.each([[1, 2], [2, 4]])('doubles %s', (a, b) => {});", // 6
    "  test.skip(\"later\", () => {});", // 7
    "  describe.each`a | b`('table $a', () => { it.only('row', () => {}); });", // 8
    '  const s = "describe(\'fake\')"; const re = /it\\(\'nope\'/;', // 9
    '  /* test("commented", () => {}) */', // 10
    '  it(`template ${1}`, () => {});', // 11
    '});', // 12
    "test('top', async (t) => {", // 13
    "  await t.test('sub one', () => {});", // 14
    '});', // 15
    "it.todo('someday');", // 16
    'obj.test("method call");', // 17
  ].join('\n');
  assert.deepEqual(tree(scanJs(text)), [
    ['suite math@2-12', ['test adds@3-5', 'test doubles %s@6-6', 'test later@7-7', ['suite table $a@8-8', ['test row@8-8']], 'test template ${1}@11-11']],
    ['test top@13-15', ['test sub one@14-14']],
    'test someday@16-16',
  ]);
});

test('scanPython: test functions and Test classes with their ends; helpers, other classes and docstrings left out', () => {
  const text = [
    'import pytest', // 1
    '', // 2
    'def test_add():', // 3
    '    """def test_in_docstring():', // 4
    '    """', // 5
    '    assert add(1, 2) == 3', // 6
    '', // 7
    'class TestCalc:', // 8
    '    def helper(self):', // 9
    '        pass', // 10
    '    async def test_mul(self):', // 11
    '        assert mul(2, 3) == 6', // 12
    '', // 13
    'class Helper:', // 14
    '    def test_not_collected(self): pass', // 15
    '', // 16
    '@pytest.mark.parametrize("n", [1, 2])', // 17
    'def test_param(n):', // 18
    '    assert n', // 19
    '', // 20
    'class TestEmpty:', // 21
    '    pass', // 22
  ].join('\n');
  assert.deepEqual(tree(scanPython(text)), ['test test_add@3-6', ['suite TestCalc@8-12', ['test test_mul@11-12']], 'test test_param@18-19']);
});

test('scanGo: TestX functions and their t.Run subtests, named the way go test names them', () => {
  const text = 'package gm\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif add(1, 2) != 3 { t.Fatal("no") }\n}\n\nfunc TestTable(t *testing.T) {\n\tt.Run("one", func(t *testing.T) {})\n\tt.Run("two words", func(t *testing.T) {})\n}\n\nfunc Testable(t *testing.T) {}\nfunc helper(t *testing.T) {}\nfunc BenchmarkX(b *testing.B) {}\n';
  assert.deepEqual(tree(scanGo(text)), ['test TestAdd@5-7', ['test TestTable@9-12', ['test one@10-10', 'test two_words@11-11']]]);
});

test('namePattern and isCaseOf: each-names and parametrized ids', () => {
  assert.equal(namePattern('adds'), null);
  assert.ok(namePattern('doubles %s').test('doubles 2'));
  assert.ok(namePattern('$a + $b = $expected').test('1 + 2 = 3'));
  assert.ok(isCaseOf('test_param', 'test_param[1-2]'));
  assert.ok(isCaseOf('doubles %s', 'doubles 4'));
  assert.ok(!isCaseOf('adds', 'adds'));
  assert.ok(!isCaseOf('test_param', 'test_param_other'));
});

// --- commands -----------------------------------------------------------------------------------------

test('fullNamePattern: one regex for -t and --test-name-pattern', () => {
  assert.equal(fullNamePattern([{ names: ['math', 'adds'], group: false }]), '^(?:math adds$)');
  assert.equal(fullNamePattern([{ names: ['math'], group: true }, { names: ['a.b (c)'], group: false }]), '^(?:math(?: |$)|a\\.b \\(c\\)$)');
  assert.equal(fullNamePattern([{ names: ['math', 'doubles %s'], group: true }]), '^(?:math doubles .*?(?: |$))');
  const re = new RegExp(fullNamePattern([{ names: ['math', 'doubles %s'], group: true }]));
  assert.ok(re.test('math doubles 2') && !re.test('math adds'));
});

test('runCommand: each framework with its reporter, files and name filter', () => {
  const out = '/run/report';
  const one = [{ file: 'src/math.test.js', names: ['math', 'adds'], group: false }];
  assert.equal(runCommand('jest', { base: 'jest', targets: one, out }), "jest --json --outputFile=/run/report --testLocationInResults -t '^(?:math adds$)' --runTestsByPath src/math.test.js");
  assert.equal(runCommand('jest', { base: 'jest', all: true, out }), 'jest --json --outputFile=/run/report --testLocationInResults');
  assert.equal(runCommand('jest', { base: 'jest', targets: [{ file: 'a b.test.js', names: [], group: true }], out }), "jest --json --outputFile=/run/report --testLocationInResults --runTestsByPath 'a b.test.js'");
  assert.equal(runCommand('vitest', { base: 'npx vitest', targets: [{ file: 'web/s.test.ts', names: ['strings'], group: true }], out }),
    "npx vitest run --reporter=default --reporter=json --outputFile.json=/run/report -t '^(?:strings(?: |$))' web/s.test.ts");
  assert.equal(runCommand('node', { base: 'node', targets: [{ file: 'a.test.mjs', names: [], group: true }, { file: 'b.test.mjs', names: [], group: true }], out }),
    'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=/run/report a.test.mjs b.test.mjs');
  // A name filter only when every target is narrower than its file.
  assert.equal(runCommand('node', { base: 'node', targets: [{ file: 'a.test.mjs', names: [], group: true }, { file: 'b.test.mjs', names: ['x'], group: false }], out }),
    'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=/run/report a.test.mjs b.test.mjs');
  assert.equal(runCommand('pytest', { base: 'python3 -m pytest', targets: [{ file: 'tests/test_calc.py', names: ['TestCalc', 'test_mul'], group: false }, { file: 'tests/test_calc.py', names: ['test_param', 'test_param[1]'], group: false }], out }),
    "python3 -m pytest -p no:cacheprovider -o junit_family=xunit1 --junitxml=/run/report tests/test_calc.py::TestCalc::test_mul 'tests/test_calc.py::test_param[1]'");
  assert.equal(runCommand('pytest', { base: 'pytest', all: true, out }), 'pytest -p no:cacheprovider -o junit_family=xunit1 --junitxml=/run/report');
  assert.throws(() => runCommand('mocha', { base: 'mocha', out }), /No runner/);
  assert.equal(runCommand('jest', { base: 'jest', targets: [{ file: 'C:\\p\\a b.test.js', names: [], group: true }], out: 'C:\\r\\out.json', quote: winQuote }),
    'jest --json --outputFile=C:\\r\\out.json --testLocationInResults --runTestsByPath "C:\\p\\a b.test.js"');
});

test('goRunCommand, pytestId, listCommand and quoting', () => {
  assert.equal(goRunCommand({ base: 'go', packages: ['./...'] }), 'go test -json ./...');
  assert.equal(goRunCommand({ base: 'go', packages: ['.'], tests: [['TestAdd'], ['TestFail']] }), "go test -json -run '^(?:TestAdd|TestFail)$' .");
  assert.equal(goRunCommand({ base: 'go', packages: ['./sub'], tests: [['TestTable', 'two_words']] }), "go test -json -run '^TestTable$/^two_words$' ./sub");
  assert.equal(pytestId('t.py', ['TestX', 'test_y']), 't.py::TestX::test_y');
  assert.equal(pytestId('t.py', ['test_p', 'test_p[1]']), 't.py::test_p[1]');
  assert.deepEqual(['jest', 'vitest', 'pytest', 'go', 'node'].map((fw) => listCommand(fw, { base: fw })),
    ['jest --listTests --json', 'vitest list --json', 'pytest -p no:cacheprovider --collect-only -q', 'go test -list . ./...', null]);
  assert.equal(posixQuote('plain/path.js'), 'plain/path.js');
  assert.equal(posixQuote("it's"), "'it'\\''s'");
  assert.equal(winQuote('say "hi"'), '"say ""hi"""');
});

// --- reports ------------------------------------------------------------------------------------------------

test('parseJestJson: Jest results with locations, each-cases, skipped and todo, and a file that failed to run', () => {
  const { files, tests } = parseJestJson(fixture('jest.json'));
  assert.deepEqual(brief(tests), [['math › adds', 'passed'], ['math › multiplies', 'failed'], ['math › each › doubles 2', 'passed'], ['math › later', 'skipped'], ['someday', 'skipped']]);
  assert.equal(tests[0].path, '/proj/src/math.test.js');
  assert.deepEqual(tests.map((t) => t.line), [4, 7, 12, 15, 18]);
  const fail = tests[1];
  assert.deepEqual([fail.duration, fail.expected, fail.actual], [5, '3', '2']);
  assert.match(fail.message, /^Error: expect\(received\)\.toBe\(expected\)/);
  assert.ok(!/\x1b|at Object\.toBe/.test(fail.message), 'colors and stack frames are left out of the message');
  assert.match(fail.details, /at Object\.toBe/);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['/proj/src/broken.test.js', 'failed']]);
  assert.match(files[0].message, /SyntaxError/);
});

test('parseJestJson: Vitest’s JSON reporter', () => {
  const { tests } = parseJestJson(fixture('vitest.json'));
  assert.deepEqual(brief(tests), [['strings › upper', 'passed'], ['strings › lower', 'failed'], ['skipped one', 'skipped']]);
  assert.deepEqual([tests[1].expected, tests[1].actual, tests[1].duration], ["'abc'", "'ABC'", 3.5]);
});

test('parseJunit: pytest (xunit1 with files and lines, xunit2 without), classes, params, skips and setup errors', () => {
  const { tests } = parseJunit(fixture('pytest.xml'), { root: '/proj' });
  assert.deepEqual(brief(tests), [['test_add', 'passed'], ['TestCalc › test_mul', 'failed'], ['test_param[1]', 'passed'], ['test_param[2]', 'passed'], ['test_skip', 'skipped'], ['test_needs_db', 'failed']]);
  assert.deepEqual(tests.map((t) => t.path), [...Array(5).fill('/proj/tests/test_calc.py'), '/proj/tests/test_fixture.py']);
  assert.deepEqual(tests.map((t) => t.line), [3, 7, 10, 10, 14, 1]);
  assert.deepEqual([tests[1].expected, tests[1].actual], ['7', '6']);
  assert.equal(tests[4].message, 'later');
  assert.match(tests[5].message, /fixture 'db' not found/);
  const two = parseJunit(fixture('pytest-xunit2.xml'), { root: '/proj' }).tests;
  assert.deepEqual(two.map((t) => [t.path, t.names]), [['/proj/pkg/tests/test_io.py', ['TestRead', 'test_lines']], ['/proj/test_top.py', ['test_one']]]);
});

test('parseJunit: node:test’s junit reporter, with describe blocks as nested suites', () => {
  const { tests } = parseJunit(fixture('node-junit.xml'), { style: 'node' });
  assert.deepEqual(brief(tests), [['math › adds', 'passed'], ['math › fails', 'failed'], ['math › skipped', 'skipped'], ['math › inner › deep', 'passed'], ['top', 'passed'], ['throws', 'failed']]);
  assert.equal(tests[0].path, '/proj/a.test.mjs');
  assert.deepEqual([tests[1].expected, tests[1].actual], ['{ a: 2 }', '{ a: 1 }']);
  assert.equal(tests[2].message, '', 'node writes message="true" for a skip');
  assert.equal(tests[5].message.split('\n')[0], 'boom');
});

test('parseGoJson: tests, subtests, the line of a failure, and packages', () => {
  const { tests, packages, output } = parseGoJson(`plain build line\n${fixture('go.jsonl')}`);
  assert.deepEqual(tests.map((t) => [t.pkg, t.names.join('/'), t.status]), [
    ['example.com/gm', 'TestAdd', 'passed'], ['example.com/gm', 'TestFail', 'failed'], ['example.com/gm', 'TestSkip', 'skipped'], ['example.com/gm', 'TestTable', 'failed'],
    ['example.com/gm', 'TestTable/one', 'passed'], ['example.com/gm', 'TestTable/two_words', 'failed'], ['example.com/gm/sub', 'TestSub', 'passed'],
  ]);
  const fail = tests[1];
  assert.deepEqual([fail.line, fail.message, fail.expected, fail.actual], [12, 'math_test.go:12: got 2, want 3', '3', '2']);
  assert.deepEqual(packages.map((p) => [p.pkg, p.status]), [['example.com/gm', 'failed'], ['example.com/gm/sub', 'passed']]);
  assert.match(output, /^plain build line\n/);
  assert.match(output, /--- FAIL: TestFail/);
});

test('framework listings: vitest list, jest --listTests, pytest --collect-only, go test -list', () => {
  assert.deepEqual(parseVitestList(`some banner\n${listings['vitest list --json']}`), [
    { path: '/proj/web/strings.test.ts', names: ['strings', 'upper'] }, { path: '/proj/web/strings.test.ts', names: ['strings', 'nested', 'lower'] },
  ]);
  assert.deepEqual(parseVitestList('no json here'), []);
  assert.deepEqual(parseJestList(listings['jest --listTests --json']), ['/proj/src/math.test.js', '/proj/src/custom-check.js']);
  assert.deepEqual(parseJestList('/proj/a.test.js\n/proj/b.test.js\n'), ['/proj/a.test.js', '/proj/b.test.js']);
  assert.deepEqual(parsePytestCollect(listings['pytest --collect-only -q'], '/proj').map((t) => t.names.join('::')), ['test_add', 'TestCalc::test_mul', 'test_param[1]', 'test_param[2]']);
  assert.deepEqual(parseGoList(listings['go test -list . ./...']), [{ pkg: 'example.com/gm', names: ['TestAdd', 'TestFail', 'TestSkip', 'TestTable'] }, { pkg: 'example.com/gm/sub', names: ['TestSub'] }]);
});

test('expectedActual and summarize', () => {
  assert.deepEqual(expectedActual('expected 5 to equal 6'), { expected: '6', actual: '5' });
  assert.deepEqual(expectedActual('E       AssertionError: assert [1] == [2]'), { expected: '[2]', actual: '[1]' });
  assert.deepEqual(expectedActual('just broken'), {});
  const long = ['Error: boom', '    at a (x.js:1:1)', '    at b (node:internal/x:2:2)', ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join('\n');
  assert.equal(summarize(long, 3), 'Error: boom\nline 0\nline 1\n…');
});

// --- the model ---------------------------------------------------------------------------------------------

function sampleFile() {
  const scanned = scanJs("describe('math', () => {\n  it('adds', () => {});\n  it.each([1])('doubles %s', () => {});\n});\ntest('top', () => {});\n");
  return fileNode({ path: '/proj/src/math.test.js', rel: 'src/math.test.js', fw: 'jest', runRoot: '/proj', folder: '/proj', scanned });
}

test('find: scanned nodes, each-cases under their family, unknown names added under the deepest match', () => {
  const file = sampleFile();
  assert.equal(find(file, ['math', 'adds']).line, 2);
  assert.equal(find(file, ['math', 'doubles 1']), null);
  const kase = find(file, ['math', 'doubles 1'], { add: true });
  assert.deepEqual([kase.parent.name, kase.names, kase.line, kase.dynamic], ['doubles %s', ['math', 'doubles 1'], 3, true]);
  assert.equal(find(file, ['math', 'doubles 1']), kase, 'found again, not added twice');
  const extra = find(file, ['other', 'thing'], { add: true });
  assert.deepEqual([extra.parent.name, extra.parent.kind, extra.parent.parent, extra.kind], ['other', 'suite', file, 'test']);
});

test('statusOf, counts, failedTests: results roll up to suites, files and folders', () => {
  const file = sampleFile();
  const folder = node({ kind: 'folder', name: 'proj', path: '/proj', names: [], children: [file] });
  file.parent = folder;
  const results = new Map();
  const set = (names, status) => results.set(keyOf(file.path, names), { status });
  const kase = find(file, ['math', 'doubles 1'], { add: true });
  set(['math', 'adds'], 'passed');
  set(['math', 'doubles 1'], 'failed');
  set(['top'], 'skipped');
  const none = new Set();
  assert.equal(statusOf(find(file, ['math']), results, none), 'failed');
  assert.equal(statusOf(find(file, ['math', 'doubles %s']), results, none), 'failed');
  assert.equal(statusOf(folder, results, none), 'failed');
  assert.equal(statusOf(find(file, ['top']), results, none), 'skipped');
  assert.equal(statusOf(find(file, ['math']), results, new Set([keyOf(file.path, ['math', 'adds'])])), 'running');
  assert.deepEqual(counts([folder], results), { passed: 1, failed: 1, skipped: 1, total: 3 });
  assert.deepEqual(failedTests([folder], results), [kase]);
  set(['math', 'doubles 1'], 'passed');
  assert.equal(statusOf(folder, results, none), 'passed');
  assert.equal(statusOf(fileNode({ path: '/x', rel: 'x', scanned: [] }), new Map(), none), null);
});

test('plan: targets grouped by framework and place, a whole file absorbing its tests', () => {
  const file = sampleFile();
  const other = fileNode({ path: '/proj/tests/test_a.py', rel: 'tests/test_a.py', fw: 'pytest', runRoot: '/proj', folder: '/proj', scanned: scanPython('def test_a():\n    pass\n') });
  const groups = plan([find(file, ['math', 'adds']), find(file, ['math']), find(other, ['test_a'])]);
  assert.deepEqual(groups.map((g) => [g.fw, g.runRoot, g.all, g.targets]), [
    ['jest', '/proj', false, [{ file: 'src/math.test.js', names: ['math', 'adds'], group: false }, { file: 'src/math.test.js', names: ['math'], group: true }]],
    ['pytest', '/proj', false, [{ file: 'tests/test_a.py', names: ['test_a'], group: false }]],
  ]);
  assert.deepEqual(plan([find(file, ['top']), file])[0].targets, [{ file: 'src/math.test.js', names: [], group: true }]);
  const folder = node({ kind: 'folder', name: 'proj', path: '/proj', names: [], children: [file, other] });
  assert.deepEqual(plan([folder]).map((g) => [g.fw, g.all, g.targets.length]), [['jest', true, 0], ['pytest', true, 0]]);
});

test('nodeAtLine: the innermost test around a line', () => {
  const file = sampleFile();
  assert.equal(nodeAtLine(file, 2).name, 'adds');
  assert.equal(nodeAtLine(file, 4).name, 'math');
  assert.equal(nodeAtLine(file, 5).name, 'top');
  assert.equal(nodeAtLine(file, 9), null);
});
