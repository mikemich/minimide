// The history on disk: <user dir>/history/<hash of the file's path>/index.json plus one file per
// version (<timestamp><extension>). The index holds the path and, for each version, its time, size,
// content hash, file name and an optional label; a version from Auto Save is marked `auto` (and
// `since`: when the run of auto saves it stands for began). History is keyed by the absolute path,
// so it does not depend on which folder is open.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export function createStore(mide) {
  const { fs } = mide;
  const ROOT = `${mide.user.dir}/history`;
  const REMOTE = `${mide.user.dir}/remote/`; // mirrors of SSH folders: the remote machine is the source of truth
  const listeners = new Set();
  const locks = new Map();
  let order = Promise.resolve();

  // --- small helpers ---------------------------------------------------------
  const bytes = new TextEncoder();
  async function sha1(text) {
    const digest = await crypto.subtle.digest('SHA-1', bytes.encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const dirFor = async (path) => `${ROOT}/${(await sha1(path)).slice(0, 20)}`;

  /** One job at a time per history folder, so two saves (or a save and a prune) never interleave. */
  function locked(key, job) {
    const run = (locks.get(key) || Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  /** Snapshots and moves run in the order they were asked for, so a save just before a rename is moved with it. */
  function inOrder(job) {
    const run = order.then(job, job);
    order = run.catch(() => {});
    return run;
  }

  async function readIndex(dir) {
    try {
      const index = JSON.parse(await fs.read(`${dir}/index.json`));
      return index && Array.isArray(index.versions) && typeof index.path === 'string' ? index : null;
    } catch { return null; }
  }
  const writeIndex = (dir, index) => fs.write(`${dir}/index.json`, JSON.stringify(index));
  const removeFiles = (dir, names) => Promise.all(names.map((n) => fs.removeHistory(`${dir}/${n}`).catch(() => {})));

  const number = (key, fallback) => { const v = Number(mide.config.get(`local-history.${key}`)); return Number.isFinite(v) && v >= 0 ? v : fallback; };

  // --- what is worth keeping --------------------------------------------------
  const globCache = new Map();
  function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  }
  function matcher(pattern) {
    let m = globCache.get(pattern);
    if (m) return m;
    const clean = pattern.trim().replace(/\/+$/, '');
    if (!clean) m = () => false;
    else if (!clean.includes('/')) {
      const re = new RegExp(`^${globToRegExp(clean)}$`);
      m = (segments) => segments.some((s) => re.test(s));
    } else {
      const anchored = clean.startsWith('/');
      const re = new RegExp(`${anchored ? '^' : '(^|/)'}${globToRegExp(anchored ? clean.slice(1) : clean)}(/|$)`);
      m = (segments, rel) => re.test(rel);
    }
    globCache.set(pattern, m);
    return m;
  }

  function folderRoots() {
    const ws = mide.workspace;
    const roots = (ws.folders || []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
    if (ws.project) roots.push(ws.project);
    return roots;
  }

  function ignored(path) {
    const root = folderRoots().filter((r) => path.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
    // Outside the folders only the file's name is matched: ~/build/notes.txt is not build output.
    const rel = root ? path.slice(root.length + 1) : path.slice(path.lastIndexOf('/') + 1);
    const segments = rel.split('/');
    const patterns = [...(mide.config.get('local-history.ignore') || []), ...(mide.config.get('core.ignoredNames') || [])];
    return patterns.some((p) => typeof p === 'string' && matcher(p)(segments, rel));
  }

  /** Whether a file at this path with this much text is kept: not ignored, not too big, not ours. */
  function eligible(path, text) {
    if (!path || path.startsWith(`${ROOT}/`) || path.startsWith(REMOTE)) return false;
    const limit = number('maxFileSizeKB', 1024) * 1024;
    if (text.length > limit || (text.length * 3 > limit && bytes.encode(text).length > limit)) return false;
    return !ignored(path);
  }

  // --- retention --------------------------------------------------------------
  /** Splits an index's versions (oldest first) into those to keep and those to drop. */
  function retention(versions, now = Date.now()) {
    const max = Math.floor(number('maxVersions', 50));
    const days = number('maxAgeDays', 30);
    const cutoff = days > 0 ? now - days * DAY : -Infinity;
    const keep = [];
    const drop = [];
    versions.forEach((v, i) => ((max > 0 && versions.length - i > max) || v.time < cutoff ? drop : keep).push(v));
    return { keep, drop };
  }

  /** Applies the retention rules to one history folder; resolves to the number of versions removed. */
  function pruneDir(dir) {
    return locked(dir, async () => {
      const index = await readIndex(dir);
      if (!index) return 0;
      const { keep, drop } = retention(index.versions);
      if (!drop.length) return 0;
      if (!keep.length) await fs.removeHistory(dir).catch(() => {});
      else {
        index.versions = keep;
        await writeIndex(dir, index);
        await removeFiles(dir, drop.map((v) => v.file));
      }
      return drop.length;
    });
  }

  let pruning = null;
  /** Prunes every file's history, a little at a time so the editor stays responsive. */
  function pruneAll({ isCancelled = () => false } = {}) {
    pruning ||= (async () => {
      let removed = 0;
      let entries = [];
      try { entries = await fs.readdir(ROOT); } catch {}
      for (const e of entries) {
        if (isCancelled()) break;
        if (!e.isDir) continue;
        removed += await pruneDir(e.path);
        await new Promise((r) => setTimeout(r, 15));
      }
      return removed;
    })().finally(() => { pruning = null; });
    return pruning;
  }

  // --- snapshots --------------------------------------------------------------
  const extOf = (path) => { const m = /\.[A-Za-z0-9]{1,12}$/.exec(path.slice(path.lastIndexOf('/') + 1)); return m ? m[0] : ''; };

  /**
   * Keeps `text` as the newest version of `path`, unless it is unchanged, ignored or too big.
   * With `auto` (a save by Auto Save) it replaces the newest version while that one is from Auto Save
   * too and its run began less than `autoSaveMinutes` ago, so typing with Auto Save on doesn't push
   * the real history out.
   */
  function snapshot(path, text, label = null, { auto = false } = {}) {
    if (!eligible(path, text)) return Promise.resolve(null);
    return inOrder(async () => {
      const dir = await dirFor(path);
      const added = await locked(dir, async () => {
        const hash = await sha1(text);
        const index = (await readIndex(dir)) || { path, versions: [] };
        const last = index.versions.at(-1);
        if (last && last.hash === hash) {
          // Saved by hand: the auto save version with this text is kept like any other.
          if (!auto && last.auto) { delete last.auto; delete last.since; await writeIndex(dir, index); }
          return null;
        }
        const time = Math.max(Date.now(), (last?.time || 0) + 1);
        const version = { id: String(time), time, size: bytes.encode(text).length, hash, file: `${time}${extOf(path)}` };
        if (label) version.label = label;
        const since = last?.since ?? last?.time;
        const replace = auto && !label && last?.auto && time - since < number('autoSaveMinutes', 5) * MINUTE;
        if (auto && !label) version.auto = true;
        if (replace) { version.since = since; index.versions.pop(); }
        await fs.write(`${dir}/${version.file}`, text);
        index.path = path;
        index.versions.push(version);
        const { keep, drop } = retention(index.versions);
        index.versions = keep;
        await writeIndex(dir, index);
        if (replace) drop.push(last);
        if (drop.length) await removeFiles(dir, drop.map((v) => v.file));
        return version;
      });
      if (added) for (const fn of listeners) fn(path);
      return added;
    });
  }

  /** The versions of a file, newest first. */
  async function versions(path) {
    const index = await readIndex(await dirFor(path));
    return index ? [...index.versions].reverse() : [];
  }

  async function read(path, version) {
    return fs.read(`${await dirFor(path)}/${version.file}`);
  }

  /** Every file that has history: [{ dir, path, versions (oldest first) }]. */
  async function all() {
    let entries = [];
    try { entries = await fs.readdir(ROOT); } catch {}
    const found = await Promise.all(entries.filter((e) => e.isDir).map(async (e) => {
      const index = await readIndex(e.path);
      return index?.versions.length ? { dir: e.path, path: index.path, versions: index.versions } : null;
    }));
    return found.filter(Boolean);
  }

  // --- moves -------------------------------------------------------------------
  /** A file was renamed: its history follows it (and is merged into any history the new path already had). */
  async function moveFile(from, to) {
    const fromDir = await dirFor(from);
    const toDir = await dirFor(to);
    if (fromDir === toDir) return;
    await locked(fromDir, () => locked(toDir, async () => {
      const source = await readIndex(fromDir);
      if (!source) return;
      const target = (await readIndex(toDir)) || { path: to, versions: [] };
      await fs.mkdir(toDir);
      const taken = new Set(target.versions.map((v) => v.file));
      for (const v of source.versions) {
        let file = v.file;
        for (let n = 1; taken.has(file); n++) file = `${v.time}-${n}${extOf(v.file)}`;
        taken.add(file);
        await fs.rename(`${fromDir}/${v.file}`, `${toDir}/${file}`);
        target.versions.push({ ...v, file });
      }
      target.path = to;
      target.versions.sort((a, b) => a.time - b.time);
      await writeIndex(toDir, target);
      await fs.removeHistory(fromDir);
    }));
    for (const fn of listeners) { fn(from); fn(to); }
  }

  /** A file or a folder was renamed. Waits for the snapshots asked for before it, so they move too. */
  function move(from, to) {
    return inOrder(async () => {
      await moveFile(from, to);
      const stat = await fs.stat(to).catch(() => null);
      if (!stat?.isDir) return;
      for (const entry of await all()) if (entry.path.startsWith(from + '/')) await moveFile(entry.path, to + entry.path.slice(from.length));
    });
  }

  return {
    ROOT, hash: sha1, snapshot, versions, read, all, move, eligible, pruneAll, pruneDir, retention,
    onDidChange: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    PRUNE_MARKER: `${ROOT}/.pruned`,
  };
}
