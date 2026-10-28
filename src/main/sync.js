// Settings sync: a secret store for the GitHub token, and the few GitHub calls sync needs.
//
// The token lives only in this process. The renderer can store it, ask whether one is set and
// delete it, but never read it back: it asks for "upload" or "download" and this file talks to
// GitHub. The calls are fixed to the user's own settings gist on api.github.com.
import fs from 'node:fs/promises';

/** Names the renderer may store. Anything else is refused. */
export const SECRET_NAMES = ['github-gist-token'];
const DESCRIPTION = 'Minimide settings sync';
const MANIFEST = 'minimide-sync.json';
const FILE_NAME = /^[\w.~ -]{1,120}$/;
const GIST_ID = /^[0-9a-f]{8,64}$/i;
const MAX_FILES = 200;
const MAX_TOTAL = 4 * 1024 * 1024;

/**
 * Secrets encrypted with the operating system's keychain (Electron safeStorage), kept in one file.
 * `plain` (tests only) stores them base64 instead, so a test run never touches the real keychain.
 */
export function createSecrets({ file, safeStorage, plain = false }) {
  const encrypt = (value) => {
    if (plain) return `plain:${Buffer.from(value).toString('base64')}`;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer, so a token can\'t be kept safely.');
    return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  };
  const decrypt = (stored) => {
    const [kind, data] = [stored.slice(0, stored.indexOf(':')), stored.slice(stored.indexOf(':') + 1)];
    if (kind === 'plain' && plain) return Buffer.from(data, 'base64').toString();
    if (kind === 'enc') return safeStorage.decryptString(Buffer.from(data, 'base64'));
    throw new Error('Unreadable secret.');
  };
  const read = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; } };
  const write = async (data) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  const checkName = (name) => { if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret "${name}".`); };
  return {
    async set(name, value) {
      checkName(name);
      if (typeof value !== 'string' || !/^[\w.-]{8,255}$/.test(value.trim())) throw new Error('That doesn\'t look like a token.');
      await write({ ...await read(), [name]: encrypt(value.trim()) });
    },
    async has(name) { checkName(name); return typeof (await read())[name] === 'string'; },
    async delete(name) {
      checkName(name);
      const data = await read();
      delete data[name];
      await write(data);
    },
    /** Main process only: never exposed to the renderer. */
    async get(name) {
      checkName(name);
      const stored = (await read())[name];
      if (typeof stored !== 'string') return null;
      try { return decrypt(stored); } catch { return null; }
    },
  };
}

/**
 * `fetch` is injected (net.fetch); `gh()` runs the GitHub CLI's `auth token`; the gist id is kept by
 * `getId`/`setId` (app state).
 */
export function createGist({ secrets, fetch, apiBase = 'https://api.github.com', version, gh, getId, setId }) {
  const TOKEN = 'github-gist-token';

  async function api(method, pathname, body) {
    const token = await secrets.get(TOKEN);
    if (!token) throw new Error('Sync isn\'t set up yet. Run "Sync: Set Up…" first.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch(apiBase + pathname, {
        method, signal: ctrl.signal, redirect: 'manual',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': `Minimide/${version}`, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'GitHub took too long to answer.' : 'Couldn\'t reach GitHub. Check your internet connection.');
    } finally { clearTimeout(timer); }
    if (res.status === 401) throw new Error('GitHub didn\'t accept the token. Run "Sync: Set Up…" again with a token that has the "gist" scope.');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now, or the token can\'t use gists. Try again in a minute, or set up sync again.');
    if (res.status === 404) { const err = new Error('The sync gist wasn\'t found. It may have been deleted.'); err.notFound = true; throw err; }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
    return res.json();
  }

  const summary = (g) => ({ id: g.id, url: g.html_url, updatedAt: g.updated_at });

  /** The id of this user's sync gist: the remembered one, or the newest gist with our description. */
  async function locate() {
    const known = await getId();
    if (known && GIST_ID.test(known)) return known;
    const mine = await api('GET', '/gists?per_page=100');
    const found = (Array.isArray(mine) ? mine : []).find((g) => g.description === DESCRIPTION && GIST_ID.test(String(g.id)));
    if (found) await setId(found.id);
    return found?.id || null;
  }

  function validate(files) {
    const names = files && typeof files === 'object' ? Object.keys(files) : [];
    if (!names.length || names.length > MAX_FILES) throw new Error('Nothing to upload.');
    let total = 0;
    for (const name of names) {
      if (!FILE_NAME.test(name) || name === MANIFEST || typeof files[name] !== 'string') throw new Error(`Can't sync a file called "${name}".`);
      total += files[name].length;
    }
    if (total > MAX_TOTAL) throw new Error('Your settings are larger than 4 MB, which is too much to sync.');
    return names;
  }

  return {
    async status() { return { hasToken: await secrets.has(TOKEN), gistId: (await getId()) || null }; },

    /** Whether the GitHub CLI is installed and logged in. Nothing is stored or returned. */
    async cliAvailable() {
      try { return /^[\w.-]{8,255}$/.test((await gh()).trim()); } catch { return false; }
    },

    /** Use `gh auth token`. The token goes straight into the secret store; the renderer only learns whether it worked. */
    async cliLogin() {
      let out;
      try { out = (await gh()).trim(); } catch { return { ok: false, error: 'The GitHub CLI isn\'t installed or you\'re not logged in (gh auth login).' }; }
      if (!/^[\w.-]{8,255}$/.test(out)) return { ok: false, error: 'The GitHub CLI didn\'t return a token.' };
      await secrets.set(TOKEN, out);
      return { ok: true };
    },

    async forget() { await setId(null); await secrets.delete(TOKEN); },

    /** Replace the gist's contents with `files`. Creates the gist the first time. */
    async upload(files) {
      const names = validate(files);
      const payload = Object.fromEntries(names.map((n) => [n, { content: files[n] || '\n' }])); // GitHub refuses empty files
      payload[MANIFEST] = { content: JSON.stringify({ app: 'minimide', version, uploadedAt: new Date().toISOString() }, null, 2) + '\n' };
      let id = await locate();
      if (id) {
        try {
          const current = await api('GET', `/gists/${id}`);
          for (const name of Object.keys(current.files || {})) if (!(name in payload)) payload[name] = null; // removed here, removed there
          return summary(await api('PATCH', `/gists/${id}`, { files: payload }));
        } catch (err) {
          if (!err.notFound) throw err;
          await setId(null); // deleted on GitHub: start a new one
          id = null;
        }
      }
      const created = await api('POST', '/gists', { description: DESCRIPTION, public: false, files: payload });
      await setId(created.id);
      return summary(created);
    },

    /** The synced files as { name: text }, or null when there is no sync gist yet. */
    async download() {
      let id = await locate();
      if (!id) return null;
      let g;
      try { g = await api('GET', `/gists/${id}`); } catch (err) {
        if (err.notFound) { await setId(null); throw new Error('The sync gist wasn\'t found. It may have been deleted. Upload to start a new one.'); }
        throw err;
      }
      const files = {};
      for (const [name, f] of Object.entries(g.files || {})) {
        if (name === MANIFEST || !FILE_NAME.test(name)) continue;
        if (f.truncated || typeof f.content !== 'string') throw new Error(`"${name}" is too large to download from the gist.`);
        files[name] = f.content;
      }
      return { ...summary(g), files };
    },
  };
}
