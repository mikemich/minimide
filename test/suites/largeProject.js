// A 55,000-file project: everything is indexed and searched, the UI stays responsive, and the
// cached file list follows outside changes without re-listing the project.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(50); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  await until(() => ws.project);
  let maxGap = 0, last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last - 50); last = n; }, 50);
  const files = await app.projectFiles();
  out.fileCount = files.length;
  out.nodeModulesIgnored = !files.some((f) => f.includes('/node_modules/'));
  const res = await window.native.project.search(ws.project, 'needle', { ignored: app.config.get('core.ignoredNames') });
  out.searchMatches = res.results.reduce((n, r) => n + r.matches.length, 0);
  out.searchError = res.error || null;
  await window.native.fs.write(ws.project + '/src/mod1/brand-new.js', 'x\n');
  await window.native.fs.trash(ws.project + '/src/mod2/file5.js');
  await sleep(1500);
  const t = performance.now();
  const after = await app.projectFiles();
  out.relistFast = performance.now() - t < 50;
  out.newFileSeen = after.includes(ws.project + '/src/mod1/brand-new.js');
  out.deletedGone = !after.some((f) => f.endsWith('/src/mod2/file5.js'));
  clearInterval(iv);
  out.responsive = maxGap < 1000;
  out.maxStallMs = Math.round(maxGap);
  out.errors = errors;
  return out;
})()
