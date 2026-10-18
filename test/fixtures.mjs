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
  write(path.join(d, 'package.json'), '{ "name": "demo", "scripts": { "greet": "echo task-ran-ok" } }\n');
}

/** `sbx`: a project, a secret folder beside it (linked from inside it) and three packages to install. */
function sbx(root) {
  const d = path.join(root, 'sbx');
  write(path.join(d, 'proj/notes.txt'), 'hello world from the project\n');
  write(path.join(d, 'secret/passwd.txt'), 'top secret\n');
  fs.symlinkSync('../secret', path.join(d, 'proj/link-out'));
  fs.cpSync(path.join(REPO, 'test/fixtures/packages'), d, { recursive: true });
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
  large(root);
  for (const home of ['qah', 'home3', 'qah2', 'sessh', 'qbh', 'termh', 'dialogh', 'sbxh', 'largeh']) fs.mkdirSync(path.join(root, home), { recursive: true });
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node test/fixtures.mjs [dir]`: build the fixtures by hand, e.g. to debug a suite.
  const dir = process.argv[2];
  if (dir) fs.mkdirSync(dir, { recursive: true });
  console.log(createFixtures(dir || undefined));
}
