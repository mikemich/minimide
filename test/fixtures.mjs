// Builds every fixture project and user home the end-to-end suites need, in a fresh temp dir.
// Node port of the old fixtures.sh: no bash, sed or python needed, only `git` on PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A small committed PNG (256 x 256) used wherever a fixture needs an image. */
export const ICON = path.join(REPO, 'docs/icon.png');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitInit(dir, name, email) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', email);
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

/** `qa`: odd file names, line endings, a binary file and a hostile README (handsOn, session suites). */
function qa(root) {
  const d = path.join(root, 'qa');
  gitInit(d, 'QA', 'qa@example.com');
  write(path.join(d, 'crlf.txt'), 'line one\r\nline two\r\n');
  write(path.join(d, 'my file ü.txt'), 'needle üñí here\n');
  write(path.join(d, "it's here.py"), 'print("quoted ok")\n');
  write(path.join(d, 'data.bin'), Buffer.from([0, 1, 2, ...Buffer.from('binary')]));
  write(path.join(d, 'sub/gone.txt'), 'temp\n');
  write(path.join(d, 'replace-me.txt'), 'alpha beta\n');
  write(path.join(d, 'replace-open.txt'), 'alpha gamma\n');
  write(path.join(d, 'README.md'), [
    '# XSS test',
    '<img src=x onerror="window.__xss=1">',
    '<script>window.__xss=2</script>',
    '[bad link](javascript:window.__xss=3)',
    '<a href="#" onclick="window.__xss=4">click</a>',
    '',
  ].join('\n'));
  fs.copyFileSync(ICON, path.join(d, 'image.png'));
  commitAll(d, 'init');
}

