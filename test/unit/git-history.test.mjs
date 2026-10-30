import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRefs, parseLog, parseFileLog, parseShow, parseTreeDiff, parseStashes, relativeTime, LaneGraph } from '../../packages/git-history/parse.js';

const US = '\x1f';
const RS = '\x1e';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const rec = (hash, parents, refs, subject, t = 100) => [hash, parents, 'Ada', 'ada@example.com', String(t), String(t + 1), refs, subject].join(US);

test('parseRefs: kinds, the checked-out branch first, remote HEAD dropped', () => {
  const refs = parseRefs('tag: refs/tags/v1.0, refs/remotes/origin/main, HEAD -> refs/heads/main, refs/remotes/origin/HEAD, refs/heads/feature');
  assert.deepEqual(refs, [
    { name: 'main', kind: 'branch', current: true },
    { name: 'feature', kind: 'branch', current: false },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ]);
  assert.deepEqual(parseRefs('HEAD, refs/heads/x'), [{ name: 'HEAD', kind: 'head' }, { name: 'x', kind: 'branch', current: false }]);
  assert.deepEqual(parseRefs(''), []);
});

test('parseLog: -z records with every field', () => {
  const out = parseLog(`${rec(A, `${B} ${C}`, 'HEAD -> refs/heads/main', 'Merge branch \'x\'', 200)}\0${rec(B, C, '', 'Second')}\0`);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].parents, [B, C]);
  assert.equal(out[0].subject, "Merge branch 'x'");
  assert.equal(out[0].time, 200);
  assert.equal(out[0].ctime, 201);
  assert.equal(out[0].refs[0].name, 'main');
  assert.deepEqual(out[1].refs, []);
});

test('parseLog: a root commit has no parents, a subject may hold the separator', () => {
  const [c] = parseLog(`${rec(A, '', '', `odd${US}subject`)}\0`);
  assert.deepEqual(c.parents, []);
  assert.equal(c.subject, `odd${US}subject`);
});

test('parseFileLog: the file as named in each commit, across a rename', () => {
  const stdout = `${RS}${rec(A, B, '', 'Edit')}\0\nM\0src/app.js\0`
    + `${RS}${rec(B, C, '', 'Rename')}\0\nR087\0src/old.js\0src/app.js\0`
    + `${RS}${rec(C, D, '', 'Merge')}\0`
    + `${RS}${rec(D, '', '', 'Add')}\0\nA\0src/old.js\0`;
  const out = parseFileLog(stdout);
  assert.deepEqual(out.map((c) => c.subject), ['Edit', 'Rename', 'Merge', 'Add']);
  assert.deepEqual(out[0].file, { status: 'M', path: 'src/app.js' });
  assert.deepEqual(out[1].file, { status: 'R', oldPath: 'src/old.js', path: 'src/app.js' });
  assert.equal(out[2].file, null);
  assert.deepEqual(out[3].file, { status: 'A', path: 'src/old.js' });
});

test('parseShow: committer and a multi-line body', () => {
  const s = parseShow([A, `${B} ${C}`, 'Ada', 'ada@x', '10', 'Bob', 'bob@x', '20', 'tag: refs/tags/v2', 'Subject line\n\nBody one\nBody two\n\n'].join(US) + '\0');
  assert.equal(s.subject, 'Subject line');
  assert.equal(s.message, 'Subject line\n\nBody one\nBody two');
  assert.equal(s.committer, 'Bob');
  assert.equal(s.committerTime, 20);
  assert.deepEqual(s.parents, [B, C]);
  assert.deepEqual(s.refs, [{ name: 'v2', kind: 'tag' }]);
});

