// Source Control: a git panel (stage / unstage / discard / commit / push / pull) and a diff view.

const LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Untracked', T: 'Type changed' };

export function activate(mide) {
  const { h, icon, fileIcon } = mide.ui;
  const state = { root: null, branch: '', upstream: null, ahead: 0, behind: 0, staged: [], changes: [], conflicts: [], hasHead: true, busy: false };
  const diffs = new Set();

  // Never let git wait for a password prompt that nobody can see.
  // Background calls never run a repo's fsmonitor command; nothing runs at all until the folder is trusted.
  const git = (args, opts = {}) => mide.process.exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: state.root || mide.workspace.project, timeout: 60000, env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }, ...opts });

  // --- status --------------------------------------------------------------
  // The repo root derived from the project path itself (not `--show-toplevel`, which resolves
  // symlinks and then no longer matches the paths the editor uses).
  async function findRoot(project) {
    const r = await mide.process.exec('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-cdup'], { cwd: project });
    if (r.code !== 0) return null;
    const parts = project.split('/');
    for (const seg of r.stdout.trim().split('/').filter(Boolean)) if (seg === '..') parts.pop();
    return parts.join('/') || '/';
  }

  // With several project folders the panel shows one folder's repository: the active file's,
  // or the one picked in the header.
  let chosen = null;
  const currentFolder = () => (mide.workspace.folders.includes(chosen) ? chosen : mide.workspace.project);

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq; // a newer refresh supersedes this one
    const project = currentFolder();
    if (!project || !mide.workspace.isTrusted(project)) { state.root = null; return render(); }
    const root = await findRoot(project);
    if (seq !== refreshSeq) return;
    if (!root) { state.root = null; return render(); }
    // --no-optional-locks: a background status must not hold .git/index.lock during stage/commit.
    const res = await git(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root });
    if (seq !== refreshSeq) return;
    state.root = root;
    const staged = [];
    const changes = [];
    const conflicts = [];
    state.branch = '';
    state.upstream = null;
    state.ahead = state.behind = 0;
    state.hasHead = true;
    const parts = res.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.head ')) state.branch = line.slice(14);
      else if (line.startsWith('# branch.oid ')) state.hasHead = line.slice(13) !== '(initial)';
      else if (line.startsWith('# branch.upstream ')) state.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) { state.ahead = +m[1]; state.behind = +m[2]; }
      } else if (line[0] === '1' || line[0] === '2') {
        const fields = line.split(' ');
        const xy = fields[1];
        const path = fields.slice(line[0] === '1' ? 8 : 9).join(' ');
        const orig = line[0] === '2' ? parts[++i] : null;
        if (xy[0] !== '.') staged.push({ path, code: xy[0], orig });
        if (xy[1] !== '.') changes.push({ path, code: xy[1] });
      } else if (line[0] === 'u') {
        conflicts.push({ path: line.split(' ').slice(10).join(' '), code: 'U' });
      } else if (line[0] === '?') {
        changes.push({ path: line.slice(2), code: '?' });
      }
    }
    Object.assign(state, { staged, changes, conflicts });
    for (const p of offered) if (!conflicts.some((e) => e.path === p)) offered.delete(p);
    render();
    for (const d of diffs) d.reload();
  }

  let refreshTimer = null;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 300); };
  const afterChange = async () => {
    await refresh();
    mide.services.get('git-status')?.refresh?.(); // keep tree + branch item in sync
  };

  // Git operations run one at a time (two at once fight over .git/index.lock).
  let queue = Promise.resolve();
  let pending = 0;
  function run(args, opts) {
    pending++;
    state.busy = true;
    render();
    const job = queue.then(() => runNow(args, opts));
    queue = job.catch(() => {});
    return job;
  }
  async function runNow(args, { quiet = false, label, cwd } = {}) {
    const r = await git(args, cwd ? { cwd } : {});
    pending--;
    state.busy = pending > 0;
    if (r.code !== 0 && !quiet) {
      const msg = (r.stderr || r.stdout).trim();
      const auth = /terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(msg);
      mide.notify.error(`git ${label || args[0]} failed`, auth ? `${msg}\n\nGit needs credentials. Set up an SSH key or a credential helper (e.g. "gh auth setup-git"), then try again.` : msg);
    }
    await afterChange();
    return r;
  }

  // --- actions -------------------------------------------------------------
  const abs = (p, root = state.root) => `${root}/${p}`;
  const stage = (paths, cwd) => run(['add', '-A', '--', ...paths], { label: 'add', cwd });
  const stageAll = () => run(['add', '-A'], { label: 'add' }); // no path list: fine for thousands of files
  // Unstaging a rename must also unstage the deletion of its old path.
  const unstage = (entries, cwd) => {
    const paths = [...new Set(entries.flatMap((e) => (e.orig ? [e.path, e.orig] : [e.path])))];
    return state.hasHead ? run(['restore', '--staged', '--', ...paths], { label: 'unstage', cwd }) : run(['rm', '--cached', '-r', '-q', '--', ...paths], { label: 'unstage', cwd });
  };
  const unstageAll = () => (state.hasHead ? run(['restore', '--staged', '--', '.'], { label: 'unstage' }) : run(['rm', '--cached', '-r', '-q', '--', '.'], { label: 'unstage' }));

  async function discard(entries) {
    const names = entries.map((e) => e.path);
    const choice = await mide.ui.confirm({
      type: 'warning',
      message: entries.length === 1 ? `Discard changes to ${names[0]}?` : `Discard changes to ${entries.length} files?`,
      detail: 'Edits to tracked files are reverted to the last commit. New (untracked) files are moved to the Trash.',
      buttons: ['Discard Changes', 'Cancel'],
    });
    if (choice !== 0) return;
    const untracked = entries.filter((e) => e.code === '?');
    const tracked = entries.filter((e) => e.code !== '?');
    for (const e of untracked) await mide.fs.trash(abs(e.path));
    // Discarding every change uses "." rather than a (possibly huge) list of paths.
    const all = tracked.length && tracked.length === state.changes.filter((e) => e.code !== '?').length;
    if (tracked.length) await run(['restore', '--', ...(all ? ['.'] : tracked.map((e) => e.path))], { label: 'restore' });
    else await afterChange();
  }

  async function commit() {
    const message = msgInput.value.trim();
    if (!message) { msgInput.focus(); return mide.notify.info('Write a commit message first.'); }
    const amend = amendBox.checked;
    if (!state.staged.length && !amend) {
      if (!state.changes.length) return mide.notify.info('Nothing to commit.');
      if (mide.config.get('source-control.confirmStageAllOnCommit')) {
        const c = await mide.ui.confirm({ message: 'There are no staged changes.', detail: `Stage all ${state.changes.length} changes and commit them?`, buttons: ['Stage All & Commit', 'Cancel'] });
        if (c !== 0) return;
      }
      const s = await run(['add', '-A'], { label: 'add' });
      if (s.code !== 0) return;
    }
    const r = await run(['commit', '-m', message, ...(amend ? ['--amend'] : [])], { label: 'commit' });
    if (r.code === 0) {
      msgInput.value = '';
      amendBox.checked = false;
      try { localStorage.removeItem(draftKey()); } catch {}
      mide.notify.success(amend ? 'Commit amended' : 'Committed', r.stdout.split('\n')[0]);
    }
  }

  async function push() {
    const r = state.upstream ? await run(['push'], { label: 'push' }) : await run(['push', '-u', 'origin', 'HEAD'], { label: 'push' });
    if (r.code === 0) mide.notify.success(`Pushed ${state.branch}`);
  }
  async function pull() {
    const r = await run(['pull', '--ff-only'], { label: 'pull' });
    if (r.code === 0) mide.notify.success('Up to date', r.stdout.trim().split('\n').pop());
  }

  // --- panel ---------------------------------------------------------------
  const draftKey = () => `source-control:draft:${state.root}`;
  const msgInput = h('textarea.input.sc-message', {
    rows: 3, placeholder: 'Commit message (⌘↩ to commit)', spellcheck: true,
    oninput: () => { try { localStorage.setItem(draftKey(), msgInput.value); } catch {} },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); } },
  });
  const amendBox = h('input', { type: 'checkbox' });
  const folderSelect = h('select.input.sc-folder', { title: 'Project folder', hidden: true, onchange: () => showFolder(folderSelect.value) });
  function showFolder(folder) {
    if (folder === currentFolder()) return;
    chosen = folder;
    msgInput.value = ''; // render() brings back the other repository's draft
    refresh();
  }
  const branchEl = h('div.sc-branch');
  const commitBtn = h('button.btn.primary.sc-commit', { onclick: commit }, 'Commit');
  const lists = h('div.sc-lists');
  const el = h('div.sc-view',
    h('div.sc-header', h('span.sc-title', 'Source Control'),
      folderSelect,
      h('div.sc-header-actions', h('button.icon-btn', { title: 'Refresh', onclick: () => refresh() }, icon('refresh', 14)))),
    h('div.sc-body', branchEl,
      h('div.sc-compose', msgInput, h('div.sc-compose-row', commitBtn, h('label.sc-amend', amendBox, 'Amend'))),
      lists));

  function renderFolders() {
    const folders = mide.workspace.folders;
    folderSelect.hidden = folders.length < 2;
    folderSelect.replaceChildren(...folders.map((f) => h('option', { value: f, title: f }, mide.path.basename(f))));
    folderSelect.value = currentFolder() || '';
  }

  function render() {
    renderFolders();
    if (!mide.workspace.project) {
      lists.replaceChildren(h('div.sc-empty', 'Open a folder to use source control.'));
      branchEl.replaceChildren();
      return;
    }
    const folder = currentFolder();
    if (!mide.workspace.isTrusted(folder)) {
      branchEl.replaceChildren();
      lists.replaceChildren(h('div.sc-empty', h('p', 'Restricted Mode: git is off until you trust this folder, because a repository\'s settings can run commands.'),
        h('button.btn.primary', { onclick: () => mide.workspace.requestTrust(folder) }, 'Trust Folder…')));
      return;
    }
    if (!state.root) {
      branchEl.replaceChildren();
      lists.replaceChildren(h('div.sc-empty', h('p', 'This folder is not a git repository.'),
        h('button.btn.primary', { onclick: async () => { await mide.process.exec('git', ['init'], { cwd: folder }); afterChange(); } }, 'Initialize Repository')));
      return;
    }
    if (document.activeElement !== msgInput && !msgInput.value) { try { msgInput.value = localStorage.getItem(draftKey()) || ''; } catch {} }
    branchEl.replaceChildren(
      icon('branch', 14), h('span.sc-branch-name', state.branch || 'detached'),
      // (replaceChildren would print a null child as "null", so spread an empty list instead)
      ...(state.upstream ? [h('span.sc-sync', { title: `${state.ahead} to push, ${state.behind} to pull from ${state.upstream}` }, `↑${state.ahead} ↓${state.behind}`)] : []),
      h('div.sc-branch-actions',
        h('button.btn.small', { onclick: pull, disabled: state.busy || !state.upstream }, 'Pull'),
        h('button.btn.small', { onclick: push, disabled: state.busy, title: state.upstream ? `Push to ${state.upstream}` : 'Push this branch to origin and track it' }, state.upstream ? 'Push' : 'Publish')));
    commitBtn.disabled = state.busy;
    commitBtn.textContent = state.busy ? 'Working…' : state.staged.length ? `Commit ${state.staged.length} staged` : 'Commit';
    const groups = [];
    if (state.conflicts.length) groups.push(group('Merge Conflicts', state.conflicts, 'conflict'));
    if (state.staged.length) groups.push(group('Staged Changes', state.staged, 'staged'));
    groups.push(group('Changes', state.changes, 'changes'));
    if (!state.staged.length && !state.changes.length && !state.conflicts.length) groups.push(h('div.sc-empty', 'No changes. Working tree is clean.'));
    lists.replaceChildren(...groups);
  }

  function group(title, entries, kind) {
    if (!entries.length) return h('div');
    const actions = kind === 'staged'
      ? [h('button.icon-btn', { title: 'Unstage All', onclick: () => unstageAll() }, '−')]
      : kind === 'changes'
        ? [h('button.icon-btn', { title: 'Discard All', onclick: () => discard(entries) }, '↺'), h('button.icon-btn', { title: 'Stage All', onclick: () => stageAll() }, '+')]
        : [h('button.icon-btn', { title: 'Mark All Resolved', onclick: () => stage(entries.map((e) => e.path)) }, '+')];
    return h('div.sc-group',
      h('div.sc-group-header', h('span', title), h('span.sc-count', String(entries.length)), h('div.sc-group-actions', actions)),
      ...entries.map((e) => row(e, kind)));
  }

  function row(entry, kind) {
    const slash = entry.path.lastIndexOf('/');
    const name = entry.path.slice(slash + 1);
    const dir = slash > 0 ? entry.path.slice(0, slash) : '';
    const btn = (title, label, fn) => h('button.icon-btn', { title, disabled: state.busy, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const open = btn(kind === 'conflict' ? 'Open at First Conflict' : 'Open File', icon('file', 13), () => (kind === 'conflict' ? openConflict(entry) : openFile(entry)));
    const actions = kind === 'staged'
      ? [open, btn('Unstage', '−', () => unstage([entry]))]
      : kind === 'conflict'
        ? [open, btn('Mark Resolved (stage)', '+', () => stage([entry.path]))] // discard/restore don't apply to unmerged files
        : [open, btn('Discard Changes', '↺', () => discard([entry])), btn('Stage', '+', () => stage([entry.path]))];
    return h('div.sc-row', {
      title: `${entry.path} · ${LABELS[entry.code] || entry.code}${entry.orig ? ` (from ${entry.orig})` : ''}`,
      onclick: () => (kind === 'conflict' ? openConflict(entry) : openDiff(entry, kind)),
      oncontextmenu: async (ev) => {
        ev.preventDefault();
        const choice = await mide.ui.contextMenu([
          { id: 'diff', label: 'Open Changes' }, { id: 'open', label: 'Open File', enabled: entry.code !== 'D' },
          { type: 'separator' },
          kind === 'staged' ? { id: 'unstage', label: 'Unstage' } : { id: 'stage', label: kind === 'conflict' ? 'Mark Resolved' : 'Stage' },
          { id: 'discard', label: 'Discard Changes', enabled: kind === 'changes' },
          { type: 'separator' }, { id: 'reveal', label: 'Reveal in Finder' },
        ]);
        if (choice === 'diff') openDiff(entry, kind);
        else if (choice === 'open') (kind === 'conflict' ? openConflict(entry) : openFile(entry));
        else if (choice === 'stage') stage([entry.path]);
        else if (choice === 'unstage') unstage([entry]);
        else if (choice === 'discard') discard([entry]);
        else if (choice === 'reveal') mide.shell.reveal(abs(entry.path));
      },
    }, h(`span.sc-code.c-${entry.code === '?' ? 'U' : entry.code}`, entry.code === '?' ? 'U' : entry.code === 'U' ? '!' : entry.code),
    fileIcon(name), h('span.sc-name', name), dir ? h('span.sc-dir', dir) : null, h('div.sc-row-actions', actions));
  }

  function openFile(entry, root) { if (entry.code !== 'D') mide.workspace.open(abs(entry.path, root)); }
  // A conflicted file opens at its first conflict (the merge-conflicts package does the jump).
  async function openConflict(entry) {
    const item = await mide.workspace.open(abs(entry.path));
    mide.services.get('merge-conflicts')?.revealFirst(item);
  }

  // Once the last conflict marker is gone and the file is saved, offer to stage it.
  const offered = new Set();
  mide.workspace.onDidSave((editor) => {
    const path = editor.getPath?.();
    const rel = path && state.root && path.startsWith(`${state.root}/`) ? path.slice(state.root.length + 1) : null;
    if (!rel || !state.conflicts.some((e) => e.path === rel) || offered.has(rel)) return;
    const text = editor.getText();
    if (/^(<{7}|>{7})(?: |$)/m.test(text)) return;
    offered.add(rel);
    mide.notify.info(`No conflict markers left in ${mide.path.basename(rel)}`, 'Mark it as resolved to stage it.', { actions: [{ label: 'Mark as resolved', run: () => stage([rel]) }] });
  });

  // --- diff view -----------------------------------------------------------
  async function textAt(ref, path, root = state.root) {
    if (ref === 'worktree') { try { return await mide.fs.read(abs(path, root)); } catch { return ''; } }
    const r = await git(['show', `${ref}:${path}`], { cwd: root });
    return r.code === 0 ? r.stdout : '';
  }

  class DiffItem {
    constructor(entry, kind) {
      this.type = 'diff';
      this.entry = entry;
      this.kind = kind;
      this.iconName = 'split';
      this.root = state.root; // the panel may show another repository later
      this.id = `diff-${kind}-${this.root}/${entry.path}`;
      this.listeners = new Map();
      this.headerLeft = h('span.sc-diff-side');
      this.headerRight = h('span.sc-diff-side');
      this.host = h('div.sc-diff-host');
      this.element = h('div.sc-diff', { tabIndex: -1 },
        h('div.sc-diff-toolbar', h('span.sc-diff-path', entry.path), this.headerLeft, h('span.sc-diff-arrow', '→'), this.headerRight,
          h('div.sc-diff-actions',
            h('button.btn.small', { onclick: () => this.toggleLayout() }, 'Toggle Layout'),
            entry.code !== 'D' ? h('button.btn.small', { onclick: () => openFile(entry, this.root) }, 'Open File') : null,
            kind === 'staged' ? h('button.btn.small', { onclick: () => unstage([entry], this.root) }, 'Unstage')
              : h('button.btn.small.primary', { onclick: () => stage([entry.path], this.root) }, 'Stage'))),
        this.host);
      this.layout = mide.config.get('source-control.diffLayout');
      this.reload();
    }
    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    getTitle() { return `${mide.path.basename(this.entry.path)} (${this.kind === 'staged' ? 'staged' : 'changes'})`; }
    getElement() { return this.element; }
    focus() { this.element.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { this.view?.destroy(); diffs.delete(this); }
    toggleLayout() { this.layout = this.layout === 'inline' ? 'side-by-side' : 'inline'; this.reload(); }

    async reload() {
      const { entry, kind } = this;
      const [leftRef, rightRef, leftLabel, rightLabel] = kind === 'staged'
        ? [state.hasHead ? 'HEAD' : null, '', 'Last commit', 'Staged']
        : [entry.code === '?' ? null : '', 'worktree', entry.code === '?' ? 'New file' : 'Staged / last commit', 'Working tree'];
      const [a, b] = await Promise.all([leftRef == null ? '' : textAt(leftRef, entry.orig || entry.path, this.root), textAt(rightRef, entry.path, this.root)]);
      if (a === this.a && b === this.b && this.view && this.shownLayout === this.layout) return;
      Object.assign(this, { a, b });
      this.headerLeft.textContent = leftLabel;
      this.headerRight.textContent = rightLabel;
      const { MergeView, unifiedMergeView } = await mide.cm.extras.merge();
      const { EditorView, lineNumbers } = mide.cm.view;
      const { EditorState } = mide.cm.state;
      const { syntaxHighlighting } = mide.cm.language;
      const { classHighlighter } = mide.cm.highlight;
      if (a === b) {
        // Nothing left to compare (e.g. the change was just committed or discarded).
        this.view?.destroy();
        this.view = null;
        this.shownLayout = null;
        this.host.replaceChildren(h('div.sc-diff-empty', h('div.sc-diff-empty-title', 'No changes'),
          h('div', kind === 'staged' ? 'The staged version matches the last commit.' : 'The file matches its staged / committed version.')));
        return;
      }
      const lang = await mide.editor.languageFor(entry.path);
      const extensions = [lineNumbers(), syntaxHighlighting(classHighlighter), EditorView.editable.of(false), EditorState.readOnly.of(true), lang || []];
      const scroll = this.view?.dom.querySelector('.cm-scroller, .cm-mergeView')?.scrollTop || this.view?.scrollDOM?.scrollTop || 0;
      this.view?.destroy();
      this.host.replaceChildren();
      this.shownLayout = this.layout;
      if (this.layout === 'inline') {
        this.view = new EditorView({ parent: this.host, doc: b, extensions: [...extensions, unifiedMergeView({ original: a, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } })] });
      } else {
        this.view = new MergeView({ parent: this.host, a: { doc: a, extensions }, b: { doc: b, extensions }, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true, highlightChanges: true });
      }
      requestAnimationFrame(() => { const s = this.host.querySelector('.cm-mergeView') || this.host.querySelector('.cm-scroller'); if (s) s.scrollTop = scroll; });
    }
  }

  function openDiff(entry, kind) {
    const existing = mide.workspace.getItems().find((i) => i.type === 'diff' && i.id === `diff-${kind}-${state.root}/${entry.path}`);
    if (existing) return mide.workspace.openItem(existing);
    const item = new DiffItem(entry, kind);
    diffs.add(item);
    mide.workspace.openItem(item);
  }

  // --- wiring --------------------------------------------------------------
  mide.sidebar.addView({ id: 'source-control', title: 'Source Control', icon: 'branch', order: 15, command: 'source-control:show', element: el, onShow: refresh, focus: () => msgInput.focus() });
  mide.commands.add({
    'source-control:show': { title: 'Show Source Control', run: () => { mide.sidebar.show('source-control', { focus: true }); refresh(); } },
    'source-control:commit': { title: 'Commit', when: () => !!state.root, run: () => { mide.sidebar.show('source-control'); commit(); } },
    'source-control:push': { title: 'Push', when: () => !!state.root, run: push },
    'source-control:pull': { title: 'Pull', when: () => !!state.root, run: pull },
    'source-control:stage-all': { title: 'Stage All Changes', when: () => !!state.root, run: () => stageAll() },
    'source-control:diff-active-file': {
      title: 'Open Changes for Current File',
      when: () => !!state.root && !!mide.workspace.getActiveItem()?.getPath?.(),
      run: async () => {
        await refresh();
        const rel = mide.workspace.getActiveItem().getPath().slice(state.root.length + 1);
        const entry = state.changes.find((e) => e.path === rel);
        const stagedEntry = state.staged.find((e) => e.path === rel);
        if (entry) openDiff(entry, 'changes');
        else if (stagedEntry) openDiff(stagedEntry, 'staged');
        else mide.notify.info('No changes in this file.');
      },
    },
  });
  mide.workspace.onDidChangeFolders(() => { refresh(); });
  mide.workspace.onDidChangeActiveItem((item) => {
    const folder = mide.workspace.folders.length > 1 && mide.workspace.folderFor(item?.getPath?.());
    if (folder) showFolder(folder);
  });
  mide.workspace.onDidChangeTrust(() => { refresh(); });
  mide.workspace.onDidSave(scheduleRefresh);
  mide.workspace.onDidChangeFiles(scheduleRefresh);
  const onFocus = () => scheduleRefresh();
  window.addEventListener('focus', onFocus);
  mide.subscriptions.add({ dispose: () => { window.removeEventListener('focus', onFocus); for (const d of [...diffs]) mide.workspace.closeItem(d); } });
  refresh();
}
