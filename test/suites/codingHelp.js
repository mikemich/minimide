// Back / forward after jumps, the editor's right-click menu, shortcuts shown in the menu bar,
// Toggle Comment and the keyboard cheat sheet, over the `chproj` fixture (no language server).
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(60); } return null; };
  while (!ws.project) await sleep(50);
  const out = {};
  const here = () => { const e = ws.getActiveEditor(); return { file: e?.getTitle(), line: e?.getCursor().line }; };
  const jump = (ed, line) => ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(line).from }, userEvent: 'select.pointer' });
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  // --- back / forward ---------------------------------------------------------
  const long = await ws.open(`${ws.project}/long.js`);
  await sleep(800); // a newly opened file's first scroll isn't a jump
  jump(long, 90);
  await app.commands.run('navigate:back'); await sleep(100);
  out.back = here();
  await app.commands.run('navigate:forward'); await sleep(100);
  out.forward = here();
  const before = app.navigation.back.length;
  for (const line of [91, 92, 93, 92]) { jump(long, line); await sleep(20); }
  out.smallMovesNotRecorded = app.navigation.back.length === before;
  jump(long, 90);

  await ws.open(`${ws.project}/notes.txt`);
  await sleep(800);
  await app.commands.run('navigate:back'); await sleep(150);
  out.crossFile = here();
  await app.commands.run('navigate:forward'); await sleep(150);
  out.crossFileForward = here();

  // The default key: ⌃- on macOS, Alt+← elsewhere.
  await ws.open(`${ws.project}/long.js`);
  await sleep(800);
  jump(long, 1);
  long.view.focus();
  key(long.view.contentDOM, isMac ? { key: '-', code: 'Minus', ctrlKey: true } : { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
  await sleep(150);
  out.backKey = here().line;

  // --- right-click menu ---------------------------------------------------------
  const shape = (items) => items.map((i) => (i.type === 'separator' ? '|' : i.role || i.label)).join(',');
  const rightClick = async (ed, line) => {
    const coords = ed.view.coordsAtPos(ed.view.state.doc.line(line).from + 2);
    ed.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: coords.left + 1, clientY: (coords.top + coords.bottom) / 2 }));
    await sleep(250);
  };
  const notes = await ws.open(`${ws.project}/notes.txt`);
  await sleep(200);
  await T.answers('menu', null);
  await rightClick(notes, 2);
  out.txtMenu = shape((await T.menus()).shown[0] || []);

  await ws.open(`${ws.project}/long.js`);
  await sleep(200);
  long.view.dispatch({ selection: { anchor: long.view.state.doc.line(6).from }, scrollIntoView: true });
  long.view.scrollDOM.scrollTop = 0;
  await sleep(100);
  await T.answers('menu', 'editor:toggle-comment');
  await rightClick(long, 3);
  out.menuMovedCursor = long.getCursor().line;
  out.menuRanComment = long.view.state.doc.line(3).text;
  long.view.focus();
  key(long.view.contentDOM, { key: '/', code: 'Slash', ...(isMac ? { metaKey: true } : { ctrlKey: true }) });
  await sleep(100);
  out.modSlash = long.view.state.doc.line(3).text;

  // --- shortcuts shown in the menu bar ----------------------------------------------
  await sleep(500);
  const acc = (await T.menus()).accelerators;
  out.accelerators = { back: acc['navigate:back'], definition: acc['lsp:go-to-definition'], palette: acc['command-palette:toggle'] };

  // --- cheat sheet ----------------------------------------------------------
  await app.commands.run('help:cheat-sheet');
  const sheet = await until(() => document.querySelector('.cheat-sheet'));
  out.cheatSheet = { sections: sheet?.querySelectorAll('.cheat-section').length, hasPeek: /Peek definition/.test(sheet?.innerText || '') };
  key(sheet, { key: 'Escape', code: 'Escape' });
  out.cheatSheet.closedByEscape = !!(await until(() => !document.querySelector('.cheat-sheet')));
  await app.commands.run('help:cheat-sheet');
  const sidebarBefore = app.sidebar.visible;
  const row = [...(await until(() => document.querySelector('.cheat-sheet')))?.querySelectorAll('button.cheat-row') || []].find((b) => /Sidebar/.test(b.innerText));
  row?.click();
  await sleep(200);
  out.cheatSheet.rowRuns = app.sidebar.visible !== sidebarBefore && !document.querySelector('.cheat-sheet');
  if (app.sidebar.visible !== sidebarBefore) app.sidebar.toggle();

  // --- hold ⌘ to see shortcuts ----------------------------------------------
  const hold = isMac ? { key: 'Meta', code: 'MetaLeft', metaKey: true } : { key: 'Control', code: 'ControlLeft', ctrlKey: true };
  const release = () => window.dispatchEvent(new KeyboardEvent('keyup', { key: hold.key, code: hold.code, bubbles: true }));
  await ws.open(`${ws.project}/notes.txt`);
  await ws.open(`${ws.project}/long.js`);
  long.view.focus();
  await sleep(200);
  key(window, hold);
  await sleep(150);
  const early = !!document.querySelector('.key-hints');
  const shown = await until(() => document.querySelector('.key-hints'), 1500);
  const badges = [...(shown?.querySelectorAll('.key-hint') || [])].map((b) => b.textContent);
  const cards = [...(shown?.querySelectorAll('.key-hints-card') || [])].map((c) => c.querySelector('.key-hints-title').textContent + ': ' + [...c.querySelectorAll('.key-hints-row span')].map((x) => x.textContent).join(', '));
  release();
  await sleep(50);
  const tab1 = isMac ? '⌘1' : 'Ctrl+1';
  out.holdCmd = {
    notInstant: !early, shown: !!shown, tabBadges: badges.includes(tab1),
    sidebarBadge: badges.some((b) => /E$/.test(b)), // Files: ⇧⌘E
    cursorCard: cards.find((c) => c.startsWith('At the cursor')) || null,
    anywhereCard: cards.some((c) => c.startsWith('Anywhere') && c.includes('Go to a file')),
    hiddenOnRelease: !document.querySelector('.key-hints'),
  };
  // A quick shortcut never shows them.
  key(window, hold);
  await sleep(100);
  key(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true, ...(isMac ? { metaKey: true } : { ctrlKey: true }) });
  await sleep(600);
  out.holdCmd.notForShortcuts = !document.querySelector('.key-hints');
  release();
  // Not over a dialog: the labels would point at things it covers.
  await app.commands.run('help:cheat-sheet');
  await sleep(150);
  key(window, hold);
  await sleep(650);
  out.holdCmd.notOverDialog = !document.querySelector('.key-hints');
  release();
  app.ui.closeModal();
  await sleep(150);

  // --- one box -------------------------------------------------------------
  const boxInput = () => document.querySelector('.select-list .select-input');
  const typeIn = async (text) => { const i = boxInput(); i.value = text; i.dispatchEvent(new Event('input')); await sleep(120); };
  const labels = () => [...document.querySelectorAll('.select-item .select-label')].map((x) => x.textContent);
  const badgeText = () => document.querySelector('.select-mode')?.textContent;
  out.box = {};
  await ws.open(`${ws.project}/long.js`);
  await sleep(150);
  await app.commands.run('fuzzy-finder:toggle');
  await until(boxInput);
  await until(() => document.activeElement === boxInput()); // typed once the box has focus, like a person
  out.box.filesBadge = badgeText();
  await typeIn('>comment');
  out.box.editorCommandsKept = labels().includes('Editor: Toggle Comment');
  await typeIn('>remove line');
  out.box.removeLine = labels()[0];
  await typeIn('>colors');
  out.box.colors = labels();
  await typeIn('');
  out.box.backToFiles = badgeText();
  await typeIn('?');
  out.box.help = labels();
  await typeIn(':7');
  out.box.line = labels()[0];
  boxInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(200);
  out.box.lineJumped = long.getCursor().line;
  app.quickOpen.open(':'); await until(boxInput);
  await typeIn(':1:0');
  boxInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(200);
  out.box.columnZero = long.getCursor().line;
  await app.commands.run('command-palette:toggle');
  await until(boxInput);
  await sleep(50);
  out.box.paletteOpensOnPrefix = `${boxInput().value}|${badgeText()}`;
  await app.commands.run('command-palette:toggle');
  await sleep(200);
  out.box.sameKeyCloses = !document.querySelector('.select-list');
  long.view.focus();
  key(long.view.contentDOM, { key: 'K', code: 'KeyK', shiftKey: true, ...(isMac ? { metaKey: true } : { ctrlKey: true }) });
  await sleep(100);
  out.box.deleteLineKey = long.view.state.doc.line(7).text;
  return out;
})();
