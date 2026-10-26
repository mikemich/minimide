#!/usr/bin/env node
// End-to-end test runner: builds the app, creates fixtures, then launches Electron once per suite
// with the dev-build test hooks (MINIMIDE_HOME / MINIMIDE_EVAL / MINIMIDE_SCREENSHOT), parses the
// `[eval] <json>` line the suite's renderer script produced and checks it.
//
//   node test/run.mjs                 run every suite
//   node test/run.mjs handsOn core    run some suites (dependencies are added automatically)
//   node test/run.mjs --no-build      skip `node build.mjs`
//   node test/run.mjs --keep          keep the fixture dir even when everything passes
//
// Logs and screenshots go to test/output/<suite>.{log,png}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixtures } from './fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES_DIR = path.join(REPO, 'test/suites');
const OUTPUT = path.join(REPO, 'test/output');
const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Suites. `expect` maps a dotted path in the result to an expected value: a RegExp (tested against
// the value as a string), a function (must return true) or anything else (compared as JSON).
// `env.has(cmd)` says whether a program is on PATH, for checks that depend on optional tools.
// Every suite also gets the generic checks in genericFailures().
// `knownIssues` maps an expect path to a description of an app bug that is not fixed yet: a failure
// there is reported but doesn't fail the run, and a pass is flagged so the entry can be removed.

const SUITES = [
  {
    name: 'dialogHarness', home: 'dialogh', project: 'qa', timeout: 60,
    expect: () => ({ scripted: 2, savePath: '/tmp/scripted.txt' }),
  },
  {
    name: 'core', home: 'coreh', project: 'corep', timeout: 90,
    expect: () => ({
      helloActivated: 1, init: 'init', chord: 'hi!', dirty: true, saved: JSON.stringify('Xhello\nworld\n'), dirtyAfter: false,
      reloaded: 'changed outside\n', treeAfterDisable: 'false/false', treeAfterEnable: 'true/true', hot: 'reloaded! activations=2',
      files: 'a.txt,sub/deep.js', synced: true, items: 2,
    }),
  },
  {
    name: 'handsOn', home: 'qah', project: 'qa', delay: 4000, timeout: 300,
    expect: () => ({
      'untitledSaveAs.content': JSON.stringify('print("hi")\n'), 'untitledSaveAs.title': 'saved_new.py', 'untitledSaveAs.lang': 'Python', 'untitledSaveAs.dirty': false,
      'dirtyCloseCancelThenDiscard.cancelKeptOpen': true, 'dirtyCloseCancelThenDiscard.discardClosed': true, 'dirtyCloseCancelThenDiscard.fileUnchanged': true,
      'crlfPreserved.crlf': 'preserved',
      'unicodePathFinderAndSearch.opened': true, 'unicodePathFinderAndSearch.searchHits': 1,
      'runnerQuotedFilename.ran': true,
      'binaryFile.type': 'binary',
      'fileDeletedWhileOpen.stillOpen': true, 'fileDeletedWhileOpen.saveRecreates': true,
      'renameOpenFile.newPath': '/renamed/moved.txt', 'renameOpenFile.oldGone': true, 'renameOpenFile.newExists': true, 'renameOpenFile.tab': 'moved.txt',
      'markdownXss.rendered': true, 'markdownXss.xss': 'none', 'markdownXss.hasScriptTag': false, 'markdownXss.hasOnAttrs': false,
      'replaceAllWithOpenEditor.openEditor': JSON.stringify('DIRTY OMEGA gamma\n'), 'replaceAllWithOpenEditor.stillDirty': true,
      'replaceAllWithOpenEditor.renamedBuffer': JSON.stringify('OMEGA beta\n'), 'replaceAllWithOpenEditor.diskOfRenamed': JSON.stringify('alpha beta\n'),
      'invalidConfigJson.notified': true, 'invalidConfigJson.appAlive': true,
      'userKeymapUnbind.unboundWorks': true, 'userKeymapUnbind.restoredWorks': true,
      allThemes: /^\d+ themes applied$/,
      disableEnableEveryPackage: /^\d+ packages cycled cleanly$/,
      'splitAndCloseLast.panes': 1, 'splitAndCloseLast.originalStillOpen': true,
      'sessionSerializesImage.hasImage': true,
      terminalTabs: (t) => t?.before >= 3 && t.after === t.before - 1,
      smokeEveryCommand: /^\d+ commands ran without errors$/,
      totalErrors: 0,
    }),
  },
  {
    name: 'newPackages', home: 'home3', project: 'p4', timeout: 120,
    expect: (env) => ({
      active: 'image-viewer:true sticky-scroll:true snippets:true source-control:true',
      image: /^256 × 256 .*PNG$/, zoomAfterIn: '125%', cmdPlusZoomsImageNotFont: '150% / font unchanged', svg: /^64 × 64 .*SVG$/,
      sticky: ['1class Inventory {', '6 summarize(filter) {', '8 for (const item of this.items) {', '9 if (filter(item)) {'],
      tabExpanded: JSON.stringify('console.log();'),
      completionHasSnippets: /fori.*forof/,
      // Non-snippet completions come from the TypeScript server, when it is installed.
      ...(env.has('typescript-language-server') ? { completionHasLsp: true } : {}),
      userSnippet: JSON.stringify('console.log("hey from new.js");'),
      scInitial: ['Staged Changes: M inventory.js', 'Changes: M notes.md, U new.js'],
      branch: /^master/,
      afterStage: ['Staged Changes: M inventory.js, M notes.md', 'Changes: U new.js'],
      diffView: 'side-by-side, changed lines: 2', inlineDiff: 'inline diff with deleted chunk', commit: /Committed/,
      gitLog: (l) => Array.isArray(l) && l.length === 2 && /Handle missing items; update notes$/.test(l[0]) && /Initial commit$/.test(l[1]),
      afterCommit: ['Changes: U new.js'],
    }),
  },
  {
    name: 'lspPaths', home: 'qah2', project: 'ts space', timeout: 120, requires: ['typescript-language-server'],
    expect: () => ({ ready: true, typeErrorFlagged: true, definitionOpened: (n) => Number.isInteger(n) && n >= 1, laterFileDiagnostics: true }),
  },
  {
    name: 'sessionSave', home: 'sessh', project: 'qa', timeout: 60,
    expect: () => ({ saved: [['crlf.txt', 'image.png'], ['README.md']], 'cursor.line': 2, 'cursor.col': 4, sidebar: 'source-control' }),
  },
  {
    name: 'sessionRestore', home: 'sessh', project: 'qa', timeout: 60, dependsOn: 'sessionSave',
    expect: () => ({ restored: [['crlf.txt', 'image.png'], ['README.md']], 'cursor.line': 2, 'cursor.col': 4, sidebar: 'source-control' }),
  },
  {
    name: 'regressions', home: 'qbh', project: 'qb', timeout: 180,
    expect: () => ({
      'cmdShiftShortcutsInEditor.paletteOpened': true, 'cmdShiftShortcutsInEditor.plainTypingNotIntercepted': true,
      'azertyCmdZ.tabStillOpen': true,
      'previewTabInSplitKeepsPane.panes': 2, 'previewTabInSplitKeepsPane.rightPaneStillListed': true, 'previewTabInSplitKeepsPane.rightItems': ['target.txt'],
      'closePaneWithThreePanes.panesLeft': 2, 'closePaneWithThreePanes.titles': ['lines.txt', 'target.txt'],
      'reloadAsksAboutUnsaved.cancelKeptEdits': true,
      'brokenConfigNotOverwritten.fileUntouched': true,
      'saveAsOntoOpenFile.oldTabClosed': true, 'saveAsOntoOpenFile.oneDocument': true, 'saveAsOntoOpenFile.disk': JSON.stringify('NEW CONTENT\n'),
      'deletedFileMarkedUnsaved.markedUnsaved': true,
      'snippetSelectionWithDollarBraces.literalPreserved': true,
      'duplicateBinarySafe.identical': true,
      'markdownRemoteImageBlockedAndAnchors.remoteBlocked': true, 'markdownRemoteImageBlockedAndAnchors.headingId': 't',
      'previewClosesWithSource.previewGone': true,
      'replaceAllRegexDoesNotJoinLines.lines': JSON.stringify('one_two\nthree_four\n'), 'replaceAllRegexDoesNotJoinLines.literalDollar': JSON.stringify('$$5:_10\n'),
      'searchCatastrophicRegexDoesNotFreeze.resultOrTimeout': /^(stopped: |\d+ files$)/, 'searchCatastrophicRegexDoesNotFreeze.uiResponsive': true,
      totalErrors: 0,
    }),
  },
  {
    name: 'sandbox', home: 'sbxh', project: 'sbx/proj', timeout: 90,
    expect: () => ({
      installWordCount: 'word-count', sandboxed: true, recordedAccess: 'sandboxed', statusShowsCount: true, commandEdited: true, foreignKeybindingDropped: true,
      installEvil: 'evil', evilGlobals: 'undefined,undefined,undefined,undefined,undefined', evilAllowed: [], foreignCommandRegistered: false,
      foreignConfigHidden: 'hidden', themeUnchanged: 'nightfall', foreignSchemaIgnored: 'nightfall', cssRemoteRemoved: true,
      installReader: 'proj-reader', readerProject: true, readerDotDot: true, readerSymlink: true, readerWrite: true, readerExec: true, readerGitConfig: true, readerNodeModules: true, 'viewer.read': 'ALLOWED', 'viewer.write': 'blocked',
      cssNoFakeUi: true, cssKeepsSafeVars: true, evilChannels: 'undefined,undefined,undefined,undefined,undefined', floodThrottled: true, notifySpamCapped: true,
      installReaper: 'file-reaper', reaperBlocked: [], reaperProjectWrite: 'ALLOWED', clobberOpenInit: 'blocked', initUntouched: true,
      uninstallClean: true, records: ['evil', 'file-reaper', 'net-probe', 'proj-reader', 'proj-viewer'], netProbeRan: true, netLocalRefused: [], reservedNameRefused: true,
    }),
  },
  {
    name: 'trust', home: 'trusth', project: null, trust: false, timeout: 90,
    expect: () => ({
      restrictedStatus: true, markerAfterOpen: false, markerAfterBlame: false, scRestricted: true, lspRestricted: true,
      trusted: true, gitBranchAfterTrust: true, markerAfterTrust: false, storedTrust: true, restrictedAfterUntrust: true,
    }),
  },
  {
    name: 'languages', home: 'fth', project: 'ftproj', timeout: 90,
    expect: () => ({
      // Each file opens in the right language and gets highlighted.
      langs: (l) => !!l && Object.entries({ Makefile: 'Makefile', 'rules.nft': 'nftables', 'app.log': 'Log', 'data.csv': 'CSV', '.zshrc': 'Shell',
        '.gitignore': 'Ignore', 'main.tf': 'Terraform', '.env': 'Properties files' }).every(([f, lang]) => new RegExp(`^${lang} \\([1-9]`).test(l[f] || '')),
      afterFo: (l) => Array.isArray(l) && l.includes('for|for … in') && l.includes('fori|Counting for loop'),
      afterNs: (l) => Array.isArray(l) && l.includes('nsr1|word'),
      afterDollarNs: (l) => Array.isArray(l) && l.includes('$nsr1|word'),
      expanded: JSON.stringify('for item in list; do\n  \ndone'),
    }),
  },
  {
    name: 'largeProject', home: 'largeh', project: 'large', timeout: 180,
    expect: () => ({
      fileCount: 55000, nodeModulesIgnored: true, searchMatches: 1100, searchError: null,
      relistFast: true, newFileSeen: true, deletedGone: true, responsive: true,
    }),
  },
  {
    name: 'terminal', home: 'termh', project: 'rproj', timeout: 150, requires: ['python3', 'cc'],
    expect: () => ({
      runButton: true, prompt: true, python: 'Hello, Mike! 2+2=4', pyExit: true, buttonBackToPlay: true, c: 'C says 42', task: 'task-ran-ok',
      stopWorks: true, shell: 'shell-42', ctrlBPassedThrough: true, escapeKeptPanel: true, cmdPStillWorks: true,
    }),
  },
];

// ---------------------------------------------------------------------------
// Checks

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function show(v) {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

/** Failure markers any suite can produce: THREW / ERR values, non-empty error lists, totalErrors. */
function genericFailures(result) {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (v.includes('THREW') || v.startsWith('ERR ')) out.push(`${p || '(result)'}: ${show(v)}`);
    } else if (Array.isArray(v)) {
      const key = p.split('.').pop();
      if (['errors', 'errs'].includes(key) && v.length) out.push(`${p}: ${show(v)}`);
      else v.forEach((x, i) => walk(x, p ? `${p}.${i}` : String(i)));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(result, '');
  if (typeof result?.totalErrors === 'number' && result.totalErrors > 0) out.push(`totalErrors: ${result.totalErrors}`);
  return out;
}

/** Returns { failures, known, fixed }: failing checks, failing known issues, known issues that now pass. */
function check(suite, result, env) {
  const failures = genericFailures(result);
  const known = [];
  const fixed = [];
  const knownIssues = suite.knownIssues || {};
  for (const [p, want] of Object.entries(suite.expect(env))) {
    const got = get(result, p);
    let ok;
    if (want instanceof RegExp) ok = got != null && want.test(typeof got === 'string' ? got : JSON.stringify(got));
    else if (typeof want === 'function') { try { ok = !!want(got); } catch { ok = false; } }
    else ok = JSON.stringify(got) === JSON.stringify(want);
    const message = `${p}: got ${show(got)}, want ${want instanceof RegExp ? want : typeof want === 'function' ? 'check to pass' : show(want)}`;
    if (p in knownIssues) (ok ? fixed : known).push(ok ? `${p} passes now: remove it from knownIssues` : `known issue: ${p} (${knownIssues[p]})`);
    else if (!ok) failures.push(message);
  }
  return { failures: [...new Set(failures)], known, fixed };
}

// ---------------------------------------------------------------------------
// Environment

function has(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK); return true; } catch {}
    }
  }
  return false;
}

