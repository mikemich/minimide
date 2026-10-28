// Smoke test for the browser demo: serves docs/ over plain http, opens /try/ in a hidden Electron
// window (an ordinary web page: no preload, no mide:// protocol) and checks that the editor starts
// and its main features answer. Run with `npm run test:web` (builds docs/try first).
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
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
};

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const errors = [];
  // An in-memory session, so localStorage from an earlier run can't leak in.
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { partition: 'web-smoke' } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const fail = (msg) => { console.log(`FAIL  browser demo: ${msg}`); app.exit(1); };
  const timer = setTimeout(() => fail('did not start within 30s'), 30000);
  await win.loadURL(`http://127.0.0.1:${server.address().port}/try/`);
  for (;;) {
    const ready = await win.webContents.executeJavaScript("document.body.classList.contains('ready') && !!window.minimide?.workspace.allItems().length").catch(() => false);
    if (ready) break;
    if (await win.webContents.executeJavaScript("!!document.querySelector('.fatal')").catch(() => false)) return fail(await win.webContents.executeJavaScript("document.querySelector('.fatal').textContent"));
    await new Promise((r) => setTimeout(r, 100));
  }
  clearTimeout(timer);
  const out = await win.webContents.executeJavaScript(CHECKS).catch((err) => ({ error: err.message }));
  const failures = Object.entries(EXPECT).filter(([k, ok]) => !ok(out[k])).map(([k]) => `${k}: got ${JSON.stringify(out[k])}`);
  if (errors.length) failures.push(...errors.map((e) => `console error: ${e}`));
  if (out.error) failures.push(out.error);
  if (failures.length) return fail(`\n  ${failures.join('\n  ')}`);
  console.log(`PASS  browser demo (${out.packages} packages, ${JSON.stringify(out.tabs)})`);
  app.exit(0);
});
