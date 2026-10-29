// Minimide main process: windows, the mide:// protocol, and the native bridge.
import { app, BrowserWindow, Menu, protocol, ipcMain, dialog, shell, clipboard, nativeTheme, session, net, nativeImage, ClipboardItem, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createPackageManager } from './package-manager.js';
import { createUpdater } from './updater.js';
import { createVscodeReader } from './vscode.js';
import { createSecrets, createGist } from './sync.js';
import { registerAi } from './ai.js';
import { createRemoteSsh } from './remote-ssh.js';
import dns from 'node:dns/promises';
import net_ from 'node:net';

// node-pty is native and optional: without it the terminal falls back gracefully.
let pty = null;
try { pty = createRequire(import.meta.url)('node-pty'); } catch (err) { console.warn('[pty] unavailable:', err.message); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER_DIR = path.join(ROOT, 'dist/renderer');
const BUILTIN_PACKAGES = path.join(ROOT, 'packages');
// Test/dev overrides are ignored in packaged builds: they would let anything that can launch the
// app run code with the editor's file permissions.
const DEV_BUILD = !app.isPackaged;
const USER_DIR = (DEV_BUILD && process.env.MINIMIDE_HOME) || path.join(os.homedir(), '.minimide');
const USER_PACKAGES = path.join(USER_DIR, 'packages');
const DEV = DEV_BUILD && process.argv.includes('--dev');
// A packaged build never accepts debugging switches: another local program could use them to drive
// Minimide (and inherit the file and folder access macOS has granted it).
if (!DEV_BUILD && process.argv.some((a) => /^--(remote-debugging-(port|pipe)|inspect|inspect-brk|js-flags)(=|$)/.test(a))) app.exit(1);
// Windows: never run a program that happens to sit in the current folder (a planted git.exe).
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
const SCREENSHOT = DEV_BUILD ? process.env.MINIMIDE_SCREENSHOT : undefined;
// Apps launched from Finder/the Dock may not inherit $SHELL, so fall back to the user's login shell.
const IS_WIN = process.platform === 'win32';
const USER_SHELL = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || safeUserShell() || '/bin/sh';

/** Kill a child and everything it started (detached children lead their own process group). */
function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode != null) return;
  if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {} return; }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

