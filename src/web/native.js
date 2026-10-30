// window.native for the browser demo. The app talks to Electron only through window.native
// (see src/preload/preload.cjs); here the same calls run against an in-memory file system holding
// a sample project, kept in localStorage so edits survive a reload. Things a web page can't do
// (terminals, git, installing packages) answer with a pointer to the desktop app.
// With ?repo=owner/name it holds a public GitHub repo instead: the file list comes from the GitHub
// API, file contents are fetched when first read, and nothing is saved (see github.js).
import { SAMPLE_FILES, USER_FILES } from './sample.js';
import { readRepoRequest, loadTree, fetchText, rawUrl, parseRepoInput, RepoError, MAX_FILE, BINARY, IMAGE } from './github.js';

const BASE = new URL('./', location.href).href;
const HOME = '/home/you';
const SAMPLE_PROJECT = `${HOME}/hello-minimide`;
const USER_DIR = `${HOME}/.minimide`;
const STORE = 'minimide-demo-fs-v1';
const STATE = 'minimide-demo-state-v1';
// Need a desktop: language servers, terminals, running code and git.
const LEFT_OUT = new Set(['lsp', 'terminal', 'runner', 'git', 'git-blame', 'source-control', 'debugger', 'ai', 'settings-sync', 'vscode-import', 'remote-ssh', 'local-history', 'git-history', 'inlay-hints', 'git-hunks', 'test-explorer']);
const DESKTOP_ONLY = 'This needs the desktop app. Download Minimide from GitHub to use it.';

// --- which project: the sample, or a GitHub repo -------------------------------------

const query = new URLSearchParams(location.search);
const request = readRepoRequest(query);
let repoMode = !!request && !request.error; // false again if the repo can't be opened
export let PROJECT = repoMode ? `${HOME}/${request.name}` : SAMPLE_PROJECT;
/** What main.js shows about it: the open repo, or why it couldn't be opened. */
export const repo = { active: false, slug: '', ref: '', start: null, error: request?.error || '', notices: [] };
// The tests serve a fake GitHub from their own local server (?gh=/fake); a real page can't redirect requests.
const GH = { api: 'https://api.github.com', raw: 'https://raw.githubusercontent.com' };
if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && /^\/\w+$/.test(query.get('gh') || '')) {
  GH.api = `${location.origin}${query.get('gh')}/api`;
  GH.raw = `${location.origin}${query.get('gh')}/raw`;
}

// --- in-memory file system ----------------------------------------------------

const files = new Map(); // path -> { text, mtime }. In a repo, text is null until first read and `remote` is the path in the repo
const dirs = new Set(['/']);
const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const within = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
const notFound = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

/** Creates p and its missing parents; returns the folders it created. */
function addDirs(p) {
  const made = [];
  for (let d = p; !dirs.has(d); d = dirname(d)) { dirs.add(d); made.push(d); }
  return made;
}
function putEntry(p, entry) {
  const made = addDirs(dirname(p));
  files.set(p, entry);
  return made;
}
const putFile = (p, text) => putEntry(p, { text, mtime: Date.now() });

function seed() {
  if (!repoMode) for (const [rel, text] of Object.entries(SAMPLE_FILES)) putFile(`${PROJECT}/${rel}`, text);
  for (const [rel, text] of Object.entries(USER_FILES)) putFile(`${USER_DIR}/${rel}`, text);
  addDirs(`${USER_DIR}/packages`);
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch {}
  if (!saved?.files) return seed();
  // A repo borrows the saved settings only; the saved sample project stays as it is.
  const keep = (p) => !repoMode || within(p, USER_DIR);
  for (const d of saved.dirs || []) if (keep(d)) addDirs(d);
  for (const [p, text] of Object.entries(saved.files)) if (keep(p)) putFile(p, text);
  if (repoMode && !files.has(`${USER_DIR}/config.json`)) seed();
}
load();

let saveTimer = null;
function persist() {
  if (repoMode) return; // changes to a repo stay in this tab
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ dirs: [...dirs], files: Object.fromEntries([...files].map(([p, f]) => [p, f.text])) })); } catch {}
  }, 300);
}

/** Start over with the sample project (the demo's "Reset" link). */
export function resetDemo() {
  try { localStorage.removeItem(STORE); localStorage.removeItem(STATE); } catch {}
}