/** Kill a process and everything it started (it was spawned as a process group leader). */
function killTree(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// ---------------------------------------------------------------------------
// Running a suite

function runSuite(suite, { electron, fixtures }) {
  const script = path.join(SUITES_DIR, `${suite.name}.js`);
  const log = path.join(OUTPUT, `${suite.name}.log`);
  const png = path.join(OUTPUT, `${suite.name}.png`);
  fs.rmSync(png, { force: true });
  // The window is never shown in test mode: keep Chromium from throttling its timers and rendering.
  const args = ['.', '--mide-test', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
  // GitHub's Ubuntu runners can't use Chromium's sandbox (no SUID helper, user namespaces restricted).
  if (IS_LINUX && process.env.CI) args.push('--no-sandbox');
  if (suite.project) args.push(path.join(fixtures, suite.project));
  const env = {
    ...process.env,
    MINIMIDE_HOME: path.join(fixtures, suite.home),
    MINIMIDE_SCREENSHOT: png,
    MINIMIDE_EVAL: script,
    MINIMIDE_SCREENSHOT_DELAY: String(suite.delay ?? 2500),
    MINIMIDE_WINDOW: '1440x900',
    // Suites trust every folder unless they test workspace trust itself.
    ...(suite.trust === false ? {} : { MINIMIDE_TRUST_ALL: '1' }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MINIMIDE_FRAMES;
  delete env.MINIMIDE_PROJECT;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electron, args, { cwd: REPO, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, (suite.timeout ?? 120) * 1000);
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Electron may leave helpers (e.g. a stuck pty) behind; make sure the group is gone.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      fs.writeFileSync(log, output);
      const seconds = (Date.now() - started) / 1000;
      const lines = output.split(/\r?\n/);
      const evalLine = lines.find((l) => l.startsWith('[eval] '));
      const evalError = lines.find((l) => l.startsWith('[eval error]'));
      const exit = signal ? `signal ${signal}` : code ? `exit code ${code}` : null;
      const base = { seconds, log };
      if (spawnError) return resolve({ ...base, status: 'FAIL', failures: [`could not start Electron: ${spawnError.message}`] });
      if (timedOut) return resolve({ ...base, status: 'FAIL', failures: [`timed out after ${suite.timeout ?? 120}s${evalLine ? ' (after the script finished)' : ''}`] });
      if (evalError) return resolve({ ...base, status: 'FAIL', failures: [evalError] });
      if (!evalLine) return resolve({ ...base, status: 'FAIL', failures: [`no [eval] output (${exit || 'exited normally'}); see ${path.relative(REPO, log)}`] });
      let result;
      try { result = JSON.parse(evalLine.slice('[eval] '.length)); } catch (err) {
        return resolve({ ...base, status: 'FAIL', failures: [`unparseable [eval] output: ${err.message}`] });
      }
      const { failures, known, fixed } = check(suite, result, runEnv);
      // A crash after the script reported is an app problem worth seeing, but the checks still count.
      const notes = [...known, ...fixed, ...(exit ? [`app ${exit} after the script finished`] : [])];
      resolve({ ...base, status: failures.length ? 'FAIL' : 'PASS', failures, notes, result });
    });
  });
}

