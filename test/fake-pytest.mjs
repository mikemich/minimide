// A stand-in for pytest in the testExplorer suite, for machines without it: finds test_*.py files,
// their test functions and Test classes, and "runs" them by name (a name with "fail" fails, one
// with "skip" is skipped, the rest pass; a function under @pytest.mark.parametrize has the cases
// [1] and [2]). Understands --collect-only -q, --junitxml=<file> and node ids.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const cwd = process.cwd();
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function testFiles(dir = cwd, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/^test_.*\.py$/.test(e.name)) out.push(path.relative(cwd, p));
  }
  return out.sort();
}

/** [{ id, file, classname, name, line }] for every test in a file. */
function collect(file) {
  const out = [];
  let cls = null;
  const lines = fs.readFileSync(path.join(cwd, file), 'utf8').split('\n');
  lines.forEach((l, i) => {
    const c = /^class (Test\w*)/.exec(l);
    if (c) { cls = c[1]; return; }
    if (/^\S/.test(l)) cls = null;
    const d = /^(\s*)def (test\w*)/.exec(l);
    if (!d || (d[1] && !cls)) return;
    const owner = d[1] ? cls : null;
    const mod = file.replace(/\.py$/, '').split(path.sep).join('.');
    const base = { file, classname: owner ? `${mod}.${owner}` : mod, line: i };
    const id = [file, owner, d[2]].filter(Boolean).join('::');
    if (/parametrize/.test(lines[i - 1] || '')) for (const k of [1, 2]) out.push({ ...base, id: `${id}[${k}]`, name: `${d[2]}[${k}]` });
    else out.push({ ...base, id, name: d[2] });
  });
  return out;
}

const all = testFiles().flatMap(collect);
if (args.includes('--collect-only')) {
  for (const t of all) console.log(t.id);
  console.log(`\n${all.length} tests collected in 0.01s`);
  process.exit(0);
}

const ids = args.filter((a) => !a.startsWith('-') && !['no:cacheprovider', 'junit_family=xunit1'].includes(a));
const chosen = ids.length ? all.filter((t) => ids.some((id) => t.id === id || t.id.startsWith(`${id}::`) || t.id.startsWith(`${id}[`) || t.file === id)) : all;
const cases = chosen.map((t) => {
  const attrs = `classname="${xml(t.classname)}" name="${xml(t.name)}" file="${xml(t.file)}" line="${t.line}" time="0.001"`;
  if (/fail/.test(t.name)) return { t, out: `<testcase ${attrs}><failure message="assert 2 == 3">    def ${t.name}():\n&gt;       assert 1 + 1 == 3\nE       assert 2 == 3\n\n${xml(t.file)}:${t.line + 2}: AssertionError</failure></testcase>`, failed: true };
  if (/skip/.test(t.name)) return { t, out: `<testcase ${attrs}><skipped type="pytest.skip" message="not today">${xml(t.file)}:${t.line + 1}: not today</skipped></testcase>` };
  return { t, out: `<testcase ${attrs} />` };
});
for (const c of cases) console.log(`${c.t.id} ${c.failed ? 'FAILED' : 'PASSED'}`);
const junit = args.find((a) => a.startsWith('--junitxml='))?.slice('--junitxml='.length);
const failures = cases.filter((c) => c.failed).length;
if (junit) fs.writeFileSync(junit, `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="${failures}" tests="${cases.length}">${cases.map((c) => c.out).join('')}</testsuite></testsuites>`);
process.exit(failures ? 1 : 0);
