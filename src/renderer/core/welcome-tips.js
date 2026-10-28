// A small card with three things worth knowing, shown the first time the app starts with a project
// open (once per settings folder) and any time from the command box. It's not a modal: ignore it
// and keep working.
import { h, icon } from './dom.js';
import { prettyBinding, isMac } from './keymap.js';
import { showEditorMenu } from './editor-menu.js';

export function bindWelcomeTips(app) {
  let card = null;
  const close = () => { card?.remove(); card = null; };

  // The right-click menu needs code under the cursor: open the README (or any file) if nothing is.
  const rightClick = async () => {
    let editor = app.workspace.getActiveEditor();
    if (!editor) {
      const files = await app.projectFiles();
      const pick = files.find((f) => /^readme/i.test(f)) || files[0];
      if (pick) editor = await app.workspace.open(`${app.workspace.project}/${pick}`);
    }
    if (!editor?.view) return app.ui.notify.info('Open a file first, then right-click in it');
    editor.view.focus();
    showEditorMenu(app);
  };

  function show() {
    close();
    const finder = app.keymap.bindingsFor('fuzzy-finder:toggle')[0];
    const steps = [
      [`Hold ${isMac ? '⌘' : 'Ctrl'} to see every shortcut`, () => app.keyHints.show()],
      [finder ? [h('kbd', prettyBinding(finder)), ' finds anything (type > for commands)'] : 'Find anything from one box (type > for commands)', () => app.quickOpen.open()],
      ['Right-click code for more', rightClick],
    ];
    card = h('div.welcome-tips', { role: 'region', 'aria-label': 'Welcome tips' },
      h('div.welcome-tips-head', h('span', 'Three things to try'),
        h('button.icon-btn', { title: 'Close', onclick: close }, icon('close', 13))),
      steps.map(([text, run], i) => h('div.welcome-tip',
        h('span.welcome-tip-num', String(i + 1)), h('span.welcome-tip-text', text),
        h('button.btn.small', { onclick: run }, 'Try it'))),
      h('div.welcome-tips-foot', h('button.btn.primary.small', { onclick: close }, 'Got it')));
    document.body.append(card);
  }

  // Once per settings folder: the flag lives in the app state, saved with the rest of it.
  function maybeShow() {
    if (app.state.welcomeShown || !app.workspace.project) return;
    app.state.welcomeShown = true;
    app.persistState();
    show();
  }

  app.commands.add('help:welcome-tips', 'Show Welcome Tips', show);
  return { show, close, maybeShow, isShown: () => !!card };
}
