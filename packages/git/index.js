// Git integration. Provides the "git-status" service that tree-view consumes,
// a branch indicator, and diff markers in the editor gutter.
import { diffLines } from './diff.js';

export function activate(mide) {
  const { h, icon } = mide.ui;
  const { StateField, StateEffect, RangeSet } = mide.cm.state;
  const { gutter, GutterMarker } = mide.cm.view;

  // Each project folder can be (in) its own repository. `statuses` and `dirStatuses` cover all of
  // them; `repoRoot` and `branch` are the repository of the active file's folder.
  let repos = new Map(); // repo root -> { root, branch, statuses }
  let folderRepos = new Map(); // project folder -> its repo root
  let repoRoot = null;
  let branch = '';
  let statuses = new Map(); // abs path -> 'modified' | 'added' | 'untracked' | 'deleted'
  let dirStatuses = new Map();
  const listeners = new Set();
  const markerClicks = new Set();
  const headCache = new Map(); // abs path -> HEAD text | null

  // Background git calls never run a repo's fsmonitor command (and only run at all in trusted folders).
  const SAFE = ['-c', 'core.fsmonitor=false'];
  const git = (...args) => mide.process.exec('git', [...SAFE, ...args], { cwd: repoRoot || mide.workspace.project });
  // The repo root derived from the project path itself (not `--show-toplevel`, which resolves
  // symlinks and then no longer matches the paths the editor uses).
  async function findRoot(project) {
    const r = await mide.process.exec('git', [...SAFE, 'rev-parse', '--show-cdup'], { cwd: project });
    if (r.code !== 0) return null;
    const parts = project.split('/');
    for (const seg of r.stdout.trim().split('/').filter(Boolean)) if (seg === '..') parts.pop();
    return parts.join('/') || '/';
  }

  /** The repository a path is in (the innermost one), or null. */
  function repoOf(path) {
    let best = null;
    for (const root of path ? repos.keys() : []) if ((path === root || path.startsWith(root + '/')) && (!best || root.length > best.length)) best = root;
    return best;
  }

  async function readRepo(root) {
    const inRoot = (...args) => mide.process.exec('git', [...SAFE, ...args], { cwd: root });
    // --no-optional-locks: background status must not hold .git/index.lock while you stage or commit.
    const [b, s] = await Promise.all([inRoot('rev-parse', '--abbrev-ref', 'HEAD'), inRoot('--no-optional-locks', 'status', '--porcelain=v1', '-z')]);
    let name = b.code === 0 ? b.stdout.trim() : '';
    if (!name || name === 'HEAD') {
      // No commits yet, or detached: symbolic-ref knows the branch name in the first case.
      const sym = await inRoot('symbolic-ref', '--short', 'HEAD');
      name = sym.code === 0 ? sym.stdout.trim() : b.code === 0 ? 'detached' : '';
    }
    const repo = { root, branch: name, statuses: new Map() };
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
      repo.statuses.set(`${root}/${file.replace(/\/$/, '')}`, st);
    }
    return repo;
  }

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq; // a newer refresh supersedes this one (e.g. the project changed meanwhile)
    const folders = mide.workspace.folders.filter((f) => mide.workspace.isTrusted(f));
    const roots = await Promise.all(folders.map(findRoot));
    if (seq !== refreshSeq) return;
    const unique = [...new Set(roots.filter(Boolean))];
    const found = await Promise.all(unique.map(readRepo));
    if (seq !== refreshSeq) return;
    repos = new Map(found.map((r) => [r.root, r]));
    folderRepos = new Map(folders.map((f, i) => [f, roots[i]]).filter(([, r]) => r));
    statuses = new Map(found.flatMap((r) => [...r.statuses]));
    dirStatuses = new Map();
    for (const repo of found) {
      for (const [p, st] of repo.statuses) {
        let dir = p.slice(0, p.lastIndexOf('/'));
        while (dir.length >= repo.root.length) {
          const prev = dirStatuses.get(dir);
          if (prev !== 'modified') dirStatuses.set(dir, st === 'deleted' ? 'modified' : prev && prev !== st ? 'modified' : st);
          dir = dir.slice(0, dir.lastIndexOf('/'));
        }
      }
    }
    pickCurrent();
    headCache.clear();
    emit();
    refreshAllGutters();
  }

  // The branch item and branch commands follow the active file's folder.
  function pickCurrent() {
    const repo = repos.get(folderRepos.get(mide.workspace.getActiveFolder()));
    const changed = (repo?.root ?? null) !== repoRoot;
    repoRoot = repo?.root ?? null;
    branch = repo?.branch ?? '';
    return changed;
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
    /** The repository `path` is in, if it's one of the project's. */
    rootFor: (path) => repoOf(path),
    branchFor: (path) => repos.get(repoOf(path))?.branch ?? '',
    onDidChange: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    /** A click on a change marker in the gutter: fn(view, line) with a 1-based line; return true to handle it. */
    onDidClickMarker: (fn) => { markerClicks.add(fn); return { dispose: () => markerClicks.delete(fn) }; },
    refresh,
  });

  // --- status bar ----------------------------------------------------------
  const label = h('span.git-branch');
  mide.statusBar.addItem({ id: 'git-branch', element: label, align: 'left', priority: 5, tooltip: 'Git: switch branch', onClick: () => mide.commands.run('git:checkout-branch') });
  function renderStatus() {
    if (!repoRoot) { label.replaceChildren(); return; }
    const changed = repos.get(repoRoot)?.statuses.size || 0;
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
  // A click on a marker goes to whoever asked for it (git-hunks opens that change).
  function clickMarker(view, line) {
    if (!markerClicks.size) return false;
    let hit = false;
    view.state.field(field).between(line.from, line.from, () => { hit = true; return false; });
    const number = view.state.doc.lineAt(line.from).number;
    for (const fn of hit ? markerClicks : []) if (fn(view, number)) return true;
    return false;
  }
  const gitGutter = [field, gutter({ class: 'cm-git-gutter', markers: (v) => v.state.field(field), domEventHandlers: { mousedown: clickMarker } })];

  let gutterExt = null;
  mide.config.observe('git.gutter', (on) => {
    gutterExt?.dispose();
    gutterExt = on ? mide.editor.addExtension(gitGutter) : null;
    if (on) setTimeout(refreshAllGutters, 50);
  });

  async function headText(path, root) {
    if (headCache.has(path)) return headCache.get(path);
    const rel = path.slice(root.length + 1);
    const r = await mide.process.exec('git', [...SAFE, 'show', `HEAD:${rel}`], { cwd: root });
    const text = r.code === 0 ? r.stdout : null;
    headCache.set(path, text);
    return text;
  }

  async function updateGutter(editor) {
    if (!editor?.view || !mide.config.get('git.gutter')) return;
    const path = editor.getPath();
    const root = repoOf(path);
    if (!root || path === root) return;
    const view = editor.view;
    let ranges = [];
    const st = mide.editor.isLargeFile(editor) ? null : statusFor(path); // no diff (or a marker per line) for a large file
    if (st === 'untracked' || st === 'added') {
      for (let i = 1; i <= view.state.doc.lines; i++) ranges.push(markers.added.range(view.state.doc.line(i).from));
    } else if (st) {
      const base = await headText(path, root);
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
      if (path && !statuses.has(path) && repoOf(path)) {
        statuses.set(path, 'modified'); // optimistic; confirmed on next refresh
      }
      updateGutter(editor);
    }, 350));
  });
  mide.workspace.onDidOpenItem((item) => { if (item.type === 'editor') setTimeout(() => updateGutter(item), 30); });
  mide.workspace.onDidChangeLargeFile((doc) => { for (const item of doc.views) updateGutter(item); });

  let refreshTimer = null;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); };
  mide.workspace.onDidChangeFolders(refresh);
  mide.workspace.onDidChangeTrust(refresh);
  mide.workspace.onDidChangeActiveItem(() => { if (pickCurrent()) emit(); });
  mide.workspace.onDidSave(scheduleRefresh);
  mide.workspace.onDidChangeFiles(scheduleRefresh);
  const onFocus = () => scheduleRefresh();
  window.addEventListener('focus', onFocus);
  mide.subscriptions.add({ dispose: () => window.removeEventListener('focus', onFocus) });
  refresh();
}
