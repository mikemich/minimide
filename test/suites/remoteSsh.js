// Remote folders over SSH, against a fake ssh (fixtures: remote/fake-ssh runs commands in
// remote/server as if it were the remote home) and the real rsync. Opens a folder on a host that
// wants a password (logged in through a terminal tab), then checks uploads on save, downloads,
// conflicts, deletes and renames, an incomplete mirror, trust, and rejected hosts and paths.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, R = window.native.remote;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const fixtures = app.userInfo.dir.replace(/\/[^/]+$/, '');
  const server = fixtures + '/remote/server/proj';
  const read = (p) => window.native.fs.read(p).catch(() => null);
  const exists = async (p) => (await window.native.fs.stat(p)) != null;
  const status = () => document.querySelector('.status-item[data-id="remote-ssh"]')?.textContent || '';
  const sync = () => app.commands.run('remote-ssh:sync');
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (err) { out[name] = `THREW ${err.message}`; } };
  const edit = (ed, text) => ed.view.dispatch({ changes: { from: 0, insert: text } });

  await step('rejected', async () => {
    const bad = [['-oProxyCommand=touch /tmp/pwned', '~/proj'], ['host;id', '~/proj'], ['a b', '~/proj'], ['host\n', '~/proj'], ['', '~/proj'],
      ['devbox', 'proj'], ['devbox', '~/$(id)'], ['devbox', '~/../etc'], ['devbox', '/tmp/a b'], ['devbox', "~/it's"]];
    let rejected = 0;
    for (const [h, p] of bad) { try { await R.connect(h, p, []); } catch { rejected++; } }
    return rejected === bad.length ? 'all' : `${rejected} of ${bad.length}`;
  });
  await step('unreachable', async () => { try { await R.connect('downhost', '~/proj', []); return 'connected?'; } catch (err) { return err.message; } });

  // A host that asks for a password: the command logs in through a terminal tab, then opens the folder.
  await step('passwordHost', async () => {
    const res = await R.connect('pwhost', '~/proj', []);
    return res.needsLogin && /fake-ssh .*-f -N pwhost/.test(res.loginCommand) ? 'needs login' : JSON.stringify(res);
  });
  await app.commands.run('remote-ssh:open-folder', { host: 'pwhost', path: '~/proj' });
  const root = await until(() => ws.project?.startsWith(`${app.userInfo.dir}/remote/pwhost/`) && ws.project, 30000);
  out.opened = !!root && root.endsWith('/proj');
  out.loggedIn = await exists(fixtures + '/remote/logged-in');
  out.status = await until(() => /SSH: pwhost/.test(status()) && !/syncing|offline/.test(status()) && status());

  await step('mirrored', async () => ({
    a: await read(root + '/a.txt'),
    spaced: await read(root + '/sub dir/b c.txt'),
    quoted: await read(root + "/it's.txt"),
    git: await exists(root + '/.git'),
    nodeModules: await exists(root + '/node_modules'),
  }));

  await step('saveUploads', async () => {
    const ed = await ws.open(root + '/a.txt');
    edit(ed, 'EDITED ');
    await ws.save(ed);
    return !!(await until(async () => (await read(server + '/a.txt')) === 'EDITED hello from the server\n'));
  });

  await step('remoteChangePulled', async () => {
    const ed = await ws.open(root + '/notes.md');
    await window.native.fs.write(server + '/notes.md', '# Notes, changed on the server\n');
    await sleep(1100);
    await sync();
    return !!(await until(() => ed.getText() === '# Notes, changed on the server\n'));
  });

  await step('dirtyNotOverwritten', async () => {
    const ed = await ws.open(root + "/it's.txt");
    edit(ed, 'unsaved ');
    await window.native.fs.write(server + "/it's.txt", 'changed on the server meanwhile\n');
    await sync();
    const ok = (await read(root + "/it's.txt")) === 'quote in the name\n' && ed.isDirty() && ed.getText() === 'unsaved quote in the name\n';
    await ws.revert(ed);
    return ok;
  });

  // Let the syncs that follow downloads finish, so they don't race the next step.
  const settle = async () => { await sleep(1800); await sync(); };

  // Saving a file that changed on the server too asks which copy to keep.
  await settle();
  await step('conflictKeepMine', async () => {
    const ed = await ws.open(root + '/clash.txt');
    edit(ed, 'mine: '); // unsaved, so syncs leave the file alone meanwhile
    await window.native.fs.write(server + '/clash.txt', 'theirs, a longer line\n');
    await sync();
    await T.answers('confirm', 0); // "Keep Mine"
    await ws.save(ed);
    return !!(await until(async () => (await read(server + '/clash.txt')) === 'mine: original\n'));
  });
  await settle();
  await step('conflictUseTheirs', async () => {
    const ed = await ws.open(root + '/clash2.txt');
    edit(ed, 'mine: ');
    await window.native.fs.write(server + '/clash2.txt', 'theirs wins\n');
    await sync();
    await T.answers('confirm', 1); // "Use the One on pwhost"
    await ws.save(ed);
    return !!(await until(() => ed.getText() === 'theirs wins\n' && !ed.isDirty()));
  });

  // Deletes and renames made here reach the server on the next sync.
  await settle();
  await step('deleteAndRename', async () => {
    await window.native.fs.trash(root + '/gone.txt');
    await window.native.fs.rename(root + '/move-me.txt', root + '/moved.txt');
    await window.native.fs.rename(root + '/old', root + '/new');
    await sync();
    return {
      deleted: !(await exists(server + '/gone.txt')),
      renamed: !(await exists(server + '/move-me.txt')) && (await read(server + '/moved.txt')) === 'rename me\n',
      folderRenamed: !(await exists(server + '/old')) && (await read(server + '/new/name.txt')) === 'renamed folder\n',
    };
  });

  // Only files the mirror knows (and that didn't change there) are deleted remotely; files
  // missing here are downloaded again rather than deleted there.
  await step('incompleteMirror', async () => {
    await window.native.fs.write(server + '/docs/three.md', 'added on the server\n');
    await window.native.fs.trash(root + '/docs');
    await window.native.proc.exec('rm', [root + '/sub dir/b c.txt']);
    await sync();
    return {
      knownDeleted: !(await exists(server + '/docs/one.md')) && !(await exists(server + '/docs/two.md')),
      unknownKept: (await read(server + '/docs/three.md')) === 'added on the server\n',
      unknownDownloaded: (await read(root + '/docs/three.md')) === 'added on the server\n',
      missingRedownloaded: (await read(root + '/sub dir/b c.txt')) === 'in a folder with a space\n',
      serverKeptMissing: await exists(server + '/sub dir/b c.txt'),
    };
  });

  // Trusting a parent folder (here: everything) doesn't trust remote copies; the prompt offers the host.
  await step('trust', async () => {
    app.userInfo.trustAll = false;
    try {
      await app.trust.trust(fixtures);
      const parentIgnored = !app.trust.isTrusted(root) && app.trust.isTrusted(fixtures + '/qa');
      await T.answers('confirm', 1); // "Trust Everything on pwhost"
      await app.trust.prompt(root);
      const hostTrusted = app.trust.isTrusted(root) && app.trust.folders.some((f) => f.path === `${app.userInfo.dir}/remote/pwhost`);
      const otherHost = !app.trust.isTrusted(`${app.userInfo.dir}/remote/devbox/0123456789ab/proj`);
      await app.trust.untrust(fixtures);
      await app.trust.untrust(`${app.userInfo.dir}/remote/pwhost`);
      return { parentIgnored, hostTrusted, otherHost };
    } finally { app.userInfo.trustAll = true; }
  });

  await step('terminalCommand', async () => R.terminalCommand(`pwhost/${root.split('/').slice(-2)[0]}`));

  await step('disconnectReconnect', async () => {
    await app.commands.run('remote-ssh:disconnect');
    const offline = /offline/.test(status());
    await app.commands.run('remote-ssh:reconnect');
    const back = !!(await until(() => /SSH: pwhost/.test(status()) && !/offline|syncing/.test(status())));
    return { offline, back };
  });

  // A host that needs no password, opened straight through the bridge (absolute path).
  await step('secondHost', async () => {
    const res = await R.connect('devbox', server, app.config.get('core.ignoredNames'));
    return { root: res.root.startsWith(`${app.userInfo.dir}/remote/devbox/`), a: await read(res.root + '/a.txt'), lookup: (await R.lookup(res.root))?.host };
  });

  out.errors = errors.filter((e) => !/Autofill/.test(e));
  return out;
})()
