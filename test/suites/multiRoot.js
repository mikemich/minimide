// Several project folders in one window (multiRootRestore runs next with the same home): add a
// folder, then the tree, Find File, Find in Project, relative paths and git cover both; remove it;
// an untrusted folder puts the window in Restricted Mode; the folder list is saved with the session.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const alpha = await until(() => ws.project);
  const base = alpha.replace(/\/[^/]+$/, '');
  const beta = `${base}/beta`, gamma = `${base}/gamma`;
  const names = () => ws.folders.map((f) => f.split('/').pop());
  const treeRoots = () => [...document.querySelectorAll('.tree-row.project-folder .tree-name')].map((e) => e.textContent);
  const treeRow = (p) => document.querySelector(`.tree-row[data-path="${CSS.escape(p)}"]`);
  const statusTexts = () => [...document.querySelectorAll('.status-item')].map((e) => e.textContent);
  const git = app.packages.services.get('git-status');
  for (const i of ws.allItems()) { await T.answers('confirm', 1); await ws.closeItem(i); }
  app.sidebar.show('tree-view');

  // --- one folder: as before ---------------------------------------------------------------
  out.single = { folders: names(), rel: ws.relativePath(`${alpha}/src/app.js`), title: document.title, treeRoots: treeRoots().length };

  // --- add a folder ------------------------------------------------------------------------
  await T.answers('openFolder', beta);
  await app.commands.run('project:add-folder');
  await until(() => ws.folders.length === 2);
  out.added = names();
  out.title = document.title;
  out.treeRoots = await until(() => treeRoots().length === 2 && treeRoots());
  out.treeShowsBetaFiles = !!(await until(() => treeRow(`${beta}/readme.md`) && treeRow(`${alpha}/main.txt`)));
  out.rel = { alpha: ws.relativePath(`${alpha}/src/app.js`), beta: ws.relativePath(`${beta}/lib/util.py`), root: ws.relativePath(beta) };
  out.folderFor = ws.folderFor(`${beta}/lib/util.py`) === beta && ws.folderFor(`${alpha}/main.txt`) === alpha && ws.folderFor('/elsewhere/x') === null;
  out.resolved = ws.resolvePath('beta/lib/util.py') === `${beta}/lib/util.py` && ws.resolvePath('src/app.js') === `${alpha}/src/app.js`;

  // --- Find File lists both folders, with the folder's name in front -----------------------
  await app.commands.run('fuzzy-finder:toggle');
  const input = await until(() => document.querySelector('.select-list .select-input'));
  input.value = 'util'; input.dispatchEvent(new Event('input'));
  const first = await until(() => document.querySelector('.select-item .finder-dir') && document.querySelector('.select-item'));
  out.finder = { dir: first?.querySelector('.finder-dir')?.textContent, name: first?.querySelector('.finder-name')?.textContent, placeholder: input.placeholder };
  first?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  out.finderOpened = !!(await until(() => ws.getActiveItem()?.getPath?.() === `${beta}/lib/util.py`));

  // --- Find in Project searches every folder; a folder filter can name a folder ------------
  await app.commands.run('find-in-project:show');
  const q = await until(() => document.querySelector('.fip-query'));
  const fipFiles = () => [...document.querySelectorAll('.fip-file')].map((e) => e.title).sort();
  q.value = 'shared-needle'; q.dispatchEvent(new Event('input'));
  out.search = await until(() => fipFiles().length >= 2 && fipFiles());
  const folderInput = document.querySelector('.fip-folder');
  folderInput.value = 'beta'; folderInput.dispatchEvent(new Event('input'));
  out.searchInBeta = await until(() => fipFiles().length === 1 && fipFiles());
  folderInput.value = ''; folderInput.dispatchEvent(new Event('input'));
  // The same through the package API, as find-in-project and todos use it.
  const api = app.packages.createApi({ meta: { name: 'probe', dir: base, url: '', manifest: { name: 'probe' } }, subscriptions: [], styleEls: [] });
  out.apiSearch = (await api.project.search('shared-needle')).results.map((r) => ws.relativePath(r.file)).sort();
  out.apiFolders = api.workspace.folders.map((f) => f.split('/').pop());

  // --- git: each folder's own repository ---------------------------------------------------
  app.sidebar.show('tree-view');
  window.dispatchEvent(new Event('focus'));
  out.gitStatus = await until(() => git.statuses().get(`${beta}/readme.md`) === 'modified' && git.statuses().get(`${beta}/new.txt`));
  out.treeGit = await until(() => treeRow(`${beta}/readme.md`)?.dataset.git);
  await ws.open(`${beta}/readme.md`);
  out.branchForBeta = await until(() => git.root() === beta && statusTexts().some((t) => /^master/.test(t)) && git.branch());
  await ws.open(`${alpha}/main.txt`);
  out.noBranchForAlpha = !!(await until(() => git.root() === null && !statusTexts().some((t) => /^master/.test(t))));
  await ws.open(`${beta}/readme.md`);
  await app.commands.run('source-control:show');
  const scRows = () => [...document.querySelectorAll('.sc-row .sc-name')].map((e) => e.textContent).sort();
  out.sourceControl = await until(() => document.querySelector('.sc-folder')?.value === beta && scRows().length === 2 && { folder: document.querySelector('.sc-folder').value.split('/').pop(), rows: scRows(), pickerShown: !document.querySelector('.sc-folder').hidden });

  // --- remove the folder -------------------------------------------------------------------
  app.sidebar.show('tree-view');
  await app.commands.run('project:remove-folder', { path: beta });
  out.removed = { folders: names(), rel: ws.relativePath(`${alpha}/src/app.js`), title: document.title };
  out.treeAfterRemove = !!(await until(() => treeRoots().length === 0 && treeRow(`${alpha}/main.txt`) && !treeRow(`${beta}/readme.md`)));
  out.folderForRemoved = ws.folderFor(`${beta}/lib/util.py`);
  out.gitAfterRemove = !!(await until(() => git.statuses().get(`${beta}/readme.md`) == null));

  // --- an untrusted folder: asked about, then Restricted Mode for it only ------------------
  out.restrictedBefore = statusTexts().some((t) => /Restricted Mode/.test(t));
  await T.answers('openFolder', gamma);
  await T.answers('confirm', 2); // "Restricted Mode"
  await app.commands.run('project:add-folder');
  await until(() => ws.folders.length === 2);
  out.gammaTrusted = app.trust.isTrusted(gamma);
  out.alphaStillTrusted = app.trust.isTrusted(alpha);
  out.restrictedAfter = !!(await until(() => statusTexts().some((t) => /Restricted Mode/.test(t))));
  out.restrictedTooltip = document.querySelector('[data-id="restricted-mode"]')?.title;
  window.dispatchEvent(new Event('focus'));
  await sleep(1200);
  out.noGitInGamma = git.rootFor(`${gamma}/g.txt`) === null && git.statuses().get(`${gamma}/g.txt`) == null;

  // --- the same folder again, under its own name or through a link: refused, and said so ------
  const shown = new Set(document.querySelectorAll('#notifications .notification'));
  const fresh = () => [...document.querySelectorAll('#notifications .notification')].filter((n) => !shown.has(n))
    .map((n) => [n.querySelector('.notification-title'), n.querySelector('.notification-detail')].filter(Boolean).map((e) => e.textContent.split(`${base}/`).join('')).join(' | '));
  const twice = await app.addFolder(`${alpha}/`);
  const viaLink = await app.addFolder(`${base}/alpha-link`);
  await T.answers('openFolder', `${base}/alpha-link`);
  await app.commands.run('project:add-folder');
  await until(() => fresh().length === 3);
  out.duplicate = {
    added: [twice, viaLink], folders: names(), treeRoots: treeRoots(), watched: [...ws.watched.keys()].map((f) => f.split('/').pop()),
    notes: fresh(),
  };

  // --- back in, and saved with the session -------------------------------------------------
  await app.addFolder(beta);
  await until(() => ws.folders.length === 3);
  await ws.open(`${beta}/lib/util.py`);
  await sleep(300);
  app.saveSession(); await app.persistState();
  out.saved = names();
  out.sessionFolders = app.state.sessions?.[alpha]?.folders?.map((f) => f.split('/').pop());
  out.finalTitle = document.title;
  out.errors = errors;
  return out;
})()
