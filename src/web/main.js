// Entry point of the browser demo: install the stand-in for Electron's bridge, then start the
// same app the desktop version runs.
import { PROJECT, resetDemo } from './native.js';
import '../renderer/app.js';

const app = window.minimide;
const ready = () => new Promise((resolve) => {
  const check = () => (document.body.classList.contains('ready') ? resolve() : setTimeout(check, 50));
  check();
});

ready().then(async () => {
  app.commands.add('demo:reset', 'Reset the Demo', () => {
    resetDemo();
    location.reload();
  });
  if (!app.workspace.allItems().length) await app.workspace.open(`${PROJECT}/README.md`);
  app.ui.notify.info('This is Minimide, running in your browser', 'Your edits stay in this browser. Terminals, git and language servers need the desktop app.', {
    timeout: 9000,
    actions: [{ label: 'Download', run: () => window.open('https://github.com/mikemich/minimide/releases/latest', '_blank', 'noopener') }],
  });
});
