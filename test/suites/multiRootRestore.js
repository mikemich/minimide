// Several project folders, part 2: a fresh launch on the same project brings back the folders that
// multiRoot added, still with the untrusted one in Restricted Mode (and without asking again); the
// tree follows changes in each of them, and in a folder that is inside another one.
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

  // The restored tree keeps up with the disk in every folder (the folders came back one by one).
  const rows = (p) => [...document.querySelectorAll(`.tree-row[data-path="${CSS.escape(p)}"]`)];
  const [alpha, , beta] = ws.folders;
  await window.native.fs.write(`${alpha}/fresh.txt`, 'new\n');
  await window.native.fs.write(`${beta}/lib/fresh.py`, 'new\n');
  out.newFilesShown = !!(await until(() => rows(`${alpha}/fresh.txt`).length && rows(`${beta}/lib/fresh.py`).length));

  // A folder inside another one: its files show (and update) under both.
  await app.addFolder(`${alpha}/src`);
  await until(() => ws.folders.length === 4 && rows(`${alpha}/src`).length === 2);
  await window.native.fs.write(`${alpha}/src/nested.js`, 'new\n');
  out.nestedNewFile = await until(() => rows(`${alpha}/src/nested.js`).length);
  rows(`${alpha}/src`)[0].click(); // the one inside alpha
  out.nestedBoth = await until(() => rows(`${alpha}/src/nested.js`).length === 2 && rows(`${alpha}/src/app.js`).length === 2 && 2);
  await window.native.fs.write(`${alpha}/src/second.js`, 'new\n');
  out.nestedSecondBoth = await until(() => rows(`${alpha}/src/second.js`).length === 2 && 2);
  await ws.open(`${alpha}/src/app.js`);
  out.nestedActiveRows = await until(() => rows(`${alpha}/src/app.js`).filter((r) => r.classList.contains('active')).length === 2 && 2);
  out.errors = errors;
  return out;
})()
