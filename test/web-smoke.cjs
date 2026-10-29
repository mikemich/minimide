// Smoke test for the browser demo: serves docs/ over plain http, opens /try/ in a hidden Electron
// window (an ordinary web page: no preload, no mide:// protocol) and checks that the editor starts
// and its main features answer. Run with `npm run test:web` (builds docs/try first).
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

// A fake GitHub under /fake (the demo reads ?gh=/fake only when it is served from localhost), so the
// tests never reach the real one. /fake/hits lists the raw files that were requested.
const hits = [];
const TREES = {
  'acme/widgets/trunk': [
    ['README.md', 'blob', 60], ['src', 'tree'], ['src/index.js', 'blob', 40], ['src/my file.js', 'blob', 30], ['src/util', 'tree'], ['src/util/deep.js', 'blob', 30],
    ['docs', 'tree'], ['docs/big.txt', 'blob', 2000000], ['logo.png', 'blob', 100], ['data.bin', 'blob', 20],
  ],
  'acme/widgets/v1': [['README.md', 'blob', 20], ['old.txt', 'blob', 10]],
};
const RAW = {
  'acme/widgets/trunk/README.md': '# Widgets\nA needle in the readme.\n',
  'acme/widgets/trunk/src/index.js': 'export const needle = 1;\n',
  'acme/widgets/trunk/src/my file.js': 'export const spaced = true;\n',
  'acme/widgets/trunk/src/util/deep.js': 'export const deep = "needle";\n',
  'acme/widgets/v1/README.md': '# Widgets v1\n',
};
const HUGE = 20050; // more than the demo lists
const json = (res, status, body, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
function fakeGithub(url, res) {
  const parts = url.pathname.slice('/fake/'.length).split('/').map(decodeURIComponent);
  if (parts[0] === 'hits') return json(res, 200, hits);
  if (parts[0] === 'api') hits.push(`api:${url.pathname}`);
  if (parts[0] === 'raw') {
    const key = parts.slice(1).join('/');
    hits.push(key);
    if (key.startsWith('huge/repo/main/')) return res.writeHead(200).end('a needle\n');
    return key in RAW ? res.writeHead(200, { 'Content-Type': 'text/plain' }).end(RAW[key]) : res.writeHead(404).end();
  }
  const [, , owner, name, kind, , ref] = parts; // api/repos/<owner>/<name>[/git/trees/<ref>]
  const slug = `${owner}/${name}`;
  if (slug === 'limited/repo') return json(res, 403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
  if (slug === 'huge/repo') {
    if (!kind) return json(res, 200, { default_branch: 'main' });
    return json(res, 200, { tree: Array.from({ length: HUGE }, (_, i) => ({ path: `d${i % 50}/f${i}.txt`, type: 'blob', size: 10 })), truncated: true });
  }
  if (slug === 'acme/widgets' && !kind) return json(res, 200, { default_branch: 'trunk' });
  const tree = TREES[`${slug}/${ref}`];
  if (slug !== 'acme/widgets' || !tree) return json(res, 404, { message: 'Not Found' });
  json(res, 200, { sha: 'abc', truncated: false, tree: tree.map(([path, type, size]) => ({ path, type, size, mode: '100644' })) });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/fake/')) return fakeGithub(url, res);
  let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

// Evaluated in the page once it's ready; returns what it found.
const CHECKS = `(async () => {
  const app = window.minimide, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.tabs = app.workspace.allItems().map((i) => i.getTitle());
  out.packages = [...app.packages.packages.values()].filter((p) => p.active).length;
  out.theme = !!document.querySelector('link[href*="theme-nightfall/theme.css"]');
  app.quickOpen.open('>');
  await wait(100);
  const input = document.querySelector('.select-list .select-input');
  input.value = '>select theme'; input.dispatchEvent(new Event('input'));
  await wait(100);
  out.colors = document.querySelector('.select-item .select-label')?.textContent;
  app.ui.closeModal();
  const file = app.workspace.project + '/scratch.txt';
  await window.native.fs.write(file, 'hello');
  out.roundTrip = await window.native.fs.read(file);
  // A file written into a new folder: the tree shows the folder, as with the app's real watcher.
  await window.native.fs.write(app.workspace.project + '/fresh/inside.txt', 'x');
  await wait(500);
  out.newFolderInTree = [...document.querySelectorAll('.tree-name')].some((n) => n.textContent === 'fresh');
  out.search = (await window.native.project.search(app.workspace.project, 'TODO', {})).results.length;
  // Save / Don't Save / Cancel: an HTML dialog, since window.confirm only has two buttons.
  const answer = window.native.dialog.confirm({ message: 'Save?', buttons: ['Save', "Don't Save", 'Cancel'], cancelId: 2 });
  await wait(50);
  document.querySelectorAll('.web-dialog-buttons button')[1]?.click();
  out.dialog = await answer;
  const ed = await app.workspace.open(app.workspace.project + '/src/app.js');
  await wait(300);
  out.highlighted = !!ed.view.contentDOM.querySelector('.tok-keyword');
  // Breadcrumbs work without a language server: symbols from the syntax tree.
  ed.view.dispatch({ selection: { anchor: ed.getText().indexOf('todos.push') } });
  const crumbs = () => [...ed.view.dom.querySelectorAll('.cm-breadcrumbs .cm-crumb')].map((c) => c.textContent).join(' › ');
  for (let i = 0; i < 50 && !crumbs().endsWith('addTodo'); i++) await wait(100);
  out.breadcrumbs = crumbs();
  return out;
})()`;

const EXPECT = {
  tabs: (v) => Array.isArray(v) && v.includes('README.md'),
  packages: (v) => v >= 12,
  theme: (v) => v === true,
  colors: (v) => v === 'Theme: Select Theme…',
  roundTrip: (v) => v === 'hello',
  newFolderInTree: (v) => v === true,
  dialog: (v) => v === 1,
  search: (v) => v >= 1,
  highlighted: (v) => v === true,
  breadcrumbs: (v) => v === 'src › app.js › addTodo',
};

// On a ?repo=acme/widgets page (opened at src/index.js): the file list, lazy loading, search, placeholders, edits.
const REPO_CHECKS = `(async () => {
  const app = window.minimide, n = window.native, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {}, root = app.workspace.project;
  const fakeHits = async () => (await (await fetch('/fake/hits')).json()).filter((h) => h.startsWith('acme/widgets/'));
  out.root = root;
  out.tabs = app.workspace.allItems().map((i) => i.getTitle());
  out.tree = (await n.fs.readdir(root)).map((e) => e.name + (e.isDir ? '/' : '')).sort();
  out.srcTree = (await n.fs.readdir(root + '/src')).map((e) => e.name + (e.isDir ? '/' : '')).sort();
  out.finderFiles = (await app.projectFiles()).sort();
  out.hitsBeforeRead = await fakeHits(); // only the file that was opened: the rest loads on first read
  out.notice = [...document.querySelectorAll('.notification')].map((e) => e.textContent).find((t) => /stay in this tab/.test(t)) || null;
  out.statusItem = !!document.querySelector('.status-item[data-id="github-repo"]');
  out.welcomeCard = !!document.querySelector('.welcome-tips');
  app.quickOpen.open();
  await wait(100);
  const input = document.querySelector('.select-list .select-input');
  input.value = 'deep'; input.dispatchEvent(new Event('input'));
  await wait(150);
  out.finderTop = document.querySelector('.select-item .finder-name')?.textContent;
  app.ui.closeModal();
  out.search = (await n.project.search(root, 'needle', {})).results.map((r) => r.file.slice(root.length + 1)).sort();
  out.deep = await n.fs.read(root + '/src/util/deep.js');
  out.spaced = await n.fs.read(root + '/src/my file.js');
  out.bigNote = (await n.fs.read(root + '/docs/big.txt')).split('\\n')[0];
  out.binNote = (await n.fs.read(root + '/data.bin')).split('\\n')[0];
  out.imageUrl = await n.fs.readDataUrl(root + '/logo.png');
  out.hitsAfter = await fakeHits();
  // Edits stay in memory.
  await n.fs.write(root + '/src/index.js', 'edited');
  out.edited = await n.fs.read(root + '/src/index.js');
  await n.fs.rename(root + '/src/util/deep.js', root + '/src/util/renamed.js');
  out.renamedRead = await n.fs.read(root + '/src/util/renamed.js');
  await wait(600);
  return out;
})()`;

const STORE = "localStorage.getItem('minimide-demo-fs-v1')";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notificationText = "[...document.querySelectorAll('.notification')].map((e) => e.textContent).join(' | ')";

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  // An in-memory session, so localStorage from an earlier run can't leak in.
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { partition: 'web-smoke' } });
  // A 403 or 404 from the fake GitHub is logged by Chromium; that is the point of those visits.
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource/.test(e.message)) errors.push(e.message); });
  const run = (code) => win.webContents.executeJavaScript(code);
  const fail = (msg) => { console.log(`FAIL  browser demo: ${msg}`); app.exit(1); };
  const timer = setTimeout(() => fail('did not finish within 90s'), 90000);

  // Loads a page and waits until it has started and `settled` (a page expression) is true.
  const visit = async (query, settled = 'true') => {
    await win.loadURL(`${base}/try/${query}`);
    for (let i = 0; ; i++) {
      if (await run(`document.body.classList.contains('ready') && (${settled})`).catch(() => false)) return;
      if (await run("!!document.querySelector('.fatal')").catch(() => false)) throw new Error(await run("document.querySelector('.fatal').textContent"));
      if (i > 250) throw new Error(`${query} did not settle`);
      await wait(100);
    }
  };

  try {
    // --- the sample project -------------------------------------------------------------------
    await visit('', '!!window.minimide?.workspace.allItems().length');
    const out = await run(CHECKS);
    out.welcome = await run("!!document.querySelector('.welcome-tips')");
    await wait(600); // the demo saves its files a moment after a change
    const savedSample = await run(STORE);
    const failures = Object.entries(EXPECT).filter(([k, ok]) => !ok(out[k])).map(([k]) => `${k}: got ${JSON.stringify(out[k])}`);
    if (out.welcome !== true) failures.push('the welcome card did not show on the first visit');
    const csp = fs.readFileSync(path.join(ROOT, 'try/index.html'), 'utf8').match(/connect-src ([^;"]*)/)?.[1];
    if (csp !== "'self' https://api.github.com https://raw.githubusercontent.com") failures.push(`connect-src is ${csp}`);

    // --- validation of what the address bar can say ---------------------------------------------
    const gh = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/web/github.js')).href);
    const bad = ['repo=a/b/c', 'repo=../x', 'repo=a/..', 'repo=-a/b', 'repo=a/b?x', 'repo=a%20b/c', 'repo=evil.com%2F@y/z', 'repo=', 'repo=a',
      'repo=acme/widgets&ref=..', 'repo=acme/widgets&ref=a..b', 'repo=acme/widgets&ref=/x', 'repo=acme/widgets&ref=x/', 'repo=acme/widgets&ref=x%0Ay', 'repo=acme/widgets&ref=https://evil.com',
      'repo=acme/widgets&ref=a?b', 'repo=acme/widgets&ref=-x', 'repo=acme/widgets&ref=x.lock', 'repo=acme/widgets&ref=',
      'repo=acme/widgets&path=../../x', 'repo=acme/widgets&path=/etc/passwd', 'repo=acme/widgets&path=a//b', 'repo=acme/widgets&path=a%5Cb', 'repo=acme/widgets&path=a%00b', 'repo=acme/widgets&path=a%23b', 'repo=acme/widgets&path=a%3Fb'];
    const good = ['repo=mikemich/minimide', 'repo=a/b.c_d-e', 'repo=acme/widgets&ref=feature/x-1.2', 'repo=acme/widgets&ref=v1.0.0&path=src/my%20file.js', 'repo=acme/widgets&path=src/index.js'];
    for (const q of bad) if (!gh.readRepoRequest(new URLSearchParams(q))?.error) failures.push(`should be rejected: ?${q}`);
    for (const q of good) if (gh.readRepoRequest(new URLSearchParams(q))?.error) failures.push(`should be accepted: ?${q}`);
    if (gh.readRepoRequest(new URLSearchParams('x=1')) !== null) failures.push('no ?repo should mean the sample');
    for (const [input, want] of [['mikemich/minimide', 'mikemich/minimide'], ['https://github.com/mikemich/minimide.git', 'mikemich/minimide'], ['github.com/a/b/tree/main', 'a/b'], ['nope', null], ['../x', null], ['a b/c', null]]) {
      if (gh.parseRepoInput(input) !== want) failures.push(`parseRepoInput(${input}) = ${gh.parseRepoInput(input)}`);
    }

    // --- a repo -------------------------------------------------------------------------------
    await visit('?repo=acme/widgets&path=src/index.js&gh=/fake', "window.minimide.workspace.allItems().length && document.querySelector('.notification')");
    const repo = await run(REPO_CHECKS);
    const want = {
      root: '/home/you/widgets', tabs: ['index.js'],
      tree: ['README.md', 'data.bin', 'docs/', 'logo.png', 'src/'], srcTree: ['index.js', 'my file.js', 'util/'],
      finderFiles: ['README.md', 'data.bin', 'docs/big.txt', 'logo.png', 'src/index.js', 'src/my file.js', 'src/util/deep.js'],
      hitsBeforeRead: ['acme/widgets/trunk/src/index.js'],
      statusItem: true, welcomeCard: false, finderTop: 'deep.js',
      search: ['README.md', 'src/index.js', 'src/util/deep.js'],
      deep: 'export const deep = "needle";\n', spaced: 'export const spaced = true;\n',
      imageUrl: `${base}/fake/raw/acme/widgets/trunk/logo.png`,
      edited: 'edited', renamedRead: 'export const deep = "needle";\n',
    };
    for (const [k, v] of Object.entries(want)) if (JSON.stringify(repo[k]) !== JSON.stringify(v)) failures.push(`repo ${k}: got ${JSON.stringify(repo[k])}, want ${JSON.stringify(v)}`);
    if (!/^Changes to acme\/widgets stay in this tab/.test(repo.notice || '')) failures.push(`repo notice: ${repo.notice}`);
    if (!/isn't shown.*over 1 MB/.test(repo.bigNote)) failures.push(`big file note: ${repo.bigNote}`);
    if (!/isn't shown.*binary/.test(repo.binNote)) failures.push(`binary file note: ${repo.binNote}`);
    // Only text files were downloaded: not the big one, the picture or the binary.
    if (repo.hitsAfter.some((h) => /big\.txt|logo\.png|data\.bin/.test(h))) failures.push(`downloaded a file it should have skipped: ${repo.hitsAfter}`);
    if (await run(STORE) !== savedSample) failures.push('opening and editing a repo changed the saved sample project');

    // A tag: its own tree and contents.
    await visit('?repo=acme/widgets&ref=v1&gh=/fake', 'window.minimide.workspace.allItems().length');
    const tag = await run(`(async () => ({ tabs: window.minimide.workspace.allItems().map((i) => i.getTitle()), text: await window.native.fs.read(window.minimide.workspace.project + '/README.md'), files: (await window.minimide.projectFiles()).sort() }))()`);
    if (JSON.stringify(tag) !== JSON.stringify({ tabs: ['README.md'], text: '# Widgets v1\n', files: ['README.md', 'old.txt'] })) failures.push(`ref v1: ${JSON.stringify(tag)}`);

    // --- repos that can't be opened: the sample project stays usable ----------------------------------
    const fallbacks = [
      ['?repo=limited/repo&gh=/fake', /60 anonymous requests an hour.*Try again after .*sample project is open instead/s, 'rate limit'],
      ['?repo=nobody/missing&gh=/fake', /nobody\/missing.*private or misspelled/s, 'missing repo'],
      ['?repo=../../etc/passwd&gh=/fake', /owner\/name/, 'invalid repo'],
      ['?repo=acme/widgets&path=../../x&gh=/fake', /file path/, 'invalid path'],
      ['?repo=acme/widgets&ref=..%2Fx&gh=/fake', /branch or tag/, 'invalid ref'],
    ];
    for (const [query, expected, label] of fallbacks) {
      const requests = (await run("fetch('/fake/hits').then((r) => r.json())")).length;
      await visit(query, `window.minimide.workspace.allItems().length && ${notificationText}.includes("open instead")`);
      const info = await run(`({ project: window.minimide.workspace.project, tabs: window.minimide.workspace.allItems().map((i) => i.getTitle()), text: ${notificationText} })`);
      const after = (await run("fetch('/fake/hits').then((r) => r.json())")).slice(requests);
      if (info.project !== '/home/you/hello-minimide' || !info.tabs.includes('README.md')) failures.push(`${label}: the sample project did not open: ${JSON.stringify(info)}`);
      if (!expected.test(info.text)) failures.push(`${label}: message was ${info.text}`);
      if (/^invalid/.test(label) && after.length) failures.push(`${label}: made requests ${after}`);
      if (label === 'rate limit' && after.join() !== 'api:/fake/api/repos/limited/repo') failures.push(`${label}: requests ${after}`);
    }
    if (await run(STORE) !== savedSample) failures.push('the sample project changed while repos were being tried');

    // --- a huge repo: the list is cut off and search downloads a limited number of files ------------------
    await visit('?repo=huge/repo&gh=/fake', "document.querySelector('.notification')");
    const huge = await run(`(async () => {
      const app = window.minimide, root = app.workspace.project;
      const first = await window.native.project.search(root, 'needle', {});
      const second = await window.native.project.search(root, 'needle', {});
      return { files: (await app.projectFiles()).length, text: ${notificationText}, first: first.results.length, firstNotice: first.notice, second: second.results.length,
        downloads: (await (await fetch('/fake/hits')).json()).filter((h) => h.startsWith('huge/repo/')).length };
    })()`);
    if (huge.files !== 20000 || !/more than 20,000 files/.test(huge.text)) failures.push(`huge repo list: ${JSON.stringify(huge)}`);
    if (huge.first !== 300 || !/^Searched 300 of 20,000 files/.test(huge.firstNotice || '') || huge.second !== 600 || huge.downloads !== 600) failures.push(`huge repo search: ${JSON.stringify(huge)}`);

    // --- the sample project, as it was --------------------------------------------------------------
    await visit('', '!!window.minimide?.workspace.allItems().length');
    const back = await run(`(async () => ({ scratch: await window.native.fs.read(window.minimide.workspace.project + '/scratch.txt'), welcome: !!document.querySelector('.welcome-tips') }))()`);
    if (back.scratch !== 'hello') failures.push('the sample project lost its saved files');
    if (back.welcome) failures.push('the welcome card showed again');

    clearTimeout(timer);
    if (errors.length) failures.push(...errors.map((e) => `console error: ${e}`));
    if (out.error) failures.push(out.error);
    if (failures.length) return fail(`\n  ${failures.join('\n  ')}`);
    console.log(`PASS  browser demo (${out.packages} packages, ${JSON.stringify(out.tabs)}; GitHub repos, fallbacks and limits)`);
    app.exit(0);
  } catch (err) {
    fail(err.stack || err.message);
  }
});
