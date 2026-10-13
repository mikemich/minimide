// Minimide main process: windows, the mide:// protocol, and the native bridge.
import { app, BrowserWindow, Menu, protocol, ipcMain, dialog, shell, clipboard, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';

// node-pty is native and optional: without it the terminal falls back gracefully.
let pty = null;
try { pty = createRequire(import.meta.url)('node-pty'); } catch (err) { console.warn('[pty] unavailable:', err.message); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER_DIR = path.join(ROOT, 'dist/renderer');
const BUILTIN_PACKAGES = path.join(ROOT, 'packages');
const USER_DIR = process.env.MINIMIDE_HOME || path.join(os.homedir(), '.minimide');
const USER_PACKAGES = path.join(USER_DIR, 'packages');
const DEV = process.argv.includes('--dev');
const SCREENSHOT = process.env.MINIMIDE_SCREENSHOT;
// Apps launched from Finder/the Dock may not inherit $SHELL, so fall back to the user's login shell.
const USER_SHELL = process.env.SHELL || safeUserShell() || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');

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
async function listPackages() {
  const all = [...await readPackageDir(BUILTIN_PACKAGES, true), ...await readPackageDir(USER_PACKAGES, false)];
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
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  let file = null;
  if (url.host === 'app') file = within(RENDERER_DIR, parts.join('/') || 'index.html');
  else if (url.host === 'user') file = within(USER_DIR, parts.join('/'));
  else if (url.host === 'pkg') {
    // "name@stamp" lets the renderer bust the module cache for a whole package on reload.
    const pkg = packageIndex.get(parts.shift().replace(/@\d+$/, ''));
    if (pkg) file = within(pkg.dir, parts.join('/') || pkg.manifest.main || 'index.js');
  }
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Project helpers

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.DS_Store', '.hg', '.svn', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);

async function walk(root, { ignored = DEFAULT_IGNORES, limit = 50000 } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (ignored.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
  }
  return files;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.exe', '.dylib', '.so', '.o', '.a', '.class', '.jar', '.wasm', '.lock']);

async function searchProject(root, query, { regex = false, caseSensitive = false, ignored, maxResults = 2000 } = {}) {
  if (!query) return { results: [], truncated: false };
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { error: err.message, results: [] };
  }
  const files = await walk(root, { ignored: ignored ? new Set(ignored) : DEFAULT_IGNORES });
  const results = [];
  let count = 0;
  for (const file of files) {
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2_000_000) continue;
      text = await fs.readFile(file, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const matches = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const line = lines[i];
      const m = re.exec(line);
      if (m) {
        matches.push({ line: i + 1, col: m.index, length: m[0].length || 1, text: line.slice(0, 400) });
        if (++count >= maxResults) break;
      }
    }
    if (matches.length) results.push({ file, matches });
    if (count >= maxResults) return { results, truncated: true };
  }
  return { results, truncated: false };
}

// ---------------------------------------------------------------------------
// Windows

const windows = new Set();
// Set by ⌘Q / app.quit(): once every window has confirmed its unsaved changes, quit for real.
let quitting = false;
const watchers = new Map(); // `${webContents.id}:${key}` -> FSWatcher
const procs = new Map(); // `${wcId}:${id}` -> ChildProcess
const ptys = new Map(); // `${wcId}:${id}` -> IPty

function createWindow(projectPath, { restore = false } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });

  win.on('closed', () => {
    windows.delete(win);
    for (const [key, w] of watchers) if (key.startsWith(`${wcId}:`)) { w.close(); watchers.delete(key); }
    for (const [key, child] of procs) if (key.startsWith(`${wcId}:`)) { child.kill(); procs.delete(key); }
    for (const [key, term] of ptys) if (key.startsWith(`${wcId}:`)) { try { term.kill(); } catch {} ptys.delete(key); }
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
        const img = await win.webContents.capturePage();
        await fs.writeFile(SCREENSHOT, img.toPNG());
        console.log(`[screenshot] wrote ${SCREENSHOT}`);
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

// ---------------------------------------------------------------------------
// IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => fn(event, ...args));
}

function registerIpc() {
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
  handle('fs:mkdir', (_e, p) => fs.mkdir(p, { recursive: true }));
  handle('fs:rename', (_e, a, b) => fs.rename(a, b));
  handle('fs:trash', (_e, p) => shell.trashItem(p));
  handle('fs:watch', (event, root, key = 'project') => {
    const id = `${event.sender.id}:${key}`;
    watchers.get(id)?.close();
    watchers.delete(id);
    if (!root) return;
    try {
      let timer = null;
      const changed = new Set();
      const w = fss.watch(root, { recursive: true }, (_type, filename) => {
        if (!filename || filename.split(path.sep).some((s) => s === '.git' || s === 'node_modules')) return;
        changed.add(path.join(root, filename));
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!event.sender.isDestroyed()) event.sender.send('fs:changed', [...changed], key);
          changed.clear();
        }, 120);
      });
      w.on('error', () => {});
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
  handle('project:initial', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return { project: w?.__project ?? null, restore: !!w?.__restore };
  });

  // dialogs
  handle('dialog:openFolder', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openFile', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:saveAs', async (event, defaultPath) => {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { defaultPath });
    return r.canceled ? null : r.filePath;
  });
  handle('dialog:confirm', async (event, opts) => {
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

  // native context menu: items = [{ id, label, accelerator?, enabled? } | { type: 'separator' }]
  handle('menu:popup', (event, items) => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate(items.map((it) => it.type === 'separator' ? it : {
      label: it.label, enabled: it.enabled !== false, click: () => { picked = it.id; },
    }));
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => setTimeout(() => resolve(picked), 0) });
  }));

  // shell & misc
  handle('shell:openExternal', (_e, url) => /^https?:|^mailto:/.test(url) && shell.openExternal(url));
  handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  handle('shell:openPath', (_e, p) => shell.openPath(p));
  handle('clipboard:write', (_e, text) => clipboard.writeText(text));
  handle('clipboard:read', () => clipboard.readText());

  // processes
  handle('proc:exec', (_e, cmd, args = [], opts = {}) => new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || (err && !stdout ? String(err.message) : '') }));
  }));
  handle('proc:spawn', (event, id, command, opts = {}) => {
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const shellPath = USER_SHELL;
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shellPath, args, {
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', ...opts.env },
      detached: process.platform !== 'win32',
    });
    procs.set(key, child);
    const send = (ch, ...a) => { if (!sender.isDestroyed()) sender.send(ch, id, ...a); };
    child.stdout.on('data', (d) => send('proc:data', d.toString(), 'stdout'));
    child.stderr.on('data', (d) => send('proc:data', d.toString(), 'stderr'));
    child.on('error', (err) => send('proc:data', `${err.message}\n`, 'stderr'));
    child.on('close', (code, signal) => { procs.delete(key); send('proc:exit', code, signal); });
    return child.pid;
  });
  // JSON-RPC over stdio with Content-Length framing (LSP, DAP). Framing works on raw bytes,
  // so multi-byte characters split across chunks are handled correctly.
  handle('proc:spawnRpc', (event, id, argv, opts = {}) => {
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
    const shellPath = USER_SHELL;
    // A login shell gives servers the user's PATH (npm globals, Homebrew, cargo, …).
    const child = process.platform === 'win32'
      ? spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: true })
      : spawn(shellPath, ['-lc', `exec ${argv.map(quote).join(' ')}`], { cwd: opts.cwd || os.homedir(), env: { ...process.env, ...opts.env } });
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
    child.on('close', (code, signal) => { procs.delete(key); send('proc:exit', code, signal); });
    return child.pid;
  });
  handle('proc:send', (event, id, json) => {
    const child = procs.get(`${event.sender.id}:${id}`);
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    return true;
  });
  handle('proc:write', (event, id, data) => procs.get(`${event.sender.id}:${id}`)?.stdin.write(data));
  handle('proc:kill', (event, id) => {
    const child = procs.get(`${event.sender.id}:${id}`);
    if (!child) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  });

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
    ptys.set(key, term);
    // Coalesce output so a flood (e.g. `cat bigfile`) doesn't drown the IPC channel.
    let buffer = '';
    let timer = null;
    const flush = () => { timer = null; if (buffer && !sender.isDestroyed()) sender.send('term:data', id, buffer); buffer = ''; };
    term.onData((data) => { buffer += data; if (!timer) timer = setTimeout(flush, 4); });
    term.onExit(({ exitCode, signal }) => {
      flush();
      ptys.delete(key);
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

  // user dir, packages & state
  handle('user:info', () => ({ appRoot: ROOT, dir: USER_DIR, packagesDir: USER_PACKAGES, platform: process.platform, home: os.homedir(), shell: USER_SHELL, version: app.getVersion() }));
  handle('packages:list', () => listPackages());
  handle('state:load', async () => {
    try { return JSON.parse(await fs.readFile(path.join(USER_DIR, 'state.json'), 'utf8')); } catch { return {}; }
  });
  handle('state:save', (_e, state) => fs.writeFile(path.join(USER_DIR, 'state.json'), JSON.stringify(state, null, 2)));

  // window
  handle('window:new', (_e, project) => { createWindow(project); });
  handle('window:setTitle', (event, title) => BrowserWindow.fromWebContents(event.sender)?.setTitle(title));
  handle('window:setProject', (event, p) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.__project = p; });
  handle('window:close', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) { w.__forceClose = true; w.close(); }
  });
  handle('window:cancelClose', () => { quitting = false; });
  handle('window:toggleDevTools', (event) => event.sender.toggleDevTools());
  handle('window:reload', (event) => event.sender.reload());
}

