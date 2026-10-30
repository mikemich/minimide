// Git History: a repository's commits (with a lane graph, branch/tag labels, a filter and paging),
// what a commit changed, a file's history across renames, and stashes. Git runs only in trusted
// folders, never with the repository's fsmonitor command, and never waits for a password prompt.
import { LOG_FORMAT, SHOW_FORMAT, STASH_FORMAT, parseLog, parseFileLog, parseShow, parseTreeDiff, parseStashes, relativeTime, LaneGraph } from './parse.js';

const PAGE = 200;
const LANE_W = 12;
const ROW_H = 24;
const MAX_LANES = 16; // wider graphs are clipped
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const COMMIT_ICON = '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>';

export function activate(mide) {
  const { h, icon, fileIcon } = mide.ui;
  const ws = mide.workspace;
  mide.ui.registerIcon('git-commit', COMMIT_ICON);
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const short = (hash) => (hash || '').slice(0, 7);
  const when = (t) => new Date(t * 1000).toLocaleString();
  let disposed = false;

  // --- running git -----------------------------------------------------------------
  // Background-safe: no fsmonitor hook, no optional locks, no prompts, no editor.
  const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'color.ui=false'];
  const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' };
  function git(root, args, { timeout = 60000 } = {}) {
    // A repository's settings can run commands, so nothing runs until its folder is trusted.
    if (!root || !ws.isTrusted(root)) return Promise.resolve({ code: 1, stdout: '', stderr: 'Restricted Mode: git is off until you trust this folder.', restricted: true });
    return mide.process.exec('git', [...SAFE, ...args], { cwd: root, timeout, env: ENV });
  }
  const errorText = (r) => (r.stderr || r.stdout || '').trim() || `git exited with code ${r.code}`;
  function failed(label, r) {
    const msg = errorText(r);
    mide.notify.error(`git ${label} failed`, msg);
    return false;
  }

  // The repository root derived from the path itself (not `--show-toplevel`, which resolves
  // symlinks and then no longer matches the paths the editor uses).
  async function findRoot(dir) {
    const r = await mide.process.exec('git', [...SAFE, 'rev-parse', '--show-cdup'], { cwd: dir, env: ENV });
    if (r.code !== 0) return null;
    const parts = dir.split('/');
    for (const seg of r.stdout.trim().split('/').filter(Boolean)) if (seg === '..') parts.pop();
    return parts.join('/') || '/';
  }

  /** The repository a file (default: the active file, else the active folder) is in: { root } or { reason, folder }. */
  async function repoFor(path = null) {
    const folder = (path && ws.folderFor(path)) || ws.getActiveFolder() || ws.project;
    const target = path || folder;
    if (!target) return { root: null, reason: 'no-folder' };
    if (!ws.isTrusted(target)) return { root: null, reason: 'restricted', folder: (path && ws.folderFor(path)) || folder || target };
    let root = mide.services.get('git-status')?.rootFor?.(target) || null;
    if (!root) {
      const st = await mide.fs.stat(target).catch(() => null);
      root = await findRoot(st?.isDir ? target : dirname(target));
    }
    return root ? { root } : { root: null, reason: 'not-repo' };
  }

  function explain(repo) {
    if (repo.reason === 'restricted') {
      mide.notify.warn('Restricted Mode', 'Git is off until you trust this folder, because a repository\'s settings can run commands.',
        { actions: [{ label: 'Trust Folder…', run: () => ws.requestTrust(repo.folder) }] });
    } else if (repo.reason === 'not-repo') mide.notify.info('Not a git repository', 'The file\'s folder is not in a git repository.');
    else mide.notify.info('Open a folder first.');
  }

  // Changes run one at a time (two at once fight over .git/index.lock), then everything refreshes.
  let queue = Promise.resolve();
  function change(root, args) {
    const job = queue.then(() => git(root, args));
    queue = job.catch(() => {});
    return job.then(async (r) => { await afterChange(root); return r; });
  }
  async function afterChange(root) {
    mide.services.get('git-status')?.refresh?.();
    if (mide.commands.has('source-control:refresh')) mide.commands.run('source-control:refresh');
    for (const view of views.values()) if (view.root === root) { view.sig = null; view.reload(); }
  }

  // --- the actions on a commit ---------------------------------------------------------
  async function uncommitted(root) {
    const r = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    if (r.code !== 0) return errorText(r);
    return r.stdout.trim();
  }

  function copyHash(hash) {
    mide.clipboard.write(hash);
    mide.notify.info('Copied commit hash', hash);
  }

  async function checkout(root, c) {
    const dirty = await uncommitted(root);
    if (dirty) {
      const lines = dirty.split('\n');
      mide.notify.warn('Checkout refused: there are uncommitted changes', `Commit or stash them first.\n\n${lines.slice(0, 8).join('\n')}${lines.length > 8 ? `\n… and ${lines.length - 8} more` : ''}`);
      return false;
    }
    const choice = await mide.ui.confirm({
      type: 'question',
      message: `Check out ${short(c.hash)}?`,
      detail: `“${c.subject}”\n\nHEAD will be detached at this commit. Create a branch there if you want to keep new commits.`,
      buttons: ['Check Out', 'Cancel'],
    });
    if (choice !== 0) return false;
    const r = await change(root, ['checkout', '--detach', c.hash]);
    if (r.code !== 0) return failed('checkout', r);
    mide.notify.success(`HEAD is now at ${short(c.hash)}`, c.subject);
    return true;
  }

  async function createBranch(root, c) {
    const name = await mide.ui.prompt({
      title: `New branch at ${short(c.hash)}`,
      placeholder: 'Branch name',
      validate: (v) => (!v.trim() ? 'Type a branch name' : /\s/.test(v.trim()) ? 'Branch names have no spaces' : null),
    });
    if (!name?.trim()) return false;
    const branch = name.trim();
    const valid = await git(root, ['check-ref-format', '--branch', branch]);
    if (valid.code !== 0) { mide.notify.error(`“${branch}” is not a valid branch name`); return false; }
    const r = await change(root, ['branch', branch, c.hash]);
    if (r.code !== 0) return failed('branch', r);
    mide.notify.success(`Created branch ${branch}`, `at ${short(c.hash)} ${c.subject}`, {
      actions: [{ label: 'Check Out', run: async () => { const x = await change(root, ['checkout', branch]); if (x.code !== 0) failed('checkout', x); } }],
    });
    return true;
  }

  async function revert(root, c) {
    const choice = await mide.ui.confirm({
      type: 'question',
      message: `Revert ${short(c.hash)}?`,
      detail: `“${c.subject}”\n\nA new commit undoes its changes${c.parents.length > 1 ? ' (relative to its first parent)' : ''}.`,
      buttons: ['Revert', 'Cancel'],
    });
    if (choice !== 0) return false;
    const r = await change(root, ['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.hash]);
    if (r.code !== 0) return conflict('revert', r, root);
    mide.notify.success(`Reverted ${short(c.hash)}`, c.subject);
    return true;
  }

  async function cherryPick(root, c) {
    const choice = await mide.ui.confirm({
      type: 'question',
      message: `Cherry-pick ${short(c.hash)}?`,
      detail: `“${c.subject}”\n\nIts changes are applied on top of the current branch as a new commit.`,
      buttons: ['Cherry-Pick', 'Cancel'],
    });
    if (choice !== 0) return false;
    const r = await change(root, ['cherry-pick', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.hash]);
    if (r.code !== 0) return conflict('cherry-pick', r, root);
    mide.notify.success(`Cherry-picked ${short(c.hash)}`, c.subject);
    return true;
  }

  /** A revert or cherry-pick that stopped: show git's words, and offer to abort when it is in progress. */
  async function conflict(op, r, root) {
    const msg = errorText(r);
    // Stopped half way (a conflict, or a change that is already there): git keeps REVERT_HEAD / CHERRY_PICK_HEAD.
    const stopped = (await git(root, ['rev-parse', '--quiet', '--verify', op === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD'])).code === 0;
    mide.notify.error(`git ${op} failed`, msg, stopped ? {
      actions: [{ label: `Abort ${op === 'revert' ? 'Revert' : 'Cherry-Pick'}`, run: async () => { const a = await change(root, [op, '--abort']); if (a.code !== 0) failed(`${op} --abort`, a); } }],
    } : {});
    return false;
  }

  // --- stashes ----------------------------------------------------------------------
  async function listStashes(root) {
    const r = await git(root, ['stash', 'list', '-z', `--format=${STASH_FORMAT}`]);
    return r.code === 0 ? parseStashes(r.stdout) : [];
  }
  /** The stash@{n} name of a stash (by its hash) right now: other stashes may have come or gone. */
  async function stashRef(root, stash) {
    const now = (await listStashes(root)).find((s) => s.hash === stash.hash);
    if (!now) mide.notify.warn('That stash is gone', stash.subject);
    return now?.ref || null;
  }

  async function stashChanges(root) {
    const message = await mide.ui.prompt({ title: 'Stash message (optional). Enter to continue.', placeholder: 'Message' });
    if (message == null) return false;
    const choice = await mide.ui.confirm({
      type: 'question',
      message: 'Stash your changes?',
      detail: 'Tracked changes are saved in a stash and the working tree goes back to the last commit. Untracked files are included only if you choose so.',
      buttons: ['Stash', 'Stash Including Untracked', 'Cancel'],
    });
    if (choice !== 0 && choice !== 1) return false;
    const r = await change(root, ['stash', 'push', ...(choice === 1 ? ['--include-untracked'] : []), ...(message.trim() ? ['-m', message.trim()] : [])]);
    if (r.code !== 0) return failed('stash', r);
    if (/No local changes to save/i.test(r.stdout + r.stderr)) { mide.notify.info('No local changes to stash'); return false; }
    mide.notify.success('Changes stashed', message.trim() || r.stdout.trim().split('\n')[0]);
    return true;
  }

  async function applyStash(root, stash, { pop = false } = {}) {
    const ref = pop ? await stashRef(root, stash) : stash.hash;
    if (!ref) return false;
    const r = await change(root, ['stash', pop ? 'pop' : 'apply', ref]);
    if (r.code !== 0) return failed(pop ? 'stash pop' : 'stash apply', r);
    mide.notify.success(pop ? 'Stash popped' : 'Stash applied', stash.subject);
    return true;
  }

  async function dropStash(root, stash) {
    const choice = await mide.ui.confirm({
      type: 'warning',
      message: `Drop ${stash.ref}?`,
      detail: `“${stash.subject}”\n\nThe stashed changes are deleted.`,
      buttons: ['Drop Stash', 'Cancel'],
    });
    if (choice !== 0) return false;
    const ref = await stashRef(root, stash);
    if (!ref) return false;
    const r = await change(root, ['stash', 'drop', ref]);
    if (r.code !== 0) return failed('stash drop', r);
    mide.notify.success('Stash dropped', stash.subject);
    return true;
  }

  /** Picks a stash, then runs fn on it. */
  async function pickStash(placeholder, fn) {
    const repo = await repoFor(ws.getActiveEditor()?.getPath() || null);
    if (!repo.root) return explain(repo);
    const list = await listStashes(repo.root);
    if (!list.length) return mide.notify.info('No stashes');
    mide.ui.selectList({
      placeholder,
      items: list.map((s) => ({ label: s.subject, detail: `${s.ref} · ${relativeTime(s.time)}`, s })),
      onSelect: (item) => fn(repo.root, item.s),
    });
  }

  // --- reading commits ----------------------------------------------------------------
  /** The files a commit (or a stash) changed, against its first parent, with line counts. */
  async function filesOf(root, commit, { stash = false } = {}) {
    const r = await git(root, ['show', '--format=', '-z', '-M', '--raw', '--numstat', '--diff-merges=first-parent', commit.hash, '--']);
    if (r.code !== 0) throw new Error(errorText(r));
    const parent = commit.parents[0] || null;
    const files = parseTreeDiff(r.stdout).map((f) => ({
      ...f,
      left: f.status === 'A' || !parent ? null : { ref: parent, path: f.oldPath || f.path },
      right: f.status === 'D' ? null : { ref: commit.hash, path: f.path },
    }));
    // A stash made with --include-untracked keeps the untracked files in a third parent.
    if (stash && commit.parents[2]) {
      const u = await git(root, ['show', '--format=', '-z', '--raw', '--numstat', commit.parents[2], '--']);
      if (u.code === 0) {
        for (const f of parseTreeDiff(u.stdout)) files.push({ ...f, status: 'A', untracked: true, left: null, right: { ref: commit.parents[2], path: f.path } });
      }
    }
    return files;
  }

  async function blob(root, side) {
    if (!side) return { text: '' };
    const spec = `${side.ref}:${side.path}`;
    const size = await git(root, ['cat-file', '-s', spec]);
    if (size.code !== 0) return { text: '', missing: true };
    if (Number(size.stdout) > MAX_DIFF_BYTES) return { text: '', tooBig: true };
    const r = await git(root, ['cat-file', 'blob', spec]);
    if (r.code !== 0) return { text: '', missing: true };
    if (r.stdout.includes('\0')) return { text: '', binary: true };
    return { text: r.stdout };
  }

  async function showCommit(root, ref) {
    const r = await git(root, ['show', '-s', '-z', `--format=${SHOW_FORMAT}`, '--decorate=full', '--decorate-refs-exclude=refs/stash', ref, '--']);
    if (r.code !== 0) throw new Error(errorText(r));
    return parseShow(r.stdout);
  }

  // --- diffs ----------------------------------------------------------------------------
  /** A read-only side-by-side (or inline) diff of a and b in host, like source control's. */
  async function mountDiff(host, a, b, path, layout) {
    const { MergeView, unifiedMergeView } = await mide.cm.extras.merge();
    const { EditorView, lineNumbers } = mide.cm.view;
    const { EditorState } = mide.cm.state;
    const { syntaxHighlighting } = mide.cm.language;
    const lang = await mide.editor.languageFor(path);
    const extensions = [lineNumbers(), mide.editor.highlighters.map((x) => syntaxHighlighting(x)), EditorView.editable.of(false), EditorState.readOnly.of(true), lang || []];
    host.replaceChildren();
    if (layout === 'inline') {
      return new EditorView({ parent: host, doc: b, extensions: [...extensions, unifiedMergeView({ original: a, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } })] });
    }
    return new MergeView({ parent: host, a: { doc: a, extensions }, b: { doc: b, extensions }, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true, highlightChanges: true });
  }

  /** Fills host with the diff of one file of a commit; returns the view (or null for a message). */
  async function fileDiff(root, file, host, layout, isCurrent = () => true) {
    const [a, b] = await Promise.all([blob(root, file.left), blob(root, file.right)]);
    if (!isCurrent()) return null;
    const why = [a, b].find((x) => x.binary) ? 'Binary file' : [a, b].find((x) => x.tooBig) ? 'File too large to compare' : null;
    if (why || a.text === b.text) {
      host.replaceChildren(h('div.gh-empty', h('div.gh-empty-title', why || 'No changes'), h('div', why ? 'There is nothing to show side by side.' : 'The file is the same on both sides.')));
      return null;
    }
    return mountDiff(host, a.text, b.text, file.path, layout);
  }

  const sideLabel = (side, fallback) => (side ? `${short(side.ref)}${side.path ? ` · ${side.path}` : ''}` : fallback);

  class CommitDiffItem {
    constructor(root, commit, file) {
      this.type = 'git-commit-diff';
      this.iconName = 'split';
      this.root = root;
      this.commit = commit;
      this.file = file;
      this.id = `git-commit-diff:${root}:${commit.hash}:${file.path}`;
      this.layout = mide.config.get('source-control.diffLayout') === 'inline' ? 'inline' : 'side-by-side';
      this.host = h('div.gh-diff-host');
      this.leftLabel = h('span.gh-diff-side', sideLabel(file.left, 'New file'));
      this.rightLabel = h('span.gh-diff-side', sideLabel(file.right, 'Deleted'));
      this.element = h('div.gh-diff', { tabIndex: -1 },
        h('div.gh-diff-toolbar',
          h('span.gh-diff-path', file.oldPath ? `${file.oldPath} → ${file.path}` : file.path),
          this.leftLabel, h('span.gh-diff-arrow', '→'), this.rightLabel,
          h('div.gh-diff-actions',
            h('button.btn.small', { onclick: () => { this.layout = this.layout === 'inline' ? 'side-by-side' : 'inline'; this.load(); } }, 'Toggle Layout'),
            file.right ? h('button.btn.small', { onclick: () => openVersion(root, file.right.ref, file.right.path, commit) }, 'Open This Version') : null)),
        this.host);
      this.load();
    }
    async load() {
      const seq = (this.seq = (this.seq || 0) + 1);
      this.view?.destroy();
      this.view = await fileDiff(this.root, this.file, this.host, this.layout, () => seq === this.seq && !this.gone);
      if (this.gone) this.view?.destroy();
    }
    on() { return { dispose() {} }; }
    getTitle() { return `${basename(this.file.path)} (${short(this.commit.hash)})`; }
    getElement() { return this.element; }
    getPath() { return null; }
    isDirty() { return false; }
    focus() { this.element.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { this.gone = true; this.view?.destroy(); }
  }

  function openFileDiff(root, commit, file) {
    const id = `git-commit-diff:${root}:${commit.hash}:${file.path}`;
    const existing = ws.getItems().find((i) => i.type === 'git-commit-diff' && i.id === id);
    return ws.openItem(existing || new CommitDiffItem(root, commit, file));
  }

  // --- a file as it was in a commit, read-only ---------------------------------------
  class VersionItem {
    constructor(root, ref, path, commit, text) {
      this.type = 'git-version';
      this.iconName = 'git-commit';
      this.root = root;
      this.ref = ref;
      this.path = path;
      this.body = h('div.gh-version-body');
      this.element = h('div.gh-version', { tabIndex: -1 },
        h('div.gh-version-note', `Read-only: ${path} at ${short(ref)}${commit?.subject ? ` · ${commit.subject}` : ''}`),
        this.body);
      this.build(text);
    }
    async build(text) {
      const { EditorView, lineNumbers } = mide.cm.view;
      const { EditorState } = mide.cm.state;
      const { syntaxHighlighting } = mide.cm.language;
      const lang = await mide.editor.languageFor(this.path);
      if (this.gone) return;
      this.view = new EditorView({
        parent: this.body,
        doc: text,
        extensions: [lineNumbers(), mide.editor.highlighters.map((x) => syntaxHighlighting(x)), EditorState.readOnly.of(true), EditorView.editable.of(false), lang || []],
      });
    }
    on() { return { dispose() {} }; }
    getTitle() { return `${basename(this.path)} @ ${short(this.ref)}`; }
    getElement() { return this.element; }
    getPath() { return null; }
    isDirty() { return false; }
    focus() { this.view?.focus(); }
    serialize() { return null; }
    destroy() { this.gone = true; this.view?.destroy(); }
  }

  async function openVersion(root, ref, path, commit) {
    const b = await blob(root, { ref, path });
    if (b.missing) return mide.notify.error(`${path} is not in ${short(ref)}`);
    if (b.binary || b.tooBig) return mide.notify.info(b.binary ? 'That is a binary file' : 'That file is too large to open');
    return ws.openItem(new VersionItem(root, ref, path, commit, b.text));
  }

  // --- the graph ---------------------------------------------------------------------
  function graphSvg(row) {
    const x = (i) => i * LANE_W + LANE_W / 2;
    const mid = ROW_H / 2;
    const width = Math.min(row.width, MAX_LANES) * LANE_W;
    const line = (a, b, y0, y1, color) => (a === b
      ? `<path class="gh-l${color % 8}" d="M${x(a)} ${y0}V${y1}"/>`
      : `<path class="gh-l${color % 8}" d="M${x(a)} ${y0}C${x(a)} ${(y0 + y1) / 2} ${x(b)} ${(y0 + y1) / 2} ${x(b)} ${y1}"/>`);
    let s = `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">`;
    for (const [a, b, c] of row.top) s += line(a, b, 0, mid, c);
    for (const [a, b, c] of row.bottom) s += line(a, b, mid, ROW_H, c);
    s += `<circle class="gh-d${row.color % 8}${row.merge ? ' gh-merge-dot' : ''}" cx="${x(row.col)}" cy="${mid}" r="${row.merge ? 4 : 3.5}"/>`;
    return `${s}</svg>`;
  }

  function refBadges(refs) {
    return refs.map((r) => h(`span.gh-ref.gh-ref-${r.kind}${r.current ? '.current' : ''}`, { title: r.kind === 'tag' ? `tag ${r.name}` : r.kind === 'remote' ? `remote branch ${r.name}` : r.current ? `${r.name} (checked out)` : r.name },
      r.name));
  }

  // --- where commits come from -------------------------------------------------------------
  /**
   * Pages of `git log` (PAGE at a time, with --skip). git ignores --skip with --follow, so a file's
   * history asks for the first skip + PAGE commits and drops the ones it already has.
   */
  function logSource(root, args, { file = false } = {}) {
    let skip = 0;
    const src = {
      done: false,
      async next() {
        if (src.done) return [];
        const [pre, post] = args;
        const range = file ? [`--max-count=${skip + PAGE}`] : [`--skip=${skip}`, `--max-count=${PAGE}`];
        const r = await git(root, [...pre, ...range, ...post]);
        if (r.code !== 0) {
          src.done = true;
          if (skip === 0) throw new Error(errorText(r));
          return [];
        }
        const list = file ? parseFileLog(r.stdout).slice(skip) : parseLog(r.stdout);
        skip += PAGE;
        if (list.length < PAGE) src.done = true;
        return list;
      },
    };
    return src;
  }

  /** Several logs merged newest first (git can't OR --grep with --author), each read lazily. */
  function mergedSource(sources) {
    const bufs = sources.map(() => []);
    const src = {
      done: false,
      async next() {
        const out = [];
        while (out.length < PAGE) {
          await Promise.all(sources.map(async (s, i) => { if (!bufs[i].length && !s.done) bufs[i].push(...await s.next()); }));
          let best = -1;
          for (let i = 0; i < bufs.length; i++) if (bufs[i].length && (best < 0 || bufs[i][0].ctime > bufs[best][0].ctime)) best = i;
          if (best < 0) break;
          const c = bufs[best].shift();
          for (let i = 0; i < bufs.length; i++) if (i !== best && bufs[i][0]?.hash === c.hash) bufs[i].shift();
          out.push(c);
        }
        src.done = sources.every((s, i) => s.done && !bufs[i].length);
        return out;
      },
    };
    return src;
  }

  // --- the history view --------------------------------------------------------------------
  const views = new Map(); // key -> HistoryView

  class HistoryView {
    /** file: a path relative to root for a file's history, else the whole repository. */
    constructor(root, file = null) {
      this.type = 'git-history';
      this.iconName = 'git-commit';
      this.root = root;
      this.file = file;
      this.key = file ? `${root}\0${file}` : root;
      this.listeners = new Map();
      this.gen = 0;
      this.detailSeq = 0;
      this.selected = null; // { kind: 'commit' | 'stash', hash }
      this.layout = mide.config.get('source-control.diffLayout') === 'inline' ? 'inline' : 'side-by-side';
      this.branchSelect = h('select.input.gh-branch', { title: 'Which commits', onchange: () => this.reset() },
        h('option', { value: 'HEAD' }, 'Current branch'), h('option', { value: 'all' }, 'All branches'));
      this.filter = h('input.input.gh-filter', {
        type: 'search', placeholder: 'Filter by message, author or hash', spellcheck: false,
        oninput: () => { clearTimeout(this.filterTimer); this.filterTimer = setTimeout(() => this.reset(), 250); },
        onkeydown: (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); this.list.focus(); } },
      });
      this.commitsEl = h('div.gh-commits');
      this.stashEl = h('div.gh-stashes');
      this.status = h('div.gh-list-status');
      this.list = h('div.gh-list', { tabIndex: 0, onkeydown: (e) => this.onKey(e), onscroll: () => this.maybeLoadMore() },
        file ? null : this.stashEl, this.commitsEl, this.status);
      this.main = h('div.gh-main');
      const title = file ? h('div.gh-head', h('div.gh-head-title', basename(file)), h('div.gh-head-sub', { title: `${root}/${file}` }, dirname(file) === '/' ? mide.path.basename(root) : `${mide.path.basename(root)}/${dirname(file)}`))
        : h('div.gh-head', h('div.gh-head-title', mide.path.basename(root)), h('div.gh-head-sub', { title: root }, 'History'));
      this.element = h(`div.gh-view${file ? '.gh-file-mode' : ''}`, { tabIndex: -1 },
        h('div.gh-side',
          h('div.gh-toolbar', title,
            h('div.gh-tools',
              file ? null : h('button.icon-btn', { title: 'Stash Changes…', onclick: () => stashChanges(this.root) }, icon('plus', 14)),
              h('button.icon-btn', { title: 'Refresh', onclick: () => this.reload() }, icon('refresh', 14)))),
          h('div.gh-filters', file ? null : this.branchSelect, this.filter),
          this.list),
        this.main);
      this.showEmptyMain();
      this.loadBranches();
      this.reset();
    }

    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    getTitle() { return this.file ? `${basename(this.file)} (git history)` : `History: ${mide.path.basename(this.root)}`; }
    getElement() { return this.element; }
    getPath() { return null; }
    isDirty() { return false; }
    focus() { this.list.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() {
      this.gone = true;
      this.gen++;
      clearTimeout(this.filterTimer);
      this.diff?.destroy();
      views.delete(this.key);
    }

    async loadBranches() {
      const r = await git(this.root, ['for-each-ref', '--format=%(refname)', '--sort=-committerdate', 'refs/heads']);
      if (r.code !== 0 || this.gone) return;
      const value = this.branchSelect.value;
      const branches = r.stdout.split('\n').filter(Boolean);
      const current = mide.services.get('git-status')?.branchFor?.(this.root);
      this.branchSelect.replaceChildren(
        h('option', { value: 'HEAD' }, current && current !== 'detached' ? `Current branch (${current})` : 'Current (HEAD)'),
        h('option', { value: 'all' }, 'All branches'),
        ...branches.map((ref) => h('option', { value: ref }, ref.replace(/^refs\/heads\//, ''))));
      this.branchSelect.value = [...this.branchSelect.options].some((o) => o.value === value) ? value : 'HEAD';
    }

    /** The commits to list: [git args before --skip, after it]. */
    sources() {
      const q = this.filter.value.trim();
      const pick = this.branchSelect.value;
      const revs = this.file || pick === 'HEAD' ? ['HEAD'] : pick === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : [pick];
      const pre = this.file
        ? ['log', '-z', `--format=%x1e${LOG_FORMAT}`, '--decorate=full', '--decorate-refs-exclude=refs/stash', '--name-status', '-M', '--follow']
        : ['log', '-z', `--format=${LOG_FORMAT}`, '--decorate=full', '--decorate-refs-exclude=refs/stash'];
      const post = (extra) => [...extra, ...revs, '--', ...(this.file ? [this.file] : [])];
      const opts = { file: !!this.file };
      if (!q) return logSource(this.root, [pre, post([])], opts);
      const match = ['--regexp-ignore-case', '--fixed-strings'];
      return mergedSource([
        logSource(this.root, [pre, post([...match, `--grep=${q}`])], opts),
        logSource(this.root, [pre, post([...match, `--author=${q}`])], opts),
      ]);
    }

    /** Re-reads the list from the top (after a change), keeping the selection when it is still there. */
    reload() {
      this.loadBranches();
      this.reset({ keepSelection: true });
    }

    reset({ keepSelection = false } = {}) {
      const gen = ++this.gen;
      this.commits = [];
      this.byHash = new Map();
      this.done = false;
      this.loading = false;
      this.error = null;
      this.graphOn = !this.file && !this.filter.value.trim() && mide.config.get('git-history.showGraph') !== false;
      this.graph = new LaneGraph();
      this.graphWidth = 1;
      this.list.style.setProperty('--gh-graph-w', `${LANE_W}px`);
      this.list.classList.toggle('gh-no-graph', !this.graphOn);
      this.source = this.sources();
      this.commitsEl.replaceChildren();
      if (!keepSelection) { this.selected = null; this.showEmptyMain(); }
      this.hashMatch = null;
      const q = this.filter.value.trim();
      // A hash (or the start of one) in the filter finds that commit even if its message doesn't match.
      if (/^[0-9a-f]{4,40}$/i.test(q)) {
        this.hashMatch = git(this.root, ['log', '-1', '-z', `--format=${this.file ? '%x1e' : ''}${LOG_FORMAT}`, '--decorate=full', '--decorate-refs-exclude=refs/stash',
          ...(this.file ? ['--name-status', '-M'] : []), '--end-of-options', `${q}^{commit}`, '--', ...(this.file ? [this.file] : [])])
          .then((r) => (r.code === 0 ? (this.file ? parseFileLog(r.stdout) : parseLog(r.stdout)) : []).filter((c) => c.hash.startsWith(q.toLowerCase())));
      }
      if (!this.file) this.loadStashes(gen);
      this.loadMore(gen);
    }

    async loadMore(gen = this.gen) {
      if (this.loading || this.done || gen !== this.gen) return;
      this.loading = true;
      this.renderStatus();
      let page;
      try {
        page = await this.source.next();
        if (this.hashMatch) { const found = await this.hashMatch; this.hashMatch = null; page = [...found, ...page]; }
      } catch (err) {
        if (gen !== this.gen) return;
        this.loading = false;
        this.done = true;
        this.error = /does not have any commits yet|bad default revision|unknown revision/i.test(err.message) ? 'No commits yet.' : err.message;
        return this.renderStatus();
      }
      if (gen !== this.gen || this.gone) return; // a newer filter or branch replaced this request
      this.loading = false;
      this.done = this.source.done;
      const fresh = page.filter((c) => !this.byHash.has(c.hash));
      this.appendRows(fresh);
      this.renderStatus();
      if (this.selected && this.selected.kind === 'commit' && !this.rowFor(this.selected.hash)?.classList.contains('selected')) this.markSelected();
      // A file's history opens on its newest change.
      if (this.file && !this.selected && this.commits.length) this.select(this.commits[0]);
      // Keep going until the list can scroll.
      requestAnimationFrame(() => this.maybeLoadMore());
    }

    maybeLoadMore() {
      const l = this.list;
      if (!this.gone && !this.done && !this.loading && l.scrollTop + l.clientHeight > l.scrollHeight - 400) this.loadMore();
    }

    appendRows(commits) {
      const frag = document.createDocumentFragment();
      let pathHint = this.commits.at(-1)?.file?.oldPath || this.commits.at(-1)?.file?.path || this.file;
      for (const c of commits) {
        this.commits.push(c);
        this.byHash.set(c.hash, c);
        if (this.file) {
          // Merges list no files: the file kept the name it has in the next newer commit.
          if (!c.file) c.file = { status: 'M', path: pathHint };
          pathHint = c.file.oldPath || c.file.path;
        }
        let graph = null;
        if (this.graphOn) {
          const row = this.graph.add(c);
          if (row.width > this.graphWidth) {
            this.graphWidth = Math.min(row.width, MAX_LANES);
            this.list.style.setProperty('--gh-graph-w', `${this.graphWidth * LANE_W}px`);
          }
          graph = h('span.gh-graph', { html: graphSvg(row) });
        }
        const renamed = this.file && c.file?.oldPath ? h('span.gh-renamed', { title: `${c.file.oldPath} → ${c.file.path}` }, 'renamed') : null;
        frag.append(h(`div.gh-row${c.parents.length > 1 ? '.gh-merge' : ''}`, {
          dataset: { hash: c.hash },
          title: `${c.hash}\n${c.author} <${c.email}>\n${when(c.time)}\n\n${c.subject}`,
          onclick: () => this.select(c),
          oncontextmenu: (e) => { e.preventDefault(); this.select(c); this.commitMenu(c); },
        },
        graph,
        h('span.gh-text', ...refBadges(c.refs), c.parents.length > 1 && !this.graphOn ? h('span.gh-merge-mark', { title: 'Merge commit' }, icon('branch', 12)) : null, h('span.gh-subject', c.subject), renamed),
        h('span.gh-author', c.author),
        h('span.gh-date', { title: when(c.time) }, relativeTime(c.time)),
        h('span.gh-hash', short(c.hash))));
      }
      this.commitsEl.append(frag);
    }

    renderStatus() {
      const n = this.commits.length;
      const q = this.filter.value.trim();
      this.status.textContent = this.error ? this.error
        : this.loading ? (n ? `Loading more… (${n} so far)` : 'Loading…')
          : !n ? (q ? `No commits match “${q}”.` : 'No commits.')
            : this.done ? `${n} ${n === 1 ? 'commit' : 'commits'}` : `${n} commits · scroll for more`;
      this.status.classList.toggle('error', !!this.error && this.error !== 'No commits yet.');
    }

    async loadStashes(gen) {
      const list = await listStashes(this.root);
      if (gen !== this.gen || this.gone) return;
      this.stashes = list;
      const open = this.stashesOpen ?? true;
      const header = h('div.gh-section', {
        onclick: () => { this.stashesOpen = !open; this.loadStashes(this.gen); },
      }, h(`span.gh-chevron${open ? '.open' : ''}`, icon('chevron', 12)), h('span', 'Stashes'), h('span.gh-count', String(list.length)),
      h('button.icon-btn.gh-section-action', { title: 'Stash Changes…', onclick: (e) => { e.stopPropagation(); stashChanges(this.root); } }, icon('plus', 13)));
      const rows = open ? list.map((s) => h('div.gh-row.gh-stash-row', {
        dataset: { stash: s.hash },
        title: `${s.ref}\n${when(s.time)}`,
        onclick: () => this.selectStash(s),
        oncontextmenu: async (e) => {
          e.preventDefault();
          this.selectStash(s);
          const choice = await mide.ui.contextMenu([{ id: 'apply', label: 'Apply Stash' }, { id: 'pop', label: 'Pop Stash' }, { type: 'separator' }, { id: 'drop', label: 'Drop Stash…' }]);
          if (choice === 'apply') applyStash(this.root, s);
          else if (choice === 'pop') applyStash(this.root, s, { pop: true });
          else if (choice === 'drop') dropStash(this.root, s);
        },
      }, h('span.gh-text', h('span.gh-ref.gh-ref-stash', s.ref), h('span.gh-subject', s.subject)), h('span.gh-date', relativeTime(s.time)))) : [];
      this.stashEl.replaceChildren(header, ...rows, list.length || !open ? null : h('div.gh-stash-empty', 'No stashes. Stash your changes with +.'));
      this.markSelected();
    }

    rowFor(hash) { return this.list.querySelector(`.gh-row[data-hash="${hash}"]`); }

    markSelected() {
      for (const el of this.list.querySelectorAll('.gh-row.selected')) el.classList.remove('selected');
      const s = this.selected;
      if (!s) return;
      const el = s.kind === 'stash' ? this.list.querySelector(`.gh-row[data-stash="${s.hash}"]`) : this.rowFor(s.hash);
      el?.classList.add('selected');
      return el;
    }

    move(delta) {
      const rows = [...this.list.querySelectorAll('.gh-row')];
      const at = rows.findIndex((r) => r.classList.contains('selected'));
      const next = rows[at < 0 ? 0 : at + delta];
      if (!next) return;
      next.click();
      next.scrollIntoView({ block: 'nearest' });
      if (delta > 0) this.maybeLoadMore();
    }

    onKey(e) {
      if (e.target !== this.list) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.move(e.key === 'ArrowDown' ? 1 : -1); }
    }

    select(c) {
      this.selected = { kind: 'commit', hash: c.hash };
      this.markSelected();
      if (this.file) this.showFileCommit(c);
      else this.showDetails(c.hash);
    }

    selectStash(s) {
      this.selected = { kind: 'stash', hash: s.hash };
      this.markSelected();
      this.showDetails(s.hash, s);
    }

    /** Selects a commit by hash (or any ref), loading details even if it isn't in the loaded rows. */
    async reveal(ref) {
      const r = await git(this.root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
      const hash = r.code === 0 ? r.stdout.trim() : null;
      if (!hash) { mide.notify.warn(`No commit ${ref} in ${mide.path.basename(this.root)}`); return false; }
      const known = this.byHash.get(hash);
      if (known) { this.select(known); this.rowFor(hash)?.scrollIntoView({ block: 'center' }); return true; }
      this.selected = { kind: 'commit', hash };
      this.markSelected();
      if (!this.file) await this.showDetails(hash);
      return true;
    }

    showEmptyMain() {
      this.diff?.destroy();
      this.diff = null;
      this.main.replaceChildren(h('div.gh-empty', h('div.gh-empty-title', this.file ? 'Pick a commit' : 'Pick a commit or a stash'),
        h('div', this.file ? 'See how the file changed in it.' : 'See its message and the files it changed.')));
    }

    commitMenu(c) {
      return mide.ui.contextMenu([
        { id: 'copy', label: 'Copy Hash' },
        { type: 'separator' },
        { id: 'checkout', label: 'Checkout (Detached)…' },
        { id: 'branch', label: 'Create Branch Here…' },
        { type: 'separator' },
        { id: 'cherry', label: 'Cherry-Pick…' },
        { id: 'revert', label: 'Revert Commit…' },
      ]).then((choice) => this.act(choice, c));
    }

    act(id, c) {
      switch (id) {
        case 'copy': return copyHash(c.hash);
        case 'checkout': return checkout(this.root, c);
        case 'branch': return createBranch(this.root, c);
        case 'cherry': return cherryPick(this.root, c);
        case 'revert': return revert(this.root, c);
        case 'apply': return applyStash(this.root, c.stash);
        case 'pop': return applyStash(this.root, c.stash, { pop: true });
        case 'drop': return dropStash(this.root, c.stash);
      }
    }

    // --- one commit (or stash): message, metadata, actions and files ---
    async showDetails(hash, stash = null) {
      const seq = ++this.detailSeq;
      this.diff?.destroy();
      this.diff = null;
      let commit, files;
      try {
        commit = await showCommit(this.root, hash);
        files = await filesOf(this.root, commit, { stash: !!stash });
      } catch (err) {
        if (seq === this.detailSeq) this.main.replaceChildren(h('div.gh-empty', h('div.gh-empty-title', 'Could not read the commit'), h('div', err.message)));
        return;
      }
      if (seq !== this.detailSeq || this.gone) return;
      commit.stash = stash;
      this.current = commit;
      const body = commit.message.split('\n').slice(1).join('\n').replace(/^\n+/, '');
      const btn = (id, label, primary = false) => h(`button.btn.small${primary ? '.primary' : ''}`, { dataset: { action: id }, onclick: () => this.act(id, commit) }, label);
      const actions = stash
        ? [btn('apply', 'Apply', true), btn('pop', 'Pop'), btn('drop', 'Drop…'), btn('copy', 'Copy Hash')]
        : [btn('copy', 'Copy Hash'), btn('checkout', 'Checkout…'), btn('branch', 'Create Branch Here…'), btn('cherry', 'Cherry-Pick…'), btn('revert', 'Revert…')];
      const person = (name, email, t) => h('span', h('span.gh-person', name), h('span.gh-email', ` <${email}>`), h('span.gh-when', ` · ${when(t)} (${relativeTime(t)})`));
      const sameCommitter = commit.committer === commit.author && commit.committerEmail === commit.email && commit.committerTime === commit.time;
      const meta = [
        ['Author', person(commit.author, commit.email, commit.time)],
        sameCommitter ? null : ['Committer', person(commit.committer, commit.committerEmail, commit.committerTime)],
        [stash ? 'Stash' : 'Commit', h('span', h('code.gh-full-hash', commit.hash), stash ? h('span.gh-ref.gh-ref-stash', stash.ref) : null)],
        commit.parents.length ? ['Parents', h('span.gh-parents', ...commit.parents.map((p, i) => h('a.gh-parent', {
          href: '#', title: stash ? (i === 0 ? 'The commit the stash was made on' : i === 1 ? 'The staged changes' : 'The untracked files') : `Show ${p}`,
          onclick: (e) => { e.preventDefault(); this.reveal(p); },
        }, short(p))))] : ['Parents', h('span.gh-muted', 'none (first commit)')],
        commit.refs.length ? ['Refs', h('span.gh-refs', ...refBadges(commit.refs))] : null,
      ].filter(Boolean);
      const added = files.reduce((n, f) => n + f.added, 0);
      const deleted = files.reduce((n, f) => n + f.deleted, 0);
      const fileRows = files.map((f) => {
        const name = basename(f.path);
        const dir = f.path.includes('/') ? dirname(f.path) : '';
        const total = f.added + f.deleted;
        const bar = Math.min(total, 5);
        const plus = total ? Math.round((f.added / total) * bar) : 0;
        return h('div.gh-file', {
          dataset: { path: f.path },
          title: `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}${f.untracked ? ' (untracked)' : ''}`,
          onclick: () => openFileDiff(this.root, commit, f),
          oncontextmenu: async (e) => {
            e.preventDefault();
            const choice = await mide.ui.contextMenu([
              { id: 'diff', label: 'Open Changes' },
              { id: 'version', label: 'Open This Version', enabled: !!f.right },
              { id: 'history', label: 'File History', enabled: !stash },
            ]);
            if (choice === 'diff') openFileDiff(this.root, commit, f);
            else if (choice === 'version') openVersion(this.root, f.right.ref, f.right.path, commit);
            else if (choice === 'history') showFileHistory(this.root, f.path);
          },
        },
        h(`span.gh-status.c-${f.status}`, f.untracked ? 'U' : f.status),
        fileIcon(name), h('span.gh-file-name', name),
        f.oldPath ? h('span.gh-file-dir', `← ${f.oldPath}`) : dir ? h('span.gh-file-dir', dir) : null,
        h('span.gh-counts', f.binary ? h('span.gh-muted', 'binary') : [h('span.gh-add', `+${f.added}`), ' ', h('span.gh-del', `−${f.deleted}`)],
          h('span.gh-bar', ...Array.from({ length: 5 }, (_, i) => h(`span.${i < plus ? 'add' : i < bar ? 'del' : 'none'}`)))));
      });
      this.main.replaceChildren(h('div.gh-details',
        h('div.gh-message', h('div.gh-message-subject', commit.subject || '(no message)'), body ? h('pre.gh-message-body', body) : null),
        h('div.gh-meta', ...meta.flatMap(([k, v]) => [h('span.gh-meta-key', k), h('span.gh-meta-value', v)])),
        h('div.gh-actions', ...actions),
        h('div.gh-files-head', `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`, files.length ? h('span.gh-totals', h('span.gh-add', ` +${added}`), ' ', h('span.gh-del', `−${deleted}`)) : null,
          commit.parents.length > 1 && !stash ? h('span.gh-muted', ` · compared with the first parent ${short(commit.parents[0])}`) : null),
        h('div.gh-files', ...fileRows)));
    }

    // --- file mode: the file's diff in the selected commit ---
    async showFileCommit(c) {
      const seq = ++this.detailSeq;
      const f = c.file;
      const parent = c.parents[0] || null;
      const file = {
        ...f,
        left: f.status === 'A' || !parent ? null : { ref: parent, path: f.oldPath || f.path },
        right: f.status === 'D' ? null : { ref: c.hash, path: f.path },
      };
      this.current = { ...c, fileEntry: file };
      const host = h('div.gh-diff-host');
      const head = h('div.gh-file-commit',
        h('div.gh-file-commit-top',
          h('span.gh-hash', short(c.hash)), h('span.gh-file-commit-subject', c.subject),
          h('div.gh-diff-actions',
            h('button.btn.small', { onclick: () => { this.layout = this.layout === 'inline' ? 'side-by-side' : 'inline'; this.showFileCommit(c); } }, 'Toggle Layout'),
            h('button.btn.small', { onclick: () => showCommitInHistory(this.root, c.hash) }, 'Show Commit'),
            file.right ? h('button.btn.small.primary', { dataset: { action: 'open-version' }, onclick: () => openVersion(this.root, c.hash, file.right.path, c) }, 'Open This Version') : null)),
        h('div.gh-file-commit-meta', `${c.author} · ${when(c.time)} (${relativeTime(c.time)})`,
          f.oldPath ? ` · renamed from ${f.oldPath}` : f.status === 'A' ? ' · added' : f.status === 'D' ? ' · deleted' : '',
          h('span.gh-diff-sides', h('span.gh-diff-side', sideLabel(file.left, 'New file')), h('span.gh-diff-arrow', ' → '), h('span.gh-diff-side', sideLabel(file.right, 'Deleted')))));
      this.diff?.destroy();
      this.diff = null;
      this.main.replaceChildren(h('div.gh-file-diff', head, host));
      const view = await fileDiff(this.root, file, host, this.layout, () => seq === this.detailSeq && !this.gone);
      if (seq !== this.detailSeq || this.gone) { view?.destroy(); return; }
      this.diff = view;
    }
  }

  async function openView(root, file = null) {
    const key = file ? `${root}\0${file}` : root;
    let view = views.get(key);
    if (!view) { view = new HistoryView(root, file); views.set(key, view); }
    await ws.openItem(view);
    return view;
  }

  async function showHistory(path = ws.getActiveEditor()?.getPath() || null) {
    const repo = await repoFor(path);
    if (!repo.root) return explain(repo);
    return openView(repo.root);
  }

  async function showFileHistory(rootOrNull, path) {
    if (!path) return mide.notify.info('Open a file first.');
    let root = rootOrNull;
    let abs = path;
    if (root) abs = path.startsWith('/') ? path : `${root}/${path}`;
    else {
      const repo = await repoFor(path);
      if (!repo.root) return explain(repo);
      root = repo.root;
    }
    if (abs === root || !abs.startsWith(root + '/')) return mide.notify.info('That file is not in the repository.');
    return openView(root, abs.slice(root.length + 1));
  }

  async function showCommitInHistory(root, ref) {
    const view = await openView(root);
    await view.reveal(ref);
    return view;
  }

  /** From anywhere (git blame's "Show Commit"): arg is a hash, or { hash, path }. */
  async function showCommitCommand(arg) {
    const hash = typeof arg === 'string' ? arg : arg?.hash;
    const path = (typeof arg === 'object' && arg?.path) || ws.getActiveEditor()?.getPath() || null;
    if (!hash) {
      const ref = await mide.ui.prompt({ title: 'Show which commit? (a hash, branch or tag)', placeholder: 'HEAD~2, v1.0, 1a2b3c4…' });
      if (!ref?.trim()) return;
      return showCommitCommand({ hash: ref.trim(), path });
    }
    const repo = await repoFor(path);
    if (!repo.root) return explain(repo);
    return showCommitInHistory(repo.root, hash);
  }

  // Lists follow commits made elsewhere (source control, a terminal): when HEAD or a ref moves.
  let watchTimer = null;
  async function checkViews() {
    const roots = [...new Set([...views.values()].map((v) => v.root))];
    for (const root of roots) {
      const r = await git(root, ['for-each-ref', '--format=%(objectname) %(refname)']);
      const head = await git(root, ['rev-parse', '--quiet', '--verify', 'HEAD']);
      if (r.code !== 0 || disposed) continue;
      const sig = `${head.stdout.trim()}\n${r.stdout}`;
      for (const view of views.values()) {
        if (view.root !== root) continue;
        if (view.sig != null && view.sig !== sig) view.reload();
        view.sig = sig;
      }
    }
  }
  mide.services.consume('git-status', (svc) => {
    const sub = svc.onDidChange(() => { clearTimeout(watchTimer); watchTimer = setTimeout(checkViews, 300); });
    mide.subscriptions.add(sub);
  });
  mide.workspace.onDidChangeTrust(() => { for (const v of views.values()) if (!ws.isTrusted(v.root)) ws.closeItem(v); });

  // --- commands -------------------------------------------------------------------------
  const activePath = () => ws.getActiveEditor()?.getPath() || null;
  const hasFolder = () => !!ws.project || !!activePath();
  const inRepo = async () => { const repo = await repoFor(activePath()); if (!repo.root) explain(repo); return repo.root; };
  // Offered (in menus too) for files in a repository, as far as the git package knows.
  const fileInRepo = () => {
    const path = activePath();
    const svc = mide.services.get('git-status');
    return !!path && (!svc?.rootFor || !!svc.rootFor(path));
  };
  mide.commands.add({
    'git-history:show': { title: 'Show History', category: 'Git', when: hasFolder, run: () => showHistory() },
    'git-history:file-history': { title: 'File History', category: 'Git', when: fileInRepo, run: () => showFileHistory(null, activePath()) },
    'git-history:file-history-for': { title: 'File History for a Path', category: 'Git', hidden: true, run: (path) => showFileHistory(null, path) },
    'git-history:show-commit': { title: 'Show Commit…', category: 'Git', when: hasFolder, run: (arg) => showCommitCommand(arg) },
    'git-history:stash': { title: 'Stash Changes…', category: 'Git', when: hasFolder, run: async () => { const root = await inRepo(); return root && stashChanges(root); } },
    'git-history:stash-apply': { title: 'Apply Stash…', category: 'Git', when: hasFolder, run: () => pickStash('Apply which stash?', (root, s) => applyStash(root, s)) },
    'git-history:stash-pop': { title: 'Pop Stash…', category: 'Git', when: hasFolder, run: () => pickStash('Pop which stash?', (root, s) => applyStash(root, s, { pop: true })) },
    'git-history:stash-drop': { title: 'Drop Stash…', category: 'Git', when: hasFolder, run: () => pickStash('Drop which stash?', (root, s) => dropStash(root, s)) },
  });

  mide.subscriptions.add({
    dispose: () => {
      disposed = true;
      clearTimeout(watchTimer);
      for (const item of ws.getItems().filter((i) => ['git-history', 'git-commit-diff', 'git-version'].includes(i.type))) ws.closeItem(item);
    },
  });
}
