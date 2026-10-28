// Settings sync, the first computer: set up with a pasted token (a fake `gh` that isn't logged in
// means no CLI offer), a rejected token, sign out, set up again, upload to a fake api.github.com
// (test/servers.mjs) and upload again, which updates the same gist and removes a deleted file.
// Also checks the token never appears in any file or in what the page can reach.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide;
  const T = window.mideTest;
  const fsx = window.native.fs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const home = app.userInfo.dir;
  const fixtures = home.replace(/\/[^/]+$/, '');
  const GOOD = 'test-token-1234567890';
  const BAD = 'wrong-token-123456';
  const json = async (p, fallback) => { try { return JSON.parse(await fsx.read(p)); } catch { return fallback; } };
  const store = () => json(fixtures + '/gist-store.json', { gists: {} });
  const requests = () => json(fixtures + '/gist-settingsSync-requests.json', []);
  const notes = () => [...document.querySelectorAll('#notifications .notification')].map((e) => e.textContent.trim());
  const sawNote = (re) => until(() => notes().find((n) => re.test(n)), 8000);
  const clearNotes = () => document.querySelectorAll('#notifications .notification-close').forEach((b) => b.click());
  const run = (id) => app.commands.run(id);
  const paste = async (text) => {
    const input = await until(() => document.querySelector('.select-list.prompt .select-input'), 4000);
    if (!input) return null;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return input;
  };

  // The files on this computer.
  const mine = {
    'config.json': '{\n  // computer one\n  "editor.fontSize": 15\n}\n',
    'keymap.json': '{\n  "Alt-Shift-j": "panel:toggle"\n}\n',
    'styles.css': '/* computer one */\n:root { --accent: #ff7ab2; }\n',
    'init.js': '// computer one\nexport default function () {}\n',
    'snippets/mine.json': '{ "Mine": { "prefix": "mine", "body": ["mine"] } }\n',
    'snippets/extra.json': '{ "Extra": { "prefix": "extra", "body": ["extra"] } }\n',
    'snippets/notes.txt': 'not a snippet file\n',
  };
  for (const [name, text] of Object.entries(mine)) await fsx.write(`${home}/${name}`, text);
  await wait(800);
  clearNotes();

  out.commands = app.commands.list().filter((c) => c.id.startsWith('settings-sync:')).map((c) => `${c.category}: ${c.title}`).sort();

  // --- not set up yet ----------------------------------------------------------
  run('settings-sync:upload');
  out.notSetUp = !!(await sawNote(/Sync isn't set up yet/));
  clearNotes();

  // --- set up with a pasted token (masked), first a rejected one ---------------
  run('settings-sync:set-up');
  const input = await paste('abc');
  out.promptMasked = input?.type === 'password';
  out.shortTokenRefused = !!(await until(() => document.querySelector('.select-list.prompt .prompt-message.error'), 2000));
  await paste(BAD);
  out.readyBad = !!(await sawNote(/Settings sync is ready/));
  clearNotes();
  await T.answers('confirm', 0); // Upload
  run('settings-sync:upload');
  out.badTokenMessage = (await sawNote(/accept the token/)) || notes().join(' | ');
  out.nothingStoredForBadToken = Object.keys((await store()).gists).length === 0;
  clearNotes();

  // --- sign out, then set up with the right token ------------------------------
  await T.answers('confirm', 0); // Sign Out
  run('settings-sync:set-up');
  out.signedOut = !!(await sawNote(/Signed out of settings sync/));
  out.statusAfterSignOut = await window.native.gist.status();
  clearNotes();
  run('settings-sync:set-up');
  await paste(GOOD);
  out.ready = !!(await sawNote(/Settings sync is ready/));
  out.statusAfterSetUp = await window.native.gist.status();
  clearNotes();

  // --- first upload ------------------------------------------------------------
  const before = (await requests()).length;
  await T.answers('confirm', 0);
  run('settings-sync:upload');
  out.uploaded = !!(await sawNote(/Settings uploaded/));
  const gists = Object.values((await store()).gists);
  const gist = gists[0] || { files: {} };
  out.gistCount = gists.length;
  out.private = gist.public === false;
  out.description = gist.description;
  out.uploadedFiles = Object.keys(gist.files).sort();
  out.contentIdentical = ['config.json', 'keymap.json', 'styles.css', 'init.js'].every((n) => gist.files[n] === mine[n]) && gist.files['snippets--mine.json'] === mine['snippets/mine.json'];
  out.manifest = JSON.parse(gist.files['minimide-sync.json'] || '{}').app;
  const first = (await requests()).slice(before);
  out.firstUpload = first.map((r) => `${r.method} ${r.path.replace(/[0-9a-f]{32}/, ':id')}`);
  out.authOnAll = first.length > 0 && first.every((r) => r.token === GOOD);
  out.headers = first.every((r) => /^Minimide\//.test(r.userAgent) && r.apiVersion === '2022-11-28');
  out.state = (await json(home + '/state.json', {})).settingsSync;
  out.stateHasGistId = out.state?.gistId === Object.keys((await store()).gists)[0];
  clearNotes();

  // --- the token is nowhere the page or the user's files can see it --------------
  const all = [];
  const walk = async (dir) => {
    for (const e of await fsx.readdir(dir)) {
      if (e.isDir) { if (!/node_modules|\.git$/.test(e.name)) await walk(e.path); continue; }
      const st = await fsx.stat(e.path);
      if (st && st.size < 2_000_000) all.push([e.path, await fsx.read(e.path).catch(() => '')]);
    }
  };
  await walk(home);
  out.filesScanned = all.length >= 8;
  out.tokenInFiles = all.filter(([, text]) => text.includes(GOOD) || text.includes(BAD)).map(([p]) => p.slice(home.length));
  out.secretsFileExists = all.some(([p]) => p.endsWith('/secrets.json'));
  let storage = '';
  try { storage = JSON.stringify({ ...localStorage }); } catch {}
  out.tokenInPage = document.documentElement.outerHTML.includes(GOOD) || storage.includes(GOOD);
  out.secretsApi = Object.keys(window.native.secrets).sort();
  out.otherSecretRefused = await window.native.secrets.set('anything-else', 'abcdefgh12345').then(() => 'accepted', (e) => /Unknown secret/.test(e.message) ? 'refused' : e.message);
  out.statusHasNoToken = !JSON.stringify(await window.native.gist.status()).includes(GOOD);
  out.tokenInUploadResult = JSON.stringify(await window.native.gist.download()).includes(GOOD);

  // --- upload again: same gist, deleted file removed ---------------------------
  await fsx.write(home + '/keymap.json', '{\n  "Alt-Shift-j": "panel:toggle",\n  "Alt-Shift-k": "sidebar:toggle"\n}\n');
  await fsx.rename(home + '/snippets/extra.json', home + '/extra-moved.txt');
  await wait(500);
  const before2 = (await requests()).length;
  await T.answers('confirm', 0);
  run('settings-sync:upload');
  out.uploadedAgain = !!(await until(async () => (await requests()).slice(before2).some((r) => r.method === 'PATCH'), 8000));
  await wait(300);
  const second = (await requests()).slice(before2);
  out.secondUpload = second.map((r) => `${r.method} ${r.path.replace(/[0-9a-f]{32}/, ':id')}`);
  out.deletedRemotely = second.find((r) => r.method === 'PATCH')?.deleted;
  const after = Object.values((await store()).gists);
  out.stillOneGist = after.length === 1;
  out.updatedKeymap = /Alt-Shift-k/.test(after[0]?.files['keymap.json'] || '');
  out.extraGone = !('snippets--extra.json' in (after[0]?.files || {}));
  out.errors = errors;
  return out;
})()
