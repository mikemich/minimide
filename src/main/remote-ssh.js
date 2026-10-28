// Remote folders over SSH. A remote folder is edited as a local mirror in
// ~/.minimide/remote/<host>/<hash>/<name>, kept in sync with the system's ssh and rsync, so the
// tree, search, git and language servers all just work on local files.
//
// remote.json (next to the mirror) remembers the host, the remote path, and for every file the
// remote and local size + mtime at the last sync. From that, each sync decides per file:
// changed remotely only -> download; changed locally only -> upload; both -> conflict (left
// alone, the renderer asks). A file missing locally is downloaded again: nothing is deleted
// remotely because it's missing here. Deletes and renames are recorded when they happen (see
// recordTrash / recordRename, called from the fs:trash / fs:rename handlers) and only applied
// to remote files that haven't changed since the last sync.
//
// Safety: hosts and remote roots are checked against a strict pattern (rsync passes host:path
// through the remote shell), every program runs from an argument array, and remote commands
// are sh scripts sent on stdin with every path single-quoted.
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@%+-]{0,252}$/;
const ROOT_RE = /^[\w./+@,=~-]+$/;
const HASH_RE = /^[0-9a-f]{12}$/;
const MAX_FILES = 20000;
const MAX_BYTES = 500 * 1024 * 1024;
const LOGIN_RE = /permission denied|password|passphrase|keyboard-interactive|host key verification failed|authenticity of host/i;

/** POSIX single quoting, for remote sh scripts. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// For the command lines handed to the terminal: bare when safe, single-quoted otherwise.
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : q(s));
const globEscape = (s) => s.replace(/[*?[\]\\]/g, '\\$&');

export function checkHost(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new Error(`"${String(host).slice(0, 80)}" isn't a host Minimide can use. Use a name like server, me@server.example.com, or a Host from ~/.ssh/config.`);
  }
  return host;
}

/** "~", "~/dir" or "/abs/dir", in a character set that's safe for rsync's remote shell. */
export function checkRemotePath(p) {
  if (typeof p !== 'string') throw new Error('Enter a folder path such as ~/project or /srv/app.');
  p = p.trim().replace(/(.)\/+$/, '$1');
  if (p === '~/') p = '~';
  const ok = (p === '~' || p.startsWith('~/') || p.startsWith('/')) && ROOT_RE.test(p) && !p.split('/').includes('..');
  if (!ok) throw new Error(`"${p.slice(0, 120)}" isn't a folder path Minimide can use. Start it with / or ~/, and use only letters, digits and . _ - + @ , = ~`);
  return p;
}

