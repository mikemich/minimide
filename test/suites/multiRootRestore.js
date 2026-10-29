// Several project folders, part 2: a fresh launch on the same project brings back the folders that
// multiRoot added, still with the untrusted one in Restricted Mode (and without asking again).
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  await until(() => ws.folders.length === 3);
  const names = () => ws.folders.map((f) => f.split('/').pop());
  const treeRoots = () => [...document.querySelectorAll('.tree-row.project-folder .tree-name')].map((e) => e.textContent);
  out.folders = names();
  app.sidebar.show('tree-view');
  out.treeRoots = await until(() => treeRoots().length === 3 && treeRoots());
  out.tab = (await until(() => ws.getActiveItem()?.getPath?.()))?.split('/').slice(-3).join('/');
  out.title = document.title;
  out.restricted = !!(await until(() => [...document.querySelectorAll('.status-item')].some((e) => /Restricted Mode/.test(e.textContent))));
  out.gammaTrusted = app.trust.isTrusted(ws.folders[1]);
  out.errors = errors;
  return out;
})()
