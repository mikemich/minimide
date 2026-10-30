// Test Explorer: finds the tests of each project folder (Jest, Vitest, node:test, pytest, Go),
// lists them as folder › file › suite › test, runs them with the framework's machine-readable
// reporter and shows the results in the view, beside each test in the editor and in the status
// bar, with each failure's message under its test. A syntax scan fills the view at once; in a
// trusted folder the framework's own list fills in what a scan can't see (each-cases,
// parametrized ids). Nothing runs in a folder you haven't trusted.
import { FRAMEWORKS, testFileKind, jsFramework, frameworkFromImports, nearestRoot, scanFor, PYTEST_MARKERS, PYTEST_MAYBE } from './discover.js';
import { runCommand, goRunCommand, listCommand, posixQuote, winQuote } from './frameworks.js';
import { parseJestJson, parseJunit, parseGoJson, parseVitestList, parseJestList, parsePytestCollect, parseGoList, stripAnsi, goModule } from './parse.js';
import { node, fileNode, find, walk, keyOf, statusOf, counts, plan, relative, nodeAtLine, failedTests } from './model.js';
import { editorParts } from './gutter.js';

const MAX_FILES = 2000; // test files read per folder
const MAX_BYTES = 512 * 1024; // larger files aren't scanned
const MAX_OUTPUT = 1024 * 1024; // characters kept in the output panel
const SEP = '\u0000';

