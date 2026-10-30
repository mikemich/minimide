// Local History: a version of every file each time it is saved, kept outside git (see store.js),
// with a view to compare versions against the open buffer, restore them and recover deleted files.
import { createStore } from './store.js';

const CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
const PRUNE_EVERY = 6 * 60 * 60 * 1000; // the startup prune runs at most this often

export function activate(mide) {
  const { h } = mide.ui;
  const ws = mide.workspace;
  const store = createStore(mide);
  mide.ui.registerIcon('history', CLOCK);
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const lf = (text) => text.replace(/\r\n?/g, '\n');
  let disposed = false;

  // --- formatting ----------------------------------------------------------------
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  function ago(time, now = Date.now()) {
    const s = Math.max(0, Math.round((now - time) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return plural(Math.max(1, m), 'minute');
    const hr = Math.round(m / 60);
    if (hr < 24) return plural(hr, 'hour');
    const d = Math.round(hr / 24);
    if (d === 1) return 'yesterday';
    return plural(d, 'day');
  }
  const when = (time) => new Date(time).toLocaleString();
  function sizeText(n) {
    if (n < 1024) return `${n} B`;
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  }

  // --- where the text lives now ----------------------------------------------------
  const documentFor = (path) => ws.getDocuments().find((d) => d.path === path) || null;
  /** The buffer if the file is open, else the file on disk, else null (deleted). Always with \n line ends. */
  async function currentText(path) {
    const doc = documentFor(path);
    if (doc) return doc.getText();
    try { return lf(await mide.fs.read(path)); } catch { return null; }
  }
  /** The same text as it would be saved (the file's own line ends): what a version's hash is of. */
  async function currentRaw(path) {
    const doc = documentFor(path);
    if (doc) return doc.getTextForSave();
    try { return await mide.fs.read(path); } catch { return null; }
  }
  const activePath = () => ws.getActiveEditor()?.getPath() || null;

  // --- saving versions ----------------------------------------------------------
  mide.workspace.onDidSave((item, info) => {
    const doc = item.document;
    if (doc?.path) store.snapshot(doc.path, doc.getTextForSave(), null, { auto: !!info?.auto }).catch((err) => console.warn('[local-history]', err));
  });
  // The buffer is about to be replaced by the file on disk: keep what is in it (the text is read now, synchronously).
  mide.workspace.onWillReload((doc, reason) => {
    if (!doc.path) return;
    store.snapshot(doc.path, doc.getTextForSave(), reason === 'revert' ? 'Before revert' : 'Before reload from disk').catch(() => {});
  });
  mide.workspace.onDidRenamePath((from, to) => {
    // Open history views follow the file (the workspace may already have moved their `path`).
    for (const [key, view] of [...views]) {
      if (key === from || key.startsWith(from + '/')) view.setPath(to + key.slice(from.length));
    }
    store.move(from, to).catch((err) => console.warn('[local-history]', err));
  });

  // --- retention ------------------------------------------------------------------
  async function startupPrune() {
    try {
      const last = Number(await mide.fs.read(store.PRUNE_MARKER).catch(() => 0)) || 0;
      if (Date.now() - last < PRUNE_EVERY) return;
      await store.pruneAll({ isCancelled: () => disposed });
      if (!disposed) await mide.fs.write(store.PRUNE_MARKER, String(Date.now()));
    } catch (err) { console.warn('[local-history]', err); }
  }
  const pruneTimer = setTimeout(startupPrune, 10000);
  mide.subscriptions.add({ dispose: () => { disposed = true; clearTimeout(pruneTimer); } });

  // --- restoring --------------------------------------------------------------------
  /** Replaces the buffer with an old version as one edit, so undo brings the newer text back. */
  async function restore(path, version) {
    let text;
    try { text = lf(await store.read(path, version)); } catch (err) { return mide.notify.error('Could not read that version', err.message); }
    if (!documentFor(path) && !await mide.fs.stat(path)) return recoverFile(path, version);
    const editor = await ws.open(path);
    const view = editor?.view;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === text) return mide.notify.info('The file already matches that version.');
    // Whatever is in the buffer now stays reachable from the history.
    await store.snapshot(path, editor.document.getTextForSave(), 'Before restore');
    let start = 0;
    while (start < current.length && start < text.length && current[start] === text[start]) start++;
    let endA = current.length;
    let endB = text.length;
    while (endA > start && endB > start && current[endA - 1] === text[endB - 1]) { endA--; endB--; }
    view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) }, selection: { anchor: start + (endB - start) }, scrollIntoView: true, userEvent: 'input.restore' });
    mide.notify.info(`Restored the version from ${ago(version.time)}`, 'Undo brings the newer text back. Save to keep it.');
    for (const view of views.values()) view.refreshDiff();
  }

  /** Writes a version of a file that no longer exists back to its path, after asking. */
  async function recoverFile(path, version) {
    const exists = !!await mide.fs.stat(path);
    const choice = await mide.ui.confirm({
      type: 'question',
      message: `${exists ? 'Overwrite' : 'Recover'} ${basename(path)}?`,
      detail: `The version from ${ago(version.time)} will be written to ${path}.`,
      buttons: [exists ? 'Overwrite' : 'Recover', 'Cancel'],
    });
    if (choice !== 0) return false;
    try {
      await mide.fs.write(path, await store.read(path, version));
    } catch (err) { mide.notify.error(`Could not write ${basename(path)}`, err.message); return false; }
    await ws.open(path);
    mide.notify.success(`Recovered ${basename(path)}`);
    return true;
  }

  // --- the history view --------------------------------------------------------------
  const views = new Map(); // path -> HistoryView
  const snapshots = new Set(); // open SnapshotItems
  // Turning the package off closes its tabs (their timers and listeners go with them).
  mide.subscriptions.add({ dispose: () => { for (const item of [...views.values(), ...snapshots]) ws.closeItem(item); } });

  class HistoryView {
    constructor(path) {
      this.type = 'local-history';
      this.iconName = 'history';
      this.path = this.key = path; // `key`: where it is in `views` (the workspace moves `path` on a rename)
      this.id = `local-history-${path}`;
      this.listeners = new Map();
      this.versions = [];
      this.selected = null;
      this.list = h('div.lh-list', { tabIndex: 0, onkeydown: (e) => this.onKey(e) });
      this.foot = h('div.lh-foot');
      this.leftLabel = h('span.lh-side-label');
      this.rightLabel = h('span.lh-side-label');
      this.restoreBtn = h('button.btn.small.primary', { onclick: () => this.selected && restore(this.path, this.selected) }, 'Restore');
      this.openBtn = h('button.btn.small', { onclick: () => this.selected && openSnapshot(this.path, this.selected) }, 'Open');
      this.host = h('div.lh-host');
      this.fileLabel = h('div.lh-file', basename(path));
      this.dirLabel = h('div.lh-path', { title: path }, dirname(path));
      this.element = h('div.lh-view', { tabIndex: -1 },
        h('div.lh-side',
          h('div.lh-side-head', this.fileLabel, this.dirLabel),
          this.list, this.foot),
        h('div.lh-main',
          h('div.lh-toolbar', this.leftLabel, h('span.lh-arrow', '→'), this.rightLabel, h('div.lh-actions', this.openBtn, this.restoreBtn)),
          this.host));
      this.sub = store.onDidChange((changed) => { if (changed === this.path) this.load(); });
      this.tick = setInterval(() => this.renderList(), 30000);
      this.editorSub = ws.onDidUpdateEditor((editor, update) => {
        if (update?.docChanged && editor.getPath?.() === this.path) { clearTimeout(this.liveTimer); this.liveTimer = setTimeout(() => this.refreshDiff(), 400); }
      });
    }

    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    /** The file was renamed: show (and look up) the history under its new path. */
    setPath(next) {
      if (views.get(this.key) === this) views.delete(this.key);
      this.key = this.path = next;
      this.id = `local-history-${next}`;
      views.set(next, this);
      this.fileLabel.textContent = basename(next);
      this.dirLabel.textContent = dirname(next);
      this.dirLabel.title = next;
      this.listeners.get('title-changed')?.();
    }
    getTitle() { return `${basename(this.path)} (history)`; }
    getElement() { return this.element; }
    getPath() { return null; }
    isDirty() { return false; }
    focus() { this.refreshDiff(); this.list.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() {
      clearInterval(this.tick);
      clearTimeout(this.liveTimer);
      this.sub.dispose();
      this.editorSub?.dispose();
      this.diff?.destroy();
      if (views.get(this.key) === this) views.delete(this.key);
    }

    /** (Re)reads the versions. `pick` chooses the version to show: 'previous' is the newest one that differs from the buffer. */
    async load(pick = null) {
      this.versions = await store.versions(this.path);
      const keep = this.selected && this.versions.find((v) => v.id === this.selected.id);
      if (keep && !pick) this.selected = keep;
      else {
        const now = await currentRaw(this.path);
        const nowHash = now == null ? null : await store.hash(now);
        this.selected = this.versions.find((v) => v.hash !== nowHash) || this.versions[0] || null;
      }
      this.renderList();
      await this.refreshDiff();
    }

    renderList() {
      const rows = this.versions.map((v) => h('div.lh-row' + (v === this.selected || v.id === this.selected?.id ? '.selected' : ''), {
        dataset: { id: v.id }, title: when(v.time), onclick: () => this.select(v),
      }, h('div.lh-row-top', h('span.lh-ago', ago(v.time)), v.label ? h('span.lh-label', v.label) : null),
      h('div.lh-meta', `${when(v.time)} · ${sizeText(v.size)}`)));
      this.list.replaceChildren(...rows);
      this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      const max = Number(mide.config.get('local-history.maxVersions')) || 0;
      const days = Number(mide.config.get('local-history.maxAgeDays')) || 0;
      this.foot.textContent = `${this.versions.length} ${this.versions.length === 1 ? 'version' : 'versions'}`
        + (max || days ? ` · keeps ${[max ? `${max} per file` : '', days ? `${days} days` : ''].filter(Boolean).join(', ')}` : '');
      this.restoreBtn.disabled = this.openBtn.disabled = !this.selected;
    }

    select(version) { this.selected = version; this.renderList(); this.refreshDiff(); }

    onKey(e) {
      const at = this.versions.findIndex((v) => v.id === this.selected?.id);
      const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : null;
      if (next == null || !this.versions[next]) return;
      e.preventDefault();
      this.select(this.versions[next]);
    }

    async refreshDiff() {
      const seq = (this.seq = (this.seq || 0) + 1);
      const version = this.selected;
      this.restoreBtn.textContent = 'Restore';
      if (!version) {
        this.diff?.destroy();
        this.diff = null;
        this.leftLabel.textContent = '';
        this.rightLabel.textContent = '';
        this.host.replaceChildren(h('div.lh-empty', h('div.lh-empty-title', 'No saved versions yet'),
          h('div', 'A version of the file is kept each time you save it.')));
        return;
      }
      let before;
      try { before = lf(await store.read(this.path, version)); } catch (err) { before = ''; }
      const now = await currentText(this.path);
      if (seq !== this.seq || disposed) return;
      if (now == null) this.restoreBtn.textContent = 'Recover';
      this.leftLabel.textContent = `${ago(version.time)}${version.label ? ` (${version.label})` : ''}`;
      this.rightLabel.textContent = now == null ? 'File not found' : documentFor(this.path)?.dirty ? 'Current (unsaved)' : 'Current';
      this.diff?.destroy();
      this.diff = null;
      this.host.replaceChildren();
      if (now === before) {
        this.host.append(h('div.lh-empty', h('div.lh-empty-title', 'Same as the current text'), h('div', 'Pick an older version to see what changed.')));
        return;
      }
      const { MergeView } = await mide.cm.extras.merge();
      const { EditorView, lineNumbers } = mide.cm.view;
      const { EditorState } = mide.cm.state;
      const { syntaxHighlighting } = mide.cm.language;
      const lang = await mide.editor.languageFor(this.path);
      if (seq !== this.seq || disposed) return;
      const extensions = [lineNumbers(), mide.editor.highlighters.map((x) => syntaxHighlighting(x)), EditorView.editable.of(false), EditorState.readOnly.of(true), lang || []];
      this.diff = new MergeView({
        parent: this.host,
        a: { doc: before, extensions },
        b: { doc: now ?? '', extensions },
        collapseUnchanged: { margin: 3, minSize: 6 },
        gutter: true,
        highlightChanges: true,
      });
    }
  }

  async function showHistory(path, pick = null) {
    if (!path) return mide.notify.info('Open a saved file first.');
    let view = views.get(path);
    if (!view) { view = new HistoryView(path); views.set(path, view); }
    await ws.openItem(view);
    await view.load(pick);
    return view;
  }

  // --- a version opened in a tab, read-only -------------------------------------------
  class SnapshotItem {
    constructor(path, version, text) {
      this.type = 'local-history-snapshot';
      this.iconName = 'history';
      this.path = path;
      this.version = version;
      this.body = h('div.lh-snapshot-body');
      snapshots.add(this);
      this.element = h('div.lh-snapshot', { tabIndex: -1 },
        h('div.lh-snapshot-note', `Read-only version of ${path} from ${when(version.time)} (${ago(version.time)})${version.label ? ` · ${version.label}` : ''}`),
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
        extensions: [lineNumbers(), mide.editor.highlighters.map((x) => syntaxHighlighting(x)), EditorState.readOnly.of(true), lang || []],
      });
    }

    on() { return { dispose() {} }; }
    getTitle() { return `${basename(this.path)} (${ago(this.version.time)})`; }
    getElement() { return this.element; }
    getPath() { return null; }
    isDirty() { return false; }
    focus() { this.view?.focus(); }
    serialize() { return null; }
    destroy() { this.gone = true; this.view?.destroy(); snapshots.delete(this); }
  }

  async function openSnapshot(path, version) {
    let text;
    try { text = lf(await store.read(path, version)); } catch (err) { return mide.notify.error('Could not read that version', err.message); }
    await ws.openItem(new SnapshotItem(path, version, text));
  }

  // --- pickers ---------------------------------------------------------------------------
  const versionItem = (v) => ({ label: ago(v.time), detail: `${when(v.time)} · ${sizeText(v.size)}${v.label ? ` · ${v.label}` : ''}`, v });

  async function restorePrevious(path = activePath()) {
    if (!path) return mide.notify.info('Open a saved file first.');
    const versions = await store.versions(path);
    if (!versions.length) return mide.notify.info('No earlier versions of this file yet.', 'A version is kept each time you save it.');
    mide.ui.selectList({
      placeholder: `Restore ${basename(path)} to…`,
      items: versions.map(versionItem),
      onSelect: (item) => restore(path, item.v),
    });
  }

  async function compareWithPrevious(path = activePath()) {
    if (!path) return mide.notify.info('Open a saved file first.');
    if (!(await store.versions(path)).length) return mide.notify.info('No earlier versions of this file yet.', 'A version is kept each time you save it.');
    return showHistory(path, 'previous');
  }

  async function recoverDeleted() {
    const entries = await store.all();
    const gone = [];
    await Promise.all(entries.map(async (e) => { if (!await mide.fs.stat(e.path)) gone.push(e); }));
    if (!gone.length) return mide.notify.info('No deleted files in the history.');
    gone.sort((a, b) => b.versions.at(-1).time - a.versions.at(-1).time);
    mide.ui.selectList({
      placeholder: 'Recover which deleted file?',
      items: gone.map((e) => ({ label: basename(e.path), detail: `${dirname(e.path)} · last saved ${ago(e.versions.at(-1).time)}`, e })),
      onSelect: (item) => {
        const versions = [...item.e.versions].reverse();
        // Same pick box, one step later: let the first one close before opening the next.
        setTimeout(() => mide.ui.selectList({
          placeholder: `Recover ${basename(item.e.path)} from…`,
          items: versions.map(versionItem),
          onSelect: (it) => recoverFile(item.e.path, it.v),
        }), 0);
      },
    });
  }

  async function cleanUp() {
    const removed = await store.pruneAll();
    mide.notify.info(removed ? `Removed ${removed} old ${removed === 1 ? 'version' : 'versions'}` : 'Nothing to clean up');
    return removed;
  }

  // --- wiring ----------------------------------------------------------------------------
  const hasPath = () => !!activePath();
  mide.commands.add({
    'local-history:show': { title: 'Show File History', when: hasPath, run: () => showHistory(activePath()) },
    'local-history:show-for': { title: 'Show File History for a Path', hidden: true, run: (path) => showHistory(path) },
    'local-history:restore': { title: 'Restore Previous Version', when: hasPath, run: () => restorePrevious() },
    'local-history:compare': { title: 'Compare with Previous', when: hasPath, run: () => compareWithPrevious() },
    'local-history:recover-deleted': { title: 'Recover Deleted File…', run: recoverDeleted },
    'local-history:clean-up': { title: 'Clean Up Old Versions', run: cleanUp },
  });
}