/** `p4`: images, a long nested class and a repo with staged/unstaged/untracked changes (newPackages). */
function p4(root) {
  const d = path.join(root, 'p4');
  gitInit(d, 'Ada Lovelace', 'ada@example.com');
  fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
  fs.copyFileSync(ICON, path.join(d, 'assets/logo.png'));
  write(path.join(d, 'assets/dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#ff7ab2"/></svg>\n');
  const lines = ['class Inventory {', '  constructor(items) {', '    this.items = items;', '  }', '', '  summarize(filter) {', '    const totals = {};', '    for (const item of this.items) {', '      if (filter(item)) {'];
  for (let i = 0; i < 60; i++) lines.push(`        totals[item.group${i}] = (totals[item.group${i}] ?? 0) + item.value * ${i};`);
  lines.push('      }', '    }', '    return totals;', '  }', '}', '');
  write(path.join(d, 'inventory.js'), lines.join('\n'));
  write(path.join(d, 'notes.md'), '# Notes\n\nFirst draft.\n');
  commitAll(d, 'Initial commit');
  write(path.join(d, 'notes.md'), '# Notes\n\nSecond draft, with edits.\n\nMore text.\n');
  write(path.join(d, 'new.js'), 'export const x = 1;\n');
  const inv = path.join(d, 'inventory.js');
  fs.writeFileSync(inv, fs.readFileSync(inv, 'utf8').replace('this.items = items;', 'this.items = items ?? [];'));
  git(d, 'add', 'inventory.js');
}

/** `ts space`: a TypeScript project whose paths contain spaces, non-ASCII and parentheses (lspPaths). */
function tsSpace(root) {
  const d = path.join(root, 'ts space');
  write(path.join(d, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
  write(path.join(d, 'src ü (app)/my lib.ts'), 'export function greetUser(name: string): string {\n  return "hi " + name;\n}\n');
  write(path.join(d, 'src ü (app)/main app.ts'), 'import { greetUser } from "./my lib";\nconst n: number = greetUser("x");\n');
  write(path.join(d, 'app (auth)/page.ts'), 'export const ok: number = "no";\n');
  write(path.join(d, 'src ü (app)/needs import.ts'), 'export const y = greetUser("a");\n');
}

/** `corep` + `coreh`: a user package with a chord and a hot-reloadable module, plus init.js (core). */
function core(root) {
  const p = path.join(root, 'corep');
  write(path.join(p, 'a.txt'), 'hello   \nworld');
  write(path.join(p, 'sub/deep.js'), 'x');
  const h = path.join(root, 'coreh');
  write(path.join(h, 'init.js'), "export default function (mide) { mide.commands.add('me:x', 'X', () => {}); window.__init = mide.package.name; }\n");
  const pkg = path.join(h, 'packages/hello');
  write(path.join(pkg, 'package.json'), '{ "name": "hello", "main": "index.js", "keymap": { "Mod-k Mod-h": "hello:hi" } }\n');
  write(path.join(pkg, 'lib.js'), "export const greet = () => 'hi!';\n");
  write(path.join(pkg, 'index.js'), [
    "import { greet } from './lib.js';",
    'export function activate(mide) {',
    '  window.__hello = (window.__hello || 0) + 1;',
    "  mide.commands.add('hello:hi', 'Hi', () => { window.__hi = greet(); });",
    '}',
    '',
  ].join('\n'));
}

/** `qb`: files for the regression checks fixed after the QA pass (regressions). */
function qb(root) {
  const d = path.join(root, 'qb');
  gitInit(d, 'QA', 'qa@example.com');
  write(path.join(d, 'lines.txt'), 'one two\nthree four\n');
  write(path.join(d, 'price.txt'), 'cost: 10\n');
  write(path.join(d, 'target.txt'), 'old target\n');
  write(path.join(d, 'gone.txt'), 'soon deleted\n');
  write(path.join(d, 'doc.md'), '# T\n![remote](https://example.com/x.png)\n[s](#t)\n');
  fs.copyFileSync(ICON, path.join(d, 'pic.png'));
  commitAll(d, 'init');
}

/** `rproj`: programs for the runner and a package.json task (terminal). */
function rproj(root) {
  const d = path.join(root, 'rproj');
  write(path.join(d, 'hello.py'), 'name = input("What\'s your name? ")\nprint(f"Hello, {name}! 2+2={2+2}")\n');
  write(path.join(d, 'calc.c'), '#include <stdio.h>\nint main(void) { printf("C says %d\\n", 6 * 7); return 0; }\n');
  write(path.join(d, 'loop.py'), 'import time\nwhile True:\n    time.sleep(0.2)\n');
  write(path.join(d, 'package.json'), '{ "name": "demo", "scripts": { "greet": "echo task-ran-ok", "slow": "echo beginning-$$ && sleep 4", "boom": "echo boom && exit 3" } }\n');
}

/** `sbx`: a project, a secret folder beside it (linked from inside it) and three packages to install. */
function sbx(root) {
  const d = path.join(root, 'sbx');
  write(path.join(d, 'proj/notes.txt'), 'hello world from the project\n');
  write(path.join(d, 'secret/passwd.txt'), 'top secret\n');
  fs.symlinkSync('../secret', path.join(d, 'proj/link-out'));
  fs.cpSync(path.join(REPO, 'test/fixtures/packages'), d, { recursive: true });
}

/** `evilrepo`: a repository whose .git/config would run a command on `git status` (core.fsmonitor). */
function evilrepo(root) {
  const d = path.join(root, 'evilrepo');
  gitInit(d, 'Mallory', 'mallory@example.com');
  write(path.join(d, 'a.txt'), 'hello\n');
  write(path.join(d, 'main.ts'), 'export const x: number = 1;\n');
  commitAll(d, 'init');
  write(path.join(d, 'a.txt'), 'hello, changed\n');
  // Leaves a marker file if git ever runs the repo's fsmonitor command.
  git(d, 'config', 'core.fsmonitor', `echo PWNED >> '${path.join(root, 'evilrepo-marker.txt')}'; false`);
}

/** `large`: 55,000 source files (more than the old 50,000-file cap) and an ignored node_modules. */
function large(root) {
  const d = path.join(root, 'large');
  for (let a = 0; a < 110; a++) {
    const dir = path.join(d, 'src', `mod${a}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let c = 0; c < 500; c++) {
      fs.writeFileSync(path.join(dir, `file${c}.js`), `export const v${c} = ${a};\n${c % 50 === 0 ? 'const needle = true;\n' : ''}`);
    }
  }
  for (let a = 0; a < 5; a++) {
    const dir = path.join(d, 'node_modules', `pkg${a}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let c = 0; c < 1000; c++) fs.writeFileSync(path.join(dir, `f${c}.js`), 'const needle = 1;\n');
  }
}

/** `chproj`: a long file and a short one, for back / forward, the editor menu and the cheat sheet (codingHelp). */
function chproj(root) {
  const d = path.join(root, 'chproj');
  write(path.join(d, 'long.js'), Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  write(path.join(d, 'notes.txt'), 'one\ntwo\nthree\n');
}

/** `emproj`: a long Markdown file (preview scroll sync) and files for Emmet in HTML, CSS and JS. */
function emproj(root) {
  const d = path.join(root, 'emproj');
  const sections = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\n${'Some words that make a paragraph. '.repeat(12)}\n\n- item a\n- item b\n`);
  write(path.join(d, 'long.md'), `# Long document\n\n${sections.join('\n')}`);
  write(path.join(d, 'page.html'), '<!doctype html>\n<html>\n<body>\n  \n</body>\n</html>\n');
  write(path.join(d, 'style.css'), 'a {\n  \n}\n');
  write(path.join(d, 'style.scss'), '.a {\n  \n}\n');
  write(path.join(d, 'view.jsx'), 'export const A = () => (\n  <div>\n    \n  </div>\n);\nconst x = 1;\n');
  write(path.join(d, 'app.js'), 'const x = 1;\n');
  write(path.join(d, 'notes.txt'), 'plain\n');
}

/** `cimproj`: a small module, a long file, Markdown (one with a space in its name) and plain text (codeImage). */
function cimproj(root) {
  const d = path.join(root, 'cimproj');
  write(path.join(d, 'main.js'), [
    '// A tiny module',
    "import { readFile } from 'node:fs/promises';",
    '',
    'export async function load(path) {',
    "  const text = await readFile(path, 'utf8');",
    "  return text.split('\\n').map((line, i) => ({ line, n: i + 1, ok: /\\S/.test(line) }));",
    '}',
    '',
  ].join('\n'));
  write(path.join(d, 'long.js'), Array.from({ length: 250 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  write(path.join(d, 'notes.md'), '# Notes\n\nteh quick brown fox\n');
  write(path.join(d, 'my notes.md'), '# My notes\n');
  write(path.join(d, 'plain.txt'), 'just some words\n');
}

/** `aiproj`: a small JavaScript project for the AI package (ai). */
function aiproj(root) {
  const d = path.join(root, 'aiproj');
  write(path.join(d, 'src/calc.js'), [
    'export function add(a, b) {',
    '  ',
    '}',
    'const items = [1, 2, 3];',
    'let total = 0;',
    'for (const x of items) total += x;',
    'console.log(total);',
    '',
  ].join('\n'));
}

/** `ftproj`: one small file per extra file type, plus a shell script for completion. */
function ftproj(root) {
  const d = path.join(root, 'ftproj');
  write(path.join(d, 'test.sh'), 'nsr1=x\nip -net "$nsr1" link\n\n');
  write(path.join(d, 'Makefile'), 'CC := gcc\nall: main.o\n\t@$(CC) -o $@ $^\n');
  write(path.join(d, 'rules.nft'), 'table inet f {\n  chain fwd { ct state established meta l4proto gre flow add @f }\n}\n');
  write(path.join(d, 'app.log'), '2026-10-26 10:00:01 ERROR boom\n');
  write(path.join(d, 'data.csv'), 'a,b\n1,2\n');
  write(path.join(d, '.zshrc'), 'export PATH=$HOME/bin:$PATH\n');
  write(path.join(d, '.gitignore'), 'node_modules/\n');
  write(path.join(d, 'main.tf'), 'resource "x" "y" {}\n');
  write(path.join(d, '.env'), 'KEY=value\n');
}

/** `extras`: a Markdown file of exactly 1,234 words, a text file and a JS file with brackets (editorExtras). */
function extras(root) {
  const d = path.join(root, 'extras');
  const words = Array.from({ length: 1234 }, (_, i) => `word${i + 1}`);
  const lines = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(' '));
  write(path.join(d, 'notes.md'), lines.join('\n') + '\n');
  write(path.join(d, 'plain.txt'), 'one two three\n');
  // Line 1 is the nested example; the strings and comments hold brackets that must not count.
  // The long run of lines pushes the closing "]})" far below the first screen.
  const code = ['const a = ({[ ]});', 'const s = "([{";', '// ( [ {', '/* ) ] } */', 'const list = ({['];
  for (let i = 0; i < 150; i++) code.push('  0,');
  code.push(']});');
  write(path.join(d, 'code.js'), code.join('\n') + '\n');
}

/**
 * `ghproj`: a repository with history for gitHistory: an initial commit, 450 small commits made with
 * fast-import (for paging), a rename (for --follow), a branch merged with a merge commit, a tag,
 * an unmerged branch to cherry-pick from, commits by a second author and a stash. Commit dates go
 * up one minute per commit so the order is fixed. `ghuntrusted` is a repository nobody trusted;
 * the home `ghh` trusts only ghproj.
 */
function ghproj(root) {
  const d = path.join(root, 'ghproj');
  gitInit(d, 'Ada Lovelace', 'ada@example.com');
  let t = 1700000000;
  const at = (...args) => {
    t += 60;
    execFileSync('git', args, { cwd: d, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` } });
  };
  const commit = (message, author) => { git(d, 'add', '-A'); at(...(author ? ['-c', `user.name=${author}`, '-c', 'user.email=grace@example.com'] : []), 'commit', '-qm', message); };
  const lines = (name) => Array.from({ length: 10 }, (_, i) => `export const line${i + 1} = '${i === 0 ? name : `value ${i + 1}`}';`).join('\n') + '\n';
  write(path.join(d, 'README.md'), '# History\n');
  write(path.join(d, 'src/old-name.js'), lines('old'));
  commit('Initial commit');
  // 450 commits in one go: fast-import writes them without touching the working tree.
  let stream = '';
  const blob = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  for (let n = 1; n <= 450; n++) {
    t += 60;
    const who = n % 100 === 0 ? 'Grace Hopper <grace@example.com>' : 'Ada Lovelace <ada@example.com>';
    stream += `commit refs/heads/master\nauthor ${who} ${t} +0000\ncommitter ${who} ${t} +0000\n${blob(`Bump counter to ${n}`)}`
      + (n === 1 ? 'from refs/heads/master^0\n' : '') + `M 100644 inline counter.txt\n${blob(`${n}\n`)}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: d, input: stream, stdio: ['pipe', 'pipe', 'pipe'] });
  git(d, 'reset', '-q', '--hard');
  write(path.join(d, 'src/old-name.js'), lines('older'));
  commit('Edit old name');
  git(d, 'mv', 'src/old-name.js', 'src/app.js');
  write(path.join(d, 'src/app.js'), lines('app'));
  commit('Rename old-name.js to app.js');
  git(d, 'checkout', '-q', '-b', 'feature');
  write(path.join(d, 'feature.txt'), 'one\ntwo\nthree\n');
  commit('Add feature work');
  git(d, 'checkout', '-q', 'master');
  write(path.join(d, 'README.md'), '# History\n\nMaster work.\n');
  commit('Master work');
  at('merge', '-q', '--no-ff', 'feature', '-m', "Merge branch 'feature'");
  at('tag', '-a', 'v1.0', '-m', 'Version 1.0');
  git(d, 'checkout', '-q', '-b', 'pick-me');
  write(path.join(d, 'pick.txt'), 'picked\n');
  commit('Add pick.txt');
  git(d, 'checkout', '-q', 'master');
  write(path.join(d, 'src/app.js'), lines('tuned'));
  commit('Tune app name');
  write(path.join(d, 'notes.txt'), 'widget\n');
  commit('Fix the widget\n\nThe widget was upside down.\nNow it is not.', 'Grace Hopper');
  write(path.join(d, 'notes.txt'), 'widget\nfinal\n');
  commit('Final tweak');
  write(path.join(d, 'README.md'), '# History\n\nMaster work.\nstashed line\n');
  at('stash', 'push', '-q', '-m', 'fixture stash');
  const u = path.join(root, 'ghuntrusted');
  gitInit(u, 'Mallory', 'mallory@example.com');
  write(path.join(u, 'u.txt'), 'untrusted\n');
  commitAll(u, 'Untrusted commit');
  write(path.join(root, 'ghh/trusted-folders.json'), JSON.stringify({ folders: [{ path: d, real: d }] }, null, 2) + '\n');
  // `ghshim/git` logs where every git command runs (then runs the real git): the suite puts it first
  // on PATH to show that nothing runs git in ghuntrusted.
  const real = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git')).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  if (process.platform !== 'win32' && real) {
    const shim = path.join(root, 'ghshim');
    write(path.join(shim, 'git'), `#!/bin/sh\necho "$(pwd -P) $*" >> '${shim}/calls.log'\nexec '${real}' "$@"\n`);
    fs.chmodSync(path.join(shim, 'git'), 0o755);
  }
}

/** `lhproj`: small files, some that local history must skip, and a folder to rename (localHistory). */
function lhproj(root) {
  const d = path.join(root, 'lhproj');
  write(path.join(d, 'notes.txt'), 'alpha\n');
  write(path.join(d, 'small.txt'), 'small\n');
  write(path.join(d, 'big.txt'), 'big\n');
  write(path.join(d, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  write(path.join(d, 'gen.min.js'), 'var a=1;\n');
  write(path.join(d, 'vendorx/lib.txt'), 'vendored\n');
  write(path.join(d, 'x.tmp'), 'temp\n');
  write(path.join(d, 'drafts/a.md'), '# draft\n');
  write(path.join(d, 'prune.txt'), 'p0\n');
  write(path.join(d, 'gone.txt'), 'gone original\n');
  write(path.join(d, 'ren.txt'), 'ren original\n');
  write(path.join(d, 'olddir/inner.txt'), 'inner original\n');
  write(path.join(d, 'ext.txt'), 'ext original\n');
  write(path.join(d, 'crlf.txt'), 'one\r\n');
  // A link inside the history folder that leads out of it: deletes must not follow it.
  write(path.join(root, 'lh-outside/victim.txt'), 'keep me\n');
  fs.mkdirSync(path.join(root, 'lhh/history'), { recursive: true });
  fs.symlinkSync(path.join(root, 'lh-outside'), path.join(root, 'lhh/history/escape'), 'junction');
}

/**
 * `mcproj`: a real repository in the middle of a merge. `master` and `feature` edited the same
 * lines, so a real merge of `feature` left conflict markers (mergeConflicts):
 *   app.js (2 conflicts), three.txt (3), crlf.txt (CRLF, 1), diff3.txt (diff3 style, with a base section),
 *   resolve.txt (1; the suite resolves it by hand and stages it).
 * `clean.txt` merged without a conflict. `tricky.txt` is untracked and only looks like it has markers
 * (indented markers, a marker inside a string, a block that never closes) plus one real conflict.
 */
function mcproj(root) {
  const d = path.join(root, 'mcproj');
  gitInit(d, 'Merge', 'merge@example.com');
  git(d, 'config', 'core.autocrlf', 'false');
  const base = {
    'app.js': ['// app', 'function a() {', '  return 1;', '}', "const mid = 'middle';", '// padding 1', '// padding 2', '// padding 3', '// padding 4', '// padding 5', 'function b() {', '  return 2;', '}', '// end', ''].join('\n'),
    'three.txt': ['head', 'one', ...Array.from({ length: 6 }, (_, i) => `gap a${i}`), 'two', ...Array.from({ length: 6 }, (_, i) => `gap b${i}`), 'three', 'tail', ''].join('\n'),
    'crlf.txt': 'first\r\nsecond\r\nthird\r\n',
    'diff3.txt': 'x\nbase value\ny\n',
    'resolve.txt': 'keep\nchange me\nkeep too\n',
    'clean.txt': 'top\nmiddle\nbottom\n',
  };
  for (const [name, text] of Object.entries(base)) write(path.join(d, name), text);
  commitAll(d, 'base');
  const edit = (side) => {
    for (const [name, text] of Object.entries(base)) {
      let next = text;
      if (name === 'app.js') next = text.replace('return 1;', `return ${side === 'ours' ? 10 : 100};`).replace('return 2;', `return ${side === 'ours' ? 20 : 200};`);
      else if (name === 'three.txt') next = text.replace('one', `one ${side}`).replace('two', `two ${side}`).replace('three', `three ${side}`);
      else if (name === 'crlf.txt') next = text.replace('second', `second ${side}`);
      else if (name === 'diff3.txt') next = text.replace('base value', `${side} value`);
      else if (name === 'resolve.txt') next = text.replace('change me', `${side} changed it`);
      else if (name === 'clean.txt' && side === 'theirs') next = text.replace('bottom', 'bottom edited');
      write(path.join(d, name), next);
    }
    commitAll(d, `${side} edits`);
  };
  git(d, 'checkout', '-q', '-b', 'feature');
  edit('theirs');
  git(d, 'checkout', '-q', 'master');
  edit('ours');
  try { git(d, '-c', 'merge.conflictStyle=merge', 'merge', '--no-edit', 'feature'); } catch { /* the conflicts are the point */ }
  git(d, 'checkout', '--conflict=diff3', '--', 'diff3.txt');
  write(path.join(d, 'tricky.txt'), [
    'const note = "<<<<<<< not a marker";',
    '  <<<<<<< indented, so not a marker',
    '  ======= neither is this',
    '<<<<<<<not a marker either, no space',
    '<<<<<<< lost',
    'this block never closes',
    '<<<<<<< HEAD',
    'current',
    '=======',
    'incoming',
    '>>>>>>> topic',
    'after',
    '',
  ].join('\n'));
}

/**
 * `outlineproj`: symbols in JavaScript, Markdown, Python, CSS and JSON (from the syntax tree) and a
 * TypeScript file served by the fake language server (test/fake-lsp.mjs), which the `outlineh` home
 * configures in place of typescript-language-server (outline).
 */
function outlineproj(root) {
  const d = path.join(root, 'outlineproj');
  write(path.join(d, 'src/app.js'), [
    'export class Cart {',
    '  constructor() {',
    '    this.items = [];',
    '  }',
    '  add(item) {',
    '    this.items.push(item);',
    '  }',
    '  total() {',
    '    return this.items.reduce((sum, item) => sum + item.price, 0);',
    '  }',
    '}',
    '',
    'export function checkout(cart) {',
    '  const amount = cart.total();',
    '  return amount;',
    '}',
    '',
    'export const format = (n) => `$${n.toFixed(2)}`;',
    '',
    'const config = {',
    "  currency: 'USD',",
    '  round(n) { return Math.round(n); },',
    '};',
    '',
  ].join('\n'));
  write(path.join(d, 'notes.md'), [
    '# Guide', '', 'Intro text.', '', '## Install', '', 'Steps here.', '', '### From source', '', 'Build it.', '',
    '```sh', '# not a heading', '```', '', '## Usage', '', 'Run it.', '', '# Appendix', '', 'The end.', '',
  ].join('\n'));
  write(path.join(d, 'tool.py'), [
    'class Greeter:', '    def __init__(self, name):', '        self.name = name', '', '    def greet(self):', '        return "hi " + self.name',
    '', '', 'def main():', '    Greeter("x").greet()', '', '', 'VERSION = "1.0"', '',
  ].join('\n'));
  write(path.join(d, 'style.css'), 'body { margin: 0; }\n.card, .panel > h2 {\n  color: red;\n}\n@media (max-width: 600px) {\n  .card { padding: 0; }\n}\n');
  write(path.join(d, 'data.json'), '{\n  "name": "demo",\n  "scripts": { "build": "x", "test": "y" },\n  "tags": ["a"]\n}\n');
  write(path.join(d, 'shapes.ts'), [
    '// Shapes, served by the fake language server.',
    'export class Circle {',
    '  radius = 1;',
    '  constructor(r: number) {',
    '    this.radius = r;',
    '  }',
    '  area() {',
    '    return Math.PI * this.radius * this.radius;',
    '  }',
    '}',
    '',
    'function scale(value: number, factor: number) {',
    '  return value * factor;',
    '}',
    '',
    'const big = scale(10, 3);',
    'const size = 42;',
    '',
  ].join('\n'));
  // The fake server stands in for TypeScript (.ts only, so app.js keeps the syntax-tree symbols).
  const home = path.join(root, 'outlineh');
  write(path.join(home, 'config.json'), JSON.stringify({
    core: { theme: 'nightfall' },
    lsp: { servers: { typescript: { command: [process.execPath, path.join(REPO, 'test/fake-lsp.mjs'), path.join(home, 'fake-lsp.json')], extensions: ['ts'] } } },
  }, null, 2) + '\n');
}

/**
 * `fpoproj`: a repository in the middle of a merge (conflict.txt), with files for every feature package
 * to act on: app.js (symbols from the syntax), shapes.ts (the fake language server: symbols and inlay
 * hints), notes.txt (bookmarks, local history) and check.js (a task that prints a problem in app.js). The
 * `fpoh` home still has the settings that switched breadcrumbs off and inlay hints on before they were
 * packages (featurePackagesOff).
 */
function fpoproj(root) {
  const d = path.join(root, 'fpoproj');
  gitInit(d, 'Off Switch', 'off@example.com');
  write(path.join(d, 'app.js'), 'export class Cart {\n  total() {\n    return 1;\n  }\n}\n');
  write(path.join(d, 'shapes.ts'), 'function scale(value: number, factor: number) {\n  return value * factor;\n}\n\nconst big = scale(10, 3);\n');
  write(path.join(d, 'notes.txt'), Array.from({ length: 8 }, (_, i) => `note ${i + 1}`).join('\n') + '\n');
  write(path.join(d, 'check.js'), "console.log('app.js:2:3: error: from a task');\n");
  write(path.join(d, 'conflict.txt'), 'top\nshared\nbottom\n');
  commitAll(d, 'base');
  git(d, 'checkout', '-q', '-b', 'feature');
  write(path.join(d, 'conflict.txt'), 'top\ntheirs\nbottom\n');
  commitAll(d, 'theirs');
  git(d, 'checkout', '-q', 'master');
  write(path.join(d, 'conflict.txt'), 'top\nours\nbottom\n');
  commitAll(d, 'ours');
  try { git(d, '-c', 'merge.conflictStyle=merge', 'merge', '--no-edit', 'feature'); } catch { /* the conflict is the point */ }
  const home = path.join(root, 'fpoh');
  write(path.join(home, 'config.json'), JSON.stringify({
    core: { theme: 'nightfall' },
    outline: { breadcrumbs: false },
    lsp: { inlayHints: true, servers: { typescript: { command: [process.execPath, path.join(REPO, 'test/fake-lsp.mjs'), path.join(home, 'fake-lsp.json')], extensions: ['ts'] } } },
  }, null, 2) + '\n');
}

/**
 * `tpproj`: a project whose `check` task (report.js) prints compiler-like problems: for files in the
 * project, a missing one, one outside it that exists (`tp-outside.c`, beside the project) and one that
 * doesn't; other.js is a second task, run with F5. mode.txt switches report.js to a shorter report. The
 * `tph` home runs the fake language server (test/fake-lsp.mjs) for .ts files, which flags `lsp-error`
 * (taskProblems).
 */
function tpproj(root) {
  const d = path.join(root, 'tpproj');
  write(path.join(d, 'src/app.ts'), '// lsp-error is flagged by the fake server\nconst n: number = "x";\nfunction f() {\n  let unused = 1;\n}\n');
  write(path.join(d, 'lib/util.c'), 'int x = 1\nint y = 2;\n');
  write(path.join(root, 'tp-outside.c'), 'int a;\nint b;\n');
  write(path.join(d, 'report.js'), [
    '// Prints problems the way compilers do. mode.txt says which report.',
    "const fs = require('fs');",
    "const path = require('path');",
    "const mode = fs.existsSync('mode.txt') ? fs.readFileSync('mode.txt', 'utf8').trim() : 'full';",
    'const red = (s) => `\\x1b[1;31m${s}\\x1b[0m`;',
    "if (mode === 'full') {",
    "  console.log('Checking 3 files...');",
    "  console.log(`src/app.ts(2,7): ${red('error')} TS2322: Type 'string' is not assignable to type 'number'.`);",
    '  console.log("src/app.ts:4:7: warning: unused variable \'unused\' [-Wunused-variable]");',
    '  console.error("lib/util.c:1:10: error: expected \';\' after top level declarator");',
    "  console.log(`${path.resolve('..', 'tp-outside.c')}:2:5: warning: outside the project, but there`);",
    "  console.log('/nowhere/at/all/gone.c:3:1: error: outside the project and missing');",
    "  console.log('missing/inside.c:7: error: in the project, not written yet');",
    "  console.log('CHECK lib/util.c#2 a format of my own');",
    '  process.exit(1);',
    '}',
    "console.log('lib/util.c:2:5: warning: only this one now');",
    '',
  ].join('\n'));
  write(path.join(d, 'other.js'), "console.log('src/app.ts:3:10: warning: from the other task');\n");
  const home = path.join(root, 'tph');
  write(path.join(home, 'config.json'), JSON.stringify({
    core: { theme: 'nightfall' },
    runner: { tasks: { check: 'node report.js' } },
    // clangd, when installed, would flag util.c too.
    lsp: { servers: { typescript: { command: [process.execPath, path.join(REPO, 'test/fake-lsp.mjs'), path.join(home, 'fake-lsp.json')], extensions: ['ts'] }, c: { disabled: true } } },
  }, null, 2) + '\n');
}

/** `dbgproj`: the same small program in JavaScript and Python, to step through (debugger). */
function dbgproj(root) {
  const d = path.join(root, 'dbgproj');
  write(path.join(d, 'app.js'), 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nlet total = 0;\nfor (let i = 1; i <= 3; i++) {\n  total = add(total, i);\n}\nconsole.log(\'total is\', total);\n');
  write(path.join(d, 'app.py'), 'def add(a, b):\n    total = a + b\n    return total\n\nresult = 0\nfor i in range(1, 4):\n    result = add(result, i)\nprint("result is", result)\n');
}

/** `bmproj`: a few small files to bookmark lines in, move around and rename (bookmarks, bookmarksRestore). */
function bmproj(root) {
  const d = path.join(root, 'bmproj');
  const lines = (name, n) => Array.from({ length: n }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n';
  write(path.join(d, 'a.txt'), lines('alpha', 12));
  write(path.join(d, 'b.txt'), lines('bravo', 8));
  write(path.join(d, 'c.txt'), lines('charlie', 6));
  write(path.join(d, 'moved.txt'), lines('moved', 6));
  write(path.join(d, 'sub/inner.txt'), lines('inner', 5));
  write(path.join(d, 'ext.txt'), lines('ext', 8));
}

/** `vsc`: a fake VS Code folder (User/ and extensions/) for "Import from VS Code" (vscodeImport). */
function vsc(root) {
  const d = path.join(root, 'vsc');
  const cmdKey = process.platform === 'darwin' ? 'cmd' : 'ctrl';
  write(path.join(d, 'User/settings.json'), [
    '{',
    '  // my editor',
    '  "editor.fontSize": 17,',
    '  "editor.tabSize": 3,',
    '  "editor.insertSpaces": false,',
    '  "editor.wordWrap": "on",',
    '  "editor.minimap.enabled": false, /* too busy */',
    '  "editor.stickyScroll.enabled": false,',
    '  "editor.fontFamily": "\'Fira Code\', Menlo, monospace",',
    '  "editor.lineHeight": 22,',
    '  "files.autoSave": "afterDelay",',
    '  "workbench.colorTheme": "Fixture Night",',
    '  "terminal.integrated.fontSize": 13,',
    '  "workbench.iconTheme": "material-icon-theme",',
    '}',
    '',
  ].join('\n'));
  write(path.join(d, 'User/keybindings.json'), [
    '// Place your key bindings in this file',
    '[',
    '  { "key": "alt+shift+j", "command": "workbench.action.togglePanel" },',
    `  { "key": "${cmdKey}+s", "command": "-workbench.action.files.save" },`,
    '  { "key": "alt+shift+q", "command": "someExtension.doThing" },',
    '  { "key": "alt+shift+w", "command": "workbench.action.togglePanel", "args": { "x": 1 } },',
    '  { "key": "alt+shift+l", "command": "workbench.action.closeActiveEditor", "when": "editorTextFocus" },',
    ']',
    '',
  ].join('\n'));
  write(path.join(d, 'User/snippets/javascript.json'), JSON.stringify({
    'Console log': { prefix: 'vslog', body: ['console.log($1);'], description: 'from vs code' },
    Arrow: { prefix: 'vsarrow', body: ['const ${1:name} = (${2}) => {', '\t$0', '};'] },
  }, null, 2));
  write(path.join(d, 'User/snippets/python.json'), '{\n  // comments are allowed\n  "Main guard": { "prefix": "vsmain", "body": ["if __name__ == \\"__main__\\":", "    main()"], },\n}\n');
  write(path.join(d, 'User/snippets/global.code-snippets'), JSON.stringify({ Todo: { scope: 'javascript,typescript', prefix: 'vstodo', body: ['// TODO: $1'] } }, null, 2));
  const ext = path.join(d, 'extensions/fixture.night-1.0.0');
  write(path.join(ext, 'package.json'), JSON.stringify({ name: 'night', publisher: 'fixture', version: '1.0.0', contributes: { themes: [{ label: 'Fixture Night', uiTheme: 'vs-dark', path: './themes/night.json' }] } }, null, 2));
  write(path.join(ext, 'themes/base.json'), '{\n  // shared by the theme\n  "colors": { "sideBar.background": "#161a24" },\n  "tokenColors": [{ "scope": "string", "settings": { "foreground": "#a5d6a7" } }]\n}\n');
  write(path.join(ext, 'themes/night.json'), JSON.stringify({
    name: 'Fixture Night', type: 'dark', include: './base.json',
    colors: { 'editor.background': '#1b1f2b', 'editor.foreground': '#d0d4e0', 'editorLineNumber.foreground': '#2a3042', 'activityBar.background': '#12151d' },
    tokenColors: [{ scope: 'comment', settings: { foreground: '#2d3345' } }, { scope: 'keyword', settings: { foreground: '#ff9e64' } }],
  }, null, 2));
}

/**
 * `remote`: a fake ssh (MINIMIDE_SSH_BIN) that runs the "remote" command locally in remote/server,
 * as if that were the remote home folder, plus a project there (remoteSsh). The host "pwhost"
 * asks for a password until it's logged in once without BatchMode; "down…" hosts can't be reached.
 */
export function remote(root) {
  const d = path.join(root, 'remote');
  write(path.join(d, 'fake-ssh'), [
    '#!/bin/sh',
    'here=$(cd "$(dirname "$0")" && pwd)',
    'batch=0; nocmd=0; control=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o) [ "$2" = BatchMode=yes ] && batch=1; shift 2 ;;',
    '    -O) control=$2; shift 2 ;;',
    '    -N) nocmd=1; shift ;;',
    '    --) shift; break ;;',
    '    -*) shift ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'host=$1; shift',
    'echo "$host ${control:+-O $control }$*" >> "$here/ssh.log"',
    '[ "$control" = check ] && exit 255',
    '[ -n "$control" ] && exit 0',
    'case "$host" in',
    '  pwhost)',
    '    if [ ! -f "$here/logged-in" ]; then',
    '      if [ $batch = 1 ]; then echo "pwhost: Permission denied (publickey,password)." >&2; exit 255; fi',
    '      touch "$here/logged-in"',
    '    fi ;;',
    '  down*) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;;',
    'esac',
    '[ $nocmd = 1 ] && exit 0',
    'cd "$here/server" && HOME="$here/server" exec sh -c "$*"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(d, 'fake-ssh'), 0o755);
  const p = path.join(d, 'server/proj');
  write(path.join(p, 'a.txt'), 'hello from the server\n');
  write(path.join(p, 'notes.md'), '# Notes\n');
  write(path.join(p, 'clash.txt'), 'original\n');
  write(path.join(p, 'clash2.txt'), 'original\n');
  write(path.join(p, 'sub dir/b c.txt'), 'in a folder with a space\n');
  write(path.join(p, "it's.txt"), 'quote in the name\n');
  write(path.join(p, 'docs/one.md'), 'one\n');
  write(path.join(p, 'docs/two.md'), 'two\n');
  write(path.join(p, 'old/name.txt'), 'renamed folder\n');
  write(path.join(p, 'gone.txt'), 'delete me\n');
  write(path.join(p, 'move-me.txt'), 'rename me\n');
  write(path.join(p, '.git/config'), '[core]\n');
  write(path.join(p, 'node_modules/m/index.js'), 'module.exports = 1;\n');
}

/**
 * `mr`: folders for one window (multiRoot, multiRootRestore): `alpha` (the project, no git),
 * `beta` (a repo with a modified and an untracked file) and `gamma` (a repo nobody trusted yet).
 * The home `mrh` trusts alpha and beta.
 */
function multiRoot(root) {
  const d = path.join(root, 'mr');
  write(path.join(d, 'alpha/main.txt'), 'shared-needle in alpha\n');
  write(path.join(d, 'alpha/src/app.js'), 'console.log("alpha");\n');
  const beta = path.join(d, 'beta');
  gitInit(beta, 'Beta', 'beta@example.com');
  write(path.join(beta, 'readme.md'), '# Beta\n');
  write(path.join(beta, 'lib/util.py'), 'def util():\n    return 1\n');
  commitAll(beta, 'init');
  write(path.join(beta, 'readme.md'), '# Beta\nshared-needle in beta\n');
  write(path.join(beta, 'new.txt'), 'untracked\n');
  const gamma = path.join(d, 'gamma');
  gitInit(gamma, 'Gamma', 'gamma@example.com');
  write(path.join(gamma, 'g.txt'), 'gamma\n');
  commitAll(gamma, 'init');
  write(path.join(gamma, 'g.txt'), 'gamma changed\n');
  // Another folder named beta, to add next to the first one.
  write(path.join(d, 'other/beta/twin.txt'), 'shared-needle in the other beta\n');
  const trusted = [path.join(d, 'alpha'), beta].map((p) => ({ path: p, real: p }));
  write(path.join(root, 'mrh/trusted-folders.json'), JSON.stringify({ folders: trusted }, null, 2) + '\n');
}

/** `ev`: files for the everyday-editing checks: encodings, line endings, long lines, code in several languages (everyday). */
function everyday(root) {
  const d = path.join(root, 'ev');
  gitInit(d, 'QA', 'qa@example.com');
  write(path.join(d, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom line\r\nsecond\r\n')]));
  write(path.join(d, 'bom.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "a": 1 }\n')]));
  write(path.join(d, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x0a])); // "café “q”" in windows-1252
  write(path.join(d, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi utf16\n', 'utf16le')]));
  write(path.join(d, 'oldmac.txt'), 'one\rtwo\rthree\r');
  write(path.join(d, 'mixed.txt'), 'a\r\nb\r\nc\nd\r\n');
  write(path.join(d, 'plain.txt'), 'alpha beta\nBeta beta gamma\nalphabet\n');
  write(path.join(d, 'code.js'), 'function f() {\n  return 1;\n}\n');
  write(path.join(d, 'style.css'), 'a {\n  color: red;\n}\n');
  write(path.join(d, 'page.html'), '<div>\n  <p>x</p>\n</div>\n');
  write(path.join(d, 'script.py'), 'def f():\n    return 1\n');
  write(path.join(d, 'conf.yml'), 'a: 1\nb: 2\n');
  write(path.join(d, 'run.sh'), 'echo hi\n');
  write(path.join(d, 'unterminated.txt'), 'no newline at end');
  write(path.join(d, 'sub/inner.txt'), 'inner\n');
  commitAll(d, 'init');
}

/**
 * Create all fixtures under `root` (default: a new dir in os.tmpdir()). Homes that need no
 * pre-seeded files are created empty: the app fills in its defaults on first launch.
 * Returns the root dir.
 */
export function createFixtures(root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimide-test-'))) {
  // Resolve symlinks (macOS /var -> /private/var) so paths match what the app reports.
  root = fs.realpathSync(root);
  qa(root);
  p4(root);
  tsSpace(root);
  core(root);
  qb(root);
  rproj(root);
  sbx(root);
  evilrepo(root);
  ftproj(root);
  chproj(root);
  emproj(root);
  large(root);
  extras(root);
  cimproj(root);
  dbgproj(root);
  lhproj(root);
  mcproj(root);
  ghproj(root);
  outlineproj(root);
  bmproj(root);
  fpoproj(root);
  tpproj(root);
  vsc(root);
  aiproj(root);
  remote(root);
  multiRoot(root);
  everyday(root);
  for (const home of ['qah', 'home3', 'qah2', 'sessh', 'qbh', 'termh', 'dialogh', 'sbxh', 'largeh', 'trusth', 'fth', 'chh', 'extrah', 'emh', 'cih', 'dbgh', 'vsih', 'sync1', 'sync2', 'aih', 'remoteh', 'lhh', 'pkgbh', 'outlineh', 'mch', 'bmh', 'evh', 'a11yh']) fs.mkdirSync(path.join(root, home), { recursive: true });
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node test/fixtures.mjs [dir]`: build the fixtures by hand, e.g. to debug a suite.
  const dir = process.argv[2];
  if (dir) fs.mkdirSync(dir, { recursive: true });
  console.log(createFixtures(dir || undefined));
}
