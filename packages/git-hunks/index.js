// Git Hunks: the changes between the index and the editor, one at a time. A click on a change marker
// in the gutter (or ⌘⌥G, ⌥F3 / ⇧⌥F3) opens a peek under the change with what was there before, and
// Stage / Revert for just that change. Stage Selected Lines stages part of one.
//
// A change goes into the index with `git apply --cached` and a patch built against the exact text the
// index holds (patch.js), so nothing else in the index moves. Other packages (source control) stage
// and unstage single changes through the "git-hunks" service.
import { toLines, hunks, applyHunks, invert, selectLines, unselectLines, patch } from './patch.js';

class HunkError extends Error {}

export function activate(mide) {
  const { h } = mide.ui;
  const { EditorView, Decoration, WidgetType, keymap } = mide.cm.view;
  const { StateField, StateEffect, Prec } = mide.cm.state;
  const { isolateHistory } = mide.cm.commands;

  // Background git never runs a repo's fsmonitor command; paths are taken literally ("*" is a name).
  const git = (root, args, opts = {}) => mide.process.exec('git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], { cwd: root, timeout: 30000, ...opts });
  const gitStatus = () => mide.services.get('git-status');

  // --- what git has ----------------------------------------------------------------
  /** The repository of `path` and the path in it, for a file in a trusted folder; or null. */
  function locate(path) {
    const root = path && mide.workspace.isTrusted(path) ? gitStatus()?.rootFor(path) : null;
    if (!root || path === root) return null;
    return { root, rel: path.slice(root.length + 1) };
  }

  // A blob never changes, so its text is kept by hash.
  const blobs = new Map();
  async function blob(root, sha) {
    if (blobs.has(sha)) return blobs.get(sha);
    const r = await git(root, ['cat-file', 'blob', sha]);
    if (r.code !== 0) throw new HunkError(r.stderr.trim() || `git couldn't read ${sha}`);
    if (r.stdout.includes('\0')) throw new HunkError('This is a binary file: stage it whole from Source Control.');
    if (blobs.size >= 100) blobs.clear();
    blobs.set(sha, r.stdout);
    return r.stdout;
  }

  /** What the index holds: { text, inIndex } ('' for a file git doesn't track yet). */
  async function indexOf({ root, rel }) {
    const r = await git(root, ['ls-files', '--stage', '-z', '--', rel]);
    if (r.code !== 0) throw new HunkError(r.stderr.trim());
    const entries = r.stdout.split('\0').filter(Boolean);
    if (!entries.length) return { text: '', inIndex: false };
    const [mode, sha, stage] = entries[0].split('\t')[0].split(' ');
    if (entries.length > 1 || stage !== '0') throw new HunkError('This file has merge conflicts. Resolve them and mark it resolved first.');
    if (mode !== '100644' && mode !== '100755') throw new HunkError('Only regular files can be staged by change.');
    return { text: await blob(root, sha), inIndex: true };
  }

  /** The last commit's version: { text, inHead }. */
  async function headOf({ root, rel }) {
    const r = await git(root, ['ls-tree', '-z', 'HEAD', '--', rel]);
    const entry = r.code === 0 ? r.stdout.split('\0').find(Boolean) : null;
    if (!entry) return { text: '', inHead: false };
    return { text: await blob(root, entry.split('\t')[0].split(' ')[2]), inHead: true };
  }

  /** Whether git turns CRLF into LF when it adds this file (core.autocrlf, or a text / eol attribute). */
  async function convertsCrlf({ root, rel }) {
    const [c, a] = await Promise.all([git(root, ['config', '--get', 'core.autocrlf']), git(root, ['check-attr', 'text', 'eol', '--', rel])]);
    const attrs = a.stdout;
    if (/: text: unset$/m.test(attrs)) return false;
    return /^(true|input)$/i.test(c.stdout.trim()) || /: text: (set|auto)$/m.test(attrs) || /: eol: (crlf|lf)$/m.test(attrs);
  }

  /** The working text as lines git would compare: CRLF stays CRLF unless git converts it on add. */
  async function workingLines(loc, text, index) {
    if (text.includes('\r\n') && !index.text.includes('\r') && (await convertsCrlf(loc))) text = text.replace(/\r\n/g, '\n');
    return toLines(text);
  }

  // Index writes run one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
  const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

  /** Makes the index hold `target` (lines) instead of `from`. Returns whether anything changed. */
  async function writeIndex({ root, rel }, index, from, target) {
    if (same(from, target)) return false;
    if (!index.inIndex) {
      // A new file: an empty entry first ("intent to add"), then the patch fills it in.
      const r = await git(root, ['add', '--intent-to-add', '--', rel]);
      if (r.code !== 0) throw new HunkError(r.stderr.trim() || 'git add failed');
    }
    const r = await git(root, ['apply', '--cached', '--whitespace=nowarn', '-'], { input: patch(rel, from, target) });
    if (r.code !== 0) {
      if (!index.inIndex) await git(root, ['rm', '--cached', '--force', '-q', '--', rel]);
      throw new HunkError(r.stderr.trim() || 'git apply failed');
    }
    return true;
  }

  async function afterIndexChange() {
    await gitStatus()?.refresh?.();
    if (mide.commands.has('source-control:refresh')) await mide.commands.run('source-control:refresh');
  }

  /** Stages the changed lines from..to (1-based, of `text`, default the file on disk). */
  async function stageLines(path, from, to, { text } = {}) {
    const loc = locate(path);
    if (!loc) throw new HunkError('This file is not in a git repository of a trusted folder.');
    const changed = await serial(async () => {
      const index = await indexOf(loc);
      const I = toLines(index.text);
      const W = await workingLines(loc, text ?? (await mide.fs.read(path)), index);
      return writeIndex(loc, index, I, selectLines(I, W, hunks(I, W), from - 1, to - 1));
    });
    if (changed) await afterIndexChange();
    return changed;
  }

  /** Unstages the staged lines from..to (1-based, of the index's version). */
  async function unstageLines(path, from, to) {
    const loc = locate(path);
    if (!loc) throw new HunkError('This file is not in a git repository of a trusted folder.');
    const changed = await serial(async () => {
      const [index, head] = await Promise.all([indexOf(loc), headOf(loc)]);
      const I = toLines(index.text);
      const H = toLines(head.text);
      const target = unselectLines(H, I, hunks(H, I), from - 1, to - 1);
      if (same(I, target)) return false;
      if (!head.inHead && !target.length) {
        // Nothing of a new file is left staged: it goes back to being untracked. (--force because the
        // index and the file differ; with --cached the file itself is never touched.)
        const r = await git(loc.root, ['rm', '--cached', '--force', '-q', '--', loc.rel]);
        if (r.code !== 0) throw new HunkError(r.stderr.trim());
        return true;
      }
      return writeIndex(loc, index, I, target);
    });
    if (changed) await afterIndexChange();
    return changed;
  }

  // --- an editor's changes -----------------------------------------------------------
  /** The editor's unstaged changes: { loc, index, I, W, list, doc }, or null outside a repository. */
  async function model(editor) {
    const loc = locate(editor?.getPath?.());
    if (!loc || !editor.view) return null;
    if ((editor.document?.encoding || 'utf8') !== 'utf8') throw new HunkError('Only UTF-8 files can be staged by change.');
    const doc = editor.view.state.doc;
    const index = await indexOf(loc);
    const eol = editor.document?.lineEnding === '\r\n' ? '\r\n' : '\n';
    const W = await workingLines(loc, doc.sliceString(0, doc.length, eol), index);
    const I = toLines(index.text);
    return { loc, index, I, W, list: hunks(I, W), doc };
  }

  // Editor lines (1-based) of a change. A deletion sits between two lines: it shows on the one above.
  const firstLine = (c) => (c.newCount ? c.newStart + 1 : Math.max(1, c.newStart));
  const lastLine = (c) => (c.newCount ? c.newStart + c.newCount : Math.max(1, c.newStart));
  const covers = (c, line) => (c.newCount ? line >= firstLine(c) && line <= lastLine(c) : line === c.newStart || line === c.newStart + 1);
  const sameChange = (a, b) => a.oldStart === b.oldStart && a.oldCount === b.oldCount && a.newStart === b.newStart && a.newCount === b.newCount;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function summary(c) {
    const parts = [];
    if (c.oldCount) parts.push(`${plural(c.oldCount, 'line')} removed`);
    if (c.newCount) parts.push(`${plural(c.newCount, 'line')} added`);
    return parts.join(', ');
  }

  // --- the peek ------------------------------------------------------------------------
  const setPeek = StateEffect.define();
  const peekField = StateField.define({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setPeek)) return e.value;
      return value && tr.docChanged ? null : value; // an edit makes the change it shows stale
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v?.deco || Decoration.none),
  });
  const peekOf = (view) => view?.state.field(peekField, false) || null;

  // Bumped whenever a peek opens or closes, so a reopen that finishes late can tell it was overtaken.
  let peekMoves = 0;

  function close(view, { focus = true } = {}) {
    if (!peekOf(view)) return false;
    peekMoves++;
    view.dispatch({ effects: setPeek.of(null) });
    if (focus) view.focus();
    return true;
  }

  const editorOf = (view) => mide.workspace.getItems().find((i) => i.type === 'editor' && i.view === view) || null;
  const MAX_SHOWN = 400;

  class PeekWidget extends WidgetType {
    constructor(info) { super(); this.info = info; }
    eq(o) { return o.info === this.info; }
    get estimatedHeight() { return 60 + 18 * Math.min(MAX_SHOWN, this.info.change.oldCount + this.info.change.newCount); }
    ignoreEvent() { return true; }
    toDOM(view) {
      const { change, index, total, removed, added, dirty, name } = this.info;
      const button = (action, label, title, run) => h('button.hunk-btn', {
        type: 'button', dataset: { action }, title, 'aria-label': title,
        onclick: (e) => { e.preventDefault(); run(); },
      }, label);
      const lines = (list, kind, count) => h(`div.hunk-lines.hunk-${kind}`, { role: 'group', 'aria-label': `${kind === 'removed' ? 'Removed' : 'Added'}: ${plural(count, 'line')}` },
        ...list.map((text) => h('div.hunk-line', h('span.hunk-sign', { 'aria-hidden': 'true' }, kind === 'removed' ? '−' : '+'), h('span.hunk-text', strip(text)), text.endsWith('\n') ? null : h('span.hunk-eof', 'no newline at end of file'))),
        count > list.length ? h('div.hunk-more', `… ${plural(count - list.length, 'more line')}`) : null);
      const title = `Change ${index + 1} of ${total}`;
      return h('div.hunk-peek', {
        role: 'region', tabIndex: -1, 'aria-label': `${title} in ${name}: ${summary(change)}`,
        onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(view); } },
      },
      h('div.hunk-header',
        h('span.hunk-title', title),
        h('span.hunk-summary', summary(change)),
        h('span.hunk-spacer'),
        button('stage', 'Stage', 'Stage this change', () => stageShown(view)),
        button('revert', 'Revert', 'Revert this change', () => revertShown(view)),
        button('previous', '↑', 'Previous change', () => step(view, -1)),
        button('next', '↓', 'Next change', () => step(view, 1)),
        button('close', '✕', 'Close (Escape)', () => close(view))),
      dirty ? h('div.hunk-note', 'Unsaved changes: Stage uses the text in the editor, not the file on disk.') : null,
      h('div.hunk-body',
        change.oldCount ? lines(removed, 'removed', change.oldCount) : null,
        change.newCount ? lines(added, 'added', change.newCount) : null));
    }
  }

  const strip = (l) => l.replace(/\r?\n$/, '');

  /** Opens the peek on change `index` of `m` (from model()). */
  function open(view, editor, m, index, { moveCursor = false, focus = true } = {}) {
    peekMoves++;
    const change = m.list[index];
    const info = {
      change, index, total: m.list.length, doc: m.doc, dirty: editor.isDirty?.() || false,
      name: mide.path.basename(editor.getPath()),
      removed: m.I.slice(change.oldStart, change.oldStart + Math.min(change.oldCount, MAX_SHOWN)),
      added: m.W.slice(change.newStart, change.newStart + Math.min(change.newCount, MAX_SHOWN)),
    };
    const doc = view.state.doc;
    const after = change.newCount ? change.newStart + change.newCount : change.newStart; // the line it goes under; 0 = above the first
    const widget = new PeekWidget(info);
    const deco = after >= 1
      ? Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(Math.min(after, doc.lines)).to)
      : Decoration.widget({ widget, block: true, side: -1 }).range(0);
    const anchor = doc.line(Math.min(firstLine(change), doc.lines)).from;
    view.dispatch({
      effects: [setPeek.of({ ...info, deco: Decoration.set([deco]) }), EditorView.scrollIntoView(deco.from, { y: 'nearest', yMargin: 40 })],
      ...(moveCursor ? { selection: { anchor } } : {}),
    });
    if (focus) requestAnimationFrame(() => view.dom.querySelector('.hunk-peek')?.focus());
  }

  function fail(title, err) {
    if (err instanceof HunkError) mide.notify.error(title, err.message);
    else mide.notify.error(title, String(err?.message || err));
  }

  /** Shows the change that `pick(list)` chooses (an index, or -1 for none). */
  async function show(view, editor, pick, opts = {}) {
    let m;
    try { m = await model(editor); } catch (err) { return fail('Can\'t show the change', err); }
    if (!m || view.state.doc !== m.doc || !view.dom.isConnected) return; // typed meanwhile
    if (!m.list.length) {
      close(view, { focus: false });
      if (!opts.quiet) mide.notify.info('No unstaged changes in this file.', 'Staged changes are in Source Control.');
      return;
    }
    const index = pick(m.list);
    if (index < 0) {
      if (!opts.quiet) mide.notify.info('No unstaged change on this line.', 'Its change may be staged already: see Source Control.');
      return;
    }
    open(view, editor, m, index, opts);
  }

  const cursorLine = (view) => view.state.doc.lineAt(view.state.selection.main.head).number;

  function step(view, dir) {
    const editor = editorOf(view);
    if (!editor) return;
    const peek = peekOf(view);
    const line = cursorLine(view);
    show(view, editor, (list) => {
      const n = list.length;
      if (peek && peek.total === n) return (peek.index + dir + n) % n;
      if (dir > 0) { const i = list.findIndex((c) => firstLine(c) > line); return i < 0 ? 0 : i; }
      const i = list.findLastIndex((c) => lastLine(c) < line);
      return i < 0 ? n - 1 : i;
    }, { moveCursor: true });
  }

  function toggleAtCursor(view) {
    if (close(view)) return;
    const editor = editorOf(view);
    if (!editor) return;
    const line = cursorLine(view);
    show(view, editor, (list) => {
      const at = list.findIndex((c) => covers(c, line));
      if (at >= 0) return at;
      const next = list.findIndex((c) => firstLine(c) > line);
      return next < 0 ? 0 : next;
    }, { moveCursor: true });
  }

  /**
   * Re-opens the peek after the change it showed was staged or reverted: on the one now in its place.
   * Not when another peek opened or closed since `moves` (say, staging again from the keyboard).
   */
  async function reopenAfter(view, editor, index, moves) {
    let m;
    try { m = await model(editor); } catch { m = null; }
    if (!m || view.state.doc !== m.doc || moves !== peekMoves) return;
    if (!m.list.length) { close(view); return; }
    open(view, editor, m, Math.min(index, m.list.length - 1), { moveCursor: true });
  }

  /** The change the peek shows, found again in a fresh model; null (and a note) when it moved. */
  async function shownChange(view, editor) {
    const peek = peekOf(view);
    if (!peek) return null;
    const m = await model(editor);
    const change = m?.list.find((c) => sameChange(c, peek.change));
    if (!m || !change || view.state.doc !== m.doc) { mide.notify.info('This change has changed', 'Open it again from the gutter.'); return null; }
    return { m, change, index: peek.index };
  }

  async function stageShown(view) {
    const editor = editorOf(view);
    if (!editor) return;
    const moves = peekMoves;
    try {
      const changed = await serial(async () => {
        const found = await shownChange(view, editor);
        if (!found) return null;
        const { m, change, index } = found;
        await writeIndex(m.loc, m.index, m.I, applyHunks(m.I, m.W, [change]));
        return index;
      });
      if (changed == null) return;
      await afterIndexChange();
      await reopenAfter(view, editor, changed, moves);
    } catch (err) { fail('Couldn\'t stage the change', err); }
  }

  /** Puts the change back the way the index has it: one edit, undone with ⌘Z. */
  async function revertShown(view) {
    const editor = editorOf(view);
    if (!editor) return;
    const moves = peekMoves;
    let found;
    try { found = await shownChange(view, editor); } catch (err) { return fail('Couldn\'t revert the change', err); }
    if (!found) return;
    revertChange(view, found.m, found.change);
    await reopenAfter(view, editor, found.index, moves);
  }

  function revertChange(view, m, change) {
    const next = applyHunks(m.W, m.I, [invert(change)]).join('').replace(/\r\n?/g, '\n');
    const current = view.state.doc.toString();
    let start = 0;
    while (start < current.length && start < next.length && current[start] === next[start]) start++;
    let endA = current.length;
    let endB = next.length;
    while (endA > start && endB > start && current[endA - 1] === next[endB - 1]) { endA--; endB--; }
    view.dispatch({
      changes: { from: start, to: endA, insert: next.slice(start, endB) },
      annotations: isolateHistory.of('full'), userEvent: 'input.revert', scrollIntoView: true,
    });
  }

  mide.editor.addExtension([peekField, Prec.highest(keymap.of([{ key: 'Escape', run: (view) => close(view) }]))]);

  // --- the gutter --------------------------------------------------------------------
  // A click on one of git's change markers opens that change (or closes it when it's already open).
  let markerClicks = null;
  mide.services.consume('git-status', (svc) => {
    markerClicks?.dispose();
    markerClicks = svc.onDidClickMarker?.((view, line) => {
      const editor = editorOf(view);
      if (!editor || !locate(editor.getPath())) return false;
      const peek = peekOf(view);
      if (peek && covers(peek.change, line)) { close(view); return true; }
      show(view, editor, (list) => list.findIndex((c) => covers(c, line)));
      return true;
    }) || null;
  });
  mide.subscriptions.add({ dispose: () => { markerClicks?.dispose(); markerClicks = null; blobs.clear(); } });

  // --- commands ----------------------------------------------------------------------
  const activeEditor = () => { const e = mide.workspace.getActiveEditor(); return e?.view ? e : null; };
  const inRepo = () => !!locate(activeEditor()?.getPath());

  async function stageAtCursor() {
    const editor = activeEditor();
    const view = editor.view;
    const sel = view.state.selection.main;
    try {
      const m = await model(editor);
      if (!m) return;
      const doc = view.state.doc;
      const from = doc.lineAt(sel.from).number;
      // A selection that ends at the start of a line doesn't take that line.
      const end = !sel.empty && doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
      const to = Math.max(from, doc.lineAt(end).number);
      if (!m.list.some((c) => (c.newCount ? firstLine(c) <= to && lastLine(c) >= from : c.newStart >= from - 1 && c.newStart <= to))) {
        return mide.notify.info(sel.empty ? 'No unstaged change on this line.' : 'No unstaged changes in the selection.');
      }
      close(view, { focus: false });
      const changed = await stageLines(editor.getPath(), from, to, { text: m.W.join('') });
      if (!changed) mide.notify.info('Nothing to stage there.');
    } catch (err) { fail('Couldn\'t stage the lines', err); }
  }

  async function revertAtCursor() {
    const editor = activeEditor();
    const view = editor.view;
    try {
      const m = await model(editor);
      if (!m || view.state.doc !== m.doc) return;
      const line = cursorLine(view);
      const change = m.list.find((c) => covers(c, line));
      if (!change) return mide.notify.info('No unstaged change on this line.');
      close(view, { focus: false });
      revertChange(view, m, change);
    } catch (err) { fail('Couldn\'t revert the change', err); }
  }

  mide.commands.add({
    'git-hunks:show': { title: 'Show Change', category: 'Git', when: inRepo, run: () => toggleAtCursor(activeEditor().view) },
    'git-hunks:next': { title: 'Show Next Change', category: 'Git', when: inRepo, run: () => step(activeEditor().view, 1) },
    'git-hunks:previous': { title: 'Show Previous Change', category: 'Git', when: inRepo, run: () => step(activeEditor().view, -1) },
    'git-hunks:stage': { title: 'Stage Selected Lines', category: 'Git', when: inRepo, run: stageAtCursor },
    'git-hunks:revert': { title: 'Revert Change at Cursor', category: 'Git', when: inRepo, run: revertAtCursor },
  });

  // --- for other packages ----------------------------------------------------------
  const asError = (fn) => async (...args) => {
    try { return await fn(...args); } catch (err) { throw err instanceof HunkError ? new Error(err.message) : err; }
  };
  mide.services.provide('git-hunks', {
    /** Stages the changes on lines from..to (1-based, inclusive) of the working file, or of `opts.text`. Resolves to whether the index changed. */
    stageLines: asError(stageLines),
    /** Unstages the staged changes on lines from..to (1-based, inclusive) of the index's version. Resolves to whether the index changed. */
    unstageLines: asError(unstageLines),
    /** The editor's unstaged changes: [{ from, to, removed, added }], editor lines, `to < from` for lines removed between two. */
    changes: asError(async (editor) => {
      const m = await model(editor);
      return (m?.list || []).map((c) => ({
        from: c.newStart + 1, to: c.newStart + c.newCount,
        removed: m.I.slice(c.oldStart, c.oldStart + c.oldCount).map(strip), added: m.W.slice(c.newStart, c.newStart + c.newCount).map(strip),
      }));
    }),
    /** Opens the peek on the change at `line` (1-based) of an editor. */
    show: (editor, line) => editor?.view && show(editor.view, editor, (list) => list.findIndex((c) => covers(c, line))),
  });
}
