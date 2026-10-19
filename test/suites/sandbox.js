// Sandboxed packages: install through the real flow, check a well-behaved package works and a
// hostile one can't get out (network, remote code, eval, files, programs, other packages' state).
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => x?.message || String(x)).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  await until(() => ws.project);
  const root = ws.project.replace(/\/proj$/, '');
  const statusTexts = () => [...document.querySelectorAll('.status-item')].map((e) => e.textContent);

  // A normal sandboxed package: status bar, a command, editing the open file.
  await T.answers('confirm', 0);
  out.installWordCount = await app.packages.install(root + '/word-count');
  const wc = app.packages.packages.get('word-count');
  out.sandboxed = !!wc?.sandboxed;
  out.recordedAccess = wc?.meta.install?.access;
  await ws.open(ws.project + '/notes.txt');
  out.statusShowsCount = !!(await until(() => statusTexts().find((t) => t === 'words: 5')));
  await app.commands.run('word-count:show');
  out.commandEdited = !!(await until(() => ws.getActiveEditor().getText().startsWith('[counted]')));
  out.foreignKeybindingDropped = ![...app.keymap.resolved()].some(([binding, command]) => command === 'source-control:push' && /Alt-p/i.test(binding));

  // A hostile package reports what it managed to do through its own setting.
  await T.answers('confirm', 0);
  out.installEvil = await app.packages.install(root + '/evil');
  const evil = JSON.parse(await until(() => app.config.get('evil.results')) || '{}');
  out.evilGlobals = [evil.window, evil.document, evil.process, evil.require, evil.indexedDB].join(',');
  out.evilAllowed = Object.entries(evil).filter(([k, v]) => String(v).startsWith('ALLOWED') && !['addForeignCommand', 'editorText'].includes(k)).map(([k]) => k);
  out.foreignCommandRegistered = app.commands.has('core:pwn');
  out.foreignConfigHidden = evil.foreignConfigVisible;
  out.themeUnchanged = app.config.get('core.theme');
  out.foreignSchemaIgnored = app.config.schema.get('core.theme')?.default;
  const css = [...document.querySelectorAll('style[data-pkg="evil"]')].map((s) => s.textContent).join('');
  out.cssRemoteRemoved = !/https?:|evil\.example|@import|image-set/i.test(css) && /data:image/.test(css);
  out.cssNoFakeUi = !/(^|[\s;{])(position|content|z-index|inset|display|visibility)\s*:/i.test(css);
  out.cssKeepsSafeVars = /--evil-ok/.test(css) && !/--evil-leak/.test(css);
  out.evilChannels = [evil.broadcastChannel, evil.storage, evil.locks, evil.nestedWorker, evil.storageViaPrototype].join(',');
  out.floodThrottled = evil.floodRejected > 0;
  out.notifySpamCapped = evil.notifyRejected >= 3;

  // project-files: inside the project only, symlinks out refused.
  await T.answers('confirm', 0);
  out.installReader = await app.packages.install(root + '/proj-reader');
  const reader = JSON.parse(await until(() => app.config.get('proj-reader.results')) || '{}');
  out.readerProject = String(reader.readProject).startsWith('ALLOWED');
  out.readerDotDot = String(reader.readDotDot).startsWith('blocked');
  out.readerSymlink = String(reader.readSymlinkOut).startsWith('blocked');
  out.readerWrite = String(reader.writeProject).startsWith('ALLOWED');
  out.readerExec = String(reader.exec).startsWith('blocked');
  out.readerGitConfig = String(reader.writeGitConfig).startsWith('blocked');
  out.readerNodeModules = String(reader.plantNodeModules).startsWith('blocked');
  await T.answers('confirm', 0);
  await app.packages.install(root + '/proj-viewer');
  out.viewer = JSON.parse(await until(() => app.config.get('proj-viewer.results')) || '{}');

  // "files" must not reach ~/.minimide (that would turn file access into full access).
  await app.config.set('file-reaper.target', app.userInfo.dir);
  await T.answers('confirm', 0);
  out.installReaper = await app.packages.install(root + '/file-reaper');
  const reaper = JSON.parse(await until(() => app.config.get('file-reaper.results')) || '{}');
  out.reaperBlocked = ['writeInitJs', 'writeInstalledJson', 'plantPackage', 'readConfig', 'caseVariant', 'dotDotIntoDir'].filter((k) => reaper[k] !== 'blocked');
  out.reaperProjectWrite = reaper.writeProjectFile;
  const initPath = app.userInfo.dir + '/init.js';
  const initBefore = await window.native.fs.read(initPath).catch(() => null);
  if (initBefore != null) {
    const initEd = await ws.open(initPath);
    await app.commands.run('file-reaper:clobber');
    const after = JSON.parse(await until(() => (JSON.parse(app.config.get('file-reaper.results') || '{}').clobberOpenInit ? app.config.get('file-reaper.results') : null)) || '{}');
    out.clobberOpenInit = after.clobberOpenInit;
    out.initUntouched = initEd.getText() === initBefore;
    if (initEd.isDirty()) await T.answers('confirm', 1); // only queue an answer if a dialog will ask
    await ws.closeItem(initEd);
  }

  await T.answers('confirm', 0);
  await app.packages.install(root + '/net-probe');
  const np = JSON.parse(await until(() => app.config.get('net-probe.results')) || '{}');
  out.netProbeRan = Object.keys(np).length === 6;
  out.netLocalRefused = Object.entries(np).filter(([, v]) => v !== 'refused').map(([k, v]) => `${k}=${v}`);

  // Uninstall removes everything the package added.
  await app.packages.uninstall('word-count');
  out.uninstallClean = !app.packages.packages.get('word-count') && !app.commands.has('word-count:show') && !statusTexts().some((t) => /words:/.test(t));
  out.records = Object.keys(JSON.parse(await window.native.fs.read(app.userInfo.dir + '/installed.json')).packages).sort();
  out.reservedNameRefused = await window.native.pkgmgr.stage(root + '/reserved-core').then(() => false, (e) => /reserved/.test(e.message));
  // The hostile package's blocked attempts log errors by design; only count unexpected ones.
  out.errors = errors.filter((e) => !/Command ids must start with/.test(e));
  return out;
})()
