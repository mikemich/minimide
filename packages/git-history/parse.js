// Parsing git's output (log, diff-tree, stash list) and laying out the commit graph. No DOM and no
// git calls here, so test/unit can check it directly.

const US = '\x1f'; // between fields
const RS = '\x1e'; // before each record of a log that also lists files

/** The fields every log asks for, in this order; the subject goes last. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%ct', '%D', '%s'].join('%x1f');
/** One commit in full: the body (%B) goes last because it may hold anything but NUL. */
export const SHOW_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f');
export const STASH_FORMAT = ['%H', '%gd', '%gs', '%ct'].join('%x1f');

/** "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main" (from --decorate=full) */
export function parseRefs(text) {
  const refs = [];
  for (let part of (text || '').split(', ')) {
    part = part.trim();
    if (!part) continue;
    if (part === 'HEAD') { refs.push({ name: 'HEAD', kind: 'head' }); continue; }
    let current = false;
    if (part.startsWith('HEAD -> ')) { current = true; part = part.slice(8); }
    if (part.startsWith('tag: ')) part = part.slice(5);
    if (part.startsWith('refs/heads/')) refs.push({ name: part.slice(11), kind: 'branch', current });
    else if (part.startsWith('refs/remotes/')) { if (!part.endsWith('/HEAD')) refs.push({ name: part.slice(13), kind: 'remote' }); }
    else if (part.startsWith('refs/tags/')) refs.push({ name: part.slice(10), kind: 'tag' });
    else refs.push({ name: part, kind: 'other' });
  }
  // The checked-out branch first, then branches, remotes and tags.
  const order = { branch: 1, head: 0, remote: 2, tag: 3, other: 4 };
  return refs.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || order[a.kind] - order[b.kind]);
}

function commitFrom(fields) {
  const [hash, parents, author, email, time, ctime, refs, ...subject] = fields;
  return { hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(time) || 0, ctime: Number(ctime) || 0, refs: parseRefs(refs), subject: subject.join(US) };
}

/** `git log -z --format=LOG_FORMAT` */
export function parseLog(stdout) {
  const out = [];
  for (const record of stdout.split('\0')) {
    const r = record.replace(/^\n/, '');
    if (!r) continue;
    const fields = r.split(US);
    if (fields.length < 8 || !/^[0-9a-f]{7,}$/.test(fields[0])) continue;
    out.push(commitFrom(fields));
  }
  return out;
}

/**
 * `git log -z --format=%x1e<LOG_FORMAT> --name-status [--follow] -- path`: each commit with the
 * file as it was named in it ({ status, path, oldPath }).
 */
export function parseFileLog(stdout) {
  const out = [];
  for (const chunk of stdout.split(RS)) {
    if (!chunk) continue;
    const end = chunk.indexOf('\0');
    const head = end < 0 ? chunk : chunk.slice(0, end);
    const fields = head.split(US);
    if (fields.length < 8) continue;
    const commit = commitFrom(fields);
    const rest = (end < 0 ? '' : chunk.slice(end + 1)).replace(/^\n/, '').split('\0');
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      const status = rest[i];
      if (!status) continue;
      if (status[0] === 'R' || status[0] === 'C') { files.push({ status: status[0], oldPath: rest[i + 1], path: rest[i + 2] }); i += 2; }
      else { files.push({ status: status[0], path: rest[i + 1] }); i += 1; }
    }
    commit.file = files[0] || null;
    out.push(commit);
  }
  return out;
}

/** `git show -s -z --format=SHOW_FORMAT <commit>` */
export function parseShow(stdout) {
  const r = stdout.replace(/\0+$/, '');
  const [hash, parents, author, email, time, committer, committerEmail, committerTime, refs, ...body] = r.split(US);
  if (!hash) return null;
  const message = body.join(US).replace(/\s+$/, '');
  return {
    hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(time) || 0,
    committer, committerEmail, committerTime: Number(committerTime) || 0, refs: parseRefs(refs),
    message, subject: message.split('\n')[0],
  };
}

