// Git integration. Provides the "git-status" service that tree-view consumes,
// a branch indicator, and diff markers in the editor gutter.
import { diffLines } from './diff.js';

export function activate(mide) {
  const { h, icon } = mide.ui;
  const { StateField, StateEffect, RangeSet } = mide.cm.state;
  const { gutter, GutterMarker } = mide.cm.view;

  let repoRoot = null;
  let branch = '';
  let statuses = new Map(); // abs path -> 'modified' | 'added' | 'untracked' | 'deleted'
  let dirStatuses = new Map();
  const listeners = new Set();
  const headCache = new Map(); // abs path -> HEAD text | null

  const git = (...args) => mide.process.exec('git', args, { cwd: repoRoot || mide.workspace.project });
  // The repo root derived from the project path itself (not `--show-toplevel`, which resolves
  // symlinks and then no longer matches the paths the editor uses).
  async function findRoot(project) {
    const r = await mide.process.exec('git', ['rev-parse', '--show-cdup'], { cwd: project });
    if (r.code !== 0) return null;
    const parts = project.split('/');
    for (const seg of r.stdout.trim().split('/').filter(Boolean)) if (seg === '..') parts.pop();
    return parts.join('/') || '/';
  }

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq; // a newer refresh supersedes this one (e.g. the project changed meanwhile)
    const project = mide.workspace.project;
    const clear = () => { repoRoot = null; branch = ''; statuses = new Map(); dirStatuses = new Map(); emit(); };
    if (!project) return clear();
    const root = await findRoot(project);
    if (seq !== refreshSeq) return;
    if (!root) return clear();
    const inRoot = (...args) => mide.process.exec('git', args, { cwd: root });
    // --no-optional-locks: background status must not hold .git/index.lock while you stage or commit.
    const [b, s] = await Promise.all([inRoot('rev-parse', '--abbrev-ref', 'HEAD'), inRoot('--no-optional-locks', 'status', '--porcelain=v1', '-z')]);
    let nextBranch = b.code === 0 ? b.stdout.trim() : '';
    if (!nextBranch || nextBranch === 'HEAD') {
      // No commits yet, or detached: symbolic-ref knows the branch name in the first case.
      const sym = await inRoot('symbolic-ref', '--short', 'HEAD');
      nextBranch = sym.code === 0 ? sym.stdout.trim() : b.code === 0 ? 'detached' : '';
    }
    if (seq !== refreshSeq) return;
    repoRoot = root;
    branch = nextBranch;
    statuses = new Map();
    const entries = s.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      const xy = e.slice(0, 2);
      const file = e.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') i++; // skip rename source
      let st = 'modified';
      if (xy === '??') st = 'untracked';
      else if (xy.includes('A')) st = 'added';
      else if (xy.includes('D')) st = 'deleted';
      statuses.set(`${repoRoot}/${file.replace(/\/$/, '')}`, st);
    }
    dirStatuses = new Map();
    for (const [p, st] of statuses) {
      let dir = p.slice(0, p.lastIndexOf('/'));
      while (dir.length >= repoRoot.length) {
        const prev = dirStatuses.get(dir);
        if (prev !== 'modified') dirStatuses.set(dir, st === 'deleted' ? 'modified' : prev && prev !== st ? 'modified' : st);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    }
    headCache.clear();
    emit();
    refreshAllGutters();
  }

  function emit() {
    renderStatus();
    for (const fn of listeners) fn();
  }

  function statusFor(path) {
    if (statuses.has(path)) return statuses.get(path);
    // Files inside an untracked directory are untracked too.
    for (const [p, st] of statuses) if (st === 'untracked' && path.startsWith(p + '/')) return 'untracked';
    return null;
  }

  mide.services.provide('git-status', {
    statuses: () => {
      const m = new Map(statuses);
      return { get: (p) => statusFor(p), has: (p) => !!statusFor(p), size: m.size };
    },
    dirStatus: (p) => dirStatuses.get(p) || (statusFor(p) === 'untracked' ? 'untracked' : null),
    branch: () => branch,
    root: () => repoRoot,
    onDidChange: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    refresh,
  });

  // --- status bar ----------------------------------------------------------
  const label = h('span.git-branch');
  mide.statusBar.addItem({ id: 'git-branch', element: label, align: 'left', priority: 5, tooltip: 'Git: switch branch', onClick: () => mide.commands.run('git:checkout-branch') });
  function renderStatus() {
    if (!repoRoot) { label.replaceChildren(); return; }
    const changed = [...statuses.values()].length;
    // replaceChildren() would print a null argument as the text "null", so only pass real nodes.
    label.replaceChildren(icon('branch', 13), h('span', branch || 'detached'), ...(changed ? [h('span.git-changes', `${changed}`)] : []));
  }

  // --- commands ------------------------------------------------------------
  mide.commands.add({
    'git:refresh': { title: 'Refresh Status', run: refresh },
    'git:checkout-branch': {
      title: 'Checkout Branch…',
      when: () => !!repoRoot,
      run: async () => {
        const res = await git('branch', '--format=%(refname:short)', '--sort=-committerdate');
        const branches = res.stdout.split('\n').filter(Boolean);
        mide.ui.selectList({
          id: 'git-branches',
          placeholder: `Current: ${branch}. Pick a branch, or type a new name.`,
          items: branches.map((b) => ({ label: b, detail: b === branch ? 'current' : '' })),
          onQuery: (q) => (q && !branches.includes(q) ? [{ label: `Create branch "${q}"`, create: q }, ...branches.filter((b) => b.includes(q)).map((b) => ({ label: b }))] : null),
          onSelect: async (item) => {
            const r = item.create ? await git('checkout', '-b', item.create) : await git('checkout', item.label);
            if (r.code !== 0) mide.notify.error('git checkout failed', r.stderr.trim());
            else mide.notify.success(`Switched to ${item.create || item.label}`);
            refresh();
          },
        });
      },
    },
    'git:open-changed-files': {
      title: 'Open Changed Files…',
      when: () => !!repoRoot,
      run: () => mide.ui.selectList({
        id: 'git-changed',
        placeholder: 'Changed files',
        items: [...statuses].filter(([, st]) => st !== 'deleted').map(([p, st]) => ({ label: mide.workspace.relativePath(p), detail: st, path: p })),
        emptyMessage: 'Working tree clean',
        onSelect: (i) => mide.workspace.open(i.path),
      }),
    },
  });

  // --- gutter --------------------------------------------------------------
  class Marker extends GutterMarker {
    constructor(kind) { super(); this.kind = kind; }
    eq(other) { return other.kind === this.kind; }
    toDOM() { const el = document.createElement('div'); el.className = `git-marker git-${this.kind}`; return el; }
  }
  const markers = { added: new Marker('added'), modified: new Marker('modified'), deleted: new Marker('deleted') };
  const setMarkers = StateEffect.define();
  const field = StateField.define({
    create: () => RangeSet.empty,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
      return tr.docChanged ? value.map(tr.changes) : value;
    },
  });
  const gitGutter = [field, gutter({ class: 'cm-git-gutter', markers: (v) => v.state.field(field) })];

  let gutterExt = null;
  mide.config.observe('git.gutter', (on) => {
    gutterExt?.dispose();
    gutterExt = on ? mide.editor.addExtension(gitGutter) : null;
    if (on) setTimeout(refreshAllGutters, 50);
  });

  async function headText(path) {
    if (headCache.has(path)) return headCache.get(path);
    const rel = path.slice(repoRoot.length + 1);
    const r = await git('show', `HEAD:${rel}`);
    const text = r.code === 0 ? r.stdout : null;
    headCache.set(path, text);
    return text;
  }

  async function updateGutter(editor) {
    if (!editor?.view || !mide.config.get('git.gutter')) return;
    const path = editor.getPath();
    if (!repoRoot || !path?.startsWith(repoRoot + '/')) return;
    const view = editor.view;
    let ranges = [];
    const st = statusFor(path);
    if (st === 'untracked' || st === 'added') {
      for (let i = 1; i <= view.state.doc.lines; i++) ranges.push(markers.added.range(view.state.doc.line(i).from));
    } else if (st) {
      const base = await headText(path);
      if (base == null || !editor.view) return;
      const doc = editor.view.state.doc;
      if (doc.lines > 20000) return;
      for (const ch of diffLines(base.split(/\r?\n/), doc.toString().split('\n'))) {
        if (ch.type === 'deleted') {
          const ln = Math.min(Math.max(ch.line, 1), doc.lines);
          ranges.push(markers.deleted.range(doc.line(ln).from));
        } else {
          for (let l = ch.line; l < ch.line + ch.count && l <= doc.lines; l++) ranges.push(markers[ch.type].range(doc.line(l).from));
        }
      }
    }
    if (!editor.view) return;
    ranges.sort((a, b) => a.from - b.from);
    editor.view.dispatch({ effects: setMarkers.of(RangeSet.of(ranges, true)) });
  }

  function refreshAllGutters() {
    for (const item of mide.workspace.getItems()) if (item.type === 'editor') updateGutter(item);
  }

  const timers = new WeakMap();
  mide.workspace.onDidUpdateEditor((editor, update) => {
    if (!update?.docChanged || editor.type !== 'editor') return;
    clearTimeout(timers.get(editor));
    timers.set(editor, setTimeout(async () => {
      const path = editor.getPath();
      if (path && !statuses.has(path) && repoRoot && path.startsWith(repoRoot + '/')) {
        statuses.set(path, 'modified'); // optimistic; confirmed on next refresh
      }
      updateGutter(editor);
    }, 350));
  });
  mide.workspace.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => updateGutter(item), 30); });

  let refreshTimer = null;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); };
  mide.workspace.onDidChangeProject(refresh);
  mide.workspace.onDidSave(scheduleRefresh);
  mide.workspace.onDidChangeFiles(scheduleRefresh);
  const onFocus = () => scheduleRefresh();
  window.addEventListener('focus', onFocus);
  mide.subscriptions.add({ dispose: () => window.removeEventListener('focus', onFocus) });
  refresh();
}
