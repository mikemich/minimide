// Import from VS Code: reads a fake VS Code folder (MINIMIDE_VSCODE_DIR), shows a preview with
// checkboxes and changes nothing until Import is pressed. Covers settings, an extension theme (with
// an include and faint comments), keybindings (including an unbound default, an unknown command,
// one with arguments and one that clashes with the user's own key), snippets that collide with the
// user's own file, importing twice, and a keymap.json with a syntax error.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide;
  const fsx = window.native.fs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const home = app.userInfo.dir;
  const read = (p) => fsx.read(p).catch(() => null);
  const view = () => document.querySelector('.vi-view');
  const texts = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim());
  const sections = () => texts('.vi-section-title span');
  const entries = () => [...document.querySelectorAll('.vi-entry')].map((e) => ({
    key: e.querySelector('input').dataset.entry, label: e.querySelector('.vi-entry-label').textContent, detail: e.querySelector('.vi-entry-detail').textContent,
    note: e.querySelector('.vi-entry-note')?.textContent || '', checked: e.querySelector('input').checked,
  }));
  const notifications = () => texts('#notifications .notification');
  const open = async () => { app.commands.run('vscode-import:run'); return until(view, 10000); };
  const close = async () => { document.querySelector('.vi-cancel')?.click(); await until(() => !view(), 3000); };

  // The user already has a snippets/javascript.json and a keymap.json with a comment and a key of their own.
  await fsx.write(home + '/snippets/javascript.json', '{ "Mine": { "prefix": "mine", "body": ["mine"] } }\n');
  const ownKeymap = '// my keys\n{\n  // keep me\n  "Alt-Shift-l": "file:save"\n}\n';
  await fsx.write(home + '/keymap.json', ownKeymap);
  await wait(800);
  const fontSizeBefore = app.config.get('editor.fontSize');

  // --- preview ---------------------------------------------------------------
  out.opened = !!(await open());
  await wait(300);
  out.sections = sections();
  const first = entries();
  out.labels = first.map((e) => e.key);
  out.clashUnticked = first.find((e) => e.key.startsWith('keybindings:') && /replaces your own/.test(e.note))?.checked === false;
  out.otherTicked = first.filter((e) => !/replaces your own/.test(e.note)).every((e) => e.checked);
  out.themeDetail = first.find((e) => e.key.startsWith('theme:'))?.detail;
  out.snippetDetails = first.filter((e) => e.key.startsWith('snippets:')).map((e) => `${e.label}|${e.detail}`);
  out.notImported = texts('.vi-skipped p').join(' || ');
  out.skippedSummary = texts('.vi-skipped summary')[0];
  // Nothing has changed yet.
  out.untouchedBefore = {
    fontSize: app.config.get('editor.fontSize') === fontSizeBefore,
    keymap: (await read(home + '/keymap.json')) === ownKeymap,
    noThemePackage: !app.packages.packages.has('vscode-fixture-night'), stickyScrollOn: !app.packages.isDisabled('sticky-scroll'),
    snippetsUntouched: !(await fsx.stat(home + '/snippets/python.json')),
  };

  // Untick one setting, then import.
  const wrap = document.querySelector('[data-entry="settings:editor.wordWrap"]');
  wrap.click();
  await wait(100);
  out.importButton = document.querySelector('.vi-import').textContent;
  document.querySelector('.vi-import').click();
  await until(() => !view(), 8000);
  await wait(1200);

  // --- result ----------------------------------------------------------------
  out.config = {
    fontSize: app.config.get('editor.fontSize'), tabSize: app.config.get('editor.tabSize'), softTabs: app.config.get('editor.softTabs'),
    fontFamily: app.config.get('editor.fontFamily'), softWrap: app.config.get('editor.softWrap'),
  };
  out.wordWrapSkipped = app.config.get('editor.softWrap') !== true;
  out.stickyScrollDisabled = app.packages.isDisabled('sticky-scroll');
  out.theme = { installed: app.packages.packages.has('vscode-fixture-night'), selected: app.config.get('core.theme') };
  const css = (await read(app.userInfo.packagesDir + '/vscode-fixture-night/theme.css')) || '';
  out.themeCss = { hasBackground: /#1b1f2b/i.test(css), hasIncludedSidebar: /#161a24/i.test(css), readable: (() => {
    const hex = (n) => { const m = new RegExp(n + ':\\s*#([0-9a-f]{6})', 'i').exec(css); return m && [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
    const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const [a, b] = [lum(hex('--fg-muted')), lum(hex('--bg'))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05) >= 4.5;
  })() };
  const keymapAfter = (await read(home + '/keymap.json')) || '';
  out.keymap = {
    keepsComments: keymapAfter.startsWith('// my keys\n') && keymapAfter.includes('// keep me'),
    keepsOwnKey: /"Alt-Shift-l": "file:save"/.test(keymapAfter) && !/"Alt-Shift-l": "tab:close"/.test(keymapAfter),
    hasBlock: keymapAfter.includes('--- Imported from VS Code on') && keymapAfter.includes('--- end of import ---'),
    added: /"Alt-Shift-j": "panel:toggle"/.test(keymapAfter),
    removedDefault: /"Mod-s": null/.test(keymapAfter),
    noUnknown: !/doThing|Alt-Shift-q|Alt-Shift-w/.test(keymapAfter),
  };
  const bound = (id) => [...app.keymap.resolved()].filter(([, c]) => c === id).map(([k]) => k);
  out.keymapLive = await until(() => bound('panel:toggle').some((k) => /^(Alt-Shift|Shift-Alt)-j$/.test(k)) && bound('file:save').length === 1, 5000)
    ? 'applied' : `not applied: panel:toggle=${bound('panel:toggle')} file:save=${bound('file:save')}`;
  out.snippetFiles = {
    ownKept: (await read(home + '/snippets/javascript.json')) === '{ "Mine": { "prefix": "mine", "body": ["mine"] } }\n',
    beside: JSON.parse((await read(home + '/snippets/javascript.vscode.code-snippets')) || '{}').Arrow?.scope,
    python: /Main guard/.test((await read(home + '/snippets/python.json')) || ''),
    global: /vstodo/.test((await read(home + '/snippets/global.code-snippets')) || ''),
  };
  const notes = notifications();
  out.notification = notes.find((n) => /Imported from VS Code/.test(n)) || notes.join(' | ');

  // --- importing again offers only what was left out --------------------------
  await open();
  await wait(300);
  out.second = { labels: entries().map((e) => e.key), matching: texts('.vi-note').find((t) => /already match/.test(t)) || null, sections: sections() };
  await close();

  // --- a keymap.json with a syntax error --------------------------------------
  await fsx.write(home + '/keymap.json', 'this is { not json');
  await wait(500);
  await open();
  await wait(300);
  out.brokenKeymap = { problem: texts('.vi-problems p').join(' '), noKeybindingSection: !sections().some((s) => /^Keybindings/.test(s)) };
  await close();
  await fsx.write(home + '/keymap.json', keymapAfter);
  await wait(500);

  out.errors = errors.filter((e) => !/keymap\.json|syntax/i.test(e));
  return out;
})()