// ---------------------------------------------------------------------------
// Main

const runEnv = { has };

function selectSuites(names) {
  if (!names.length) return SUITES;
  const unknown = names.filter((n) => !SUITES.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`Unknown suite(s): ${unknown.join(', ')}. Available: ${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const want = new Set(names);
  // Pull in dependencies (e.g. sessionRestore needs sessionSave to run first).
  for (const s of SUITES) if (want.has(s.name) && s.dependsOn) want.add(s.dependsOn);
  return SUITES.filter((s) => want.has(s.name));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const suites = selectSuites(argv.filter((a) => !a.startsWith('--')));

  // Linux without a display: re-run ourselves under a virtual X server when one is available.
  if (IS_LINUX && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    if (has('xvfb-run') && !process.env.MINIMIDE_TEST_XVFB) {
      const r = spawnSync('xvfb-run', ['-a', '--server-args=-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, MINIMIDE_TEST_XVFB: '1' } });
      process.exit(r.status ?? 1);
    }
    console.error('No DISPLAY: run the tests under a virtual X server, e.g. `xvfb-run -a npm test`.');
    process.exit(2);
  }

  if (!flags.has('--no-build')) {
    console.log('Building…');
    const r = spawnSync(process.execPath, ['build.mjs'], { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr + '\nBuild failed.'); process.exit(1); }
  }

  // The electron package resolves (and on first use downloads) the binary for this platform.
  const electron = createRequire(import.meta.url)('electron');
  const fixtures = createFixtures();
  fs.mkdirSync(OUTPUT, { recursive: true });
  console.log(`Fixtures: ${fixtures}\nOutput:   ${path.relative(REPO, OUTPUT)}/\n`);

  const rows = [];
  for (const suite of suites) {
    const missing = (suite.requires || []).filter((cmd) => !has(cmd));
    if (missing.length) {
      rows.push({ suite, status: 'SKIP', seconds: 0, failures: [], notes: [`${missing.join(', ')} not on PATH`] });
      console.log(`SKIP  ${suite.name}: ${missing.join(', ')} not on PATH`);
      continue;
    }
    const dep = suite.dependsOn && rows.find((r) => r.suite.name === suite.dependsOn);
    if (dep && dep.status !== 'PASS') {
      rows.push({ suite, status: 'FAIL', seconds: 0, failures: [`${suite.dependsOn} did not pass`], notes: [] });
      console.log(`FAIL  ${suite.name}: ${suite.dependsOn} did not pass`);
      continue;
    }
    process.stdout.write(`run   ${suite.name}… `);
    const r = await runSuite(suite, { electron, fixtures });
    rows.push({ suite, ...r });
    console.log(`${r.status} (${r.seconds.toFixed(1)}s)`);
    for (const f of r.failures) console.log(`        ✗ ${f}`);
    for (const n of r.notes || []) console.log(`        ! ${n}`);
  }

  const w = Math.max(...rows.map((r) => r.suite.name.length), 5);
  console.log(`\n${pad('Suite', w)}  Result  Time    Notes`);
  console.log(`${'-'.repeat(w)}  ------  ------  ${'-'.repeat(30)}`);
  for (const r of rows) {
    const notes = [...(r.failures.length ? [`${r.failures.length} failed check(s)`] : []), ...(r.notes || [])].join('; ');
    console.log(`${pad(r.suite.name, w)}  ${pad(r.status, 6)}  ${pad(r.seconds ? r.seconds.toFixed(1) + 's' : '-', 6)}  ${notes}`);
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);

  const failed = count('FAIL') > 0;
  if (failed || flags.has('--keep')) console.log(`Fixtures kept in ${fixtures}`);
  else fs.rmSync(fixtures, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
