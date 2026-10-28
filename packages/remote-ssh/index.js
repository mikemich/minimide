// Remote folders over SSH. "Remote: Open Folder over SSH…" makes a local copy of a folder on
// another machine and keeps the two in sync with your own ssh and rsync (the main process does
// the work, see src/main/remote-ssh.js). The tree, search, git and language servers all work on
// the local copy. Syncs happen on focus, every few seconds while focused, and soon after files
// change here; saved files are uploaded right away.
const SERVER_ICON = '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>';

export function activate(mide) {
  const { h, icon } = mide.ui;
  const remote = window.native.remote; // a built-in package, so it may use the native bridge
  mide.ui.registerIcon('server', SERVER_ICON);

  let current = null; // { id, host, remote, root } while the project is a remote folder
  let online = false;
  let syncing = null;
  let again = false;
  let wantManual = false;
  let failed = false;
  let changeTimer = null;
  let statusItem = null;
  const later = new Set(); // conflicts put off with "Decide Later": `${path}@${stamp}`
  const asking = new Set(); // files with a conflict question open
  const label = h('span.remote-ssh-status');

  const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inside = (p) => !!current && typeof p === 'string' && p.startsWith(current.root + '/');
  const dirtyPaths = () => mide.workspace.getDocuments().filter((d) => d.dirty && d.path).map((d) => d.path);

  function render(state = online ? 'ok' : 'offline') {
    if (!current) return;
    const note = { syncing: h('span.remote-ssh-note', 'syncing…'), offline: h('span.remote-ssh-note', 'offline'), error: h('span.remote-ssh-note.error', '!') }[state];
    label.replaceChildren(icon('server', 13), h('span', `SSH: ${current.host}`), ...(note ? [note] : []));
    label.dataset.state = state;
  }

  // --- connecting ------------------------------------------------------------
  async function connect(host, path, { quiet = false } = {}) {
    const note = quiet ? null : mide.notify.info(`Connecting to ${host}…`, 'The first time, Minimide downloads a copy of the folder.', { timeout: 0 });
    try {
      return await remote.connect(host, path, mide.config.get('core.ignoredNames') || []);
    } catch (err) {
      mide.notify.error(`Couldn't open ${path} on ${host}`, clean(err));
      return null;
    } finally { note?.close(); }
  }

  /** ssh wants a password (or to confirm the host key): log in once in a terminal tab, then carry on. */
  function login(host, loginCommand, then) {
    const terminal = mide.services.get('terminal');
    if (!terminal) {
      mide.notify.warn(`${host} asks for a password`, `Run this in a terminal, then try again:\n${loginCommand}`, { timeout: 0 });
      return;
    }
    mide.notify.info(`Log in to ${host} in the terminal`, 'Minimide carries on as soon as you\'re in. The login is reused for 10 minutes after the last sync.');
    terminal.run(loginCommand, { title: `ssh ${host}`, key: 'remote-ssh-login', onExit: (code) => { if (code === 0) then(); } });
  }

  async function openFolder(opts = {}) {
    if (mide.user.platform === 'win32') {
      mide.notify.info('Not on Windows yet', 'Remote folders over SSH work on macOS and Linux for now.');
      return;
    }
    let { host, path } = opts || {};
    if (!host) {
      let last = '';
      try { last = localStorage.getItem('remote-ssh.last') || ''; } catch {}
      const value = await mide.ui.prompt({
        title: 'Open a folder over SSH: the host, then a colon and the folder',
        placeholder: 'me@server:~/project',
        value: last,
        validate: (v) => (/^[^\s:]+(:\S.*)?$/.test(v.trim()) ? null : 'Type a host and a folder, like me@server:~/project'),
      });
      if (!value) return;
      const v = value.trim();
      const colon = v.indexOf(':');
      host = colon < 0 ? v : v.slice(0, colon);
      path = colon < 0 ? '~' : v.slice(colon + 1);
      try { localStorage.setItem('remote-ssh.last', v); } catch {}
    }
    path ||= '~';
    const res = await connect(host, path);
    if (!res) return;
    if (res.needsLogin) return login(host, res.loginCommand, () => openFolder({ host, path }));
    // The same folder may already be open here; otherwise this opens it (in a new window if
    // another project is open) and the project hook below takes over.
    if (mide.workspace.project === res.root) { online = true; render(); handleResult(res); } else await mide.workspace.setProject(res.root);
  }

  async function reconnect({ quiet = false } = {}) {
    const c = current;
    if (!c) return;
    render('syncing');
    const res = await connect(c.host, c.remote, { quiet });
    if (current !== c) return;
    if (!res) { online = false; render('offline'); return; }
    if (res.needsLogin) { online = false; render('offline'); offerLogin(res.loginCommand); return; }
    online = true;
    render();
    handleResult(res);
  }

  function offerLogin(loginCommand) {
    const host = current.host;
    mide.notify.warn(`${host} asks for a password`, 'Log in again to keep syncing.', {
      timeout: 0, actions: [{ label: 'Log In', run: () => login(host, loginCommand, () => reconnect()) }],
    });
  }

  async function disconnect() {
    if (!current) return;
    online = false;
    render('offline');
    await remote.disconnect(current.id).catch(() => {});
  }

  async function openTerminal() {
    if (!current) return;
    const terminal = mide.services.get('terminal');
    if (!terminal) { mide.notify.warn('The terminal is turned off', 'Turn on the Terminal package to open a remote shell.'); return; }
    terminal.run(await remote.terminalCommand(current.id), { title: `ssh ${current.host}`, key: `remote-ssh:${current.host}` });
  }

  // --- syncing ---------------------------------------------------------------
  function handleResult(res) {
    if (res?.conflicts?.length) for (const c of res.conflicts) if (!dirtyPaths().includes(c.path)) resolveConflict(c);
  }

  // One sync at a time; asking while one runs queues one more round (and waits for it).
  function syncNow({ manual = false } = {}) {
    if (!current || !online) return Promise.resolve();
    wantManual ||= manual;
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      do {
        again = false;
        const loud = wantManual;
        wantManual = false;
        await syncOnce(loud);
      } while (again && current && online);
    })().finally(() => { syncing = null; });
    return syncing;
  }

  async function syncOnce(manual) {
    const c = current;
    render('syncing');
    try {
      const res = await remote.sync(c.id, { skip: dirtyPaths() });
      if (current !== c) return;
      if (res.needsLogin) { online = false; render('offline'); offerLogin(res.loginCommand); return; }
      failed = false;
      render();
      if (manual) {
        const parts = [res.downloaded && `${res.downloaded} downloaded`, res.uploaded && `${res.uploaded} uploaded`, res.removed && `${res.removed} removed`].filter(Boolean);
        mide.notify.success(`Synced with ${c.host}`, parts.length ? parts.join(', ') : 'Everything was up to date.');
      }
      handleResult(res);
    } catch (err) {
      if (current !== c) return;
      render('error');
      // Say it once, not every few seconds while the network is down.
      if (!failed || manual) mide.notify.error(`Couldn't sync with ${c.host}`, clean(err));
      failed = true;
    }
  }

  async function resolveConflict(conflict, { fromSave = false } = {}) {
    const c = current;
    const key = `${conflict.path}@${conflict.stamp}`;
    if (!c || asking.has(conflict.path) || (!fromSave && later.has(key))) return;
    asking.add(conflict.path);
    try {
      const choice = await mide.ui.confirm({
        type: 'warning',
        message: `“${conflict.rel}” changed here and on ${c.host}`,
        detail: 'Both copies changed since the last sync. Which one do you want to keep? The other one is replaced.',
        buttons: ['Keep Mine', `Use the One on ${c.host}`, 'Decide Later'],
        cancelId: 2,
      });
      if (choice === 0) await remote.push(c.id, conflict.path, { force: true });
      else if (choice === 1) {
        await remote.pull(c.id, conflict.path);
        // Reload it now: right after a save the file watcher takes the change for our own write.
        const doc = mide.workspace.getDocuments().find((d) => d.path === conflict.path);
        if (doc && !doc.dirty) doc.reloadFrom(await mide.fs.read(conflict.path));
      }
      else later.add(key);
    } catch (err) {
      mide.notify.error(`Couldn't sync ${conflict.rel}`, clean(err));
    } finally { asking.delete(conflict.path); }
  }

  // Upload on save, asking first when the remote copy changed too.
  mide.workspace.onDidSave(async (item) => {
    const path = item?.getPath?.();
    if (!inside(path) || !online) return;
    const c = current;
    try {
      const res = await remote.push(c.id, path);
      if (res.needsLogin) { online = false; render('offline'); offerLogin(res.loginCommand); } else if (res.conflict) await resolveConflict(res, { fromSave: true });
    } catch (err) {
      render('error');
      mide.notify.error(`Couldn't upload ${path.split('/').pop()} to ${c.host}`, clean(err));
    }
  });

  mide.workspace.onDidChangeFiles((paths) => {
    if (!online || !paths?.some(inside)) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => syncNow(), 1500);
  });

  const onFocus = () => syncNow();
  window.addEventListener('focus', onFocus);
  let lastTick = 0;
  const interval = setInterval(() => {
    const secs = mide.config.get('remote-ssh.syncInterval');
    if (secs > 0 && document.hasFocus() && Date.now() - lastTick >= secs * 1000 - 500) { lastTick = Date.now(); syncNow(); }
  }, 1000);

  // --- the project -----------------------------------------------------------
  function detach() {
    current = null;
    online = false;
    clearTimeout(changeTimer);
    statusItem?.dispose();
    statusItem = null;
  }

  async function projectChanged() {
    const project = mide.workspace.project;
    const info = project ? await remote.lookup(project).catch(() => null) : null;
    if (mide.workspace.project !== project) return;
    if (info && current?.id === info.id) return;
    detach();
    if (!info) return;
    current = info;
    statusItem = mide.statusBar.addItem({
      id: 'remote-ssh', element: label, align: 'left', priority: 2, tooltip: `${info.host}:${info.remote}`, onClick: showMenu,
    });
    if (info.connected) { online = true; render(); syncNow(); } else await reconnect({ quiet: true });
  }

  async function showMenu() {
    const picked = await mide.ui.contextMenu([
      { id: 'remote-ssh:sync', label: 'Sync Now', enabled: online },
      { id: 'remote-ssh:open-terminal', label: 'Open Remote Terminal', enabled: online },
      { type: 'separator' },
      online ? { id: 'remote-ssh:disconnect', label: 'Disconnect' } : { id: 'remote-ssh:reconnect', label: 'Reconnect' },
    ]);
    if (picked) mide.commands.run(picked);
  }

  const has = () => !!current;
  mide.commands.add({
    'remote-ssh:open-folder': { title: 'Open Folder over SSH…', category: 'Remote', run: openFolder },
    'remote-ssh:sync': { title: 'Sync Now', category: 'Remote', when: () => has() && online, run: () => syncNow({ manual: true }) },
    'remote-ssh:open-terminal': { title: 'Open Remote Terminal', category: 'Remote', when: () => has() && online, run: openTerminal },
    'remote-ssh:disconnect': { title: 'Disconnect', category: 'Remote', when: () => has() && online, run: disconnect },
    'remote-ssh:reconnect': { title: 'Reconnect', category: 'Remote', when: () => has() && !online, run: () => reconnect() },
  });

  mide.workspace.onDidChangeProject(projectChanged);
  projectChanged();

  mide.subscriptions.add({
    dispose: () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      detach();
    },
  });
}
