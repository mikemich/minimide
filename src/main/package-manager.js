// Installs packages from GitHub (or a local folder) into ~/.minimide/packages.
//
// Installing is two steps so the user can see what they're getting first:
//   stage(source)  downloads and inspects the package into a temp folder, then returns its
//                  name, access level and the permissions it asks for;
//   install(id)    moves it into place and records what the user agreed to.
//
// What was agreed lives in ~/.minimide/installed.json, outside the package folders, so a
// package can't ship a file that grants itself more access.
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { net } from 'electron';

export const PERMISSIONS = {
  'project-files': 'Read files in the open project',
  'project-write': 'Change files in the open project (except git\'s and node_modules\' internals; tools can still run code from project files, so only allow this for packages you trust)',
  files: 'Read and change any file on your computer (this is close to full access: it could change files that run code)',
  shell: 'Run programs and commands on your computer (this is the same as full access)',
  network: 'Connect to the internet',
  clipboard: 'Read your clipboard',
  commands: 'Run other Minimide commands',
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Names the core uses for its own commands and settings ("core.theme", "settings:open"…). A
// package with one of these names would pass the "own namespace only" checks for them.
const RESERVED = new Set(['app', 'core', 'editor', 'ui', 'file', 'help', 'packages', 'package', 'pane', 'panel', 'pkg', 'project', 'settings',
  'sidebar', 'tab', 'theme', 'window', 'workspace', 'user', 'native', 'mide', 'minimide', 'sandbox', 'update', 'updates', 'system', 'test']);
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_UNPACKED = 100 * 1024 * 1024;
const GITHUB_TOPIC = 'minimide-package';
const SEARCH_TTL = 2 * 60 * 1000; // searches and READMEs are kept this long, to stay clear of GitHub's rate limits
const DETAILS_TTL = 5 * 60 * 1000;
const UPDATE_CHECK_EVERY = 24 * 3600 * 1000;
const MAX_README = 400 * 1024;
const OFFLINE = "Can't reach GitHub. Check your internet connection and try again.";

const isPermission = (p) => typeof p === 'string' && Object.hasOwn(PERMISSIONS, p);

/** What a package.json says about the package, in the shape the install dialog and the details page show. */
function describeManifest(manifest) {
  const asked = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  return {
    name: manifest.name, displayName: manifest.displayName || manifest.name, description: manifest.description || '', version: manifest.version || '',
    access: manifest.access === 'full' ? 'full' : 'sandboxed',
    hasCode: manifest.main !== false && !manifest.theme,
    permissions: asked.filter(isPermission),
    unknownPermissions: asked.filter((p) => !isPermission(p)),
  };
}

/**
 * apiBase replaces https://api.github.com (the tests point it at a fake server; main.js only passes it
 * in dev builds). With it set, downloads and raw files come from <apiBase>/_codeload and <apiBase>/_raw.
 */
export function createPackageManager({ userDir, packagesDir, builtinNames, trash, version, apiBase }) {
  const recordsFile = path.join(userDir, 'installed.json');
  const updatesFile = path.join(userDir, 'package-updates.json'); // what the last update check found, so it runs once a day
  const staged = new Map(); // id -> { dir, info }
  const headers = { 'user-agent': `Minimide/${version}`, accept: 'application/vnd.github+json' };
  const API = (apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const CODELOAD = apiBase ? `${API}/_codeload` : 'https://codeload.github.com';
  const RAW = apiBase ? `${API}/_raw` : 'https://raw.githubusercontent.com';
  const cache = new Map(); // key -> { at, promise }

  async function readRecords() {
    try { return JSON.parse(await fs.readFile(recordsFile, 'utf8')).packages || {}; } catch { return {}; }
  }
  async function writeRecords(records) {
    const tmp = `${recordsFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ packages: records }, null, 2) + '\n');
    await fs.rename(tmp, recordsFile);
  }

  /** Remembers a result for a while (and a load in progress, so two callers share one request). */
  function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    const entry = { at: Date.now(), promise: load() };
    cache.set(key, entry);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.promise;
  }

  async function githubRequest(pathname, accept) {
    let res;
    try { res = await net.fetch(`${API}${pathname}`, { headers: accept ? { ...headers, accept } : headers }); } catch { throw new Error(OFFLINE); }
    if (res.status === 403 || res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || retry) {
        const seconds = retry || Number(res.headers.get('x-ratelimit-reset')) - Date.now() / 1000;
        const minutes = Math.max(1, Math.ceil(seconds / 60) || 1);
        const err = new Error(`GitHub's ${pathname.startsWith('/search') ? 'search' : 'request'} limit was reached; try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        err.rateLimited = true;
        throw err;
      }
      throw new Error('GitHub refused the request (403). Is this network blocked from GitHub?');
    }
    if (!res.ok) {
      const err = new Error(res.status === 404 ? 'Repository not found. Check the name, and that it is public.' : `GitHub returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }
  const github = async (pathname) => (await githubRequest(pathname)).json();
  const githubText = async (pathname) => (await githubRequest(pathname, 'application/vnd.github.raw+json')).text();
  const orNull = (promise) => promise.catch((err) => (err.status === 404 ? null : Promise.reject(err)));

  /** "owner/repo", "github:owner/repo", a github.com URL (optionally #ref), or an absolute folder path. */
  function parseSource(source) {
    const s = String(source || '').trim();
    if (path.isAbsolute(s) || s.startsWith('~/')) return { kind: 'folder', dir: s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s };
    const m = s.match(/^(?:github:|https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#([\w./-]+))?$/);
    if (!m) throw new Error('Enter a GitHub repository like "owner/name", a github.com link, or a folder path.');
    return { kind: 'github', owner: m[1], repo: m[2], ref: m[3] || null };
  }

  async function download(url, dest) {
    const res = await net.fetch(url, { headers: { 'user-agent': headers['user-agent'] } }).catch(() => { throw new Error(OFFLINE); });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) throw new Error('This package is larger than 50 MB.');
      chunks.push(chunk);
    }
    await fs.writeFile(dest, Buffer.concat(chunks));
  }

  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });

  // Refuse links (they could point outside the package) and absurd sizes.
  async function checkTree(dir) {
    let files = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) throw new Error(`The package contains a link (${path.relative(dir, full)}), which isn't allowed.`);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!e.isFile()) throw new Error(`The package contains an unsupported file (${path.relative(dir, full)}).`);
        if (++files > MAX_FILES) throw new Error(`The package has more than ${MAX_FILES} files.`);
        bytes += (await fs.stat(full)).size;
        if (bytes > MAX_UNPACKED) throw new Error('The package is larger than 100 MB unpacked.');
      }
    }
  }

  async function stage(source) {
    const src = parseSource(source);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'minimide-pkg-'));
    try {
      let root;
      let meta;
      if (src.kind === 'github') {
        const repo = await github(`/repos/${src.owner}/${src.repo}`);
        const commit = await github(`/repos/${repo.full_name}/commits/${encodeURIComponent(src.ref || repo.default_branch)}`);
        const archive = path.join(work, 'package.tar.gz');
        await download(`${CODELOAD}/${repo.full_name}/tar.gz/${commit.sha}`, archive);
        const out = path.join(work, 'x');
        await fs.mkdir(out);
        // bsdtar (macOS, Windows) and GNU tar both refuse entries that escape the target by default.
        await run('tar', ['-xzf', archive, '-C', out]);
        const top = (await fs.readdir(out, { withFileTypes: true })).filter((e) => e.isDirectory());
        if (top.length !== 1) throw new Error('Unexpected archive layout.');
        root = path.join(out, top[0].name);
        meta = { source: `github:${repo.full_name}`, ref: commit.sha, repoUrl: repo.html_url, branch: src.ref || repo.default_branch };
      } else {
        const stat = await fs.stat(src.dir).catch(() => null);
        if (!stat?.isDirectory()) throw new Error(`${src.dir} is not a folder.`);
        root = path.join(work, 'x');
        await fs.cp(src.dir, root, { recursive: true, verbatimSymlinks: true, filter: (p) => !/[\\/](\.git|node_modules)$/.test(p) });
        meta = { source: `folder:${src.dir}`, ref: null, repoUrl: null };
      }
      await checkTree(root);
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { throw new Error('This repository has no valid package.json at its root.'); }
      const name = manifest.name;
      if (!NAME_RE.test(name || '')) throw new Error(`"${name}" isn't a valid package name (use lowercase letters, numbers and dashes).`);
      if (builtinNames().has(name)) throw new Error(`"${name}" is the name of a built-in package.`);
      if (RESERVED.has(name)) throw new Error(`"${name}" is reserved for Minimide itself. Rename the package.`);
      if (manifest.main !== false && !manifest.theme) {
        const main = path.resolve(root, manifest.main || 'index.js');
        if (!main.startsWith(root + path.sep)) throw new Error('The package\'s "main" points outside the package.');
        await fs.access(main).catch(() => { throw new Error(`The package's main file (${manifest.main || 'index.js'}) is missing.`); });
      }
      const id = path.basename(work);
      const records = await readRecords();
      const info = {
        id, ...describeManifest(manifest),
        existing: records[name] || null,
        localConflict: !records[name] && !!(await fs.stat(path.join(packagesDir, name)).catch(() => null)),
        ...meta,
      };
      staged.set(id, { work, root, info });
      setTimeout(() => discard(id), 30 * 60 * 1000).unref?.();
      return info;
    } catch (err) {
      await fs.rm(work, { recursive: true, force: true });
      throw err;
    }
  }

  async function discard(id) {
    const s = staged.get(id);
    if (!s) return;
    staged.delete(id);
    await fs.rm(s.work, { recursive: true, force: true });
  }

  /** grant: { permissions: [...] } — what the user agreed to (a subset of what was asked). */
  async function install(id, grant = {}) {
    const s = staged.get(id);
    if (!s) throw new Error('That download has expired. Try installing again.');
    const { info } = s;
    const target = path.join(packagesDir, info.name);
    const records = await readRecords();
    if (await fs.stat(target).catch(() => null)) {
      if (!records[info.name]) throw new Error(`You already have a package folder named "${info.name}". Rename or remove it first.`);
      await trash(target);
    }
    await fs.mkdir(packagesDir, { recursive: true });
    try { await fs.rename(s.root, target); } catch { await fs.cp(s.root, target, { recursive: true }); }
    records[info.name] = {
      source: info.source, ref: info.ref, branch: info.branch, version: info.version, access: info.access,
      permissions: (grant.permissions || []).filter((p) => info.permissions.includes(p)),
      installedAt: new Date().toISOString(),
    };
    await writeRecords(records);
    await discard(id);
    cache.delete(`details:${info.source.replace(/^github:/, '').toLowerCase()}`);
    return records[info.name];
  }

  async function uninstall(name) {
    if (!NAME_RE.test(name)) throw new Error('Invalid package name.');
    const records = await readRecords();
    const target = path.join(packagesDir, name);
    if (await fs.stat(target).catch(() => null)) await trash(target);
    delete records[name];
    await writeRecords(records);
  }

  /** Record a permission change the user approved after an update asked for more. */
  async function grant(name, permissions, access) {
    const records = await readRecords();
    if (!records[name]) throw new Error(`${name} wasn't installed with the package manager.`);
    records[name].permissions = permissions.filter(isPermission);
    if (access) records[name].access = access === 'full' ? 'full' : 'sandboxed';
    await writeRecords(records);
    return records[name];
  }

  // --- updates -------------------------------------------------------------
  // The commit each GitHub package's branch was at when we last looked is kept in package-updates.json.
  // An update is pending while that differs from the commit that was installed, so the "update
  // available" badges need no network, and a check runs at most once a day unless forced.
  async function readUpdateCache() {
    try {
      const c = JSON.parse(await fs.readFile(updatesFile, 'utf8'));
      return { checkedAt: Number(c.checkedAt) || 0, latest: c.latest && typeof c.latest === 'object' ? c.latest : {} };
    } catch { return { checkedAt: 0, latest: {} }; }
  }

  const githubFull = (r) => (r.source?.startsWith('github:') ? r.source.slice('github:'.length) : null);

  function pendingUpdates(records, latest) {
    const out = [];
    for (const [name, r] of Object.entries(records)) {
      const full = githubFull(r);
      if (full && latest[name] && latest[name] !== r.ref) out.push({ name, fullName: full, source: full + (r.branch ? `#${r.branch}` : ''), current: r.ref, latest: latest[name] });
    }
    return out;
  }

  /**
   * Compares each installed GitHub package with the latest commit on its branch.
   * Returns { checkedAt, updates: [{ name, fullName, source, current, latest }], errors: [{ name, error }] }.
   * Without `force` a check made in the last day is reused.
   */
  async function checkUpdates({ force = false } = {}) {
    const records = await readRecords();
    let state = await readUpdateCache();
    const errors = [];
    if (force || Date.now() - state.checkedAt > UPDATE_CHECK_EVERY) {
      const latest = {};
      let tried = 0;
      for (const [name, r] of Object.entries(records)) {
        const full = githubFull(r);
        if (!full) continue;
        tried++;
        try {
          latest[name] = (await github(`/repos/${full}/commits/${encodeURIComponent(r.branch || 'HEAD')}`)).sha;
        } catch (err) {
          errors.push({ name, error: err.message });
          if (err.rateLimited) break;
        }
      }
      // Nothing could be checked (offline, rate-limited): say so, and try again next time.
      if (tried && !Object.keys(latest).length) throw new Error(errors[0].error);
      state = { checkedAt: Date.now(), latest };
      await fs.writeFile(updatesFile, JSON.stringify(state) + '\n').catch(() => {});
      for (const key of [...cache.keys()]) if (key.startsWith('details:')) cache.delete(key);
    }
    return { checkedAt: state.checkedAt, updates: pendingUpdates(records, state.latest), errors };
  }

  // --- browsing ------------------------------------------------------------
  const installedFrom = (records) => new Map(Object.entries(records).filter(([, r]) => githubFull(r)).map(([name, r]) => [githubFull(r).toLowerCase(), { name, ...r }]));

  /** Repositories with the minimide-package topic. sort: 'stars' | 'updated'. */
  async function search(query = '', { sort = 'stars' } = {}) {
    if (sort !== 'updated') sort = 'stars';
    const q = `topic:${GITHUB_TOPIC} ${String(query).trim()}`.trim();
    const items = await cached(`search:${sort}:${q}`, SEARCH_TTL, async () => (await github(`/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=40`)).items || []);
    const records = await readRecords();
    const mine = installedFrom(records);
    const pending = new Set(pendingUpdates(records, (await readUpdateCache()).latest).map((u) => u.name));
    return items.map((r) => {
      const own = mine.get(String(r.full_name).toLowerCase());
      return {
        fullName: r.full_name, name: r.name, owner: r.owner?.login, description: r.description || '',
        stars: r.stargazers_count, url: r.html_url, updatedAt: r.pushed_at,
        installed: !!own, installedName: own?.name || null, installedVersion: own?.version || '', updateAvailable: !!own && pending.has(own.name),
      };
    });
  }

  /**
   * Everything the details page shows for a repository, read from GitHub before anything is
   * downloaded: the repository, its README, and its package.json (so the permissions it will ask for
   * are known before installing). Install itself re-reads them from the exact commit it downloads.
   */
  async function details(fullName) {
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(fullName || ''));
    if (!m) throw new Error('That is not a GitHub repository name.');
    const data = await cached(`details:${fullName.toLowerCase()}`, DETAILS_TTL, async () => {
      const repo = await github(`/repos/${m[1]}/${m[2]}`);
      const [manifestText, readme] = await Promise.all([
        orNull(githubText(`/repos/${repo.full_name}/contents/package.json`)),
        orNull(githubText(`/repos/${repo.full_name}/readme`)),
      ]);
      let manifest = null;
      let problem = null;
      if (manifestText == null) problem = "This repository has no package.json at its root, so it can't be installed.";
      else {
        try { manifest = describeManifest(JSON.parse(manifestText)); } catch { problem = "Its package.json isn't valid JSON, so it can't be installed."; }
      }
      if (manifest) {
        if (!NAME_RE.test(manifest.name || '')) problem = `"${manifest.name}" isn't a valid package name.`;
        else if (builtinNames().has(manifest.name)) problem = `"${manifest.name}" is the name of a built-in package.`;
        else if (RESERVED.has(manifest.name)) problem = `"${manifest.name}" is reserved for Minimide itself.`;
      }
      return {
        repo: {
          fullName: repo.full_name, name: repo.name, owner: repo.owner?.login, description: repo.description || '', stars: repo.stargazers_count,
          url: repo.html_url, updatedAt: repo.pushed_at, branch: repo.default_branch, license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '',
        },
        manifest, problem,
        readme: readme == null ? null : readme.slice(0, MAX_README),
        // Where the README's relative links and images point.
        rawBase: `${RAW}/${repo.full_name}/${repo.default_branch}/`,
        blobBase: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/`,
      };
    });
    const records = await readRecords();
    const own = installedFrom(records).get(data.repo.fullName.toLowerCase());
    const pending = own && pendingUpdates(records, (await readUpdateCache()).latest).some((u) => u.name === own.name);
    return {
      ...data,
      installed: own ? { name: own.name, version: own.version || '', access: own.access, permissions: own.permissions || [], branch: own.branch } : null,
      updateAvailable: !!pending,
    };
  }

  return { stage, install, discard, uninstall, grant, checkUpdates, search, details, records: readRecords, PERMISSIONS };
}