function safeUserShell() {
  try { return os.userInfo().shell || null; } catch { return null; }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'mide', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------------------
// User directory bootstrap

const USER_DEFAULTS = {
  'config.json': JSON.stringify({ core: { theme: 'nightfall' }, editor: { fontSize: 14 } }, null, 2) + '\n',
  'keymap.json': `{
  // Map keystrokes to command ids. Use "Mod" for Cmd on macOS / Ctrl elsewhere.
  // Chords are space separated, e.g. "Mod-k Mod-b".
  // Bind to null to remove a default binding.
  // "Mod-Shift-d": "editor:duplicate-line"
}
`,
  'styles.css': `/* Your personal stylesheet. Loaded last and reloaded live on save.
 * Every color in Minimide is a CSS variable, e.g.:
 *
 * :root { --accent: #ff7ab2; }
 * .cm-editor { font-family: "Fira Code"; }
 */
`,
  'init.js': `// Your init script. Runs after all packages activate; reload with "Window: Reload".
// It receives the same API every package gets. See docs/PLUGINS.md.
//
// export default function (mide) {
//   mide.commands.add('me:hello', 'Say Hello', () => mide.notify.info('Hello!'));
// }
`,
};

async function ensureUserDir() {
  await fs.mkdir(USER_PACKAGES, { recursive: true });
  for (const [name, content] of Object.entries(USER_DEFAULTS)) {
    const file = path.join(USER_DIR, name);
    if (!fss.existsSync(file)) await fs.writeFile(file, content);
  }
  // Half-finished saves (state.json.<pid>.tmp…) from a run that was killed mid-write. Recent ones
  // may belong to another running copy, so only old ones go.
  for (const name of await fs.readdir(USER_DIR).catch(() => [])) {
    if (!/^[\w.-]+\.json\.\d+\.tmp$/.test(name)) continue;
    const file = path.join(USER_DIR, name);
    try { if (Date.now() - (await fs.stat(file)).mtimeMs > 60_000) await fs.unlink(file); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Packages

async function readPackageDir(dir, builtin) {
  const out = [];
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const pkgDir = path.join(dir, e.name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
      const name = manifest.name || e.name;
      out.push({ name, dir: pkgDir, builtin, manifest, url: `mide://pkg/${encodeURIComponent(name)}/` });
    } catch (err) {
      console.warn(`[packages] skipping ${pkgDir}: ${err.message}`);
    }
  }
  return out;
}

let packageIndex = new Map();
let builtinNames = new Set();
const packageManager = createPackageManager({
  userDir: USER_DIR, packagesDir: USER_PACKAGES, builtinNames: () => builtinNames,
  trash: (p) => shell.trashItem(p), version: app.getVersion(),
  apiBase: (DEV_BUILD && process.env.MINIMIDE_GITHUB_API) || undefined, // the tests' stand-in for api.github.com
});
async function listPackages() {
  const builtin = await readPackageDir(BUILTIN_PACKAGES, true);
  builtinNames = new Set(builtin.map((p) => p.name));
  // Packages installed with the package manager carry what the user agreed to (access, permissions).
  const records = await packageManager.records();
  const user = (await readPackageDir(USER_PACKAGES, false)).map((p) => ({ ...p, install: records[p.name] || null }));
  const all = [...builtin, ...user];
  packageIndex = new Map(all.map((p) => [p.name, p])); // user packages override built-ins
  return [...packageIndex.values()];
}

// ---------------------------------------------------------------------------
// mide:// protocol — mide://app/* (renderer), mide://pkg/<name>/* (packages), mide://user/* (~/.minimide)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function within(base, rel) {
  const target = path.resolve(base, rel);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return new Response('Bad request', { status: 400 }); }
  let file = null;
  if (url.host === 'app') file = within(RENDERER_DIR, parts.join('/') || 'index.html');
  else if (url.host === 'user') file = within(USER_DIR, parts.join('/'));
  else if (url.host === 'pkg') {
    // mide://pkg/<name>/~<stamp>/… : the stamp segment busts the module cache on reload.
    const pkg = parts.length ? packageIndex.get(parts.shift()) : null;
    if (/^~\d+$/.test(parts[0] || '')) parts.shift();
    if (pkg) file = within(pkg.dir, parts.join('/') || pkg.manifest.main || 'index.js');
  }
  if (!file) return new Response('Not found', { status: 404 });
  try {
    // within() is lexical; also compare real paths so a symlink can't reach outside the base.
    if (url.host !== 'app') {
      const base = url.host === 'user' ? USER_DIR : packageIndex.get(decodeURIComponent(url.pathname.split('/')[1] || ''))?.dir;
      const [realBase, realFile] = await Promise.all([fs.realpath(base), fs.realpath(file)]);
      if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) return new Response('Not found', { status: 404 });
    }
    const body = await fs.readFile(file);
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Only Minimide's own page (and its workers) may load these cross-origin.
      'access-control-allow-origin': 'mide://app',
      'cache-control': 'no-store',
    };
    // Sandboxed packages run in this worker. Its policy allows loading code from mide:// and
    // nothing else: no fetch, WebSocket, beacons or remote scripts, so it has no way out
    // except asking the editor, which checks the package's permissions.
    // Each worker may load only its own package's files (?pkg=<name>).
    if (url.host === 'app' && parts.join('/') === 'sandbox-worker.js') {
      const pkg = url.searchParams.get('pkg') || '';
      headers['content-security-policy'] = /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pkg)
        ? `default-src 'none'; script-src mide://pkg/${encodeURIComponent(pkg)}/`
        : "default-src 'none'";
    }
    return new Response(body, { headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Network access for sandboxed packages granted "network": public internet only. Loopback, private
// networks, link-local and cloud metadata addresses are refused, every redirect is re-checked, and
// the size cap applies while downloading.

function isPublicAddress(ip) {
  if (net_.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff'));
}

async function safeFetch(url, opts = {}) {
  const MAX = 10 * 1024 * 1024;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    let target = new URL(url);
    for (let hop = 0; hop <= 5; hop++) {
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Only http and https URLs can be fetched.');
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const addrs = net_.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
      if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new Error(`${target.hostname} is a local or private address.`);
      const res = await net.fetch(target.href, { method: hop ? 'GET' : opts.method || 'GET', headers: opts.headers, body: hop ? undefined : opts.body, signal: ctrl.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { target = new URL(res.headers.get('location'), target); continue; }
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body || []) {
        size += chunk.length;
        if (size > MAX) { ctrl.abort(); throw new Error('Response is larger than 10 MB.'); }
        chunks.push(chunk);
      }
      return { status: res.status, ok: res.ok, url: target.href, headers: Object.fromEntries(res.headers), body: Buffer.concat(chunks).toString('utf8') };
    }
    throw new Error('Too many redirects.');
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Project helpers

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.DS_Store', '.hg', '.svn', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

const FILE_LIMIT = 250000;

// Lists files breadth-first, reading several directories at once (much faster on cold disks).
async function walk(root, { ignored = DEFAULT_IGNORES, limit = FILE_LIMIT } = {}) {
  const files = [];
  let queue = [root];
  while (queue.length && files.length < limit) {
    const batch = queue.splice(0, 32);
    const listings = await Promise.all(batch.map((dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => [])));
    listings.forEach((entries, i) => {
      for (const e of entries) {
        if (ignored.has(e.name)) continue;
        const full = path.join(batch[i], e.name);
        if (e.isDirectory()) queue.push(full);
        else if (e.isFile() && files.length < limit) files.push(full);
      }
    });
  }
  return files;
}

// Linux: Node's recursive fs.watch adds an inotify watch for every directory, including
// node_modules, and fails with ENOSPC on big projects. Watch only directories we care about,
// stop at a budget, and add watches for directories created later.
const LINUX_WATCH_BUDGET = 20000;
function watchTree(root, ignored, onEvent, onLimit) {
  const dirs = new Map(); // dir -> FSWatcher
  let closed = false;
  let limited = false;
  const add = async (dir) => {
    if (closed || dirs.has(dir)) return;
    if (dirs.size >= LINUX_WATCH_BUDGET) { if (!limited) { limited = true; onLimit(dirs.size); } return; }
    try {
      const w = fss.watch(dir, (_type, name) => {
        if (!name) return;
        const full = path.join(dir, name);
        onEvent(full);
        if (!ignored.has(name)) fs.stat(full).then((s) => { if (s.isDirectory()) add(full); }, () => { dirs.get(full)?.close(); dirs.delete(full); });
      });
      w.on('error', () => { w.close(); dirs.delete(dir); });
      dirs.set(dir, w);
    } catch (err) {
      if (err.code === 'ENOSPC' && !limited) { limited = true; onLimit(dirs.size); }
      return;
    }
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) if (e.isDirectory() && !ignored.has(e.name)) await add(path.join(dir, e.name));
  };
  add(root);
  return { close() { closed = true; for (const w of dirs.values()) w.close(); dirs.clear(); } };
}

const SEARCH_WORKER = path.join(ROOT, 'src/main/search-worker.cjs');
let searchWorkerSource = null;

/** Search in a worker thread with a time limit, so a pathological regex can't freeze the app. */
async function searchProject(root, query, { regex = false, caseSensitive = false, ignored, maxResults = 2000 } = {}, timeoutMs = 15000) {
  searchWorkerSource ??= await fs.readFile(SEARCH_WORKER, 'utf8'); // read via fs so it also works inside app.asar
  const worker = new Worker(searchWorkerSource, { eval: true, workerData: { root, query, regex, caseSensitive, ignored: ignored || [...DEFAULT_IGNORES], maxResults } });
  const results = [];
  return new Promise((resolve) => {
    // On timeout keep what was found so far; a stuck regex is the usual cause, a huge cold repo the other.
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ results, truncated: true, timedOut: true, notice: regex
        ? `Search stopped after ${timeoutMs / 1000}s. Showing what was found so far; a simpler regular expression may help.`
        : `Search stopped after ${timeoutMs / 1000}s. Showing what was found so far; narrow it with a folder filter.` });
    }, timeoutMs);
    worker.on('message', (m) => {
      if (m.partial) { results.push(...m.partial); return; }
      clearTimeout(timer);
      worker.terminate();
      if (m.error) return resolve({ error: m.error, results: [] });
      resolve({ results, truncated: m.truncated, notice: m.filesLimited ? `Searched the first ${m.searched.toLocaleString()} files only. Use a folder filter to search the rest.` : undefined });
    });
    worker.once('error', (err) => { clearTimeout(timer); resolve({ error: err.message, results: [] }); });
  });
}