// Change events, like the app's file watcher: debounced, per watch key.
const watches = new Map(); // key -> root
const listeners = new Set();
const pending = new Set();
let emitTimer = null;
function changed(...paths) {
  persist();
  for (const p of paths) pending.add(p);
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => {
    const all = [...pending];
    pending.clear();
    for (const [key, root] of watches) {
      const hit = all.filter((p) => within(p, root));
      if (hit.length) for (const fn of listeners) fn(hit, key);
    }
  }, 80);
}

const subtree = (p) => [...files.keys()].filter((f) => within(f, p));

// --- a GitHub repo as the project -----------------------------------------------------

const SEARCH_FETCHES = 300; // new files one search may download
let source = null; // { owner, name, branch } of the open repo
const inflight = new Map(); // file entry -> its download, so two reads share one request

const remoteUrl = (f) => rawUrl(GH.raw, source, source.branch, f.remote);
const placeholder = (rel, why) => `This file isn't shown in the browser demo (${why}).\nSee it on GitHub: https://github.com/${source.owner}/${source.name}/blob/${source.branch}/${rel}\n`;

/** Makes sure an entry's text is here, downloading it the first time it's read. */
async function ensure(p) {
  const f = files.get(p);
  if (!f) throw notFound(p);
  if (f.text != null) return f;
  if (!inflight.has(f)) {
    inflight.set(f, fetchText(remoteUrl(f)).then((text) => { f.text ??= text; }).finally(() => inflight.delete(f)));
  }
  await inflight.get(f);
  return f;
}

async function openRepo() {
  const { owner, name } = request;
  const tree = await loadTree(request, GH.api);
  source = { owner, name, branch: tree.branch };
  const root = PROJECT;
  const now = Date.now();
  addDirs(root);
  for (const d of tree.dirs) addDirs(`${root}/${d}`);
  for (const { path, size } of tree.files) {
    const entry = { text: null, mtime: now, size, remote: path };
    // Pictures open in the viewer, straight from GitHub; the rest of these get a short note instead.
    const why = IMAGE.test(path) ? 'it is an image' : BINARY.test(path) ? 'it is a binary file' : size > MAX_FILE ? 'it is over 1 MB' : null;
    if (why) { entry.text = placeholder(path, why); entry.skip = true; }
    putEntry(`${root}/${path}`, entry);
  }
  Object.assign(repo, { active: true, slug: `${owner}/${name}`, ref: tree.branch });
  if (tree.capped) repo.notices.push(`${owner}/${name} has more than ${tree.files.length.toLocaleString()} files, so only the first ${tree.files.length.toLocaleString()} are listed.`);
  else if (tree.truncated) repo.notices.push(`${owner}/${name} is too big for GitHub to list in full, so some files are missing.`);
  // What to open first: the requested file, or the README.
  const wanted = request.path && files.has(`${root}/${request.path}`) ? request.path : null;
  if (request.path && !wanted) repo.notices.push(`There is no ${request.path} in ${owner}/${name}.`);
  repo.start = wanted || tree.files.find((f) => /^readme(\.\w+)?$/i.test(f.path))?.path || null;
  if (repo.start) repo.start = `${root}/${repo.start}`;
}

/** Couldn't open the repo: say why, and carry on with the sample project. */
function backToSample(err) {
  repo.error = err instanceof RepoError ? err.message : "Couldn't open that repo.";
  repoMode = false;
  PROJECT = SAMPLE_PROJECT;
  files.clear();
  dirs.clear();
  dirs.add('/');
  load();
}

/** Where to go to open a repo ("owner/name", or a github.com address), or null if that isn't one. */
export function repoAddress(text) {
  const slug = parseRepoInput(text);
  if (!slug) return null;
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('repo', slug);
  return url.href;
}

