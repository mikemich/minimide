import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../../packages/local-history/store.js';

// The store over an in-memory file system, with settings from `config` and a clock we move by hand.
function setup(config = {}, folders = ['/p']) {
  const files = new Map();
  const dirs = new Set();
  const slow = () => new Promise((r) => setTimeout(r, 2));
  const fs = {
    read: async (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    write: async (p, text) => { await slow(); files.set(p, text); }, // a disk write takes a moment
    mkdir: async (p) => { dirs.add(p); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    removeHistory: async (p) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); dirs.delete(p); },
    readdir: async (dir) => {
      const names = new Set([...files.keys(), ...dirs].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1).split('/')[0]));
      return [...names].map((n) => ({ path: `${dir}/${n}`, isDir: !files.has(`${dir}/${n}`) }));
    },
    stat: async (p) => (files.has(p) ? { isDir: false } : dirs.has(p) ? { isDir: true } : null),
  };
  const mide = {
    fs,
    user: { dir: '/home' },
    config: { get: (key) => config[key] },
    workspace: { folders, project: folders[0] },
  };
  return { store: createStore(mide), files, dirs };
}

let now = 1_000_000;
const realNow = Date.now;
const at = (t) => { now = t; Date.now = () => now; };
const MIN = 60 * 1000;
const texts = async (store, files, path) => {
  const dir = (await store.all()).find((e) => e.path === path)?.dir;
  return (await store.versions(path)).reverse().map((v) => files.get(`${dir}/${v.file}`));
};

test('auto saves replace the newest auto save version until its run is autoSaveMinutes old', async () => {
  const { store, files } = setup({ 'local-history.autoSaveMinutes': 5 });
  const p = '/p/a.txt';
  at(1_000_000);
  await store.snapshot(p, 'by hand\n');
  at(now + 1000); await store.snapshot(p, 'a1\n', null, { auto: true });
  at(now + 1000); await store.snapshot(p, 'a2\n', null, { auto: true });
  at(now + 1000); await store.snapshot(p, 'a3\n', null, { auto: true });
  assert.deepEqual(await texts(store, files, p), ['by hand\n', 'a3\n']);
  const [newest] = await store.versions(p);
  assert.equal(newest.auto, true);
  assert.equal(newest.since, 1_001_000); // when the run began
  // Replaced versions leave no files behind.
  const dir = (await store.all())[0].dir;
  assert.equal([...files.keys()].filter((k) => k.startsWith(dir + '/') && !k.endsWith('index.json')).length, 2);

  // Five minutes into the run, the next auto save starts a new version.
  at(1_001_000 + 5 * MIN); await store.snapshot(p, 'a4\n', null, { auto: true });
  at(now + 1000); await store.snapshot(p, 'a5\n', null, { auto: true });
  assert.deepEqual(await texts(store, files, p), ['by hand\n', 'a3\n', 'a5\n']);
});

test('a save by hand always keeps a version, and keeps the auto save version it matches', async () => {
  const { store, files } = setup();
  const p = '/p/b.txt';
  at(2_000_000);
  await store.snapshot(p, 'x1\n', null, { auto: true });
  at(now + 1000); await store.snapshot(p, 'x2\n'); // by hand
  at(now + 1000); await store.snapshot(p, 'x3\n', null, { auto: true });
  // ⌘S right after Auto Save wrote the same text: that version is no longer replaceable.
  at(now + 1000); assert.equal(await store.snapshot(p, 'x3\n'), null);
  assert.equal((await store.versions(p))[0].auto, undefined);
  at(now + 1000); await store.snapshot(p, 'x4\n', null, { auto: true });
  assert.deepEqual(await texts(store, files, p), ['x1\n', 'x2\n', 'x3\n', 'x4\n']);
  // Labelled versions (before a revert, a restore…) are never replaced.
  at(now + 1000); await store.snapshot(p, 'x5\n', 'Before revert', { auto: true });
  at(now + 1000); await store.snapshot(p, 'x6\n', null, { auto: true });
  assert.deepEqual(await texts(store, files, p), ['x1\n', 'x2\n', 'x3\n', 'x4\n', 'x5\n', 'x6\n']);
});

test('autoSaveMinutes 0 keeps a version on every auto save', async () => {
  const { store, files } = setup({ 'local-history.autoSaveMinutes': 0 });
  const p = '/p/c.txt';
  at(3_000_000);
  for (let i = 1; i <= 3; i++) { at(now + 1000); await store.snapshot(p, `c${i}\n`, null, { auto: true }); }
  assert.deepEqual(await texts(store, files, p), ['c1\n', 'c2\n', 'c3\n']);
});

test('ignore patterns: relative to the folder inside it, only the name outside the folders', async () => {
  const { store } = setup({ 'local-history.ignore': ['build', 'out', '*.log', 'drafts/*.md'] });
  assert.equal(store.eligible('/p/build/x.txt', 'x'), false);
  assert.equal(store.eligible('/p/src/out/x.txt', 'x'), false);
  assert.equal(store.eligible('/p/drafts/a.md', 'x'), false);
  assert.equal(store.eligible('/p/src/x.txt', 'x'), true);
  // Outside the project folders: a folder called build or out on the way doesn't make it build output.
  assert.equal(store.eligible('/Users/me/build/notes.txt', 'x'), true);
  assert.equal(store.eligible('/srv/out/drafts/a.md', 'x'), true);
  assert.equal(store.eligible('/Users/me/build/server.log', 'x'), false);
  // A project folder that itself sits under a "build" folder.
  const other = setup({ 'local-history.ignore': ['build'] }, ['/work/build/app']);
  assert.equal(other.store.eligible('/work/build/app/src/x.txt', 'x'), true);
});

test('a save just before its folder is renamed moves with the folder', async () => {
  const { store, files, dirs } = setup();
  at(4_000_000);
  // Not awaited: the rename comes in while the first version of the file is still being written.
  const saved = store.snapshot('/p/old/new-file.txt', 'n1\n');
  dirs.add('/p/new');
  const moved = store.move('/p/old', '/p/new');
  await Promise.all([saved, moved]);
  assert.deepEqual(await texts(store, files, '/p/new/new-file.txt'), ['n1\n']);
  assert.deepEqual(await store.versions('/p/old/new-file.txt'), []);
  assert.deepEqual((await store.all()).map((e) => e.path), ['/p/new/new-file.txt']);
});

test.after(() => { Date.now = realNow; });