/**
 * `git diff-tree -r -z -M --raw --numstat [<a>] <b>` (with --no-commit-id): the changed files with
 * their status and line counts. Binary files have `binary: true` and no counts.
 */
export function parseTreeDiff(stdout) {
  const parts = stdout.split('\0');
  const files = [];
  const byPath = new Map();
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p) { i++; continue; }
    if (p[0] === ':') {
      const status = p.split(' ').pop() || 'M';
      const kind = status[0];
      let f;
      if (kind === 'R' || kind === 'C') { f = { status: kind, similarity: Number(status.slice(1)) || null, oldPath: parts[i + 1], path: parts[i + 2] }; i += 3; }
      else { f = { status: kind, path: parts[i + 1] }; i += 2; }
      f.added = 0; f.deleted = 0; f.binary = false;
      files.push(f);
      byPath.set(f.path, f);
      continue;
    }
    // numstat: "added\tdeleted\tpath" or, for a rename, "added\tdeleted\t" followed by old and new path.
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) { i++; continue; }
    let path = m[3];
    if (!path) { path = parts[i + 2]; i += 3; } else i += 1;
    const f = byPath.get(path);
    if (!f) continue;
    if (m[1] === '-') f.binary = true;
    else { f.added = Number(m[1]); f.deleted = Number(m[2]); }
  }
  return files;
}

/** `git stash list -z --format=STASH_FORMAT` */
export function parseStashes(stdout) {
  return stdout.split('\0').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, ref, subject, time] = r.split(US);
    return { hash, ref, subject: subject || '', time: Number(time) || 0, index: Number(/\{(\d+)\}/.exec(ref || '')?.[1] ?? -1) };
  }).filter((s) => /^[0-9a-f]{7,}$/.test(s.hash));
}

/** "3 days ago" */
export function relativeTime(seconds, now = Date.now() / 1000) {
  const diff = Math.max(0, now - seconds);
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [s, name] of units) if (diff >= s) { const n = Math.floor(diff / s); return `${n} ${name}${n > 1 ? 's' : ''} ago`; }
  return 'just now';
}

/**
 * The lane graph of `git log --graph`, built one commit at a time (so it continues across pages).
 * Each row says where the commit's dot is (`col`) and which lines cross the row: `top` lines run
 * from the top edge (lane a) to the middle (lane b), `bottom` lines from the middle (lane a) to the
 * bottom edge (lane b). Every line carries the color index of its lane.
 */
export class LaneGraph {
  constructor() { this.lanes = []; this.colors = 0; }

  add(commit) {
    const lanes = this.lanes;
    const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
    let col = lanes.findIndex((l) => l && l.hash === commit.hash);
    let color;
    if (col < 0) { col = free(); color = this.colors++; } else color = lanes[col].color;
    const top = [];
    lanes.forEach((l, i) => { if (l) top.push([i, l.hash === commit.hash ? col : i, l.color]); });
    for (let i = 0; i < lanes.length; i++) if (lanes[i]?.hash === commit.hash) lanes[i] = null;
    const bottom = [];
    const fresh = new Set();
    const [first, ...others] = commit.parents;
    if (first) lanes[col] = { hash: first, color };
    else if (col < lanes.length) lanes[col] = null;
    for (const p of others) {
      let j = lanes.findIndex((l) => l && l.hash === p);
      if (j < 0) { j = free(); lanes[j] = { hash: p, color: this.colors++ }; fresh.add(j); }
      bottom.push([col, j, lanes[j].color]);
    }
    lanes.forEach((l, i) => { if (l && !fresh.has(i)) bottom.push([i, i, l.color]); });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    let width = col + 1;
    for (const [a, b] of [...top, ...bottom]) width = Math.max(width, a + 1, b + 1);
    return { col, color, top, bottom, width, merge: commit.parents.length > 1 };
  }
}
