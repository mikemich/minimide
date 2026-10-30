import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { toLines, eolOf, hunks, apply, applyHunks, invert, selectLines, unselectLines, patch } from '../../packages/git-hunks/patch.js';

const L = (...lines) => lines;

test('toLines keeps line endings and a last line without one', () => {
  assert.deepEqual(toLines(''), []);
  assert.deepEqual(toLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(toLines('a\r\nb\r\n'), ['a\r\n', 'b\r\n']);
  assert.deepEqual(toLines('\n\n'), ['\n', '\n']);
  assert.equal(eolOf(['a\r\n', 'b\r\n', 'c\n']), '\r\n');
  assert.equal(eolOf(['a\n', 'b']), '\n');
  assert.equal(eolOf(['a']), null);
});

test('hunks: one per run of changed lines, 0-based', () => {
  const a = toLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n');
  const b = toLines('1\nTWO\n3\n4\n5\n6\n7\n8\n8.5\n9\n');
  assert.deepEqual(hunks(a, b), [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    { oldStart: 8, oldCount: 0, newStart: 8, newCount: 1 },
  ]);
  assert.deepEqual(hunks(a, a), []);
  assert.deepEqual(hunks([], L('x\n')), [{ oldStart: 0, oldCount: 0, newStart: 0, newCount: 1 }]);
  assert.deepEqual(hunks(L('x\n', 'y\n'), L('y\n')), [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 0 }]);
  // A final newline is a change of the last line.
  assert.deepEqual(hunks(L('x\n', 'y'), L('x\n', 'y\n')), [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
});

test('applyHunks takes only the chosen hunks; invert undoes one', () => {
  const a = toLines('a\nb\nc\nd\ne\n');
  const b = toLines('A\nb\nc\nD\ne\nf\n');
  const list = hunks(a, b);
  assert.equal(list.length, 3);
  assert.deepEqual(applyHunks(a, b, [list[1]]), toLines('a\nb\nc\nD\ne\n'));
  assert.deepEqual(applyHunks(a, b, list), b);
  assert.deepEqual(applyHunks(b, a, [invert(list[2])]), toLines('A\nb\nc\nD\ne\n'));
});

test('apply gives a line ending to a line that gets one after it', () => {
  assert.deepEqual(apply(L('x'), [{ oldStart: 1, oldCount: 0, lines: ['y'] }]), ['x\n', 'y']);
  assert.deepEqual(apply(L('x\r\n', 'y'), [{ oldStart: 2, oldCount: 0, lines: ['z'] }]), ['x\r\n', 'y\r\n', 'z']);
});

test('selectLines pairs old and new lines inside a hunk', () => {
  const a = toLines('keep\none\ntwo\nthree\nend\n');
  const b = toLines('keep\nONE\nTWO\nTHREE\nend\n');
  const list = hunks(a, b);
  assert.deepEqual(selectLines(a, b, list, 2, 2), toLines('keep\none\nTWO\nthree\nend\n'));
  assert.deepEqual(selectLines(a, b, list, 0, 0), a);
  assert.deepEqual(selectLines(a, b, list, 1, 3), b);
  // Extra new lines are added one by one; extra old lines go with the hunk's last line.
  const grow = toLines('keep\nx\ny\nz\nend\n');
  assert.deepEqual(selectLines(a, grow, hunks(a, grow), 3, 3), toLines('keep\none\ntwo\nz\nend\n'));
  const shrink = toLines('keep\nONE\nend\n');
  assert.deepEqual(selectLines(a, shrink, hunks(a, shrink), 1, 1), shrink);
  // A deletion goes with the line above or below it.
  const gone = toLines('keep\nend\n');
  assert.deepEqual(selectLines(a, gone, hunks(a, gone), 1, 1), gone);
  assert.deepEqual(selectLines(a, gone, hunks(a, gone), 0, 0), gone);
  // Adding lines to a file without a final newline.
  assert.deepEqual(selectLines(L('x'), L('x\n', 'y'), hunks(L('x'), L('x\n', 'y')), 1, 1), ['x\n', 'y']);
});

test('unselectLines puts chosen lines of the new side back', () => {
  const a = toLines('keep\none\ntwo\nthree\nend\n');
  const b = toLines('keep\nONE\nTWO\nTHREE\nend\n');
  const list = hunks(a, b);
  assert.deepEqual(unselectLines(a, b, list, 2, 2), toLines('keep\nONE\ntwo\nTHREE\nend\n'));
  assert.deepEqual(unselectLines(a, b, list, 0, Infinity), a);
  assert.deepEqual(unselectLines(a, b, list, 0, 0), b);
  // Added lines go away one by one; removed lines come back with the hunk's last line.
  const grow = toLines('keep\nx\ny\nz\nw\nend\n');
  assert.deepEqual(unselectLines(a, grow, hunks(a, grow), 4, 4), toLines('keep\nx\ny\nz\nend\n'));
  const shrink = toLines('keep\nONE\nend\n');
  assert.deepEqual(unselectLines(a, shrink, hunks(a, shrink), 1, 1), a);
  // A deletion comes back with the line above or below it.
  const gone = toLines('keep\nend\n');
  assert.deepEqual(unselectLines(a, gone, hunks(a, gone), 1, 1), a);
  assert.deepEqual(unselectLines(a, gone, hunks(a, gone), 0, 0), a);
  // Two hunks: only the one in range.
  const two = toLines('KEEP\none\ntwo\nthree\nEND\n');
  assert.deepEqual(unselectLines(a, two, hunks(a, two), 4, 4), toLines('KEEP\none\ntwo\nthree\nend\n'));
});

test('patch: headers, context, merged blocks and missing newlines', () => {
  const a = toLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n');
  const b = toLines('1\n2\nthree\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n');
  assert.equal(patch('dir/f.txt', a, b), 'diff --git a/dir/f.txt b/dir/f.txt\n--- a/dir/f.txt\n+++ b/dir/f.txt\n@@ -1,6 +1,6 @@\n 1\n 2\n-3\n+three\n 4\n 5\n 6\n');
  assert.equal(patch('f', a, a), '');
  // Two changes 6 lines apart share one block; further apart they don't.
  const near = applyHunks(b, toLines('1\n2\nthree\n4\n5\n6\n7\n8\n9\nten\n11\n12\n13\n14\n15\n16\n'), hunks(b, toLines('1\n2\nthree\n4\n5\n6\n7\n8\n9\nten\n11\n12\n13\n14\n15\n16\n')));
  assert.equal(patch('f', a, near).match(/^@@/gm).length, 1);
  const far = toLines('1\n2\nthree\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\nfifteen\n16\n');
  assert.equal(patch('f', a, far).match(/^@@/gm).length, 2);
  assert.equal(patch('f', L('x'), L('x\n')), 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n');
  assert.equal(patch('f', [], L('x\n', 'y\n')), 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  assert.equal(patch('f', L('x\n'), []), 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +0,0 @@\n-x\n');
  assert.match(patch('we"ird\tname', L('x\n'), L('y\n')), /^diff --git "a\/we\\"ird\\tname" "b\/we\\"ird\\tname"\n/);
});

// --- against real git -----------------------------------------------------------------------

const hasGit = spawnSync('git', ['--version']).status === 0;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimide-hunks-'));
  const git = (args, input) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@example.com']);
  return { dir, git, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Commits `old` as `name`, stages `a` → (`a` with `pick` of the hunks to `b`) with a patch, returns the index. */
function stageThrough(name, old, b, pick, { untracked = false } = {}) {
  const r = repo();
  try {
    fs.mkdirSync(path.dirname(path.join(r.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(r.dir, name), old ?? '');
    if (untracked) r.git(['add', '--intent-to-add', '--', name]);
    else { r.git(['add', '--', name]); r.git(['commit', '-qm', 'base']); }
    fs.writeFileSync(path.join(r.dir, name), b);
    const a = toLines(untracked ? '' : old);
    const bl = toLines(b);
    const target = pick(a, bl, hunks(a, bl));
    r.git(['apply', '--cached', '--whitespace=nowarn', '-'], patch(name, a, target));
    return r.git(['cat-file', 'blob', `:${name}`]);
  } finally { r.done(); }
}

test('git apply --cached takes the patch: the middle of three hunks', { skip: !hasGit }, () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
  const b = old.replace('line 2\n', 'line two\n').replace('line 15\n', 'line fifteen\nextra\n').replace('line 28\n', '');
  const staged = stageThrough('f.txt', old, b, (a, bl, list) => applyHunks(a, bl, [list[1]]));
  assert.equal(staged, old.replace('line 15\n', 'line fifteen\nextra\n'));
});

test('git apply --cached: CRLF lines, no final newline, spaces in the name', { skip: !hasGit }, () => {
  const old = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\nten\r\n';
  const b = old.replace('two\r\n', 'TWO\r\n').replace('nine\r\n', 'NINE\r\n');
  assert.equal(stageThrough('sub dir/my file.txt', old, b, (a, bl, list) => applyHunks(a, bl, [list[1]])), old.replace('nine\r\n', 'NINE\r\n'));
  // Changing the last line of a file without a final newline, and adding one.
  assert.equal(stageThrough('n.txt', 'a\nb\nc', 'a\nB\nc', (a, bl, list) => applyHunks(a, bl, list)), 'a\nB\nc');
  assert.equal(stageThrough('n.txt', 'a\nb\nc', 'a\nb\nc\n', (a, bl, list) => applyHunks(a, bl, list)), 'a\nb\nc\n');
  assert.equal(stageThrough('n.txt', 'a\nb\nc\n', 'a\nb\nc', (a, bl, list) => applyHunks(a, bl, list)), 'a\nb\nc');
  assert.equal(stageThrough('n.txt', 'a\nb\nc', 'A\nb\nc\nd', (a, bl, list) => applyHunks(a, bl, [list[0]])), 'A\nb\nc');
  assert.equal(stageThrough('n.txt', 'a\nb\nc', 'A\nb\nc\nd', (a, bl, list) => applyHunks(a, bl, [list[1]])), 'a\nb\nc\nd');
});

test('git apply --cached: part of a new file, and selected lines', { skip: !hasGit }, () => {
  assert.equal(stageThrough('new.txt', null, 'x\ny\nz\n', (a, bl, list) => selectLines(a, bl, list, 0, 1), { untracked: true }), 'x\ny\n');
  assert.equal(stageThrough('new.txt', null, 'x\ny\nz', (a, bl, list) => selectLines(a, bl, list, 2, 2), { untracked: true }), 'z');
  const old = 'keep\none\ntwo\nthree\nend\n';
  assert.equal(stageThrough('s.txt', old, 'keep\nONE\nTWO\nTHREE\nend\n', (a, bl, list) => selectLines(a, bl, list, 2, 2)), 'keep\none\nTWO\nthree\nend\n');
});

test('git apply --cached on a file that is already partly staged', { skip: !hasGit }, () => {
  const r = repo();
  try {
    const file = path.join(r.dir, 'p.txt');
    const old = Array.from({ length: 20 }, (_, i) => `l${i}\n`).join('');
    fs.writeFileSync(file, old);
    r.git(['add', 'p.txt']);
    r.git(['commit', '-qm', 'base']);
    const work = old.replace('l1\n', 'L1\n').replace('l10\n', 'L10\n').replace('l18\n', 'L18\n');
    fs.writeFileSync(file, work);
    // The first change is staged by hand; the patches are built against the index, not HEAD.
    r.git(['apply', '--cached', '-'], patch('p.txt', toLines(old), toLines(old.replace('l1\n', 'L1\n'))));
    const index = toLines(r.git(['cat-file', 'blob', ':p.txt']));
    const list = hunks(index, toLines(work));
    assert.equal(list.length, 2);
    r.git(['apply', '--cached', '-'], patch('p.txt', index, applyHunks(index, toLines(work), [list[1]])));
    assert.equal(r.git(['cat-file', 'blob', ':p.txt']), old.replace('l1\n', 'L1\n').replace('l18\n', 'L18\n'));
    // Unstaging the first change again: HEAD -> index hunks, one of them undone.
    const now = toLines(r.git(['cat-file', 'blob', ':p.txt']));
    const staged = hunks(toLines(old), now);
    r.git(['apply', '--cached', '-'], patch('p.txt', now, applyHunks(now, toLines(old), [invert(staged[0])])));
    assert.equal(r.git(['cat-file', 'blob', ':p.txt']), old.replace('l18\n', 'L18\n'));
  } finally { r.done(); }
});
