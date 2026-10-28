// Settings sync, a second computer (runs after settingsSync, against the gist it uploaded). Set up
// through the GitHub CLI (a fake `gh` that prints a token), then download: the preview lists only
// what differs with a diff for each file, changes nothing until Apply, never ticks init.js for you,
// ignores names it doesn't sync (the gist is seeded with some), backs up what it replaces, and lists
// packages that are missing. Finally signs out.
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
  const GH = 'gh-cli-token-abcdef123456';
  const json = async (p, fallback) => { try { return JSON.parse(await fsx.read(p)); } catch { return fallback; } };
  const read = (p) => fsx.read(p).catch(() => null);
  const store = () => json(fixtures + '/gist-store.json', { gists: {} });
  const requests = () => json(fixtures + '/gist-settingsSyncOther-requests.json', []);
  const notes = () => [...document.querySelectorAll('#notifications .notification')].map((e) => e.textContent.trim());
  const sawNote = (re) => until(() => notes().find((n) => re.test(n)), 8000);
  const clearNotes = () => document.querySelectorAll('#notifications .notification-close').forEach((b) => b.click());
  const run = (id) => app.commands.run(id);
  const view = () => document.querySelector('.ss-view');
  const rows = () => [...document.querySelectorAll('.ss-file')].map((r) => ({
    name: r.querySelector('.ss-file-name').textContent, stat: r.querySelector('.ss-file-stat').textContent, warning: r.querySelector('.ss-file-warn')?.textContent || '',
    checked: r.querySelector('input').checked, file: r.querySelector('input').dataset.file,
    diff: [...r.querySelectorAll('.ss-line')].map((l) => l.textContent),
  }));
  const gistFiles = Object.values((await store()).gists)[0].files;

  // This computer's own files: config.json, init.js and the default styles.css differ from the gist, the keymap matches it
  // and snippets/mine.json doesn't exist here yet.
  const mine = {
    'config.json': '{\n  // computer two\n  "editor.fontSize": 11\n}\n',
    'keymap.json': gistFiles['keymap.json'],
    'init.js': '// computer two\nexport default function () {}\n',
  };
  for (const [name, text] of Object.entries(mine)) await fsx.write(`${home}/${name}`, text);
  await wait(800);
  const stylesBefore = await read(home + '/styles.css');
  clearNotes();

  // --- set up through the GitHub CLI ---------------------------------------------
  await T.answers('confirm', 0); // Use GitHub CLI
  run('settings-sync:set-up');
  out.ready = !!(await sawNote(/Settings sync is ready/));
  out.noTokenPrompt = !document.querySelector('.select-list.prompt');
  out.status = await window.native.gist.status();
  clearNotes();

  // --- download: preview first ---------------------------------------------------
  run('settings-sync:download');
  out.previewOpened = !!(await until(view, 8000));
  await wait(200);
  const first = rows();
  out.files = first.map((r) => `${r.name}|${r.stat}|${r.checked ? 'ticked' : 'unticked'}`);
  out.initWarning = first.find((r) => r.name === 'init.js')?.warning;
  out.configDiff = first.find((r) => r.name === 'config.json')?.diff;
  out.newFile = first.find((r) => r.name === 'snippets/mine.json');
  out.stylesDiffRemovesDefault = first.find((r) => r.name === 'styles.css')?.diff.some((l) => /Your personal stylesheet/.test(l) && l.startsWith('−'));
  out.missing = [...document.querySelectorAll('.ss-pkg')].map((e) => e.textContent);
  out.ignored = [...document.querySelectorAll('.ss-note')].map((e) => e.textContent).find((t) => /^Ignored/.test(t)) || null;
  out.untouched = {
    config: (await read(home + '/config.json')) === mine['config.json'],
    init: (await read(home + '/init.js')) === mine['init.js'],
    mineAbsent: !(await fsx.stat(home + '/snippets/mine.json')),
    nothingWrittenOutside: !(await fsx.stat(home + '/evil.js')) && !(await fsx.stat(home + '/escape.json')) && !(await fsx.stat(home + '/x.json')),
  };

  // Untick styles.css; apply the rest that is ticked (config.json).
  document.querySelector('[data-file="styles.css"]').click();
  await wait(100);
  out.applyLabel = document.querySelector('.ss-apply').textContent;
  document.querySelector('.ss-apply').click();
  out.applied = !!(await sawNote(/Settings applied/));
  await until(() => !view(), 3000);
  out.appliedNote = notes().find((n) => /Settings applied/.test(n));
  out.missingNote = notes().find((n) => /missing here/.test(n));
  out.after = {
    configFromGist: (await read(home + '/config.json')) === gistFiles['config.json'],
    initKept: (await read(home + '/init.js')) === mine['init.js'],
    stylesKept: (await read(home + '/styles.css')) === stylesBefore,
    newSnippets: (await read(home + '/snippets/mine.json')) === gistFiles['snippets--mine.json'],
  };
  const backups = (await fsx.readdir(home + '/backups').catch(() => [])).map((e) => e.name);
  out.backupCount = backups.length;
  out.backupConfig = backups.length ? (await read(`${home}/backups/${backups[0]}/config.json`)) === mine['config.json'] : null;
  out.backupHasOnlyReplaced = backups.length ? (await fsx.readdir(`${home}/backups/${backups[0]}`)).map((e) => e.name).join(',') : null;
  clearNotes();

  // --- download again: what is left, init.js ticked by hand ------------------------
  run('settings-sync:download');
  await until(view, 8000);
  await wait(200);
  const second = rows();
  out.secondFiles = second.map((r) => `${r.name}|${r.checked ? 'ticked' : 'unticked'}`);
  document.querySelector('[data-file="init.js"]').click();
  await wait(100);
  document.querySelector('.ss-apply').click();
  await sawNote(/Settings applied/);
  await until(() => !view(), 3000);
  out.final = {
    init: (await read(home + '/init.js')) === gistFiles['init.js'],
    styles: (await read(home + '/styles.css')) === gistFiles['styles.css'],
    initNeedsReload: !!notes().find((n) => /Reload the window for init\.js/.test(n)),
  };
  out.backupsAfterSecond = (await fsx.readdir(home + '/backups').catch(() => [])).length;
  clearNotes();

  // --- everything matches now ---------------------------------------------------
  run('settings-sync:download');
  await until(view, 8000);
  await wait(200);
  out.third = { rows: rows().length, intro: document.querySelector('.ss-intro')?.textContent, missingStill: document.querySelectorAll('.ss-pkg').length };
  document.querySelector('.ss-cancel').click();
  await until(() => !view(), 3000);

  // --- what went over the wire ------------------------------------------------------
  const log = await requests();
  out.requests = [...new Set(log.map((r) => r.method))];
  out.allWithCliToken = log.length > 0 && log.every((r) => r.token === GH);
  out.gistUntouched = JSON.stringify((await store()).gists[Object.keys((await store()).gists)[0]].files['config.json']) === JSON.stringify(gistFiles['config.json']);
  out.tokenInFiles = [];
  for (const name of ['config.json', 'state.json', 'keymap.json']) if ((await read(`${home}/${name}`) || '').includes(GH)) out.tokenInFiles.push(name);

  // --- sign out ------------------------------------------------------------------
  clearNotes();
  await T.answers('confirm', 0);
  run('settings-sync:sign-out');
  out.signedOut = !!(await sawNote(/Signed out of settings sync/));
  out.statusAfterSignOut = await window.native.gist.status();
  out.stateAfterSignOut = (await json(home + '/state.json', {})).settingsSync;
  clearNotes();
  run('settings-sync:download');
  out.downloadAfterSignOut = !!(await sawNote(/Sync isn't set up yet/));
  out.errors = errors;
  return out;
})()