export function activate(mide) {
  const { h, icon, registerIcon, fileIcon } = mide.ui;
  const ws = mide.workspace;
  const isWin = mide.user.platform === 'win32';
  const quote = isWin ? winQuote : posixQuote;
  registerIcon('beaker', '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 14h9"/>');
  registerIcon('check', '<path d="M5 12.5l4.5 4.5L19 7.5"/>');
  registerIcon('skip', '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>');
  registerIcon('spinner', '<path d="M12 4a8 8 0 1 1-8 8"/>');
  registerIcon('circle', '<circle cx="12" cy="12" r="7"/>');
  registerIcon('rerun', '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/><path d="M11 9.5l4 2.5-4 2.5z" fill="currentColor"/>');

  let disposed = false;
  mide.subscriptions.add({ dispose: () => { disposed = true; } });

  // --- the model ----------------------------------------------------------------------------
  /** folder path -> folder node (children: file nodes). */
  const folders = new Map();
  /** file path -> file node. */
  const files = new Map();
  /** keyOf(path, names) -> { status, duration, message, details, expected, actual, line }. Kept across rescans. */
  const results = new Map();
  /** Keys of the tests in the run that is going on. */
  const running = new Set();
  /** file path -> names a framework listed that the scan didn't find. */
  const listed = new Map();
  /** folder -> 'scanning' | 'listing' | null. */
  const busy = new Map();
  let current = null; // the run going on: { cancelled, handle }
  let lastRun = null; // [{ kind, path, names }] of the last run
  let lastSummary = null;

  const rel = (path) => ws.relativePath(path) || path;
  const dirOf = (r) => (r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '');
  const abs = (folder, r) => (r ? `${folder}/${r}` : folder);
  const status = (n) => statusOf(n, results, running);
  const allNodes = () => [...folders.values()];
  const nodeById = (id) => { for (const f of folders.values()) for (const n of walk(f)) if (n.id === id) return n; return null; };
  const fileOf = (n) => { while (n && n.kind !== 'file') n = n.parent; return n; };
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const label = (n) => (n.kind === 'folder' ? n.name : n.kind === 'file' ? n.name : n.names.join(' › '));

  // --- discovery ----------------------------------------------------------------------------
  const tokens = new Map();
  const readText = async (path) => {
    const stat = await mide.fs.stat(path);
    if (!stat?.isFile || stat.size > MAX_BYTES) return null;
    return mide.fs.read(path).catch(() => null);
  };
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
    return out;
  }

  /** What runs a test file: { fw, runRoot } or null (no framework found for it). */
  function classify(info, r, text) {
    const kind = testFileKind(r);
    if (!kind) return null;
    if (kind === 'go') {
      const mod = nearestRoot(r, info.goDirs);
      return mod == null ? null : { kind, fw: 'go', runRoot: abs(info.folder, mod) };
    }
    if (kind === 'py') {
      const root = nearestRoot(r, info.pyDirs);
      if (root == null && !info.pyDirs.size && !/^\s*(import pytest|from pytest\b)/m.test(text)) return null;
      return { kind, fw: 'pytest', runRoot: abs(info.folder, root ?? '') };
    }
    const own = frameworkFromImports(text);
    const pkgDir = nearestRoot(r, info.pkgDirs);
    if (kind === 'js-node' && own !== 'node') return null;
    const fw = own || (pkgDir == null ? null : jsFramework(info.pkgs.get(pkgDir), info.siblings.get(pkgDir)));
    return fw ? { kind, fw, runRoot: abs(info.folder, pkgDir ?? '') } : null;
  }

  async function folderInfo(folder, rels) {
    const dirsWith = (re) => new Set(rels.filter((r) => re.test(r)).map(dirOf));
    const pkgDirs = dirsWith(/(^|\/)package\.json$/);
    const goDirs = dirsWith(/(^|\/)go\.mod$/);
    const pyDirs = dirsWith(PYTEST_MARKERS);
    for (const r of rels.filter((x) => PYTEST_MAYBE.test(x))) {
      if (/\bpytest\b/.test((await readText(abs(folder, r))) || '')) pyDirs.add(dirOf(r));
    }
    const pkgs = new Map();
    const siblings = new Map();
    for (const d of pkgDirs) {
      try { pkgs.set(d, JSON.parse((await readText(abs(folder, d ? `${d}/package.json` : 'package.json'))) || 'null')); } catch { pkgs.set(d, null); }
      siblings.set(d, rels.filter((r) => dirOf(r) === d).map((r) => r.slice(r.lastIndexOf('/') + 1)));
    }
    const modules = new Map();
    for (const d of goDirs) modules.set(abs(folder, d), goModule(await readText(abs(folder, d ? `${d}/go.mod` : 'go.mod'))));
    return { folder, pkgDirs, goDirs, pyDirs, pkgs, siblings, modules };
  }

  /** A file node for `path` in `folder`, scanned from `text`, with what a listing or a run added before. */
  function makeFile(info, path, text, cls) {
    const file = fileNode({ path, rel: relative(info.folder, path), fw: cls.fw, runRoot: cls.runRoot, folder: info.folder, scanned: scanFor(cls.kind, text) });
    file.scanKind = cls.kind;
    for (const names of listed.get(path) || []) find(file, names, { add: true });
    for (const k of results.keys()) {
      if (!k.startsWith(path + SEP)) continue;
      const names = k.slice(path.length + 1).split(SEP);
      const n = find(file, names, { add: true });
      const line = results.get(k).line;
      if (n?.dynamic && line) { n.line = line; n.end = line; }
    }
    return file;
  }

  /** Scans every test file of a folder, then (trusted folders) asks the frameworks for their lists. */
  async function discover(folder, { list = true } = {}) {
    const token = (tokens.get(folder) || 0) + 1;
    tokens.set(folder, token);
    const stale = () => disposed || tokens.get(folder) !== token || !ws.folders.includes(folder);
    busy.set(folder, 'scanning');
    render();
    const rels = await mide.project.files(folder).catch(() => []);
    if (stale()) return;
    const info = await folderInfo(folder, rels);
    if (stale()) return;
    const candidates = rels.filter((r) => testFileKind(r)).slice(0, MAX_FILES);
    const made = await mapLimit(candidates, 12, async (r) => {
      const path = abs(folder, r);
      const text = openText(path) ?? await readText(path);
      if (text == null) return null;
      const cls = classify(info, r, text);
      return cls ? makeFile(info, path, text, cls) : null;
    });
    if (stale()) return;
    const root = node({ kind: 'folder', name: folder.split('/').pop() || folder, path: folder, names: [], info });
    for (const f of made) if (f) { f.parent = root; root.children.push(f); }
    root.children.sort(byName);
    setFolder(folder, root);
    busy.set(folder, null);
    render();
    syncEditors();
    if (list && ws.isTrusted(folder) && mide.config.get('test-explorer.useFrameworkLists') !== false) await listFolder(folder, token);
  }

  function setFolder(folder, root) {
    const old = folders.get(folder);
    if (old) for (const f of old.children) if (files.get(f.path) === f) files.delete(f.path);
    if (root) { folders.set(folder, root); for (const f of root.children) files.set(f.path, f); }
    else folders.delete(folder);
  }

  /** The text of an open editor for `path` (it may be ahead of the disk), or null. */
  function openText(path) {
    const item = ws.getItems().find((i) => i.type === 'editor' && i.view && i.getPath?.() === path);
    return item ? item.view.state.doc.toString() : null;
  }

  /** Scans one file again (from its editor, or the disk). A new test file joins its folder. */
  async function rescanFile(path, text) {
    const folder = ws.folderFor(path);
    const root = folder && folders.get(folder);
    if (!root || disposed) return;
    text ??= openText(path) ?? await readText(path);
    const old = files.get(path);
    const r = relative(folder, path);
    const cls = text == null ? null : old ? { kind: old.scanKind, fw: old.fw, runRoot: old.runRoot } : classify(root.info, r, text);
    if (!cls) {
      if (old) { root.children = root.children.filter((f) => f !== old); files.delete(path); }
    } else {
      const file = makeFile(root.info, path, text, cls);
      file.parent = root;
      const at = root.children.indexOf(old);
      if (at >= 0) root.children[at] = file;
      else root.children.push(file);
      root.children.sort(byName);
      files.set(path, file);
    }
    render();
    syncEditors(path);
  }

  // --- asking the frameworks ------------------------------------------------------------------
  /** The command that starts a framework in `runRoot`: the setting, a local install, or the usual one. */
  async function baseFor(fw, runRoot, folder) {
    const custom = String(mide.config.get(`test-explorer.${fw}Command`) || '').trim();
    if (custom) return custom;
    if (fw === 'jest' || fw === 'vitest') {
      for (let dir = runRoot; ;) {
        const bin = `${dir}/node_modules/.bin/${fw}${isWin ? '.cmd' : ''}`;
        if (await mide.fs.stat(bin)) return quote(bin);
        if (dir === folder || !dir.startsWith(folder + '/')) break;
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
      return `npx --no-install ${fw}`;
    }
    if (fw === 'pytest') {
      for (const dir of new Set([runRoot, folder])) {
        const py = isWin ? `${dir}/.venv/Scripts/python.exe` : `${dir}/.venv/bin/python`;
        if (await mide.fs.stat(py)) return `${quote(py)} -m pytest`;
      }
      return isWin ? 'python -m pytest' : 'python3 -m pytest';
    }
    return fw; // node, go
  }

  /** Runs a command in `cwd` and collects what it prints: { code, stdout, stderr }. */
  function capture(command, cwd, { onData } = {}) {
    let stdout = '';
    let stderr = '';
    const handle = mide.process.spawn(command, {
      cwd, env: { NO_COLOR: '1' },
      onData: (data, stream) => { if (stream === 'stderr') stderr += data; else stdout += data; onData?.(data, stream); },
    });
    return { handle, done: handle.done.then(({ code, signal }) => ({ code, signal, stdout, stderr })) };
  }

  async function listFolder(folder, token) {
    const root = folders.get(folder);
    if (!root || !ws.isTrusted(folder)) return;
    busy.set(folder, 'listing');
    render();
    const groups = new Map();
    for (const f of root.children) groups.set(`${f.fw}${SEP}${f.runRoot}`, { fw: f.fw, runRoot: f.runRoot });
    for (const { fw, runRoot } of groups.values()) {
      const command = listCommand(fw, { base: await baseFor(fw, runRoot, folder) });
      if (!command) continue;
      const { code, stdout } = await capture(command, runRoot).done;
      if (disposed || tokens.get(folder) !== token) return;
      try { await mergeListing(root, fw, runRoot, stdout, code); } catch {}
    }
    busy.set(folder, null);
    render();
    syncEditors();
  }

  async function mergeListing(root, fw, runRoot, stdout, code) {
    const remember = (path, names) => {
      const list = listed.get(path) || [];
      if (!list.some((n) => n.join(SEP) === names.join(SEP))) list.push(names);
      listed.set(path, list);
    };
    if (fw === 'vitest' || fw === 'pytest') {
      const entries = fw === 'vitest' ? parseVitestList(stdout, runRoot) : code > 1 ? [] : parsePytestCollect(stdout, runRoot);
      for (const { path, names } of entries) {
        const file = files.get(path) || await addFile(root, path, { fw, runRoot });
        if (!file || find(file, names)) continue;
        remember(path, names);
        find(file, names, { add: true });
      }
    } else if (fw === 'jest') {
      if (code !== 0) return;
      for (const path of parseJestList(stdout, runRoot)) if (!files.has(path)) await addFile(root, path, { fw, runRoot });
    } else if (fw === 'go') {
      for (const { pkg, names } of parseGoList(stdout)) {
        const dir = goDir(root, runRoot, pkg);
        const inDir = root.children.filter((f) => f.fw === 'go' && f.path.slice(0, f.path.lastIndexOf('/')) === dir);
        for (const name of names) {
          if (!inDir.length || inDir.some((f) => find(f, [name]))) continue;
          remember(inDir[0].path, [name]);
          find(inDir[0], [name], { add: true });
        }
      }
    }
  }

  /** A test file a framework knows about that the scan didn't pick up (its own name patterns, say). */
  async function addFile(root, path, { fw, runRoot }) {
    if (!path.startsWith(root.path + '/') || files.has(path)) return files.get(path) || null;
    const text = openText(path) ?? await readText(path);
    if (text == null) return null;
    const kind = fw === 'pytest' ? 'py' : fw === 'go' ? 'go' : 'js';
    const file = makeFile(root.info, path, text, { kind, fw, runRoot });
    file.parent = root;
    root.children.push(file);
    root.children.sort(byName);
    files.set(path, file);
    return file;
  }

  /** The folder of a Go package path, inside the module at `runRoot`. */
  function goDir(root, runRoot, pkg) {
    const mod = root.info.modules.get(runRoot);
    if (mod && (pkg === mod || pkg.startsWith(mod + '/'))) return runRoot + pkg.slice(mod.length);
    return runRoot;
  }

  // --- running --------------------------------------------------------------------------------
  let reportSeq = 0;

  async function run(nodes, { why = '' } = {}) {
    nodes = nodes.filter(Boolean);
    if (current) {
      mide.notify.info('Tests are already running', 'Wait for them to finish, or cancel the run.', { actions: [{ label: 'Cancel Run', run: cancel }] });
      return false;
    }
    if (!nodes.length) { mide.notify.info('No tests to run', why || undefined); return false; }
    let groups = plan(nodes);
    const blocked = groups.filter((g) => !ws.isTrusted(g.runRoot));
    if (blocked.length) {
      const folder = blocked[0].folder;
      mide.notify.info('Tests don’t run in Restricted Mode', `Trust ${folder.split('/').pop()} to run its tests: they run code that comes with the folder.`, {
        actions: [{ label: 'Trust Folder…', run: async () => { if (await ws.requestTrust(folder)) run(nodes); } }],
      });
      groups = groups.filter((g) => !blocked.includes(g));
      if (!groups.length) return false;
    }
    lastRun = nodes.map((n) => ({ kind: n.kind, path: n.path, names: n.names }));
    const job = { cancelled: false, handle: null, total: 0 };
    current = job;
    // The tests in this run lose their old results and show as running.
    for (const g of groups) {
      for (const n of g.nodes) {
        for (const x of walk(n)) {
          if (x.kind === 'folder') continue;
          const k = keyOf(x.path, x.names);
          results.delete(k);
          if (x.kind === 'test' || x.kind === 'suite') running.add(k);
          if (x.kind === 'test' && !x.children.length) job.total++;
        }
        // A run of part of a file can't fail the file itself.
        results.delete(keyOf(n.path, []));
      }
    }
    output.clear();
    refresh();
    let failedToRun = null;
    for (const g of groups) {
      if (job.cancelled || disposed) break;
      const err = await runGroup(g, job);
      failedToRun ??= err;
      for (const n of g.nodes) for (const x of walk(n)) running.delete(keyOf(x.path, x.names));
      refresh();
    }
    running.clear();
    current = null;
    if (disposed) return false;
    lastSummary = { ...counts(nodes, results), cancelled: job.cancelled };
    refresh();
    if (failedToRun && !job.cancelled) {
      mide.notify.error(failedToRun.title, failedToRun.detail, { actions: [{ label: 'Show Output', run: () => mide.panel.show('test-output') }] });
    }
    return !job.cancelled;
  }

  /** Runs one framework in one place. Returns an error ({ title, detail }) when it reported nothing. */
  async function runGroup(g, job) {
    const base = await baseFor(g.fw, g.runRoot, g.folder);
    const report = `${mide.user.runDir}/test-explorer-${Date.now()}-${++reportSeq}.${g.fw === 'jest' || g.fw === 'vitest' ? 'json' : 'xml'}`;
    let command;
    if (g.fw === 'go') {
      const dirs = new Set();
      const tests = [];
      for (const n of g.nodes) {
        const file = fileOf(n);
        dirs.add(file.path.slice(0, file.path.lastIndexOf('/')));
        if (n.kind === 'file') tests.push(...n.children.map((c) => [c.name]));
        else tests.push(n.names);
      }
      const whole = g.all || g.nodes.some((n) => n.kind === 'file' && !n.children.length);
      const packages = g.all ? ['./...'] : [...dirs].map((d) => (d === g.runRoot ? '.' : `./${relative(g.runRoot, d)}`));
      command = goRunCommand({ base, packages, tests: whole ? [] : tests, quote });
    } else {
      // node --test on its own would also pick up other frameworks' *.test.js files: name ours.
      const targets = g.fw === 'node' && g.all ? [...g.files].map((f) => ({ file: relative(g.runRoot, f.path), names: [], group: true })) : g.targets;
      command = runCommand(g.fw, { base, targets, all: g.all && g.fw !== 'node', out: report, quote });
    }
    output.append(`$ ${command}\n`, 'command');
    output.setCommand(command, g.runRoot);
    const { handle, done } = capture(command, g.runRoot, { onData: (data, stream) => output.append(data, stream) });
    job.handle = handle;
    const { code, signal, stdout } = await done;
    job.handle = null;
    if (job.cancelled || disposed) { output.append('\nCancelled.\n', 'note'); return null; }
    output.append(`\n${signal ? `Stopped by ${signal}` : `Exited with code ${code}`}.\n`, 'note');
    let parsed = null;
    try {
      if (g.fw === 'go') parsed = parseGoJson(stdout);
      else {
        const text = await mide.fs.read(report);
        parsed = g.fw === 'jest' || g.fw === 'vitest' ? parseJestJson(text, g.runRoot)
          : parseJunit(text, { root: g.runRoot, style: g.fw === 'node' ? 'node' : 'pytest' });
      }
    } catch {}
    const reported = parsed && (parsed.tests.length || parsed.files?.length || parsed.packages?.length);
    if (!reported) {
      if (code === 0) return null; // nothing matched
      const why = stripAnsi(stdout + '\n').trim().split('\n').filter(Boolean).pop() || '';
      return { title: `${FRAMEWORKS[g.fw]} didn’t report any results`, detail: why ? `${why.slice(0, 200)}` : `The command exited with code ${code}.` };
    }
    await apply(g, parsed);
    return null;
  }

  async function apply(g, parsed) {
    const root = folders.get(g.folder);
    if (!root) return;
    const targeted = (n) => { for (let p = n; p; p = p.parent) if (g.nodes.includes(p)) return true; return false; };
    const keep = (r) => ({ status: r.status, duration: r.duration ?? null, message: r.message || '', details: r.details || '', expected: r.expected, actual: r.actual, line: r.line ?? null });
    for (const r of parsed.tests) {
      let file;
      if (g.fw === 'go') {
        const dir = goDir(root, g.runRoot, r.pkg);
        const inDir = root.children.filter((f) => f.fw === 'go' && f.path.slice(0, f.path.lastIndexOf('/')) === dir);
        file = inDir.find((f) => find(f, [r.names[0]])) || inDir[0];
      } else {
        file = files.get(r.path) || (r.path && await addFile(root, r.path, g));
      }
      if (!file) continue;
      // Jest and Vitest report the tests a name filter left out as skipped: they didn't run.
      const known = find(file, r.names);
      if (r.status === 'skipped' && !g.all && !(known && targeted(known))) continue;
      const n = known || find(file, r.names, { add: true });
      if (n.dynamic && r.line) { n.line = r.line; n.end = r.line; }
      results.set(keyOf(file.path, n.names), keep(r));
    }
    for (const f of parsed.files || []) {
      const file = files.get(f.path);
      if (file) results.set(keyOf(file.path, []), keep(f));
    }
    // A Go package that didn't build: its files show the compiler's message.
    for (const p of parsed.packages || []) {
      if (p.status !== 'failed' || parsed.tests.some((t) => t.pkg === p.pkg)) continue;
      const dir = goDir(root, g.runRoot, p.pkg);
      for (const f of root.children) if (f.fw === 'go' && f.path.slice(0, f.path.lastIndexOf('/')) === dir) results.set(keyOf(f.path, []), keep({ status: 'failed', message: p.message.split('\n').slice(0, 8).join('\n'), details: p.message }));
    }
  }

  function cancel() {
    if (!current) return;
    current.cancelled = true;
    current.handle?.kill();
    running.clear();
    refresh();
  }

  // --- what a command runs ----------------------------------------------------------------------
  const activeFile = () => { const p = ws.getActiveEditor()?.getPath?.(); return p ? files.get(p) || null : null; };
  function atCursor() {
    const ed = ws.getActiveEditor();
    const file = activeFile();
    if (!ed?.view || !file) return null;
    const line = ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
    return nodeAtLine(file, line) || file;
  }
  const resolve = (saved) => saved.map((s) => (s.kind === 'folder' ? folders.get(s.path) : files.get(s.path) && (s.names.length ? find(files.get(s.path), s.names) : files.get(s.path)))).filter(Boolean);
  const failing = () => failedTests(allNodes(), results);
  const noTests = () => (folders.size ? 'No tests were found in this project.' : 'Open a folder to find its tests.');

  // --- editors --------------------------------------------------------------------------------------
  const parts = editorParts(mide, {
    onRun: (id) => run([nodeById(id)]),
    onMenu: (id) => nodeMenu(nodeById(id)),
  });
  mide.editor.addExtension(parts.extension);
  const sent = new WeakMap();

  function editorState(path) {
    const file = files.get(path);
    if (!file) return { marks: [], failures: [] };
    const marks = [];
    const failures = [];
    for (const n of walk(file)) {
      if (n === file) continue;
      const s = status(n);
      const r = results.get(keyOf(n.path, n.names));
      if (!n.dynamic && n.line) {
        const what = n.kind === 'suite' ? 'suite' : 'test';
        marks.push({ line: n.line, status: s, id: n.id, title: s ? `${n.name}: ${s}. Click to run the ${what} again.` : `Run the ${what} “${n.name}”` });
      }
      if (r?.status === 'failed' && n.line && !n.children.some((c) => results.get(keyOf(c.path, c.names))?.status === 'failed')) {
        // Expected and received get their own row, so the message doesn't repeat them.
        const values = r.expected != null || r.actual != null;
        const message = r.message.split('\n').filter((l) => !values || !/^\s*(Expected|Received)( value)?:/.test(l)).join('\n').trim();
        failures.push({ line: n.line, title: n.names.join(' › '), message: message.split('\n').slice(0, 6).join('\n'), expected: r.expected, actual: r.actual });
      }
    }
    const fileResult = results.get(keyOf(path, []));
    if (fileResult?.status === 'failed') failures.push({ line: 1, title: `${file.name} failed to run`, message: fileResult.message.split('\n').slice(0, 8).join('\n') });
    return { marks, failures };
  }

  function syncEditors(path) {
    if (disposed) return;
    for (const item of ws.getItems()) {
      if (item.type !== 'editor' || !item.view || (path && item.getPath?.() !== path)) continue;
      const value = editorState(item.getPath?.());
      const json = JSON.stringify(value);
      if (sent.get(item.view) === json) continue;
      sent.set(item.view, json);
      item.view.dispatch({ effects: parts.setTests.of(value) });
    }
  }
  ws.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => syncEditors(item.getPath?.()), 0); });
  // Typing moves tests around: scan the editor's text again once it settles.
  const editTimers = new Map();
  ws.onDidUpdateEditor((item, update) => {
    const path = item.getPath?.();
    if (!update?.docChanged || !path || !files.has(path)) return;
    clearTimeout(editTimers.get(path));
    editTimers.set(path, setTimeout(() => { editTimers.delete(path); if (item.view) rescanFile(path, item.view.state.doc.toString()); }, 400));
  });
  mide.subscriptions.add({ dispose: () => { for (const t of editTimers.values()) clearTimeout(t); } });

  // --- the Testing view ---------------------------------------------------------------------------------
  const expanded = new Map(); // key -> open
  const keyFor = (n) => `${n.kind}${SEP}${n.path}${SEP}${n.names.join(SEP)}`;
  const isOpen = (n) => expanded.get(keyFor(n)) ?? true;
  let selectedKey = null;
  const filterInput = h('input.input.tx-filter', { placeholder: 'Filter tests', spellcheck: false, 'aria-label': 'Filter tests' });
  const tree = h('div.tx-tree', { role: 'tree', tabIndex: 0, 'aria-label': 'Tests' });
  const details = h('div.tx-details', { hidden: true });
  const button = (title, ic, onclick, cls = '') => h(`button.icon-btn${cls}`, { title, 'aria-label': title, onclick }, icon(ic, 14));
  const runAllBtn = button('Run All Tests', 'play', () => runAll());
  const runFailedBtn = button('Run Failed Tests', 'rerun', () => runFailed());
  const cancelBtn = button('Cancel Test Run', 'stop', () => cancel(), '.tx-cancel');
  const view = h('div.tx-view',
    h('div.tx-header',
      h('span.tx-title', 'Testing'),
      h('span.tx-spacer'),
      runAllBtn, runFailedBtn, cancelBtn,
      button('Refresh Tests', 'refresh', () => refreshAll()),
      button('Show Test Output', 'terminal', () => mide.panel.show('test-output', { focus: true })),
      button('Collapse All', 'collapse', () => collapseAll())),
    h('div.tx-filter-row', filterInput),
    h('div.tx-summary', { role: 'status' }),
    tree,
    details);
  const summaryEl = view.querySelector('.tx-summary');

  const STATUS_ICON = { passed: 'check', failed: 'close', skipped: 'skip', running: 'spinner' };
  const statusIcon = (s) => { const el = icon(STATUS_ICON[s] || 'circle', 13); el.classList.add('tx-status', s || 'none'); return el; };
  const duration = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);

  let rows = []; // visible rows in order: { node, el, depth }
  let drawing = 0;
  function render() {
    if (disposed || drawing) return;
    drawing = requestAnimationFrame(draw);
  }
  mide.subscriptions.add({ dispose: () => cancelAnimationFrame(drawing) });

  function matches(n, q) {
    return n.name.toLowerCase().includes(q) || (n.kind !== 'file' && n.kind !== 'folder' && n.names.join(' ').toLowerCase().includes(q));
  }

  function draw() {
    drawing = 0;
    if (disposed) return;
    const q = filterInput.value.trim().toLowerCase();
    const focused = tree.contains(document.activeElement) || document.activeElement === tree;
    rows = [];
    const out = [];
    // Filtering shows the matches with their parents, and everything under a match.
    const visit = (n, depth, under) => {
      const hit = under || !q || (n.kind !== 'folder' && matches(n, q));
      if (!hit && ![...walk(n)].some((x) => x !== n && matches(x, q))) return;
      out.push(row(n, depth));
      if (n.children.length && (q || isOpen(n))) for (const c of n.children) visit(c, depth + 1, !!q && hit);
    };
    for (const folder of ws.folders) {
      const f = folders.get(folder);
      if (f) visit(f, 0, false);
    }
    if (!out.length) {
      const scanning = [...busy.values()].includes('scanning');
      tree.replaceChildren(h('div.tx-empty', scanning ? 'Looking for tests…' : q ? `No tests match “${filterInput.value.trim()}”.` : emptyText()));
      tree.removeAttribute('aria-activedescendant');
    } else {
      tree.replaceChildren(...out);
      if (!rows.some((r) => keyFor(r.node) === selectedKey)) selectedKey = null;
      markSelected(focused);
    }
    const listing = [...busy.values()].some(Boolean);
    const c = counts(allNodes(), results);
    summaryEl.textContent = current ? (current.total ? `Running ${current.total} test${current.total === 1 ? '' : 's'}…` : 'Running tests…')
      : listing ? 'Looking for tests…'
        : c.total ? summaryText(c) : '';
    runFailedBtn.disabled = !failing().length;
    runAllBtn.disabled = !files.size;
    cancelBtn.hidden = !current;
    renderDetails();
  }
  const summaryText = (c) => [c.passed && `${c.passed} passed`, c.failed && `${c.failed} failed`, c.skipped && `${c.skipped} skipped`].filter(Boolean).join(', ') || 'No results';

  function emptyText() {
    if (!ws.folders.length) return 'Open a folder to find its tests.';
    return 'No tests found. The Test Explorer finds Jest, Vitest, node:test, pytest and Go tests.';
  }

  function row(n, depth) {
    const s = status(n);
    const r = results.get(keyOf(n.path, n.names));
    const restricted = n.kind === 'folder' && !ws.isTrusted(n.path);
    const el = h('div.tx-row', {
      id: `tx-row-${n.id}`, role: 'treeitem', 'aria-level': String(depth + 1),
      ...(n.children.length ? { 'aria-expanded': String(isOpen(n)) } : {}),
      'aria-selected': 'false',
      'aria-description': [s && `${s}`, restricted && 'Restricted Mode'].filter(Boolean).join(', ') || undefined,
      class: `${n.kind} ${s || ''}`,
      style: { paddingLeft: `${6 + depth * 14}px` },
      dataset: { id: n.id, kind: n.kind },
      title: n.kind === 'folder' ? n.path : n.kind === 'file' ? `${rel(n.path)} (${FRAMEWORKS[n.fw]})` : `${label(n)}${n.line ? ` · line ${n.line}` : ''}`,
      onmousedown: (e) => { if (e.button === 0) select(n); },
      onclick: (e) => {
        if (e.target.closest('.tx-row-run')) return;
        if (n.children.length && (n.kind === 'folder' || e.target.closest('.tx-twisty'))) toggle(n);
        else open(n);
      },
      ondblclick: () => { if (n.kind !== 'folder') open(n, { pending: false }); },
      oncontextmenu: (e) => { e.preventDefault(); select(n); nodeMenu(n); },
    },
    h('span.tx-twisty', { class: n.children.length ? (isOpen(n) ? 'open' : '') : 'leaf' }, n.children.length ? icon('chevron', 12) : null),
    statusIcon(s),
    n.kind === 'file' ? fileIcon(n.name.slice(n.name.lastIndexOf('/') + 1)) : n.kind === 'folder' ? icon('folder', 14) : null,
    h('span.tx-name', n.kind === 'file' ? n.name.slice(n.name.lastIndexOf('/') + 1) : n.name),
    n.kind === 'file' && n.name.includes('/') ? h('span.tx-dir', n.name.slice(0, n.name.lastIndexOf('/'))) : null,
    restricted ? h('span.tx-dir', 'Restricted Mode') : null,
    n.kind === 'folder' && busy.get(n.path) ? h('span.tx-dir', 'scanning…') : null,
    r?.duration != null && n.kind === 'test' ? h('span.tx-duration', duration(r.duration)) : null,
    h('button.icon-btn.tx-row-run', { tabIndex: -1, title: `Run ${n.kind === 'folder' ? 'all tests in ' : ''}${n.name}`, 'aria-label': `Run ${n.kind === 'folder' ? 'all tests in ' : ''}${n.name}`, onclick: (e) => { e.stopPropagation(); run([n]); } }, icon('play', 12)));
    rows.push({ node: n, el, depth });
    return el;
  }

  function markSelected(scroll) {
    for (const r of rows) {
      const on = keyFor(r.node) === selectedKey;
      r.el.classList.toggle('selected', on);
      r.el.setAttribute('aria-selected', String(on));
      if (on) { tree.setAttribute('aria-activedescendant', r.el.id); if (scroll) r.el.scrollIntoView({ block: 'nearest' }); }
    }
    if (!selectedKey) tree.removeAttribute('aria-activedescendant');
  }

  function select(n) {
    selectedKey = n ? keyFor(n) : null;
    markSelected(true);
    renderDetails();
  }
  const selectedNode = () => rows.find((r) => keyFor(r.node) === selectedKey)?.node || null;

  function toggle(n, force) {
    if (!n.children.length) return;
    expanded.set(keyFor(n), force ?? !isOpen(n));
    draw();
  }

  function collapseAll() {
    for (const f of folders.values()) for (const n of walk(f)) if (n.kind !== 'folder' && n.children.length) expanded.set(keyFor(n), false);
    draw();
  }

  async function open(n, opts = {}) {
    if (!n || n.kind === 'folder') return;
    const line = n.kind === 'file' ? undefined : n.line || undefined;
    const ed = await ws.open(n.path, { ...(line ? { line, col: 0 } : {}), ...opts });
    return ed;
  }

  tree.addEventListener('keydown', (e) => {
    const i = rows.findIndex((r) => keyFor(r.node) === selectedKey);
    const cur = rows[i]?.node;
    const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) select(r.node); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') { if (i <= 0) filterInput.focus(); else go(i - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'ArrowRight' && cur) { if (cur.children.length && !isOpen(cur)) toggle(cur, true); else go(i + 1); }
    else if (e.key === 'ArrowLeft' && cur) {
      if (cur.children.length && isOpen(cur)) toggle(cur, false);
      else { const p = rows.findIndex((r) => r.node === cur.parent); if (p >= 0) go(p); }
    } else if (e.key === 'Enter' && cur && (e.shiftKey || e.metaKey || e.ctrlKey)) run([cur]);
    else if (e.key === 'Enter' && cur) { if (cur.kind === 'folder') toggle(cur); else open(cur); }
    else if (e.key === ' ' && cur) { if (cur.children.length) toggle(cur); else open(cur, { focus: false }); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { if (cur) nodeMenu(cur); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  tree.addEventListener('focus', () => { if (!selectedKey && rows.length) select(rows[0].node); });
  filterInput.addEventListener('input', () => draw());
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); tree.focus(); if (rows.length) select(rows[0].node); }
    else if (e.key === 'Escape' && filterInput.value) { e.preventDefault(); e.stopPropagation(); filterInput.value = ''; draw(); }
  });

  function renderDetails() {
    const n = selectedNode();
    const r = n && results.get(keyOf(n.path, n.names));
    if (!n || !r || r.status !== 'failed') { details.hidden = true; details.replaceChildren(); return; }
    details.hidden = false;
    details.replaceChildren(
      h('div.tx-details-title', { role: 'heading', 'aria-level': '3' }, `${label(n)} failed`),
      r.expected != null || r.actual != null ? h('div.tx-details-values',
        h('div', h('span.tx-inline-label', 'Expected '), h('code', String(r.expected ?? ''))),
        h('div', h('span.tx-inline-label', 'Received '), h('code', String(r.actual ?? '')))) : null,
      h('pre.tx-details-message', { tabIndex: 0, 'aria-label': 'Failure details' }, r.details || r.message),
      h('div.tx-details-actions',
        n.kind !== 'file' ? h('button.btn.small', { onclick: () => open(n, { pending: false }) }, 'Go to Test') : null,
        h('button.btn.small', { onclick: () => run([n]) }, 'Run Again'),
        h('button.btn.small', { onclick: () => mide.panel.show('test-output', { focus: true }) }, 'Show Output')));
  }

  async function nodeMenu(n) {
    if (!n) return;
    const choice = await mide.ui.contextMenu([
      { id: 'run', label: n.kind === 'folder' ? 'Run All Tests in Folder' : n.kind === 'file' ? 'Run Tests in File' : n.kind === 'suite' ? 'Run Suite' : 'Run Test' },
      ...(n.kind !== 'folder' ? [{ id: 'open', label: 'Go to Test' }] : []),
      { id: 'reveal', label: 'Show in Testing View' },
      { id: 'output', label: 'Show Test Output' },
    ]);
    if (choice === 'run') run([n]);
    else if (choice === 'open') open(n, { pending: false });
    else if (choice === 'reveal') reveal(n);
    else if (choice === 'output') mide.panel.show('test-output', { focus: true });
  }

  function reveal(n) {
    for (let p = n.parent; p; p = p.parent) expanded.set(keyFor(p), true);
    filterInput.value = '';
    selectedKey = keyFor(n);
    mide.sidebar.show('test-explorer');
    draw();
    tree.focus();
  }

  mide.sidebar.addView({ id: 'test-explorer', title: 'Testing', icon: 'beaker', order: 40, command: 'test-explorer:show', element: view, focus: () => tree.focus(), onShow: () => draw() });

  // --- output -----------------------------------------------------------------------------------------
  const output = (() => {
    const pre = h('pre.tx-output', { tabIndex: 0, role: 'log', 'aria-label': 'Test output', 'aria-live': 'off' });
    const commandEl = h('span.tx-output-command', 'No test run yet.');
    const el = h('div.tx-output-view',
      h('div.tx-output-header',
        commandEl,
        h('span.tx-spacer'),
        button('Cancel Test Run', 'stop', () => cancel(), '.tx-cancel'),
        button('Clear Output', 'trash', () => { pre.textContent = ''; })),
      pre);
    let text = '';
    let pending = '';
    let frame = 0;
    const flush = () => {
      frame = 0;
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      text = (text + pending).slice(-MAX_OUTPUT);
      pending = '';
      pre.textContent = text;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    };
    mide.subscriptions.add({ dispose: () => cancelAnimationFrame(frame) });
    return {
      el,
      clear: () => { text = ''; pending = ''; pre.textContent = ''; },
      append: (data) => { pending += stripAnsi(data); if (!frame) frame = requestAnimationFrame(flush); },
      setCommand: (command, cwd) => { commandEl.textContent = command; commandEl.title = `${command}\nin ${cwd}`; },
      update: () => { el.querySelector('.tx-cancel').hidden = !current; },
    };
  })();
  mide.panel.addView({ id: 'test-output', title: 'Test Output', icon: 'beaker', order: 60, command: 'test-explorer:show-output', element: output.el, focus: () => output.el.querySelector('.tx-output').focus() });

  // --- status bar ----------------------------------------------------------------------------------------
  const statusEl = h('span.tx-status-item');
  mide.statusBar.addItem({ id: 'test-explorer', element: statusEl, align: 'left', priority: 60, tooltip: 'Test results: show the Testing view', command: 'test-explorer:show', onClick: () => mide.sidebar.show('test-explorer', { focus: true }) });
  statusEl.closest('.status-item')?.setAttribute('aria-label', 'Tests'); // its own name, not one made from the tooltip
  function renderStatus() {
    const item = statusEl.closest('.status-item');
    const name = (text) => { statusEl.setAttribute('aria-label', text); item?.setAttribute('aria-label', text); };
    const c = lastSummary;
    if (!current && !c) { if (item) item.hidden = true; return; }
    if (item) item.hidden = false;
    if (current) {
      statusEl.replaceChildren(statusIcon('running'), h('span', 'Running tests…'));
      name('Running tests');
      return;
    }
    statusEl.replaceChildren(
      statusIcon('passed'), h('span.tx-count', String(c.passed)),
      statusIcon('failed'), h('span.tx-count', String(c.failed)),
      ...(c.skipped ? [statusIcon('skipped'), h('span.tx-count', String(c.skipped))] : []));
    name(`Tests: ${summaryText(c)}${c.cancelled ? ' (cancelled)' : ''}`);
  }

  function refresh() {
    render();
    renderStatus();
    output.update();
    syncEditors();
  }

  // --- folders and files coming and going --------------------------------------------------------------
  function syncFolders() {
    for (const f of [...folders.keys()]) if (!ws.folders.includes(f)) { setFolder(f, null); tokens.delete(f); busy.delete(f); }
    for (const f of ws.folders) if (!folders.has(f) && !tokens.has(f)) discover(f);
    render();
  }
  const refreshAll = () => { for (const f of ws.folders) discover(f); };
  ws.onDidChangeFolders(() => syncFolders());
  ws.onDidChangeProject(() => { lastRun = null; lastSummary = null; results.clear(); listed.clear(); syncFolders(); renderStatus(); });
  ws.onDidChangeTrust(() => { for (const f of ws.folders) if (ws.isTrusted(f) && folders.has(f)) listFolder(f, tokens.get(f)); render(); });

  const CONFIG = /(^|\/)(package\.json|go\.mod|pytest\.ini|conftest\.py|pyproject\.toml|setup\.cfg|tox\.ini|vitest\.config\.[^/]+|jest\.config\.[^/]+)$/;
  let changed = new Set();
  let changeTimer = 0;
  ws.onDidChangeFiles((paths) => {
    for (const p of paths || []) if (ws.folderFor(p) && (testFileKind(relative(ws.folderFor(p), p)) || CONFIG.test(p) || files.has(p))) changed.add(p);
    if (!changed.size) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const list = [...changed];
      changed = new Set();
      const configs = new Set(list.filter((p) => CONFIG.test(p)).map((p) => ws.folderFor(p)));
      for (const f of configs) discover(f);
      for (const p of list) if (!configs.has(ws.folderFor(p))) rescanFile(p);
    }, 500);
  });
  mide.subscriptions.add({ dispose: () => clearTimeout(changeTimer) });

  ws.onDidSave((item) => {
    const path = item.getPath?.();
    if (!path || !mide.config.get('test-explorer.runOnSave')) return;
    setTimeout(async () => {
      await rescanFile(path);
      if (files.has(path) && !current) run([files.get(path)]);
    }, 0);
  });

  // --- commands ----------------------------------------------------------------------------------------------
  const runAll = () => run([...ws.folders].map((f) => folders.get(f)).filter((f) => f?.children.length), { why: noTests() });
  const runFailed = () => run(failing(), { why: 'No test failed in the last run.' });
  mide.commands.add({
    'test-explorer:show': { title: 'Testing: Show Test Explorer', run: () => mide.sidebar.show('test-explorer', { focus: true }) },
    'test-explorer:run-all': { title: 'Testing: Run All Tests', run: runAll },
    'test-explorer:run-file': {
      title: 'Testing: Run Tests in Current File', when: () => !!activeFile(),
      run: () => (activeFile() ? run([activeFile()]) : mide.notify.info('No tests in this file', 'Open a test file (Jest, Vitest, node:test, pytest or Go) to run its tests.')),
    },
    'test-explorer:run-at-cursor': {
      title: 'Testing: Run Test at Cursor', when: () => !!activeFile(),
      run: () => (atCursor() ? run([atCursor()]) : mide.notify.info('No test at the cursor', 'Put the cursor inside a test, or open a test file.')),
    },
    'test-explorer:rerun': {
      title: 'Testing: Re-run Last Tests', when: () => !!lastRun,
      run: () => (lastRun ? run(resolve(lastRun), { why: 'The tests of the last run are gone.' }) : mide.notify.info('No tests have run yet', 'Run some tests first.')),
    },
    'test-explorer:run-failed': { title: 'Testing: Run Failed Tests', when: () => failing().length > 0, run: runFailed },
    'test-explorer:cancel': { title: 'Testing: Cancel Test Run', when: () => !!current, run: cancel },
    'test-explorer:refresh': { title: 'Testing: Refresh Tests', run: refreshAll },
    'test-explorer:show-output': { title: 'Testing: Show Test Output', run: () => mide.panel.show('test-output', { focus: true }) },
    'test-explorer:clear-results': {
      title: 'Testing: Clear Test Results',
      run: () => { if (!current) { results.clear(); lastSummary = null; output.clear(); refresh(); } },
    },
  });

  mide.subscriptions.add({ dispose: () => { if (current) cancel(); } });
  syncFolders();
  renderStatus();
}