const fs = {
  async read(p) { return (await ensure(p)).text; },
  async readText(p) { return { text: (await ensure(p)).text, encoding: 'utf8', bom: false }; },
  async writeDataUrl() { throw new Error(DESKTOP_ONLY); },
  async readDataUrl(p) {
    const f = files.get(p);
    if (!f) throw notFound(p);
    if (f.remote && f.skip && IMAGE.test(f.remote)) return remoteUrl(f);
    const type = p.endsWith('.svg') ? 'image/svg+xml' : 'text/plain';
    return `data:${type};charset=utf-8,${encodeURIComponent((await ensure(p)).text)}`;
  },
  async write(p, data) { changed(p, ...putFile(p, String(data))); }, // new folders too, as the real watcher reports them
  async readdir(p) {
    if (!dirs.has(p)) throw notFound(p);
    const names = new Map();
    for (const d of dirs) if (d !== p && dirname(d) === p) names.set(basename(d), true);
    for (const f of files.keys()) if (dirname(f) === p) names.set(basename(f), false);
    return [...names].map(([name, isDir]) => ({ name, path: p === '/' ? `/${name}` : `${p}/${name}`, isDir }));
  },
  async stat(p) {
    const f = files.get(p);
    if (f) return { isDir: false, isFile: true, size: f.text?.length ?? f.size, mtime: f.mtime };
    return dirs.has(p) ? { isDir: true, isFile: false, size: 0, mtime: 0 } : null;
  },
  async mkdir(p) { changed(p, ...addDirs(p)); },
  async copy(from, to) {
    if (files.has(to) || dirs.has(to)) throw new Error(`EEXIST: file already exists, '${to}'`);
    if (files.has(from)) { changed(to, ...putEntry(to, { ...files.get(from), mtime: Date.now() })); return; }
    if (!dirs.has(from)) throw notFound(from);
    const made = addDirs(to);
    for (const d of [...dirs]) if (within(d, from)) addDirs(to + d.slice(from.length));
    for (const f of subtree(from)) putEntry(to + f.slice(from.length), { ...files.get(f), mtime: Date.now() }); // a repo file not read yet stays unread
    changed(to, ...made);
  },
  async rename(a, b) {
    if (!dirs.has(dirname(b))) throw notFound(dirname(b)); // like fs.rename: the target folder must exist
    if (files.has(a)) { putEntry(b, files.get(a)); files.delete(a); changed(a, b); return; }
    if (!dirs.has(a)) throw notFound(a);
    for (const d of [...dirs]) if (within(d, a)) { dirs.delete(d); addDirs(b + d.slice(a.length)); }
    for (const f of subtree(a)) { putEntry(b + f.slice(a.length), files.get(f)); files.delete(f); }
    changed(a, b);
  },
  async trash(p) {
    for (const f of subtree(p)) files.delete(f);
    for (const d of [...dirs]) if (within(d, p)) dirs.delete(d);
    changed(p);
  },
  async realpath(p) { return files.has(p) || dirs.has(p) ? p : null; },
  async watch(root, key = 'project') { if (root) watches.set(key, root); else watches.delete(key); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  onWatchLimited: () => () => {},
};

// --- project files and search -----------------------------------------------------

function projectFiles(root, ignored = []) {
  const skip = new Set(ignored);
  return [...files.keys()]
    .filter((f) => within(f, root) && f !== root)
    .map((f) => f.slice(root.length + 1))
    .filter((rel) => !rel.split('/').some((part) => skip.has(part)))
    .sort();
}

/** In a repo: downloads the files a search needs (at most SEARCH_FETCHES new ones). Returns a note when that left some out. */
async function fetchForSearch(paths) {
  const unread = paths.filter((p) => files.get(p).text == null);
  const wanted = unread.slice(0, SEARCH_FETCHES);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < wanted.length && !stopped) {
      try { await ensure(wanted[next++]); } catch (err) { if (err.kind === 'rate') stopped = true; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const left = unread.length - wanted.length;
  if (stopped) return 'GitHub is limiting downloads for now, so only the files already opened were searched.';
  if (left > 0) return `Searched ${(paths.length - left).toLocaleString()} of ${paths.length.toLocaleString()} files: a search downloads at most ${SEARCH_FETCHES} new ones. Search again to look through more.`;
}

// Same answers as the app's search worker: nothing for an empty query, the first match on a line.
async function search(root, query, { regex = false, caseSensitive = false, ignored, maxResults = 2000 } = {}) {
  if (!query) return { results: [], truncated: false };
  let re;
  try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi'); } catch (err) { return { error: err.message, results: [] }; }
  const results = [];
  let count = 0;
  const rels = projectFiles(root, ignored);
  const notice = repoMode ? await fetchForSearch(rels.filter((rel) => !files.get(`${root}/${rel}`).skip).map((rel) => `${root}/${rel}`)) : undefined;
  for (const rel of rels) {
    const file = `${root}/${rel}`;
    const entry = files.get(file);
    if (entry.skip || entry.text == null) continue; // a placeholder, or a repo file that wasn't downloaded
    const matches = [];
    entry.text.split('\n').forEach((line, l) => {
      re.lastIndex = 0;
      const m = count < maxResults && re.exec(line);
      if (m) { matches.push({ line: l + 1, col: m.index, length: m[0].length || 1, text: line.slice(0, 400) }); count++; }
    });
    if (matches.length) results.push({ file, matches });
  }
  return { results, truncated: count >= maxResults, notice };
}

// --- a small HTML context menu instead of the native one ---------------------------

let lastPointer = { x: 120, y: 120 };
window.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
window.addEventListener('contextmenu', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

const ROLE_LABELS = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' };
async function runRole(role) {
  if (role === 'paste') {
    const text = await navigator.clipboard.readText().catch(() => null);
    if (text != null) document.execCommand('insertText', false, text);
  } else document.execCommand(role);
}

function popupMenu(items) {
  return new Promise((resolve) => {
    document.querySelector('.web-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'web-menu';
    const focusBefore = document.activeElement;
    const done = (id) => { menu.remove(); window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); focusBefore?.focus?.(); resolve(id); };
    const outside = (e) => { if (!menu.contains(e.target)) done(null); };
    const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    for (const it of items) {
      if (it.type === 'separator') { menu.append(Object.assign(document.createElement('hr'))); continue; }
      const b = document.createElement('button');
      b.disabled = it.enabled === false;
      b.innerHTML = '<span></span><kbd></kbd>';
      b.firstChild.textContent = it.label || ROLE_LABELS[it.role] || it.role;
      b.lastChild.textContent = (it.accelerator || '').replace(/Cmd\+|Command\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃');
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { if (it.role) { done(null); runRole(it.role); } else done(it.id); };
      menu.append(b);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(lastPointer.x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(lastPointer.y, innerHeight - r.height - 8)}px`;
    window.addEventListener('keydown', escape, true);
    setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
  });
}

// --- a small HTML dialog instead of the native one (window.confirm can't offer three choices) ---

function askDialog({ message, detail, buttons = ['OK', 'Cancel'], cancelId }) {
  const cancel = cancelId ?? buttons.length - 1;
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'web-dialog-backdrop';
    const box = document.createElement('div');
    box.className = 'web-dialog';
    box.setAttribute('role', 'dialog');
    const text = (cls, value) => { const el = document.createElement('div'); el.className = cls; el.textContent = value; return el; };
    box.append(text('web-dialog-message', message));
    if (detail) box.append(text('web-dialog-detail', detail));
    const row = document.createElement('div');
    row.className = 'web-dialog-buttons';
    const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(cancel); } };
    const done = (i) => { backdrop.remove(); window.removeEventListener('keydown', escape, true); resolve(i); };
    buttons.forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (i === 0) b.className = 'primary';
      b.onclick = () => done(i);
      row.append(b);
    });
    box.append(row);
    backdrop.append(box);
    document.body.append(backdrop);
    window.addEventListener('keydown', escape, true);
    row.firstChild.focus();
  });
}

// --- the bridge ---------------------------------------------------------------------

const desktopOnly = async () => { throw new Error(DESKTOP_ONLY); };
const noop = () => () => {};
const blobUrls = new Map();
const repoState = {}; // the app state while a repo is open: kept in memory only
const folders = new Map(); // package name -> its folder under pkg/ (themes live in theme-<name>)

window.native = {
  web: {
    userFileUrl(name) {
      URL.revokeObjectURL(blobUrls.get(name));
      const text = files.get(`${USER_DIR}/${name}`)?.text ?? '';
      const url = URL.createObjectURL(new Blob([text], { type: name.endsWith('.css') ? 'text/css' : 'text/javascript' }));
      blobUrls.set(name, url);
      return url;
    },
    packageUrl: (name) => `${BASE}pkg/${encodeURIComponent(folders.get(name) || name)}/`,
  },
  fs,
  project: {
    files: async (root, ignored) => projectFiles(root, ignored),
    search,
    initial: async () => {
      if (repoMode) await openRepo().catch(backToSample);
      return { project: PROJECT, restore: true, files: [] };
    },
  },
  dialog: {
    openFolder: async () => null,
    openFile: async () => [],
    saveAs: async (defaultPath) => window.prompt('Save as', defaultPath || `${PROJECT}/untitled.txt`) || null,
    confirm: async (opts) => askDialog(opts),
  },
  menu: { popup: popupMenu, setAccelerators: async () => {} },
  pkgmgr: {
    stage: desktopOnly, install: desktopOnly, discard: async () => {}, uninstall: desktopOnly, grant: desktopOnly,
    checkUpdates: async () => ({ checkedAt: 0, updates: [], errors: [] }), search: async () => [], details: desktopOnly, permissions: async () => ({}),
  },
  net: { fetch: desktopOnly },
  vscode: { scan: desktopOnly, read: desktopOnly, theme: desktopOnly },
  secrets: { set: desktopOnly, has: desktopOnly, delete: desktopOnly },
  gist: { status: desktopOnly, cliAvailable: desktopOnly, cliLogin: desktopOnly, upload: desktopOnly, download: desktopOnly, forget: desktopOnly },
  remote: {
    connect: desktopOnly, lookup: async () => null, sync: desktopOnly, push: desktopOnly, pull: desktopOnly,
    disconnect: async () => {}, terminalCommand: desktopOnly,
  },
  trust: { list: async () => [], add: async () => [], remove: async () => [], onChange: noop },
  updates: {
    check: async () => { throw new Error('The browser demo always runs the latest version. Download the app from GitHub.'); },
    prepare: desktopOnly, staged: async () => null, restart: async () => {}, onProgress: noop,
  },
  shell: {
    openExternal: async (url) => { if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener'); },
    reveal: async () => {},
    openPath: async () => {},
  },
  clipboard: {
    write: async (text) => navigator.clipboard.writeText(text).catch(() => {}),
    read: async () => navigator.clipboard.readText().catch(() => ''),
    writeImage: async (dataUrl) => {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return {};
    },
  },
  spell: { check: () => ({ misspelled: false, suggestions: [] }), addWord: async () => {} },
  proc: {
    exec: async () => ({ code: 127, stdout: '', stderr: DESKTOP_ONLY }),
    spawn: desktopOnly, write: async () => {}, kill: async () => {}, spawnRpc: desktopOnly, send: async () => {},
    onMessage: noop, onData: noop, onExit: noop,
  },
  ai: { status: async () => ({ savedKey: false, environmentKey: false }), setKey: desktopOnly, clearKey: async () => {}, start: desktopOnly, cancel: async () => {}, onEvent: noop },
  term: { available: async () => false, create: desktopOnly, write: async () => {}, resize: async () => {}, kill: async () => {}, onData: noop, onExit: noop },
  user: {
    info: async () => ({
      appRoot: BASE, dir: USER_DIR, packagesDir: `${USER_DIR}/packages`, platform: 'web', home: HOME, shell: '',
      version: __VERSION__, runDir: '/tmp', trustAll: true,
    }),
  },
  packages: {
    list: async () => {
      const list = (await (await fetch(`${BASE}packages.json`)).json()).filter((p) => !LEFT_OUT.has(p.name));
      for (const p of list) folders.set(p.name, p.folder);
      return list.map(({ folder, ...p }) => ({ ...p, dir: `/app/packages/${folder}`, builtin: true, url: `${BASE}pkg/${encodeURIComponent(folder)}/` }));
    },
  },
  state: {
    load: async () => {
      let disk = {};
      try { disk = JSON.parse(localStorage.getItem(STATE) || '{}'); } catch {}
      // In a repo only the app-wide bits carry over; its sessions and recent projects stay in this tab.
      return repoMode ? { ...(disk.welcomeShown && { welcomeShown: true }), ...repoState } : disk;
    },
    save: async (incoming) => {
      if (repoMode) {
        Object.assign(repoState, incoming);
        if (!incoming.welcomeShown) return;
        incoming = { welcomeShown: true }; // the one thing worth keeping: you've seen the tips
      }
      try {
        const disk = JSON.parse(localStorage.getItem(STATE) || '{}');
        localStorage.setItem(STATE, JSON.stringify({ ...disk, ...incoming, sessions: { ...disk.sessions, ...incoming.sessions } }));
      } catch {}
    },
  },
  window: {
    newWindow: async () => { window.open(location.href, '_blank', 'noopener'); },
    setTitle: async (title) => { document.title = title; },
    setProject: async () => {},
    close: async () => {},
    cancelClose: async () => {},
    toggleDevTools: async () => {},
    reload: async () => location.reload(),
    onCommand: noop,
    setAppIcon: async () => {},
    onRequestClose: noop,
    onOpenPath: noop,
  },
};
