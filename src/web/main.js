// Entry point of the browser demo: install the stand-in for Electron's bridge, then start the
// same app the desktop version runs.
import { PROJECT, resetDemo, repo, repoAddress } from './native.js';
import { h } from '../renderer/core/dom.js';
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
  app.commands.add('demo:open-github-repo', 'Open a GitHub Repo…', async () => {
    let address = null;
    const input = await app.ui.prompt({
      title: 'Open a public GitHub repo: owner/name', placeholder: 'mikemich/minimide',
      validate: (text) => ((address = repoAddress(text)) ? '' : 'Type it as owner/name, or paste its github.com address.'),
    });
    if (input != null && address) location.assign(address);
  });
  if (innerWidth < 700) app.sidebar.hide(); // a phone: give the editor the room

  if (repo.active) {
    const url = `https://github.com/${repo.slug}/tree/${repo.ref}`;
    const open = () => window.open(url, '_blank', 'noopener');
    app.statusBar.addItem({ id: 'github-repo', element: h('span', `${repo.slug} @ ${repo.ref}`), align: 'left', priority: 2, tooltip: `Changes to ${repo.slug} stay in this tab. Click to see it on GitHub.`, onClick: open });
    app.ui.notify.info(`Changes to ${repo.slug} stay in this tab`, 'Files load from GitHub as you open them. Edit and search as you like; nothing is saved.', { timeout: 9000, actions: [{ label: 'View on GitHub', run: open }] });
    for (const notice of repo.notices) app.ui.notify.warn(notice, undefined, { timeout: 12000 });
    if (repo.start) await app.workspace.open(repo.start);
    return;
  }
  if (repo.error) app.ui.notify.error("Couldn't open that repo", `${repo.error} The sample project is open instead.`, { timeout: 14000 });
  if (!app.workspace.allItems().length) await app.workspace.open(`${PROJECT}/README.md`);
  app.ui.notify.info('This is Minimide, running in your browser', 'Your edits stay in this browser. Terminals, git and language servers need the desktop app.', {
    timeout: 9000,
    actions: [{ label: 'Download', run: () => window.open('https://github.com/mikemich/minimide/releases/latest', '_blank', 'noopener') }],
  });
});
