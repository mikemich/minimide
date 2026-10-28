// Reading a public GitHub repo for the browser demo (?repo=owner/name): checking what's in the URL,
// listing the files and fetching one. Everything that came from the address bar is matched against
// GitHub's own naming rules before it goes into a request, so it can only ever name a repo, never
// steer a request somewhere else. Only api.github.com and raw.githubusercontent.com are contacted.

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
const PATH = /^[A-Za-z0-9._\-+@=,~() [\]/]{1,500}$/;

export const MAX_FILE = 1024 * 1024; // bigger files get a placeholder
export const MAX_FILES = 20000; // bigger trees are cut off, with a notice
export const BINARY = /\.(zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|bin|dat|o|a|lib|obj|pyc|pdf|mp3|mp4|m4a|mov|avi|mkv|wav|flac|ogg|webm|woff2?|ttf|otf|eot|psd|sketch|wasm|node|db|sqlite3?|pack|idx|parquet|icns|ds_store)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp|avif)$/i; // shown by the image viewer, straight from GitHub

export const validOwner = (s) => OWNER.test(s);
export const validName = (s) => NAME.test(s) && s !== '.' && s !== '..';
// Git's rules for branch and tag names, a bit stricter.
export const validRef = (s) => REF.test(s) && !/^[-/.]|[/.]$|\/\/|\.\.|\.lock(\/|$)/.test(s);
export const validPath = (s) => PATH.test(s) && s.split('/').every((part) => part && part !== '.' && part !== '..');
// A path GitHub reported (it may hold any characters, but not tricks).
const safeTreePath = (s) => s.length <= 1000 && !/[\u0000-\u001f\\]/.test(s) && s.split('/').every((part) => part && part !== '.' && part !== '..');

/** The page's ?repo=owner/name[&ref=…][&path=…], or null without ?repo. { error } when something is off. */
export function readRepoRequest(params) {
  if (!params.has('repo')) return null;
  const [owner, name, ...extra] = params.get('repo').split('/');
  if (extra.length || !validOwner(owner || '') || !validName(name || '')) return { error: 'The repo should look like owner/name, for example mikemich/minimide.' };
  const ref = params.get('ref');
  if (ref != null && !validRef(ref)) return { error: "That branch or tag name isn't valid." };
  const path = params.get('path');
  if (path != null && !validPath(path)) return { error: "That file path isn't valid." };
  return { owner, name, ref, path };
}

/** "owner/name" from what someone typed or pasted: also github.com/owner/name, with or without https:// or .git. */
export function parseRepoInput(text) {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/.exec(String(text).trim());
  return m && validOwner(m[1]) && validName(m[2]) ? `${m[1]}/${m[2]}` : null;
}

export class RepoError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // kind: 'rate', 'missing', 'network', 'other'
}

async function get(url, missing) {
  let res;
  try { res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { throw new RepoError("Couldn't reach GitHub. Check your connection and try again.", 'network'); }
  if (res.ok) return res;
  if (res.status === 404) throw new RepoError(missing, 'missing');
  if (res.status === 403 || res.status === 429) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body.message || '')) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ' Try again in a little while.';
      throw new RepoError(`GitHub only allows 60 anonymous requests an hour, and they're used up.${when}`, 'rate');
    }
  }
  throw new RepoError(`GitHub answered with an error (${res.status}).`, 'other');
}

/** The files and folders of a repo at `ref` (its default branch when null). */
export async function loadTree({ owner, name, ref }, api) {
  const slug = `${owner}/${name}`;
  const missing = `Couldn't find ${slug}${ref ? ` at "${ref}"` : ''}. It may be private or misspelled; only public repos can be opened here.`;
  let branch = ref;
  if (!branch) {
    branch = (await (await get(`${api}/repos/${owner}/${name}`, missing)).json())?.default_branch;
    if (typeof branch !== 'string' || !validRef(branch)) throw new RepoError(`Couldn't read the default branch of ${slug}.`, 'other');
  }
  const data = await (await get(`${api}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`, missing)).json();
  const files = [];
  const dirs = [];
  let capped = false;
  for (const e of Array.isArray(data?.tree) ? data.tree : []) {
    if (typeof e?.path !== 'string' || !safeTreePath(e.path)) continue;
    if (e.type === 'tree') dirs.push(e.path);
    else if (e.type === 'blob') {
      if (files.length >= MAX_FILES) { capped = true; break; }
      files.push({ path: e.path, size: Number.isFinite(e.size) ? e.size : 0 });
    }
  }
  return { branch, files, dirs, capped, truncated: !!data?.truncated };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (raw, { owner, name }, ref, path) => `${raw}/${owner}/${name}/${encodePath(ref)}/${encodePath(path)}`;

export async function fetchText(url) {
  const res = await get(url, "That file isn't in the repo any more.");
  if (Number(res.headers.get('content-length')) > MAX_FILE * 2) throw new RepoError('That file is too large to show here.', 'other');
  return res.text();
}
