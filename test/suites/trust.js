// Workspace trust: a repository whose .git/config runs a command (core.fsmonitor) must not get to
// run it when opened. In Restricted Mode git, blame and language servers stay off; after trusting,
// git works but background calls still never run the repo's fsmonitor command.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(100); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const fixtures = app.userInfo.dir.replace(/\/[^/]+$/, '');
  const repo = fixtures + '/evilrepo';
  const marker = fixtures + '/evilrepo-marker.txt';
  const markerExists = async () => (await window.native.fs.stat(marker)) != null;
  const statusTexts = () => [...document.querySelectorAll('.status-item')].map((e) => e.textContent);

  await T.answers('confirm', 2); // "Restricted Mode"
  await app.openProject(repo);
  await sleep(1500);
  window.dispatchEvent(new Event('focus')); // the git package refreshes on focus
  await sleep(1500);
  out.restrictedStatus = statusTexts().some((t) => /Restricted Mode/.test(t));
  out.markerAfterOpen = await markerExists();
  const ed = await ws.open(repo + '/a.txt');
  ed.goToLine?.(1, 1);
  await sleep(1200);
  out.markerAfterBlame = await markerExists();
  app.sidebar.show('source-control');
  out.scRestricted = !!(await until(() => /Restricted Mode/.test(document.querySelector('.sc-empty')?.textContent || '')));
  await ws.open(repo + '/main.ts');
  out.lspRestricted = !!(await until(() => /restricted/.test(document.querySelector('.lsp-status')?.textContent || '')));

  await T.answers('confirm', 0); // "Trust Folder"
  await app.commands.run('workspace:trust-folder');
  out.trusted = app.trust.isTrusted(repo);
  out.gitBranchAfterTrust = !!(await until(() => statusTexts().some((t) => /master/.test(t))));
  await sleep(1000);
  out.markerAfterTrust = await markerExists();
  out.storedTrust = JSON.parse(await window.native.fs.read(app.userInfo.dir + '/trusted-folders.json')).folders.some((f) => f.path === repo);

  await app.trust.untrust(repo);
  out.restrictedAfterUntrust = !!(await until(() => statusTexts().some((t) => /Restricted Mode/.test(t))));
  out.errors = errors;
  return out;
})()
