// Settings sync: your config, keymap, styles, init script and snippets in one private GitHub gist.
//
// The GitHub token is kept by the main process (encrypted by the operating system) and never
// reaches this code: it only asks for "upload" and "download". Downloading shows a preview with
// a diff for every file and changes nothing until you press Apply; files that are replaced are
// copied to ~/.minimide/backups/<time>/ first.
import { lineDiff, collapse, summarize } from './diff.js';

// Files in the user folder that are synced as they are.
const FIXED = ['config.json', 'keymap.json', 'styles.css', 'init.js', 'snippets.json'];
const SNIPPET_PREFIX = 'snippets--';
const SNIPPET_FILE = /^[\w.~ -]{1,100}\.(json|code-snippets)$/;
const PACKAGES = 'packages.json';
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function activate(mide) {
  const { h } = mide.ui;
  const userDir = mide.user.dir;
  const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const readText = (file) => mide.fs.read(file).catch((err) => (/ENOENT/.test(err.message) ? null : Promise.reject(err)));
  let item = null;

  /** Where a synced file lives here, or null for a name this package doesn't sync. Incoming names are checked with this before anything is written. */
  function localPath(name) {
    if (FIXED.includes(name)) return `${userDir}/${name}`;
    if (name.startsWith(SNIPPET_PREFIX) && SNIPPET_FILE.test(name.slice(SNIPPET_PREFIX.length))) return `${userDir}/snippets/${name.slice(SNIPPET_PREFIX.length)}`;
    return null;
  }

  /** The GitHub packages installed here, as sorted "owner/name" sources. */
  function installedSources() {
    return mide.packages.list()
      .filter((p) => !p.builtin && p.install?.source?.startsWith('github:'))
      .map((p) => p.install.source.slice('github:'.length))
      .filter((s) => REPO.test(s))
      .sort();
  }

  /** { gistName: text } for everything this computer would upload. */
  async function collectLocal() {
    const files = {};
    for (const name of FIXED) {
      const text = await readText(localPath(name));
      if (text != null && text.trim()) files[name] = text;
    }
    if (await mide.fs.stat(`${userDir}/snippets`)) {
      for (const entry of await mide.fs.readdir(`${userDir}/snippets`)) {
        if (entry.isDir || !SNIPPET_FILE.test(entry.name)) continue;
        const text = await readText(entry.path).catch(() => null);
        if (text != null && text.trim()) files[SNIPPET_PREFIX + entry.name] = text;
      }
    }
    const sources = installedSources();
    if (sources.length) files[PACKAGES] = JSON.stringify({ packages: sources.map((source) => ({ source })) }, null, 2) + '\n';
    return files;
  }

  async function ensureSetUp() {
    let status;
    try { status = await mide.sync.status(); } catch (err) { mide.notify.error('Settings sync', cleanError(err)); return false; }
    if (status.hasToken) return true;
    mide.notify.info('Sync isn\'t set up yet', 'Set it up once, then upload from here and download on your other computers.', { actions: [{ label: 'Set Up…', run: () => mide.commands.run('settings-sync:set-up') }] });
    return false;
  }

  // --- set up --------------------------------------------------------------
  async function setUp() {
    let status;
    try { status = await mide.sync.status(); } catch (err) { return mide.notify.error('Settings sync', cleanError(err)); }
    if (status.hasToken) {
      const choice = await mide.ui.confirm({
        message: 'Settings sync is already set up on this computer.',
        detail: 'Use "Sync: Upload Settings" and "Sync: Download Settings" to move your settings. Signing out forgets the token on this computer; the gist stays on GitHub.',
        buttons: ['Sign Out', 'Keep It'],
      });
      if (choice === 0) await signOut(false);
      return;
    }
    let connected = false;
    if (await mide.sync.cliAvailable().catch(() => false)) {
      const choice = await mide.ui.confirm({
        message: 'Use your GitHub CLI login?',
        detail: 'Minimide found the GitHub CLI (gh) logged in on this computer. It can use that login to read and write one private gist for your settings. The token is kept encrypted by your operating system.',
        buttons: ['Use GitHub CLI', 'Paste a Token Instead', 'Cancel'],
      });
      if (choice === 2 || choice == null) return;
      if (choice === 0) {
        const r = await mide.sync.useGitHubCli().catch((err) => ({ ok: false, error: cleanError(err) }));
        if (!r.ok) return mide.notify.error('Couldn\'t use the GitHub CLI', r.error);
        connected = true;
      }
    }
    if (!connected) {
      const token = await mide.ui.prompt({
        title: 'Paste a GitHub token with only the "gist" scope', placeholder: 'ghp_… or github_pat_…', secret: true,
        validate: (v) => (/^[\w.-]{8,255}$/.test(v.trim()) ? null : 'That doesn\'t look like a GitHub token.'),
      });
      if (!token) return;
      try { await mide.sync.setToken(token.trim()); } catch (err) { return mide.notify.error('Couldn\'t save the token', cleanError(err)); }
    }
    mide.notify.success('Settings sync is ready', 'Your settings go to a private gist in your GitHub account.', {
      timeout: 10000,
      actions: [{ label: 'Upload Settings', run: () => mide.commands.run('settings-sync:upload') }, { label: 'Download Settings', run: () => mide.commands.run('settings-sync:download') }],
    });
  }

  async function signOut(ask = true) {
    if (ask) {
      const choice = await mide.ui.confirm({ message: 'Sign out of settings sync?', detail: 'The token is forgotten on this computer. Your gist stays on GitHub.', buttons: ['Sign Out', 'Cancel'] });
      if (choice !== 0) return;
    }
    try { await mide.sync.signOut(); } catch (err) { return mide.notify.error('Couldn\'t sign out', cleanError(err)); }
    mide.notify.info('Signed out of settings sync');
  }

  // --- upload --------------------------------------------------------------
  async function upload() {
    if (!await ensureSetUp()) return;
    let files;
    try { files = await collectLocal(); } catch (err) { return mide.notify.error('Couldn\'t read your settings', cleanError(err)); }
    const names = Object.keys(files);
    if (!names.length) return mide.notify.info('Nothing to upload', 'There are no settings files in your Minimide folder yet.');
    const choice = await mide.ui.confirm({
      message: `Upload ${names.length} file${names.length === 1 ? '' : 's'} to your sync gist?`,
      detail: `${names.join('\n')}\n\nThe gist is private, but anyone with its link can read it, so keep secrets out of these files.${names.includes('init.js') ? '\n\ninit.js is code that other computers will offer to run when they download.' : ''}\n\nWhat is in the gist now is replaced.`,
      buttons: ['Upload', 'Cancel'],
    });
    if (choice !== 0) return;
    const progress = mide.notify.info('Uploading settings…', undefined, { timeout: 0 });
    try {
      const g = await mide.sync.upload(files);
      progress.close();
      mide.notify.success('Settings uploaded', `${names.length} file${names.length === 1 ? '' : 's'} saved to your sync gist.`, g?.url ? { actions: [{ label: 'Open on GitHub', run: () => mide.shell.openExternal(g.url) }] } : undefined);
    } catch (err) { progress.close(); mide.notify.error('Couldn\'t upload your settings', cleanError(err)); }
  }

  // --- download ------------------------------------------------------------
  class SyncItem {
    constructor(plan) {
      this.type = 'settings-sync';
      this.id = 'settings-sync';
      this.iconName = 'package';
      this.plan = plan;
      this.element = h('div.ss-view');
      this.render();
    }
    on() { return { dispose() {} }; }
    getTitle() { return 'Download Settings'; }
    getElement() { return this.element; }
    focus() { this.element.querySelector('.ss-apply')?.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { if (item === this) item = null; }

    selected() { return this.plan.files.filter((f) => f.checked); }

    render() {
      const { plan } = this;
      const picked = this.selected().length;
      const fileRow = (f) => h('div.ss-file',
        h('label.ss-file-head',
          h('input', { type: 'checkbox', checked: f.checked, dataset: { file: f.name }, onchange: (e) => { f.checked = e.target.checked; this.render(); } }),
          h('span.ss-file-name', f.local),
          h('span.ss-file-stat', f.isNew ? 'new file' : `+${f.stat.added} −${f.stat.removed}`)),
        f.warning ? h('div.ss-file-warn', f.warning) : null,
        h('details', { open: f.name === 'init.js' ? true : undefined }, h('summary', 'Show changes'),
          h('div.ss-diff', f.diff.map((l) => h(`div.ss-line.${l.type}`, l.type === 'gap' ? `… ${l.count} unchanged line${l.count === 1 ? '' : 's'}` : `${l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}${l.text}`)))));
      this.element.replaceChildren(h('div.ss-content',
        h('h1', 'Download Settings'),
        h('p.ss-source', plan.updatedAt ? `From your sync gist, last updated ${new Date(plan.updatedAt).toLocaleString()}` : 'From your sync gist'),
        h('p.ss-intro', plan.files.length ? 'Nothing has changed yet. Untick anything you don\'t want, then press Apply. The files they replace are copied to a backup folder first.' : 'This computer already has everything in your sync gist.'),
        plan.files.map(fileRow),
        plan.missing.length ? h('div',
          h('div.ss-section-title', `Packages you don't have here (${plan.missing.length})`),
          h('p.ss-note', 'You can install them after applying. Each one shows what it asks for first.'),
          plan.missing.map((s) => h('div.ss-pkg', s))) : null,
        plan.ignored.length ? h('p.ss-note', `Ignored ${plan.ignored.length} file${plan.ignored.length === 1 ? '' : 's'} this version doesn't sync: ${plan.ignored.join(', ')}`) : null,
        h('div.ss-actions',
          h('button.btn.primary.ss-apply', { disabled: !picked && !plan.missing.length, onclick: () => this.apply() }, picked ? `Apply ${picked} file${picked === 1 ? '' : 's'}` : plan.missing.length ? 'Install Packages…' : 'Apply'),
          h('button.btn.ss-cancel', { onclick: () => mide.workspace.closeItem(this) }, 'Cancel'))));
    }

    async apply() {
      const chosen = this.selected();
      const failed = [];
      let backup = null;
      if (chosen.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = `${userDir}/backups/${stamp}`;
        try {
          for (const f of chosen) if (f.before != null) await mide.fs.write(`${backup}/${f.local}`, f.before);
        } catch (err) { return mide.notify.error('Couldn\'t make a backup, so nothing was changed', cleanError(err)); }
      }
      let written = 0;
      for (const f of chosen) {
        try { await mide.fs.write(f.path, f.after); written++; } catch (err) { failed.push(`${f.local}: ${cleanError(err)}`); }
      }
      if (chosen.some((f) => f.name.startsWith(SNIPPET_PREFIX) || f.name === 'snippets.json')) mide.commands.run('snippets:reload');
      const missing = this.plan.missing;
      mide.workspace.closeItem(this);
      const needsRestart = chosen.some((f) => f.name === 'init.js');
      if (failed.length) mide.notify.error('Some files couldn\'t be written', failed.join('\n'));
      if (written) {
        mide.notify.success('Settings applied', `${written} file${written === 1 ? '' : 's'} updated.${needsRestart ? ' Reload the window for init.js to run.' : ''} The old versions are in ${backup.replace(userDir, '~/.minimide')}.`, { timeout: 10000 });
      }
      if (missing.length) {
        mide.notify.info(`${missing.length} package${missing.length === 1 ? ' is' : 's are'} missing here`, missing.join(', '), {
          timeout: 0,
          actions: [{ label: 'Install…', run: async () => { for (const s of missing) await mide.packages.install(s); } }],
        });
      }
      this.result = { written, failed, backup, missing };
    }
  }

  async function download() {
    if (!await ensureSetUp()) return;
    const progress = mide.notify.info('Downloading settings…', undefined, { timeout: 0 });
    let gist;
    try { gist = await mide.sync.download(); } catch (err) { progress.close(); return mide.notify.error('Couldn\'t download your settings', cleanError(err)); }
    progress.close();
    if (!gist) return mide.notify.info('Nothing to download yet', 'Upload your settings from a computer that has them first.');
    try {
      const files = [];
      const ignored = [];
      let missing = [];
      for (const [name, text] of Object.entries(gist.files)) {
        if (name === PACKAGES) {
          try {
            const have = new Set(installedSources());
            missing = (JSON.parse(text).packages || []).map((p) => p?.source).filter((s) => typeof s === 'string' && REPO.test(s) && !have.has(s));
          } catch { ignored.push(name); }
          continue;
        }
        const path = localPath(name);
        if (!path) { ignored.push(name); continue; }
        const before = await readText(path);
        if (before === text) continue;
        const diff = lineDiff(before ?? '', text);
        files.push({
          name, path, local: path.slice(userDir.length + 1), before, after: text, isNew: before == null,
          stat: summarize(diff), diff: collapse(diff),
          // Code from the gist is never ticked for you.
          checked: name !== 'init.js',
          warning: name === 'init.js' ? 'This is code that runs every time Minimide starts. Read it before you apply it.' : '',
        });
      }
      files.sort((a, b) => a.local.localeCompare(b.local));
      if (item) mide.workspace.closeItem(item);
      item = new SyncItem({ files, missing, ignored, updatedAt: gist.updatedAt });
      mide.workspace.openItem(item);
    } catch (err) { mide.notify.error('Couldn\'t compare your settings', cleanError(err)); }
  }

  mide.commands.add('settings-sync:set-up', 'Set Up…', () => { setUp(); }, { category: 'Sync' });
  mide.commands.add('settings-sync:upload', 'Upload Settings', () => { upload(); }, { category: 'Sync' });
  mide.commands.add('settings-sync:download', 'Download Settings', () => { download(); }, { category: 'Sync' });
  mide.commands.add('settings-sync:sign-out', 'Sign Out', () => { signOut(); }, { category: 'Sync' });
  mide.subscriptions.add({ dispose: () => { if (item) mide.workspace.closeItem(item); } });
}
