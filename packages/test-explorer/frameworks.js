// The command lines: running some or all tests with a machine-readable reporter, and asking a
// framework for its own list of tests. Pure functions; `base` is the command that starts the
// framework (a setting, or found in the project), already quoted for the shell.

import { namePattern } from './discover.js';

export const posixQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
export const winQuote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`);
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A name as a regex: placeholders of an each-name ("adds %s", "$a + $b") match anything. */
const nameRegex = (name) => (namePattern(name) ? escapeRegex(name).replace(/%[sdifjoOp#]/g, '.*?').replace(/\\\$[\w.]+/g, '.*?') : escapeRegex(name));

/**
 * One regex for Jest's -t, Vitest's -t and node's --test-name-pattern, which all match the full
 * name (suite names and the test name joined by spaces). A suite (or a test with cases) also
 * matches everything inside it.
 */
export function fullNamePattern(targets) {
  const parts = targets.map((t) => `${t.names.map(nameRegex).join(' ')}${t.group ? '(?: |$)' : '$'}`);
  return `^(?:${parts.join('|')})`;
}

/** pytest node id for names under a file; a parametrized case (test_x › test_x[1]) is just test_x[1]. */
export function pytestId(file, names) {
  const parts = names.filter((n, i) => !(names[i + 1] && names[i + 1].startsWith(n + '[')));
  return [file, ...parts].join('::');
}

/**
 * Runs `targets` ([{ file, names, group }], files relative to `root`; names [] for a whole file)
 * or everything (`all`). The report goes to `out`. Returns the command line.
 */
export function runCommand(fw, { base, targets = [], all = false, out, quote = posixQuote }) {
  const files = [...new Set(targets.map((t) => t.file))];
  // A name filter only when every target is narrower than its file.
  const named = !all && targets.length && targets.every((t) => t.names.length) ? fullNamePattern(targets) : null;
  const q = quote;
  switch (fw) {
    case 'jest':
      return `${base} --json --outputFile=${q(out)} --testLocationInResults${named ? ` -t ${q(named)}` : ''}${!all && files.length ? ` --runTestsByPath ${files.map(q).join(' ')}` : ''}`;
    case 'vitest':
      return `${base} run --reporter=default --reporter=json --outputFile.json=${q(out)}${named ? ` -t ${q(named)}` : ''}${!all ? files.map((f) => ` ${q(f)}`).join('') : ''}`;
    case 'node':
      // Files are always named: node --test's own patterns find more than what we show.
      return `${base} --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${q(out)}${named ? ` --test-name-pattern=${q(named)}` : ''}${files.map((f) => ` ${q(f)}`).join('')}`;
    case 'pytest':
      return `${base} -p no:cacheprovider -o junit_family=xunit1 --junitxml=${q(out)}${all ? '' : targets.map((t) => ` ${q(pytestId(t.file, t.names))}`).join('')}`;
    default:
      throw new Error(`No runner for ${fw}`);
  }
}

/**
 * `go test -json` for packages (['./...'] or ['./sub', '.']) and, optionally, tests: top-level
 * names, or one test with its subtest path.
 */
export function goRunCommand({ base, packages, tests = [], quote = posixQuote }) {
  let run = '';
  if (tests.length === 1 && tests[0].length > 1) run = tests[0].map((n) => `^${escapeRegex(n)}$`).join('/');
  else if (tests.length) run = `^(?:${[...new Set(tests.map((t) => escapeRegex(t[0])))].join('|')})$`;
  return `${base} test -json${run ? ` -run ${quote(run)}` : ''} ${packages.map(quote).join(' ')}`;
}

/** Asking a framework which tests it would run (null: it has no such list). */
export function listCommand(fw, { base }) {
  switch (fw) {
    case 'jest': return `${base} --listTests --json`;
    case 'vitest': return `${base} list --json`;
    case 'pytest': return `${base} -p no:cacheprovider --collect-only -q`;
    case 'go': return `${base} test -list . ./...`;
    default: return null;
  }
}