const rootSh = (p) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${q(p.slice(2))}` : q(p));
const relOk = (rel) => typeof rel === 'string' && rel && !rel.includes('\0') && !rel.startsWith('/')
  && rel.split('/').every((s) => s && s !== '.' && s !== '..');
const cleanNames = (names) => (Array.isArray(names) ? names : [])
  .filter((n) => typeof n === 'string' && n && n.length < 256 && !/[/\x00-\x1f\x7f]/.test(n) && n !== '.' && n !== '..');

class SshError extends Error {
  constructor(message, login) { super(message); this.login = login; }
}

export function createRemoteSsh({ userDir, devBuild }) {
  // Tests swap in a fake ssh that runs commands in a local folder.
  const sshBin = (devBuild && process.env.MINIMIDE_SSH_BIN) || 'ssh';
  // ~/.minimide/remote, spelled like the renderer's user dir (workspace trust compares the two).
  const base = () => path.join(userDir, 'remote');
  const mirrors = new Map(); // id ("host/hash") -> mirror
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // Connection sharing: one ssh login per host, reused by every call. The sockets live in a
  // private short path (macOS limits socket paths to ~104 bytes, too short for $TMPDIR).
  let ctlDir = null;
  const control = () => {
    ctlDir ??= fss.mkdtempSync('/tmp/mide-ssh-');
    return ['-o', `ControlPath=${ctlDir}/%C`];
  };
  const background = () => [...control(), '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15'];
  const masters = new Set();

  function run(cmd, args, { input, timeout = 120000, maxBytes = 64 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let size = 0;
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} took too long and was stopped.`)); }, timeout);
      child.stdout.on('data', (d) => { size += d.length; if (size > maxBytes) child.kill('SIGKILL'); else out.push(d); });
      child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT' ? new Error(`${cmd} isn't installed (or isn't on PATH). Remote folders need ssh and rsync.`) : err);
      });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: stderr.trim() }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
  }

  const lastLine = (s) => s.split('\n').filter(Boolean).pop() || '';

  /** Starts the shared connection unless it's up. Hosts that need a password throw a login SshError. */
  async function ensureMaster(host) {
    if ((await run(sshBin, [...control(), '-O', 'check', host], { timeout: 10000 })).code === 0) return;
    // Its stderr goes to a file: the master lives on in the background and would keep a pipe open.
    const log = path.join(ctlDir, `${host}.log`);
    const fd = fss.openSync(log, 'w', 0o600);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const child = spawn(sshBin, [...control(), '-o', 'ControlMaster=yes', '-o', 'ControlPersist=10m', '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-f', '-N', host], { env, stdio: ['ignore', 'ignore', fd] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
        child.on('error', (err) => { clearTimeout(timer); reject(err.code === 'ENOENT' ? new Error(`${sshBin} isn't installed (or isn't on PATH).`) : err); });
        child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      });
    } finally { fss.closeSync(fd); }
    if (code === 0) { masters.add(host); return; }
    const err = fss.readFileSync(log, 'utf8').trim();
    if (LOGIN_RE.test(err)) throw new SshError(`${host} asks for a password or a confirmation.`, true);
    throw new SshError(`Couldn't connect to ${host}${err ? `: ${lastLine(err)}` : '.'}`, false);
  }

  /** Runs an sh script on the host (sent on stdin, so nothing in it passes through ssh's command line). */
  async function sh(host, script, opts) {
    const r = await run(sshBin, [...background(), '-T', host, 'sh', '-s'], { input: script, ...opts });
    if (r.code === 255) throw new SshError(`Lost the connection to ${host}${r.stderr ? `: ${lastLine(r.stderr)}` : '.'}`, LOGIN_RE.test(r.stderr));
    return r;
  }

  const loginCommand = (host) => `${[sshBin, ...control(), '-o', 'ControlMaster=yes', '-o', 'ControlPersist=10m', '-f', '-N', host].map(shq).join(' ')}`
    + ` && echo ${q(`Connected to ${host}. You can close this tab.`)}`;

  // --- mirrors ---------------------------------------------------------------
  async function loadMirror(host, hash) {
    if (!HOST_RE.test(host) || !HASH_RE.test(hash)) return null;
    const id = `${host}/${hash}`;
    if (mirrors.has(id)) return mirrors.get(id);
    const dir = path.join(base(), host, hash);
    let state;
    try { state = JSON.parse(await fs.readFile(path.join(dir, 'remote.json'), 'utf8')); } catch { return null; }
    if (state.host !== host || typeof state.name !== 'string' || !relOk(state.name) || state.name.includes('/')) return null;
    state.files ??= {};
    state.pending ??= [];
    state.ignored = cleanNames(state.ignored);
    const m = { id, dir, root: path.join(dir, state.name), state, queue: Promise.resolve(), saving: Promise.resolve(), connected: false };
    mirrors.set(id, m);
    return m;
  }

  async function getMirror(id) {
    const [host, hash, extra] = typeof id === 'string' ? id.split('/') : [];
    const m = extra === undefined && host && hash ? await loadMirror(host, hash) : null;
    if (!m) throw new Error('That remote folder is no longer known to Minimide.');
    return m;
  }

  /** The mirror a local path belongs to, and the path relative to its root ('' for the root). */
  async function mirrorFor(p) {
    if (typeof p !== 'string' || !p.startsWith(base() + path.sep)) return null;
    const [host, hash, name, ...rest] = path.relative(base(), p).split(path.sep);
    const m = host && hash && name ? await loadMirror(host, hash) : null;
    if (!m || m.state.name !== name) return null;
    return { m, rel: rest.join('/') };
  }

  function save(m) {
    m.saving = m.saving.then(async () => {
      const file = path.join(m.dir, 'remote.json');
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(m.state));
      await fs.rename(tmp, file);
    }).catch((err) => console.warn('[remote] saving state failed:', err.message));
    return m.saving;
  }

  // One operation at a time per mirror; a host that wants a password again reports needsLogin.
  function queued(m, fn) {
    const next = m.queue.then(async () => {
      try {
        await ensureMaster(m.state.host);
        return await fn();
      } catch (err) {
        if (err.login) return { needsLogin: true, loginCommand: loginCommand(m.state.host) };
        throw err;
      }
    });
    m.queue = next.catch(() => {});
    return next;
  }

  // --- listing ---------------------------------------------------------------
  /** Remote files (all, or just `rels`) as Map rel -> { size, mtime } (whole seconds). */
  async function listRemote(m, rels) {
    const { host, abs, ignored } = m.state;
    const prune = ['.git', ...ignored].map((n) => `-name ${q(globEscape(n))}`).join(' -o ');
    const [start, expr] = rels ? [rels.map((r) => q(`./${r}`)).join(' '), '-maxdepth 0'] : ['.', `\\( ${prune} \\) -prune -o`];
    // GNU find prints sizes and times itself; elsewhere (BSD, macOS) stat does it.
    const script = `cd ${q(abs)} || exit 3
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
  find ${start} ${expr} -type f -printf '%s %T@ %p\\0'
else
  find ${start} ${expr} -type f -exec sh -c 'for f do printf "%s %s\\000" "$(stat -f "%z %m" "$f")" "$f"; done' sh {} +
fi${rels ? ' 2>/dev/null; exit 0' : ''}\n`;
    const r = await sh(host, script, { timeout: 180000 });
    if (r.code === 3) throw new Error(`The folder ${abs} is gone from ${host}.`);
    if (r.code !== 0) throw new Error(`Couldn't list the files on ${host}${r.stderr ? `: ${lastLine(r.stderr)}` : '.'}`);
    const files = new Map();
    let total = 0;
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      const match = /^(\d+) (\d+)(?:\.\d*)? \.\/(.+)$/s.exec(rec);
      if (!match || !relOk(match[3])) continue;
      const size = Number(match[1]);
      files.set(match[3], { size, mtime: Number(match[2]) });
      total += size;
    }
    if (!rels && (files.size > MAX_FILES || total > MAX_BYTES)) {
      const what = files.size > MAX_FILES ? `more than ${MAX_FILES.toLocaleString('en-US')} files` : `more than ${MAX_BYTES / 1048576} MB of files`;
      throw new Error(`${abs} on ${host} has ${what}, too many to keep a local copy of. Open a smaller folder, or add big folders to Settings → Ignored Names.`);
    }
    return files;
  }

  async function localStat(m, rel) {
    try {
      const s = await fs.lstat(path.join(m.root, rel));
      return s.isFile() ? { size: s.size, mtime: Math.floor(s.mtimeMs / 1000) } : null;
    } catch { return null; }
  }

  async function listLocal(m) {
    const ignored = new Set(['.git', ...m.state.ignored]);
    const files = new Map();
    let queue = [''];
    while (queue.length) {
      const batch = queue.splice(0, 32);
      const listings = await Promise.all(batch.map((dir) => fs.readdir(path.join(m.root, dir), { withFileTypes: true }).catch(() => [])));
      for (const [i, entries] of listings.entries()) {
        for (const e of entries) {
          if (ignored.has(e.name)) continue;
          const rel = batch[i] ? `${batch[i]}/${e.name}` : e.name;
          if (e.isDirectory()) queue.push(rel);
          else if (e.isFile()) { const s = await localStat(m, rel); if (s) files.set(rel, s); }
        }
      }
    }
    return files;
  }

  // --- transfers -------------------------------------------------------------
  async function rsync(m, rels, direction) {
    if (!rels.length) return;
    const remote = `${m.state.host}:${m.state.abs}/`;
    const local = `${m.root}/`;
    const args = ['-ptI', '--files-from=-', '-0', '-e', [sshBin, ...background()].join(' '),
      ...(direction === 'up' ? [local, remote] : [remote, local])];
    const r = await run('rsync', args, { input: rels.join('\0') + '\0', timeout: 30 * 60000 });
    // 23/24: some files couldn't be transferred (e.g. vanished); the callers check each file.
    if (r.code !== 0 && r.code !== 23 && r.code !== 24) {
      if (/not found|No such file/i.test(r.stderr) && /rsync/.test(r.stderr)) throw new Error(`rsync isn't installed on ${m.state.host}. Install it there, then try again.`);
      throw new Error(`Couldn't ${direction === 'up' ? 'upload to' : 'download from'} ${m.state.host}${r.stderr ? `: ${lastLine(r.stderr)}` : '.'}`);
    }
  }

  // Record what both sides look like now, for files whose copies match after a transfer.
  async function record(m, rels, remote) {
    for (const rel of rels) {
      const R = remote.get(rel);
      const L = await localStat(m, rel);
      if (R && L && R.size === L.size) m.state.files[rel] = [R.size, R.mtime, L.size, L.mtime];
    }
  }
  const download = async (m, rels, remote) => { await rsync(m, rels, 'down'); await record(m, rels, remote); };
  const upload = async (m, rels) => { await rsync(m, rels, 'up'); if (rels.length) await record(m, rels, await listRemote(m, rels)); };

  const unchangedRemotely = (m, rel, remote) => {
    const k = m.state.files[rel];
    const R = remote.get(rel);
    return !!(k && R && R.size === k[0] && R.mtime === k[1]);
  };
  const existsLocally = (m, rel) => fs.lstat(path.join(m.root, rel)).then(() => true, () => false);

  // Deletes and renames made here since the last sync. Only remote files that are exactly as we
  // last saw them are touched; anything else is left alone and comes back on the next download.
  async function applyPending(m, remote) {
    const { files } = m.state;
    const ops = m.state.pending.splice(0);
    let applied = 0;
    for (const op of ops) {
      if (op.op === 'delete') {
        const rels = op.dir ? Object.keys(files).filter((r) => r.startsWith(`${op.path}/`)) : [op.path];
        const gone = [];
        for (const rel of rels) if (unchangedRemotely(m, rel, remote) && !(await existsLocally(m, rel))) gone.push(rel);
        const lines = gone.map((rel) => `rm -f -- ${q(`./${rel}`)}`);
        // Then the folders that are empty now (rmdir refuses the others).
        if (op.dir && !(await existsLocally(m, op.path))) lines.push(`[ -d ${q(`./${op.path}`)} ] && find ${q(`./${op.path}`)} -depth -type d -exec rmdir {} \\; 2>/dev/null`);
        if (!lines.length) continue;
        await sh(m.state.host, `cd ${q(m.state.abs)} || exit 3\n${lines.join('\n')}\nexit 0\n`);
        for (const rel of gone) delete files[rel];
        applied++;
      } else if (op.op === 'rename') {
        const { from, to } = op;
        if (await existsLocally(m, from) || !(await existsLocally(m, to))) continue;
        if (!op.dir && (!unchangedRemotely(m, from, remote) || remote.has(to))) continue;
        const r = await sh(m.state.host, `cd ${q(m.state.abs)} || exit 3
[ -e ${q(`./${from}`)} ] && [ ! -e ${q(`./${to}`)} ] && mkdir -p ${q(`./${path.posix.dirname(to)}`)} && mv -- ${q(`./${from}`)} ${q(`./${to}`)}\n`);
        if (r.code !== 0) continue;
        for (const rel of Object.keys(files)) {
          if (rel === from || rel.startsWith(`${from}/`)) { files[to + rel.slice(from.length)] = files[rel]; delete files[rel]; }
        }
        applied++;
      }
    }
    return applied;
  }

  async function doSync(m, skipPaths) {
    const { files } = m.state;
    let remote = await listRemote(m);
    if (m.state.pending.length && await applyPending(m, remote)) remote = await listRemote(m);
    const local = await listLocal(m);
    const skip = new Set();
    for (const p of Array.isArray(skipPaths) ? skipPaths : []) {
      if (typeof p === 'string' && p.startsWith(m.root + path.sep)) skip.add(path.relative(m.root, p).split(path.sep).join('/'));
    }
    const down = [], up = [], removeHere = [], conflicts = [];
    let skipped = 0;
    for (const rel of new Set([...remote.keys(), ...local.keys(), ...Object.keys(files)])) {
      const R = remote.get(rel), L = local.get(rel), k = files[rel];
      if (!R && !L) { delete files[rel]; continue; }
      const remoteChanged = R ? !(k && R.size === k[0] && R.mtime === k[1]) : !!k;
      const localChanged = L ? !(k && L.size === k[2] && L.mtime === k[3]) : !!k;
      if (R && L && R.size === L.size && R.mtime === L.mtime) {
        if (remoteChanged || localChanged) files[rel] = [R.size, R.mtime, L.size, L.mtime];
      } else if (R && !L) {
        // New over there, or missing here: download it (never delete remotely for that).
        if (skip.has(rel)) skipped++; else down.push(rel);
      } else if (!R) {
        // Gone remotely: drop our copy if it's untouched, otherwise upload it again.
        if (k && !localChanged) { if (skip.has(rel)) skipped++; else removeHere.push(rel); } else up.push(rel);
      } else if (remoteChanged && localChanged) {
        conflicts.push({ rel, path: path.join(m.root, rel), stamp: `${R.size}:${R.mtime}` });
      } else if (remoteChanged) {
        if (skip.has(rel)) skipped++; else down.push(rel);
      } else if (localChanged) up.push(rel);
    }
    await download(m, down, remote);
    await upload(m, up);
    for (const rel of removeHere) {
      await fs.rm(path.join(m.root, rel), { force: true });
      delete files[rel];
    }
    m.state.lastSync = Date.now();
    await save(m);
    return { downloaded: down.length, uploaded: up.length, removed: removeHere.length, skipped, conflicts };
  }

  function relOf(m, file) {
    if (typeof file !== 'string' || !file.startsWith(m.root + path.sep)) throw new Error('That file isn\'t in the remote folder.');
    const rel = path.relative(m.root, file).split(path.sep).join('/');
    if (!relOk(rel)) throw new Error('That file isn\'t in the remote folder.');
    return rel;
  }

  // --- public API (IPC) ------------------------------------------------------
  return {
    async connect(host, remotePath, ignoredNames) {
      if (process.platform === 'win32') throw new Error('Remote folders over SSH aren\'t supported on Windows yet.');
      checkHost(host);
      remotePath = checkRemotePath(remotePath);
      try { await ensureMaster(host); } catch (err) {
        if (err.login) return { needsLogin: true, loginCommand: loginCommand(host) };
        throw err;
      }
      const r = await sh(host, `cd ${rootSh(remotePath)} && pwd\n`);
      if (r.code !== 0) throw new Error(`There's no folder ${remotePath} on ${host}.`);
      const abs = r.stdout.toString().trim();
      if (!abs.startsWith('/') || !ROOT_RE.test(abs) || abs.split('/').includes('..')) {
        throw new Error(`Minimide can't sync ${abs.slice(0, 200)} yet: folder paths may only contain letters, digits and . _ - + @ , = ~`);
      }
      const hash = crypto.createHash('sha256').update(`${host}:${abs}`).digest('hex').slice(0, 12);
      let m = await loadMirror(host, hash);
      const fresh = !m;
      if (!m) {
        const dir = path.join(base(), host, hash);
        const name = abs === '/' ? host : path.posix.basename(abs);
        await fs.mkdir(path.join(dir, name), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(dir, 'remote.json'), JSON.stringify({ version: 1, host, remote: remotePath, abs, name, ignored: [], files: {}, pending: [] }));
        m = await loadMirror(host, hash);
      }
      m.state.remote = remotePath;
      m.state.abs = abs;
      m.state.ignored = cleanNames(ignoredNames);
      try {
        const result = await queued(m, () => doSync(m));
        if (result.needsLogin) return result;
        m.connected = true;
        return { id: m.id, root: m.root, host, remote: abs, ...result };
      } catch (err) {
        // Don't leave an empty mirror behind when the first download fails (e.g. too many files).
        if (fresh && !Object.keys(m.state.files).length) { mirrors.delete(m.id); await fs.rm(m.dir, { recursive: true, force: true }); }
        throw err;
      }
    },

    async lookup(p) {
      const hit = await mirrorFor(p);
      if (!hit || hit.rel) return null;
      const { m } = hit;
      return { id: m.id, root: m.root, host: m.state.host, remote: m.state.abs, path: m.state.remote, connected: m.connected };
    },

    async sync(id, opts = {}) {
      const m = await getMirror(id);
      return queued(m, () => doSync(m, opts?.skip));
    },

    /** Upload one saved file. Returns { conflict } instead when it changed remotely too (unless force). */
    async push(id, file, opts = {}) {
      const m = await getMirror(id);
      const rel = relOf(m, file);
      return queued(m, async () => {
        const L = await localStat(m, rel);
        if (!L) return { uploaded: false };
        const R = (await listRemote(m, [rel])).get(rel);
        const k = m.state.files[rel];
        const changed = R && !(k && R.size === k[0] && R.mtime === k[1]) && !(R.size === L.size && R.mtime === L.mtime);
        if (changed && !opts?.force) return { conflict: true, rel, path: file, stamp: `${R.size}:${R.mtime}` };
        await upload(m, [rel]);
        await save(m);
        return { uploaded: true };
      });
    },

    /** Replace the local copy of one file with the remote one. */
    async pull(id, file) {
      const m = await getMirror(id);
      const rel = relOf(m, file);
      return queued(m, async () => {
        const remote = await listRemote(m, [rel]);
        if (!remote.has(rel)) return { missing: true };
        await download(m, [rel], remote);
        await save(m);
        return { downloaded: true };
      });
    },

    async disconnect(id) {
      const m = await getMirror(id);
      m.connected = false;
      const host = m.state.host;
      if (![...mirrors.values()].some((x) => x.connected && x.state.host === host) && masters.has(host)) {
        masters.delete(host);
        await run(sshBin, [...control(), '-O', 'exit', host], { timeout: 10000 }).catch(() => {});
      }
    },

    /** A shell command line that opens a login shell in the remote folder. */
    async terminalCommand(id) {
      const m = await getMirror(id);
      return [sshBin, ...control(), '-o', 'ControlMaster=no', '-t', m.state.host, `cd ${m.state.abs} && exec "\${SHELL:-sh}" -l`].map(shq).join(' ');
    },

    // Called by the fs:trash / fs:rename handlers after they succeed.
    async recordTrash(p) {
      try {
        const hit = await mirrorFor(p);
        if (!hit?.rel) return;
        const { m, rel } = hit;
        const dir = Object.keys(m.state.files).some((r) => r.startsWith(`${rel}/`));
        if (!dir && !m.state.files[rel]) return;
        m.state.pending.push({ op: 'delete', path: rel, dir });
        await save(m);
      } catch (err) { console.warn('[remote] recording a delete failed:', err.message); }
    },
    async recordRename(a, b) {
      try {
        const from = await mirrorFor(a);
        if (!from?.rel) return;
        const to = await mirrorFor(b);
        if (!to?.rel || to.m !== from.m) return this.recordTrash(a);
        const st = await fs.lstat(b).catch(() => null);
        from.m.state.pending.push({ op: 'rename', from: from.rel, to: to.rel, dir: !!st?.isDirectory() });
        await save(from.m);
      } catch (err) { console.warn('[remote] recording a rename failed:', err.message); }
    },

    dispose() {
      if (!ctlDir) return;
      for (const host of masters) spawnSync(sshBin, [...control(), '-O', 'exit', host], { env, timeout: 3000, stdio: 'ignore' });
      try { fss.rmSync(ctlDir, { recursive: true, force: true }); } catch {}
    },
  };
}