// ---------------------------------------------------------------------------
// Windows

const windows = new Set();
// Set by ⌘Q / app.quit(): once every window has confirmed its unsaved changes, quit for real.
let quitting = false;
const watchers = new Map(); // `${webContents.id}:${key}` -> FSWatcher
const procs = new Map(); // `${wcId}:${id}` -> ChildProcess
const ptys = new Map(); // `${wcId}:${id}` -> IPty
// Exits we're still waiting for. node-pty aborts the process if an exit arrives while Node is
// shutting down, so quitting waits for these first (see will-quit).
const pendingPtyExits = new Set();

function createWindow(projectPath, { restore = false } = {}) {
  // Test mode: MINIMIDE_WINDOW=1440x810 sets the window size (used for demo recordings).
  const [testW, testH] = (SCREENSHOT && process.env.MINIMIDE_WINDOW || '').split('x').map(Number);
  const win = new BrowserWindow({
    width: testW || 1280,
    height: testH || 820,
    minWidth: 520,
    minHeight: 360,
    show: false,
    title: 'Minimide',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e2128' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(ROOT, 'src/preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Test mode only: lets automated tests script dialog answers (see test:answers below).
      additionalArguments: SCREENSHOT ? ['--mide-test'] : [],
      // Test windows are never shown; without this, Chromium slows their frames and timers to a crawl.
      backgroundThrottling: !SCREENSHOT,
    },
  });
  windows.add(win);
  win.__project = projectPath ?? null;
  win.__forceClose = false;
  win.__restore = restore;

  const wcId = win.webContents.id;
  win.webContents.on('console-message', (e) => {
    if (DEV || SCREENSHOT) console.log(`[renderer:${e.level}] ${e.message}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('mide://app/')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => {
    if (!SCREENSHOT) win.show();
    // On CI a never-shown window gets no frames, so the editor can't measure or redraw. Show it there
    // without focus; locally tests stay hidden so they don't pop up over your work.
    else if (process.env.CI) win.showInactive();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', (e) => {
    if (win.__forceClose || win.webContents.isCrashed() || !win.__rendererReady) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
    // If the page never answers (hung package, frozen renderer), offer to close anyway.
    clearTimeout(win.__closeTimer);
    win.__closeTimer = setTimeout(async () => {
      if (win.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: 'Minimide is not responding.', detail: 'Close the window anyway? Unsaved changes in it will be lost.',
        buttons: ['Close Anyway', 'Keep Waiting'], defaultId: 1, cancelId: 1,
      });
      if (response === 0 && !win.isDestroyed()) { win.__forceClose = true; win.close(); }
      else quitting = false;
    }, 4000);
  });

  // Everything a page started dies with the page: on close, reload/navigation, or a renderer crash.
  const cleanup = () => {
    for (const [key, w] of watchers) if (key.startsWith(`${wcId}:`)) { w.close(); watchers.delete(key); }
    for (const [key, child] of procs) if (key.startsWith(`${wcId}:`)) { killTree(child); procs.delete(key); }
    for (const [key, term] of ptys) if (key.startsWith(`${wcId}:`)) { try { term.kill(); } catch {} ptys.delete(key); }
  };
  win.webContents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) cleanup(); });
  win.webContents.on('render-process-gone', () => { cleanup(); win.__forceClose = true; });
  win.on('closed', () => {
    windows.delete(win);
    cleanup();
  });

  win.loadURL('mide://app/index.html');

  if (SCREENSHOT) {
    // Test hook: MINIMIDE_EVAL=<file.js> runs a script in the renderer (it may return a promise) before capturing.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.MINIMIDE_EVAL) {
          try {
            const result = await win.webContents.executeJavaScript(await fs.readFile(process.env.MINIMIDE_EVAL, 'utf8'));
            if (result !== undefined) console.log('[eval]', typeof result === 'string' ? result : JSON.stringify(result));
          } catch (err) { console.log('[eval error]', err.message); }
          await new Promise((r) => setTimeout(r, 700));
        }
        // Quit even if the capture fails (it can, on virtual displays in CI).
        try {
          const img = await win.webContents.capturePage();
          await fs.writeFile(SCREENSHOT, img.toPNG());
          console.log(`[screenshot] wrote ${SCREENSHOT}`);
        } catch (err) { console.log(`[screenshot] failed: ${err.message}`); }
        win.__forceClose = true;
        app.quit();
      }, Number(process.env.MINIMIDE_SCREENSHOT_DELAY || 2500));
    });
  }
  return win;
}

function focusedWin() {
  return BrowserWindow.getFocusedWindow() || [...windows][0];
}

function sendCommand(id) {
  focusedWin()?.webContents.send('app:command', id);
}

const updater = createUpdater({ devBuild: DEV_BUILD });
const remoteSsh = createRemoteSsh({ userDir: USER_DIR, devBuild: DEV_BUILD });
app.on('will-quit', () => remoteSsh.dispose());
let restartAfterUpdate = false;

// ---------------------------------------------------------------------------
// IPC

// Only Minimide's own page may use the native bridge.
const trustedSender = (event) => (event.senderFrame?.url || '').startsWith('mide://app/');
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error(`Blocked IPC "${channel}" from ${event.senderFrame?.url || 'unknown frame'}`);
    return fn(event, ...args);
  });
}

// Windows looks in the current folder before PATH, so a project could plant git.exe. Resolve bare
// command names from PATH ourselves (elsewhere they're left to the OS, which only uses PATH).
function resolveCommand(cmd) {
  if (!IS_WIN || /[\\/]/.test(cmd)) return cmd;
  const exts = path.extname(cmd) ? [''] : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) { const full = path.join(dir, cmd + ext); if (fss.existsSync(full)) return full; }
  }
  return cmd;
}

// Windows: run a command line through cmd.exe exactly as written (no libuv re-quoting).
// The bytes of a PNG data URL, or an error: the type, size and signature are all checked.
const MAX_CLIPBOARD_IMAGE = 20 * 1024 * 1024;
const MAX_WRITE_IMAGE = 50 * 1024 * 1024;
function pngFromDataUrl(dataUrl, maxBytes) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new Error('Only PNG images are accepted');
  if ((dataUrl.length - prefix.length) * 0.75 > maxBytes) throw new Error(`The image is too large (over ${Math.round(maxBytes / 1048576)} MB)`);
  const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('That is not a PNG image');
  return bytes;
}

const winQuote = (a) => (/^[\w.\\/:=-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);
const winShell = (commandLine) => [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { windowsVerbatimArguments: true, windowsHide: true }];

// Import from VS Code and settings sync. The test overrides are ignored in packaged builds.
const vscodeReader = createVscodeReader({ home: os.homedir(), platform: process.platform, appData: process.env.APPDATA, override: DEV_BUILD ? process.env.MINIMIDE_VSCODE_DIR : undefined });
const secrets = createSecrets({ file: path.join(USER_DIR, 'secrets.json'), safeStorage, plain: DEV_BUILD && process.env.MINIMIDE_SECRETS_PLAIN === '1' });
const gist = createGist({
  secrets, fetch: (url, opts) => net.fetch(url, opts), version: app.getVersion(),
  apiBase: (DEV_BUILD && process.env.MINIMIDE_GIST_API) || undefined,
  // `gh auth token` through the login shell, so Homebrew's gh is found when launched from the Dock.
  gh: () => new Promise((resolve, reject) => {
    const bin = DEV_BUILD && process.env.MINIMIDE_GH_BIN;
    const [cmd, args] = bin ? [bin, ['auth', 'token']] : IS_WIN ? [resolveCommand('gh'), ['auth', 'token']] : [USER_SHELL, ['-lc', 'gh auth token']];
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim().split(/\r?\n/).pop() || '')));
  }),
  getId: async () => (await readState()).settingsSync?.gistId || null,
  setId: (id) => saveState({ settingsSync: { gistId: id } }, { trusted: true }),
});

function registerIpc() {
  // AI requests (packages/ai). Tests point them at a fake API server.
  registerAi({ handle, userDir: USER_DIR, testBaseUrl: DEV_BUILD ? process.env.MINIMIDE_AI_BASE_URL : null });
  // filesystem
  handle('fs:read', (_e, p) => fs.readFile(p, 'utf8'));
  handle('fs:write', async (_e, p, data) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); });
  handle('fs:readdir', async (_e, p) => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.map((d) => ({ name: d.name, path: path.join(p, d.name), isDir: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(p, d.name))) }));
  });
  handle('fs:stat', async (_e, p) => {
    try { const s = await fs.stat(p); return { isDir: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtimeMs }; }
    catch { return null; }
  });
  handle('fs:readDataUrl', async (_e, p, maxBytes = 50 * 1024 * 1024) => {
    const stat = await fs.stat(p);
    if (stat.size > maxBytes) throw new Error(`File is too large to preview (${Math.round(stat.size / 1048576)} MB)`);
    const type = { '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif' }[path.extname(p).toLowerCase()]
      || MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
    return `data:${type};base64,${(await fs.readFile(p)).toString('base64')}`;
  });
  // Images the renderer drew or pasted (rendered code, screenshots): PNG only, checked before it touches the disk.
  handle('fs:writeDataUrl', async (_e, p, dataUrl) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Needs a full file path');
    const png = pngFromDataUrl(dataUrl, MAX_WRITE_IMAGE);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, png);
  });
  handle('fs:mkdir', (_e, p) => fs.mkdir(p, { recursive: true }));
  handle('fs:copy', (_e, from, to) => fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }));
  // Deletes and renames inside a remote folder's mirror are recorded for its next sync.
  handle('fs:rename', async (_e, a, b) => { await fs.rename(a, b); await remoteSsh.recordRename(a, b); });
  handle('fs:trash', async (_e, p) => { await shell.trashItem(p); await remoteSsh.recordTrash(p); });
  handle('fs:realpath', (_e, p) => fs.realpath(p).catch(() => null));
  handle('fs:watch', (event, root, key = 'project') => {
    const id = `${event.sender.id}:${key}`;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!root) return;
    try {
      let timer = null;
      let firstAt = 0;
      const changed = new Set();
      const flush = () => {
        timer = null;
        if (!event.sender.isDestroyed()) event.sender.send('fs:changed', [...changed], key);
        changed.clear();
      };
      const onEvent = (full) => {
        if (path.relative(root, full).split(path.sep).some((s) => s === '.git' || s === 'node_modules')) return;
        if (!changed.size) firstAt = Date.now();
        changed.add(full);
        clearTimeout(timer);
        // Debounce, but never hold changes back for more than half a second (e.g. during a build).
        timer = setTimeout(flush, Date.now() - firstAt > 500 ? 0 : 120);
      };
      let w;
      if (process.platform === 'linux') {
        w = watchTree(root, DEFAULT_IGNORES, onEvent, (count) => {
          if (!event.sender.isDestroyed()) event.sender.send('fs:watchLimited', root, count);
        });
      } else {
        w = fss.watch(root, { recursive: true }, (_type, filename) => { if (filename) onEvent(path.join(root, filename)); });
        w.on('error', () => {});
      }
      watchers.set(id, w);
    } catch (err) {
      console.warn('[watch]', err.message);
    }
  });

  // project
  handle('project:files', async (_e, root, ignored) => {
    const files = await walk(root, { ignored: ignored ? new Set(ignored) : DEFAULT_IGNORES });
    return files.map((f) => path.relative(root, f));
  });
  handle('project:search', (_e, root, query, opts) => searchProject(root, query, opts));
  // Called once the page is listening for close requests and open-path events.
  handle('project:initial', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return { project: null, restore: false, files: [] };
    w.__rendererReady = true;
    const files = w.__pendingFiles || [];
    w.__pendingFiles = [];
    return { project: w.__project ?? null, restore: !!w.__restore, files };
  });

  // dialogs
  // Test mode: queued answers replace native dialogs so scripted QA never blocks.
  const testAnswers = { confirm: [], saveAs: [], openFolder: [], openFile: [], menu: [] };
  const scripted = (kind) => (SCREENSHOT && testAnswers[kind].length ? { value: testAnswers[kind].shift() } : null);
  const shownMenus = []; // context menus answered from the script, for tests to inspect
  if (SCREENSHOT) handle('test:answers', (_e, kind, values) => { testAnswers[kind].push(...values); });
  if (SCREENSHOT) handle('test:menus', () => ({ shown: shownMenus.splice(0), accelerators: menuAccelerators }));
  // Test mode: capture the window as numbered JPEG frames in $MINIMIDE_FRAMES (for demo videos).
  let frameNo = 0;
  if (SCREENSHOT && process.env.MINIMIDE_FRAMES) handle('test:capture', async (event) => {
    const img = await event.sender.capturePage();
    const sized = img.getSize().width > 1920 ? img.resize({ width: 1920, quality: 'best' }) : img;
    await fs.writeFile(path.join(process.env.MINIMIDE_FRAMES, `frame-${String(frameNo++).padStart(5, '0')}.jpg`), sized.toJPEG(92));
  });

  handle('dialog:openFolder', async (event) => {
    const s = scripted('openFolder'); if (s) return s.value;
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openFile', async (event) => {
    const s = scripted('openFile'); if (s) return s.value;
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:saveAs', async (event, defaultPath) => {
    const s = scripted('saveAs'); if (s) return s.value;
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath });
    return r.canceled ? null : r.filePath;
  });
  handle('dialog:confirm', async (event, opts) => {
    const s = scripted('confirm'); if (s) return s.value;
    const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: opts.type || 'question',
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons || ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 1),
    });
    return r.response;
  });

  // native context menu: items = [{ id, label, accelerator?, enabled? } | { role } | { type: 'separator' }]
  // Accelerators are only shown: the renderer's keymap handles the keys.
  handle('menu:popup', (event, items) => new Promise((resolve) => {
    const s = scripted('menu');
    if (s) { shownMenus.push(items); return resolve(s.value); }
    let picked = null;
    const menu = Menu.buildFromTemplate(items.map((it) => it.type === 'separator' ? { type: 'separator' } : MENU_ROLES.has(it.role) ? { role: it.role } : {
      label: String(it.label), enabled: it.enabled !== false, click: () => { picked = it.id; },
      ...(validAccelerator(it.accelerator) ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
    }));
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => setTimeout(() => resolve(picked), 0) });
  }));

  // The renderer's current shortcuts, so the menu bar can show them.
  handle('menu:set-accelerators', (_e, map) => {
    menuAccelerators = Object.fromEntries(Object.entries(map || {}).filter(([id, acc]) => typeof id === 'string' && validAccelerator(acc)));
    buildMenu();
  });

  // shell & misc
  handle('shell:openExternal', (_e, url) => /^https?:|^mailto:/.test(url) && shell.openExternal(url));
  handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  handle('shell:openPath', (_e, p) => shell.openPath(p));
  handle('clipboard:write', (_e, text) => clipboard.writeText(text));
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:writeImage', async (_e, dataUrl) => {
    const png = pngFromDataUrl(dataUrl, MAX_CLIPBOARD_IMAGE);
    const img = nativeImage.createFromBuffer(png);
    if (img.isEmpty()) throw new Error('That is not a valid image');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return img.getSize();
  });
  // "Add to Dictionary" in the editor's right-click menu.
  handle('spell:addWord', (event, word) => {
    if (typeof word !== 'string' || !word || word.length > 100) throw new Error('Not a word');
    event.sender.session.addWordToSpellCheckerDictionary(word);
  });

  // processes
  handle('proc:exec', (_e, cmd, args = [], opts = {}) => new Promise((resolve) => {
    execFile(resolveCommand(cmd), args, { cwd: opts.cwd, timeout: opts.timeout ?? 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || (err && !stdout ? String(err.message) : '') }));
  }));
  handle('proc:spawn', (event, id, command, opts = {}) => {
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const env = { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', ...opts.env };
    const cwd = opts.cwd || os.homedir();
    const child = IS_WIN
      ? (([cmd, args, o]) => spawn(cmd, args, { ...o, cwd, env }))(winShell(command))
      : spawn(USER_SHELL, ['-lc', command], { cwd, env, detached: true });
    procs.get(key) && killTree(procs.get(key));
    procs.set(key, child);
    child.stdin.on('error', () => {}); // writing to a finished process must not crash the app
    const send = (ch, ...a) => { if (!sender.isDestroyed()) sender.send(ch, id, ...a); };
    child.stdout.on('data', (d) => send('proc:data', d.toString(), 'stdout'));
    child.stderr.on('data', (d) => send('proc:data', d.toString(), 'stderr'));
    child.on('error', (err) => send('proc:data', `${err.message}\n`, 'stderr'));
    child.on('close', (code, signal) => { if (procs.get(key) === child) procs.delete(key); send('proc:exit', code, signal); });
    return child.pid;
  });
  // JSON-RPC over stdio with Content-Length framing (LSP, DAP). Framing works on raw bytes,
  // so multi-byte characters split across chunks are handled correctly.
  handle('proc:spawnRpc', (event, id, argv, opts = {}) => {
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
    const env = { ...process.env, ...opts.env };
    const cwd = opts.cwd || os.homedir();
    // A login shell gives servers the user's PATH (npm globals, Homebrew, cargo, …). Detached so the
    // whole process group (servers often start helpers) can be killed together.
    const child = IS_WIN
      ? (([cmd, args, o]) => spawn(cmd, args, { ...o, cwd, env }))(winShell(argv.map(winQuote).join(' ')))
      : spawn(USER_SHELL, ['-lc', `exec ${argv.map(quote).join(' ')}`], { cwd, env, detached: true });
    procs.get(key) && killTree(procs.get(key));
    procs.set(key, child);
    const send = (ch, ...a) => { if (!sender.isDestroyed()) sender.send(ch, id, ...a); };
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
        const length = Number(m[1]);
        if (buffer.length < headerEnd + 4 + length) return;
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4 + length);
        send('proc:message', body);
      }
    });
    child.stderr.on('data', (d) => send('proc:data', d.toString(), 'stderr'));
    child.on('error', (err) => send('proc:data', `${err.message}\n`, 'stderr'));
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => { if (procs.get(key) === child) procs.delete(key); send('proc:exit', code, signal); });
    return child.pid;
  });
  handle('proc:send', (event, id, json) => {
    const child = procs.get(`${event.sender.id}:${id}`);
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    return true;
  });
  handle('proc:write', (event, id, data) => {
    const child = procs.get(`${event.sender.id}:${id}`);
    if (child?.stdin.writable) child.stdin.write(data);
  });
  handle('proc:kill', (event, id) => killTree(procs.get(`${event.sender.id}:${id}`)));

  // pseudo-terminals (integrated terminal, code runner)
  handle('term:available', () => !!pty);
  handle('term:create', (event, id, opts = {}) => {
    if (!pty) throw new Error('Terminal support (node-pty) is not available in this build.');
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const isWin = process.platform === 'win32';
    const shell = opts.shell || (isWin ? process.env.COMSPEC || 'powershell.exe' : USER_SHELL);
    // Interactive sessions get a login shell; commands run through one so PATH and aliases match.
    const args = opts.command
      ? (isWin ? ['/d', '/s', '/c', opts.command] : ['-l', '-c', opts.command])
      : (isWin ? [] : ['-l']);
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Minimide',
      TERM_PROGRAM_VERSION: app.getVersion(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      ...opts.env,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let cwd = opts.cwd && safeIsDir(opts.cwd) ? opts.cwd : os.homedir();
    const term = pty.spawn(shell, args, { name: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24, cwd, env });
    const exited = new Promise((resolve) => term.onExit(resolve)).then(() => pendingPtyExits.delete(exited));
    pendingPtyExits.add(exited);
    try { ptys.get(key)?.kill(); } catch {}
    ptys.set(key, term);
    // Coalesce output so a flood (e.g. `cat bigfile`) doesn't drown the IPC channel.
    let buffer = '';
    let timer = null;
    const flush = () => { timer = null; if (buffer && !sender.isDestroyed()) sender.send('term:data', id, buffer); buffer = ''; };
    term.onData((data) => { buffer += data; if (!timer) timer = setTimeout(flush, 4); });
    term.onExit(({ exitCode, signal }) => {
      flush();
      if (ptys.get(key) === term) ptys.delete(key);
      if (!sender.isDestroyed()) sender.send('term:exit', id, exitCode, signal);
    });
    return { pid: term.pid, shell: path.basename(shell) };
  });
  handle('term:write', (event, id, data) => { ptys.get(`${event.sender.id}:${id}`)?.write(data); });
  handle('term:resize', (event, id, cols, rows) => {
    try { ptys.get(`${event.sender.id}:${id}`)?.resize(Math.max(2, cols), Math.max(1, rows)); } catch {}
  });
  handle('term:kill', (event, id, signal) => {
    const term = ptys.get(`${event.sender.id}:${id}`);
    if (!term) return;
    try { process.platform === 'win32' ? term.kill() : term.kill(signal || 'SIGHUP'); } catch {}
  });

  // Import from VS Code: read-only, by install id, limited to its settings and theme files (see vscode.js).
  handle('vscode:scan', () => vscodeReader.scan());
  handle('vscode:read', (_e, id) => vscodeReader.read(String(id)));
  handle('vscode:theme', (_e, id, name) => vscodeReader.theme(String(id), String(name)));

  // Settings sync: the token is stored encrypted and never handed back to the page. The page can
  // only ask for the gist calls below, which are fixed to the user's own sync gist.
  handle('secrets:set', (_e, name, value) => secrets.set(name, value));
  handle('secrets:has', (_e, name) => secrets.has(name));
  handle('secrets:delete', (_e, name) => secrets.delete(name));
  handle('gist:status', () => gist.status());
  handle('gist:cliAvailable', () => gist.cliAvailable());
  handle('gist:cliLogin', () => gist.cliLogin());
  handle('gist:upload', (_e, files) => gist.upload(files));
  handle('gist:download', () => gist.download());
  handle('gist:forget', () => gist.forget());

  // remote folders over SSH (see remote-ssh.js)
  handle('remote:connect', (_e, host, remotePath, ignoredNames) => remoteSsh.connect(host, remotePath, ignoredNames));
  handle('remote:lookup', (_e, p) => remoteSsh.lookup(p));
  handle('remote:sync', (_e, id, opts) => remoteSsh.sync(id, opts));
  handle('remote:push', (_e, id, file, opts) => remoteSsh.push(id, file, opts));
  handle('remote:pull', (_e, id, file) => remoteSsh.pull(id, file));
  handle('remote:disconnect', (_e, id) => remoteSsh.disconnect(id));
  handle('remote:terminalCommand', (_e, id) => remoteSsh.terminalCommand(id));

  // user dir, packages & state
  handle('user:info', () => ({ appRoot: ROOT, dir: USER_DIR, packagesDir: USER_PACKAGES, platform: process.platform, home: os.homedir(), shell: USER_SHELL, version: app.getVersion(), runDir: RUN_DIR,
    // Test runs only: treat every folder as trusted so suites don't stop at the trust prompt.
    trustAll: DEV_BUILD && process.env.MINIMIDE_TRUST_ALL === '1' }));
  // Workspace trust: folders whose tools (git, language servers) may run. Kept by the main process
  // so every window sees the same list; each entry is stored as given and as its real path.
  handle('trust:list', () => readTrusted());
  handle('trust:add', async (_e, folder) => {
    const list = await readTrusted();
    const real = await fs.realpath(folder).catch(() => folder);
    if (!list.some((t) => t.real === real)) list.push({ path: folder, real });
    await writeTrusted(list);
    return list;
  });
  handle('trust:remove', async (_e, folder) => {
    const real = await fs.realpath(folder).catch(() => folder);
    const list = (await readTrusted()).filter((t) => t.real !== real && t.path !== folder);
    await writeTrusted(list);
    return list;
  });
  handle('packages:list', () => listPackages());
  handle('update:check', () => updater.check());
  handle('update:prepare', (event, info) => updater.prepare(info, (fraction) => {
    if (!event.sender.isDestroyed()) event.sender.send('update:progress', fraction);
  }));
  handle('update:staged', () => updater.stagedVersion());
  // Quit through the normal path (so unsaved changes are still confirmed); will-quit applies it.
  handle('update:restart', () => { restartAfterUpdate = true; app.quit(); });
  handle('pkgmgr:stage', (_e, source) => packageManager.stage(source));
  handle('pkgmgr:install', (_e, id, grant) => packageManager.install(id, grant));
  handle('pkgmgr:discard', (_e, id) => packageManager.discard(id));
  handle('pkgmgr:uninstall', (_e, name) => packageManager.uninstall(name));
  handle('pkgmgr:grant', (_e, name, permissions, access) => packageManager.grant(name, permissions, access));
  handle('pkgmgr:checkUpdates', (_e, opts) => packageManager.checkUpdates({ force: !!opts?.force }));
  handle('pkgmgr:search', (_e, query, opts) => packageManager.search(String(query ?? ''), { sort: opts?.sort }));
  handle('pkgmgr:details', (_e, fullName) => packageManager.details(fullName));
  handle('pkgmgr:permissions', () => packageManager.PERMISSIONS);
  // Network access for sandboxed packages that were granted "network". http(s) only, size- and time-limited.
  handle('net:fetch', (_e, url, opts = {}) => safeFetch(url, opts));
  handle('state:load', () => readState());
  handle('state:save', (_e, state) => saveState(state));

  // window
  handle('window:new', (_e, project) => { createWindow(project); });
  handle('window:setTitle', (event, title) => BrowserWindow.fromWebContents(event.sender)?.setTitle(title));
  handle('window:setProject', (event, p) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.__project = p; });
  handle('window:close', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) { clearTimeout(w.__closeTimer); w.__forceClose = true; w.close(); }
  });
  handle('window:cancelClose', (event) => {
    quitting = false;
    restartAfterUpdate = false;
    clearTimeout(BrowserWindow.fromWebContents(event.sender)?.__closeTimer);
  });
  handle('window:toggleDevTools', (event) => event.sender.toggleDevTools());
  // The renderer draws an icon in the theme's colors; null puts the stock icon back.
  handle('window:setAppIcon', (event, dataUrl) => {
    let img = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') ? nativeImage.createFromDataURL(dataUrl) : null;
    if (!img || img.isEmpty()) {
      const stock = app.isPackaged && process.platform === 'darwin' ? path.join(process.resourcesPath, 'icon.icns') : path.join(ROOT, 'build/icon.png');
      img = nativeImage.createFromPath(stock);
      if (img.isEmpty()) return;
    }
    if (process.platform === 'darwin') app.dock?.setIcon(img);
    else BrowserWindow.fromWebContents(event.sender)?.setIcon(img);
  });
  handle('window:reload', (event) => event.sender.reload());
}

const TRUSTED_FILE = () => path.join(USER_DIR, 'trusted-folders.json');
async function readTrusted() {
  try { const v = JSON.parse(await fs.readFile(TRUSTED_FILE(), 'utf8')); return Array.isArray(v.folders) ? v.folders : []; } catch { return []; }
}
async function writeTrusted(list) {
  const tmp = `${TRUSTED_FILE()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ folders: list }, null, 2) + '\n');
  await fs.rename(tmp, TRUSTED_FILE());
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('trust:changed', list);
}

