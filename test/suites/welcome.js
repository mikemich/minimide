// The first-launch welcome card: shown once per settings folder, its three "Try it" buttons and
// "Got it", and the command that brings it back. Over the `qa` fixture (a README.md, no file open).
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!ws.project) await sleep(50);
  const out = {};
  const cards = () => document.querySelectorAll('.welcome-tips').length;
  const tryIt = (i) => document.querySelectorAll('.welcome-tip button')[i].click();

  // Test runs skip the card at launch (it would sit over other suites), so this is the first launch.
  out.notAtTestLaunch = cards() === 0 && app.state.welcomeShown === undefined;
  app.welcomeCard.maybeShow();
  out.shown = cards();
  out.flagSet = app.state.welcomeShown === true;
  out.steps = [...document.querySelectorAll('.welcome-tip-text')].map((e) => e.textContent.replace(/^.*(?=finds)/, '… '));
  out.holdKey = document.querySelector('.welcome-tip-text').textContent === `Hold ${isMac ? '⌘' : 'Ctrl'} to see every shortcut`;
  out.notAModal = !document.querySelector('.modal-backdrop');
  await sleep(400);
  out.savedToDisk = (await window.native.state.load()).welcomeShown === true;

  // Try it: 1 shows the shortcut labels.
  tryIt(0);
  await sleep(100);
  out.hintsShown = app.keyHints.isShown() && !!document.querySelector('.key-hints');
  app.keyHints.hide();
  out.hintsHidden = !document.querySelector('.key-hints');

  // Try it: 2 opens the one box.
  tryIt(1);
  await sleep(250);
  out.boxOpen = !!document.querySelector('.select-list .select-input');
  app.ui.closeModal();
  await sleep(100);

  // Try it: 3 opens the editor's menu, opening a file first when nothing is open.
  out.noEditorBefore = !ws.getActiveEditor();
  await T.answers('menu', null);
  tryIt(2);
  let shown = [];
  for (let i = 0; i < 60 && !shown.length; i++) { await sleep(100); shown = (await T.menus()).shown; }
  out.editorOpened = ws.getActiveEditor()?.getTitle();
  out.menu = (shown[0] || []).map((it) => it.label || it.role || it.type);

  // Got it closes the card, and it doesn't come back by itself.
  document.querySelector('.welcome-tips-foot button').click();
  out.closed = cards() === 0;
  app.welcomeCard.maybeShow();
  out.notAgain = cards() === 0;
  // A new start reads the state from disk: still seen.
  app.state = await window.native.state.load();
  app.welcomeCard.maybeShow();
  out.notAfterReload = cards() === 0;

  // Show Welcome Tips brings it back, once, and the close button works.
  await app.commands.run('help:welcome-tips');
  await app.commands.run('help:welcome-tips');
  out.commandShows = cards();
  out.inPalette = app.commands.list().some((c) => c.title === 'Show Welcome Tips');
  document.querySelector('.welcome-tips-head button').click();
  out.closeButton = cards() === 0;
  return out;
})()
