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
  'project-files': 'Read and change files in the open project',
  files: 'Read and change any file on your computer',
  shell: 'Run programs and commands on your computer',
  network: 'Connect to the internet',
  clipboard: 'Read your clipboard',
  commands: 'Run other Minimide commands',
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_UNPACKED = 100 * 1024 * 1024;
const GITHUB_TOPIC = 'minimide-package';

export function createPackageManager({ userDir, packagesDir, builtinNames, trash, version }) {
  const recordsFile = path.join(userDir, 'installed.json');
  const staged = new Map(); // id -> { dir, info }
  const headers = { 'user-agent': `Minimide/${version}`, accept: 'application/vnd.github+json' };

  async function readRecords() {
    try { return JSON.parse(await fs.readFile(recordsFile, 'utf8')).packages || {}; } catch { return {}; }
  }
  async function writeRecords(records) {
    const tmp = `${recordsFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ packages: records }, null, 2) + '\n');
    await fs.rename(tmp, recordsFile);
  }

  async function github(pathname) {
    const res = await net.fetch(`https://api.github.com${pathname}`, { headers });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting requests from this network. Try again in a minute.');
    if (res.status === 404) throw new Error('Repository not found. Check the name, and that it is public.');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    return res.json();
  }

  /** "owner/repo", "github:owner/repo", a github.com URL (optionally #ref), or an absolute folder path. */
  function parseSource(source) {
    const s = String(source || '').trim();
    if (path.isAbsolute(s) || s.startsWith('~/')) return { kind: 'folder', dir: s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s };
    const m = s.match(/^(?:github:|https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#([\w./-]+))?$/);
    if (!m) throw new Error('Enter a GitHub repository like "owner/name", a github.com link, or a folder path.');
    return { kind: 'github', owner: m[1], repo: m[2], ref: m[3] || null };
  }

  async function download(url, dest) {
    const res = await net.fetch(url, { headers: { 'user-agent': headers['user-agent'] } });
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
        await download(`https://codeload.github.com/${repo.full_name}/tar.gz/${commit.sha}`, archive);
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
      if (manifest.main !== false && !manifest.theme) {
        const main = path.resolve(root, manifest.main || 'index.js');
        if (!main.startsWith(root + path.sep)) throw new Error('The package\'s "main" points outside the package.');
        await fs.access(main).catch(() => { throw new Error(`The package's main file (${manifest.main || 'index.js'}) is missing.`); });
      }
      const asked = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      const id = path.basename(work);
      const records = await readRecords();
      const info = {
        id, name, displayName: manifest.displayName || name, description: manifest.description || '', version: manifest.version || '',
        access: manifest.access === 'full' ? 'full' : 'sandboxed',
        hasCode: manifest.main !== false && !manifest.theme,
        permissions: asked.filter((p) => p in PERMISSIONS),
        unknownPermissions: asked.filter((p) => !(p in PERMISSIONS)),
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
    records[name].permissions = permissions.filter((p) => p in PERMISSIONS);
    if (access) records[name].access = access === 'full' ? 'full' : 'sandboxed';
    await writeRecords(records);
    return records[name];
  }

  async function checkUpdates() {
    const records = await readRecords();
    const out = [];
    for (const [name, r] of Object.entries(records)) {
      if (!r.source?.startsWith('github:')) continue;
      try {
        const full = r.source.slice('github:'.length);
        const commit = await github(`/repos/${full}/commits/${encodeURIComponent(r.branch || 'HEAD')}`);
        if (commit.sha !== r.ref) out.push({ name, source: full + (r.branch ? `#${r.branch}` : ''), current: r.ref, latest: commit.sha });
      } catch (err) { out.push({ name, error: err.message }); }
    }
    return out;
  }

  async function search(query = '') {
    const q = encodeURIComponent(`topic:${GITHUB_TOPIC} ${query}`.trim());
    const res = await github(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=40`);
    const records = await readRecords();
    return res.items.map((r) => ({
      fullName: r.full_name, name: r.name, owner: r.owner?.login, description: r.description || '',
      stars: r.stargazers_count, url: r.html_url, updatedAt: r.pushed_at, installed: Object.values(records).some((x) => x.source === `github:${r.full_name}`),
    }));
  }

  return { stage, install, discard, uninstall, grant, checkUpdates, search, records: readRecords, PERMISSIONS };
}
