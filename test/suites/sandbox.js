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
  out.cssRemoteRemoved = !/https?:|@import/i.test(css) && /data:image/.test(css);

  // project-files: inside the project only, symlinks out refused.
  await T.answers('confirm', 0);
  out.installReader = await app.packages.install(root + '/proj-reader');
  const reader = JSON.parse(await until(() => app.config.get('proj-reader.results')) || '{}');
  out.readerProject = String(reader.readProject).startsWith('ALLOWED');
  out.readerDotDot = String(reader.readDotDot).startsWith('blocked');
  out.readerSymlink = String(reader.readSymlinkOut).startsWith('blocked');
  out.readerWrite = String(reader.writeProject).startsWith('ALLOWED');
  out.readerExec = String(reader.exec).startsWith('blocked');

  // Uninstall removes everything the package added.
  await app.packages.uninstall('word-count');
  out.uninstallClean = !app.packages.packages.get('word-count') && !app.commands.has('word-count:show') && !statusTexts().some((t) => /words:/.test(t));
  out.records = Object.keys(JSON.parse(await window.native.fs.read(app.userInfo.dir + '/installed.json')).packages).sort();
  // The hostile package's blocked attempts log errors by design; only count unexpected ones.
  out.errors = errors.filter((e) => !/Command ids must start with/.test(e));
  return out;
})()