test('parseTreeDiff: raw + numstat, with a rename and a binary file', () => {
  const stdout = ':100644 100644 1111111 2222222 R087\0a.txt\0b.txt\0'
    + ':000000 100644 0000000 3333333 A\0img.png\0'
    + ':100644 000000 4444444 0000000 D\0gone.txt\0'
    + ':100644 100644 5555555 6666666 M\0dir/x y.js\0'
    + '1\t0\t\0a.txt\0b.txt\0-\t-\timg.png\0' + '0\t3\tgone.txt\0' + '5\t2\tdir/x y.js\0';
  assert.deepEqual(parseTreeDiff(stdout), [
    { status: 'R', similarity: 87, oldPath: 'a.txt', path: 'b.txt', added: 1, deleted: 0, binary: false },
    { status: 'A', path: 'img.png', added: 0, deleted: 0, binary: true },
    { status: 'D', path: 'gone.txt', added: 0, deleted: 3, binary: false },
    { status: 'M', path: 'dir/x y.js', added: 5, deleted: 2, binary: false },
  ]);
  assert.deepEqual(parseTreeDiff(''), []);
});

test('parseStashes', () => {
  const out = parseStashes(`${[A, 'stash@{0}', 'On main: wip', '50'].join(US)}\0${[B, 'stash@{1}', 'WIP on main: 123 x', '40'].join(US)}\0`);
  assert.deepEqual(out, [
    { hash: A, ref: 'stash@{0}', subject: 'On main: wip', time: 50, index: 0 },
    { hash: B, ref: 'stash@{1}', subject: 'WIP on main: 123 x', time: 40, index: 1 },
  ]);
});

test('relativeTime', () => {
  assert.equal(relativeTime(1000, 1010), 'just now');
  assert.equal(relativeTime(0, 7200), '2 hours ago');
  assert.equal(relativeTime(0, 86400), '1 day ago');
});

test('LaneGraph: a branch and its merge', () => {
  // E (merge of D and C) -> D -> B, C -> B, B -> A
  const g = new LaneGraph();
  const rows = [
    g.add({ hash: E, parents: [D, C] }),
    g.add({ hash: D, parents: [B] }),
    g.add({ hash: C, parents: [B] }),
    g.add({ hash: B, parents: [A] }),
    g.add({ hash: A, parents: [] }),
  ];
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 1, 0, 0]);
  assert.equal(rows[0].merge, true);
  // The merge opens a second lane: a line from the dot (lane 0) to lane 1, and lane 0 goes on.
  assert.deepEqual(rows[0].bottom.map(([a, b]) => [a, b]), [[0, 1], [0, 0]]);
  assert.deepEqual(rows[0].top, []);
  assert.equal(rows[0].width, 2);
  // D: both lanes come in, both go on (lane 0 now waits for B, lane 1 for C).
  assert.deepEqual(rows[1].top.map(([a, b]) => [a, b]), [[0, 0], [1, 1]]);
  // C sits in lane 1, which then also waits for B.
  assert.deepEqual(rows[2].top.map(([a, b]) => [a, b]), [[0, 0], [1, 1]]);
  // B: both lanes join into its dot, one lane goes on.
  assert.deepEqual(rows[3].top.map(([a, b]) => [a, b]), [[0, 0], [1, 0]]);
  assert.deepEqual(rows[3].bottom.map(([a, b]) => [a, b]), [[0, 0]]);
  // A, the root: nothing goes on, and the lanes are empty again.
  assert.deepEqual(rows[4].bottom, []);
  assert.deepEqual(g.lanes, []);
});

test('LaneGraph: a commit nobody pointed at yet (another branch tip) gets a free lane', () => {
  const g = new LaneGraph();
  g.add({ hash: A, parents: [C] });
  const tip = g.add({ hash: B, parents: [C] });
  assert.equal(tip.col, 1);
  const base = g.add({ hash: C, parents: [] });
  assert.equal(base.col, 0);
  assert.deepEqual(base.top.map(([a, b]) => [a, b]), [[0, 0], [1, 0]]);
  // Lane colors stay with their line.
  assert.notEqual(tip.color, base.color);
});