function safeIsDir(p) {
  try { return fss.statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Application menu. Edit roles are required on macOS for clipboard shortcuts.

function buildMenu() {
  const cmd = (label, id, accelerator) => ({ label, accelerator, click: () => sendCommand(id) });
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Minimide',
      submenu: [
        { role: 'about' }, { type: 'separator' },
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
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [cmd('Plugin API Docs', 'help:plugin-docs'), cmd('Open Packages Folder', 'packages:open-folder')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------

const gotLock = SCREENSHOT || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function projectFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.');
  const candidate = args[args.length - 1];
  return candidate && safeIsDir(path.resolve(candidate)) ? path.resolve(candidate) : null;
}

// Files and folders handed to us by Finder, the Dock or `open -a Minimide`.
const pendingOpens = [];
function openPath(p) {
  if (safeIsDir(p)) return createWindow(p);
  const win = focusedWin();
  if (win) win.webContents.send('app:open-path', p);
  else createWindow().webContents.once('did-finish-load', () => setTimeout(() => focusedWin()?.webContents.send('app:open-path', p), 800));
}
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (app.isReady()) openPath(p);
  else pendingOpens.push(p);
});

app.on('second-instance', (_e, argv) => {
  const p = projectFromArgv(argv);
  if (p) createWindow(p);
  else focusedWin()?.focus();
});

app.whenReady().then(async () => {
  app.setName('Minimide');
  await ensureUserDir();
  await listPackages();
  protocol.handle('mide', handleProtocol);
  registerIpc();
  buildMenu();
  app.setAboutPanelOptions({ applicationName: 'Minimide', applicationVersion: app.getVersion(), copyright: 'The editor you can read in an afternoon.' });
  const initialDir = pendingOpens.find((p) => safeIsDir(p));
  const win = createWindow(initialDir || projectFromArgv(process.argv) || process.env.MINIMIDE_PROJECT || undefined, { restore: !initialDir });
  const files = pendingOpens.filter((p) => !safeIsDir(p));
  if (files.length) win.webContents.once('did-finish-load', () => setTimeout(() => files.forEach((f) => win.webContents.send('app:open-path', f)), 800));
  app.on('activate', () => { if (windows.size === 0) createWindow(); });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SCREENSHOT || quitting) app.quit();
});
