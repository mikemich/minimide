// A stand-in for Jest in the testExplorer suite: runs describe / it / test files with a tiny
// expect() and writes the report `jest --json --outputFile` writes, so the suite needs no install.
// Understands --listTests, -t <pattern>, --runTestsByPath <files> and --outputFile=<file>.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const cwd = process.cwd();
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function testFiles(dir = cwd, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

if (args.includes('--listTests')) {
  console.log(JSON.stringify(testFiles()));
  process.exit(0);
}

const t = args.indexOf('-t');
const pattern = t >= 0 ? new RegExp(args[t + 1]) : null;
const byPath = args.indexOf('--runTestsByPath');
const files = byPath >= 0 ? args.slice(byPath + 1).map((f) => path.resolve(cwd, f)) : testFiles();
// A test that sleeps, for cancelling a run.
const delay = Number(process.env.FAKE_JEST_DELAY || 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);

const testResults = [];
let failed = 0;
for (const file of files) {
  const tests = [];
  const stack = [];
  const where = () => {
    const frame = new Error().stack.split('\n').find((l) => l.includes(file));
    const m = frame && /:(\d+):(\d+)\)?$/.exec(frame);
    return m ? { line: Number(m[1]), column: Number(m[2]) } : null;
  };
  const add = (name, fn, skip) => tests.push({ names: [...stack, name], fn, skip, location: where() });
  global.describe = (name, fn) => { stack.push(name); fn(); stack.pop(); };
  global.it = global.test = (name, fn) => add(name, fn, false);
  global.it.skip = global.test.skip = (name, fn) => add(name, fn, true);
  global.expect = (actual) => ({
    toBe(expected) {
      if (actual !== expected) throw new Error(`expect(received).toBe(expected) // Object.is equality\n\nExpected: ${JSON.stringify(expected)}\nReceived: ${JSON.stringify(actual)}`);
    },
  });
  const assertionResults = [];
  try {
    delete require.cache[file];
    require(file);
  } catch (err) {
    testResults.push({ name: file, status: 'failed', message: `  ● Test suite failed to run\n\n    ${err.message}`, assertionResults: [] });
    failed++;
    continue;
  }
  for (const test of tests) {
    const fullName = test.names.join(' ');
    const base = { ancestorTitles: test.names.slice(0, -1), title: test.names[test.names.length - 1], fullName, location: test.location, failureMessages: [], duration: null };
    // Like Jest, tests that -t leaves out are reported as pending.
    if (test.skip || (pattern && !pattern.test(fullName))) { assertionResults.push({ ...base, status: 'pending' }); continue; }
    const started = Date.now();
    try {
      test.fn();
      assertionResults.push({ ...base, status: 'passed', duration: Date.now() - started });
    } catch (err) {
      failed++;
      assertionResults.push({ ...base, status: 'failed', duration: Date.now() - started, failureMessages: [err.stack] });
    }
  }
  const status = assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed';
  console.error(`${status === 'failed' ? 'FAIL' : 'PASS'} ${path.relative(cwd, file)}`);
  testResults.push({ name: file, status, message: '', assertionResults });
}

const report = { success: !failed, numFailedTests: failed, testResults };
const out = opt('outputFile');
if (out) fs.writeFileSync(out, JSON.stringify(report));
else console.log(JSON.stringify(report));
process.exit(failed ? 1 : 0);