// A private folder for compiled programs the runner produces ({out}), instead of a guessable /tmp path.
const RUN_DIR = fss.mkdtempSync(path.join(os.tmpdir(), 'minimide-run-'));
app.on('will-quit', () => { try { fss.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {} });

// state.json is shared by every window: writes are queued, merged with what's on disk, and
// written to a temp file then renamed, so concurrent quits can't leave it half-written.
const STATE_FILE = () => path.join(USER_DIR, 'state.json');
let stateQueue = Promise.resolve();
let stateWrites = 0; // queued writes, so quitting can wait for them (see will-quit)
async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE(), 'utf8')); } catch { return {}; }
}
function saveState(incoming, { trusted = false } = {}) {
  stateWrites++;
  stateQueue = stateQueue.then(async () => {
    const disk = await readState();
    const merged = { ...disk, ...incoming, sessions: { ...disk.sessions, ...incoming.sessions } };
    // The sync gist id belongs to the main process: a page's older copy of the state can't change it.
    if (!trusted) { if (disk.settingsSync) merged.settingsSync = disk.settingsSync; else delete merged.settingsSync; }
    const tmp = `${STATE_FILE()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2));
    await fs.rename(tmp, STATE_FILE());
  }).catch((err) => console.warn('[state] save failed:', err.message)).finally(() => { stateWrites--; });
  return stateQueue;
}

function safeIsDir(p) {
  try { return fss.statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Application menu. Edit roles are required on macOS for clipboard shortcuts.

const MENU_ROLES = new Set(['cut', 'copy', 'paste', 'selectAll']);
const validAccelerator = (a) => typeof a === 'string' && /^[\w+\-=.,/\\;'`[\]]{1,40}$/.test(a);
let menuAccelerators = {}; // command id -> accelerator, from the renderer's keymap

function buildMenu() {
  // Explicit accelerators are real shortcuts; ones from the keymap are only shown.
  const cmd = (label, id, accelerator) => (accelerator
    ? { label, accelerator, click: () => sendCommand(id) }
    : { label, accelerator: menuAccelerators[id], registerAccelerator: false, click: () => sendCommand(id) });
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Minimide',
      submenu: [
        { role: 'about' }, cmd('Check for Updates…', 'app:check-for-updates'), { type: 'separator' },
        cmd('Settings…', 'settings:open', 'CmdOrCtrl+,'),
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        cmd('New File', 'file:new'),
        cmd('New Window', 'window:new', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        cmd('Open File…', 'file:open'),
        cmd('Open Folder…', 'project:open-folder'),
        { type: 'separator' },
        cmd('Save', 'file:save'),
        cmd('Save As…', 'file:save-as'),
        cmd('Save All', 'file:save-all'),
        { type: 'separator' },
        cmd('Close Tab', 'tab:close'),
        cmd('Close Window', 'window:close', 'CmdOrCtrl+Shift+W'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false },
        { role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false },
        { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll', registerAccelerator: false },
      ],
    },
    {
      label: 'View',
      submenu: [
        cmd('Command Palette', 'command-palette:toggle'),
        cmd('Toggle Sidebar', 'sidebar:toggle'),
        cmd('Toggle Panel', 'panel:toggle'),
        { type: 'separator' },
        cmd('Split Right', 'pane:split-right'),
        { type: 'separator' },
        cmd('Increase Font Size', 'editor:font-increase'),
        cmd('Decrease Font Size', 'editor:font-decrease'),
        cmd('Reset Font Size', 'editor:font-reset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        cmd('Reload Window', 'window:reload'),
        cmd('Toggle Developer Tools', 'window:toggle-dev-tools', isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I'),
      ],
    },
    {
      label: 'Go',
      submenu: [
        cmd('Back', 'navigate:back'),
        cmd('Forward', 'navigate:forward'),
        { type: 'separator' },
        cmd('Go to File…', 'fuzzy-finder:toggle'),
        cmd('Go to Symbol in File…', 'lsp:go-to-symbol'),
        cmd('Go to Symbol in Project…', 'lsp:go-to-workspace-symbol'),
        cmd('Go to Line…', 'editor:go-to-line'),
        { type: 'separator' },
        cmd('Go to Definition', 'lsp:go-to-definition'),
        cmd('Peek Definition', 'lsp:peek-definition'),
        cmd('Find References', 'lsp:find-references'),
        { type: 'separator' },
        cmd('Problems', 'lsp:toggle-problems'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [cmd('Keyboard Cheat Sheet', 'help:cheat-sheet'), cmd('All Keybindings…', 'help:keybindings'), { type: 'separator' }, cmd('Plugin API Docs', 'help:plugin-docs'), cmd('Open Packages Folder', 'packages:open-folder'), ...(isMac ? [] : [{ type: 'separator' }, cmd('Check for Updates…', 'app:check-for-updates')])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------

const gotLock = SCREENSHOT || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/** Folders and files named on the command line, resolved against the caller's working directory. */
function pathsFromArgv(argv, cwd = process.cwd()) {
  // In development argv is [electron, ".", …args]; packaged it's [Minimide, …args].
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && !a.startsWith('psn_'));
  const dirs = [];
  const files = [];
  for (const a of args) {
    const p = path.resolve(cwd, a);
    if (safeIsDir(p)) dirs.push(p);
    else if (fss.existsSync(p)) files.push(p);
  }
  return { dirs, files };
}

/** Deliver a file to a window, queuing it until that window's page is ready. */
function sendOpenPath(win, p) {
  if (win.__rendererReady) win.webContents.send('app:open-path', p);
  else (win.__pendingFiles ||= []).push(p);
}

// Files and folders handed to us by Finder, the Dock or `open -a Minimide`.
const pendingOpens = [];
function openPath(p) {
  if (safeIsDir(p)) return createWindow(p);
  const win = focusedWin() || createWindow();
  sendOpenPath(win, p);
  win.focus();
}
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) openPath(p);
  else pendingOpens.push(p);
});

app.on('second-instance', (_e, argv, workingDirectory) => {
  const { dirs, files } = pathsFromArgv(argv, workingDirectory);
  for (const d of dirs) createWindow(d);
  for (const f of files) openPath(f);
  if (!dirs.length && !files.length) focusedWin()?.focus();
});

app.whenReady().then(async () => {
  app.setName('Minimide');
  await ensureUserDir();
  await listPackages();
  protocol.handle('mide', handleProtocol);
  registerIpc();
  buildMenu();
  // Spell check (Markdown and plain text only; the editor turns it on per file). macOS uses the system's dictionaries.
  if (process.platform !== 'darwin') {
    const have = session.defaultSession.availableSpellCheckerLanguages;
    const locale = app.getLocale();
    session.defaultSession.setSpellCheckerLanguages([[locale, locale.split('-')[0], 'en-US'].find((l) => have.includes(l))].filter(Boolean));
  }
  app.setAboutPanelOptions({ applicationName: 'Minimide', applicationVersion: app.getVersion(), copyright: 'The editor you can read in an afternoon.' });
  // Deny-by-default for browser permission prompts (camera, mic, location…) packages might trigger.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['fullscreen', 'clipboard-sanitized-write'].includes(permission));
  const argvPaths = pathsFromArgv(process.argv);
  const initialDir = pendingOpens.find((p) => safeIsDir(p)) || argvPaths.dirs[0] || (DEV_BUILD && process.env.MINIMIDE_PROJECT) || undefined;
  const opened = !!(pendingOpens.length || argvPaths.dirs.length || argvPaths.files.length);
  const win = createWindow(initialDir, { restore: !opened });
  for (const d of argvPaths.dirs.slice(1)) createWindow(d);
  for (const f of [...pendingOpens.filter((p) => !safeIsDir(p)), ...argvPaths.files]) sendOpenPath(win, f);
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});

app.on('before-quit', () => { quitting = true; });
// A downloaded update is applied on the way out, whether the user picked "Restart" or quit later.
let ptysDrained = false;
let stateFlushed = false;
app.on('will-quit', (event) => {
  // Windows save their state as they close: let the last write finish, or it leaves a .tmp behind.
  if (!stateFlushed && stateWrites) {
    event.preventDefault();
    Promise.race([stateQueue, new Promise((r) => setTimeout(r, 1500))]).then(() => { stateFlushed = true; app.quit(); });
    return;
  }
  if (!ptysDrained && (ptys.size || pendingPtyExits.size)) {
    event.preventDefault();
    for (const term of ptys.values()) { try { term.kill(); } catch {} }
    ptys.clear();
    Promise.race([Promise.all([...pendingPtyExits]), new Promise((r) => setTimeout(r, 1500))]).then(() => { ptysDrained = true; app.quit(); });
    return;
  }
  updater.finish({ relaunch: restartAfterUpdate });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SCREENSHOT || quitting) app.quit();
});
