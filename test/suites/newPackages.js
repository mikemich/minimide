// New packages over the `p4` fixture: image viewer, sticky scroll, snippets (Tab expansion,
// completions, user snippets) and the source control panel (stage, diff, commit).
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const errs = [];
  const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); oe(...a); };
  const app = window.minimide, ws = app.workspace;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(100); } return null; };
  const root = await until(() => ws.project);
  const out = {};
  const pk = app.packages.packages;
  out.active = ['image-viewer', 'sticky-scroll', 'snippets', 'source-control'].map((n) => `${n}:${pk.get(n)?.active}${pk.get(n)?.error ? '!' + pk.get(n).error.message : ''}`).join(' ');

  // --- image viewer
  await ws.open(root + '/assets/logo.png');
  out.image = await until(() => document.querySelector('.iv-info')?.textContent.includes('×') && document.querySelector('.iv-info').textContent);
  await app.commands.run('image-viewer:zoom-in');
  out.zoomAfterIn = document.querySelector('.iv-zoom-label')?.textContent;
  const fontBefore = app.config.get('editor.fontSize');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Equal', key: '=', ...MOD, bubbles: true, cancelable: true }));
  await wait(100);
  out.cmdPlusZoomsImageNotFont = document.querySelector('.iv-zoom-label')?.textContent + ' / font ' + (app.config.get('editor.fontSize') === fontBefore ? 'unchanged' : 'CHANGED');
  await ws.open(root + '/assets/dot.svg');
  out.svg = await until(() => [...document.querySelectorAll('.iv-info')].map((e) => e.textContent).find((t) => t.includes('SVG')));

  // --- sticky scroll
  const inv = await ws.open(root + '/inventory.js');
  await wait(300);
  inv.view.scrollDOM.scrollTop = inv.view.lineBlockAt(inv.view.state.doc.line(40).from).top;
  await wait(400);
  out.sticky = [...document.querySelectorAll('.pane.active .editor-item:not([hidden]) .cm-sticky-line')].map((l) => l.textContent.trim().replace(/\s+/g, ' '));

  // --- snippets: Tab expansion + completion list (the TypeScript server, when installed, serves .js)
  const scratch = await ws.open(root + '/new.js');
  await wait(300);
  const v = scratch.view;
  v.dispatch({ changes: { from: v.state.doc.length, insert: '\nlog' }, selection: { anchor: v.state.doc.length + 4 } });
  v.focus();
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  await wait(150);
  out.tabExpanded = JSON.stringify(v.state.doc.toString().split('\n').pop());
  v.dispatch({ changes: { from: v.state.doc.length, insert: '\nfor' }, selection: { anchor: v.state.doc.length + 4 } });
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true }));
  out.completionHasSnippets = (await until(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].filter((li) => li.querySelector('.cm-completionIcon-snippet')).map((li) => li.textContent.slice(0, 30)).join(' | '), 8000));
  // LSP items can arrive a little after the snippet items.
  out.completionHasLsp = !!(await until(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((li) => !li.querySelector('.cm-completionIcon-snippet')), 3000));
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  await window.native.fs.write(app.userInfo.dir + '/snippets.json', '{ "javascript": { "Hello": { "prefix": "hey", "body": "console.log(\\"hey from $TM_FILENAME\\");" } } }');
  await ws.open(app.userInfo.dir + '/snippets.json');
  await ws.save();
  await wait(400);
  await ws.open(root + '/new.js');
  v.dispatch({ changes: { from: v.state.doc.length, insert: '\nhey' }, selection: { anchor: v.state.doc.length + 4 } });
  v.focus();
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  await wait(150);
  out.userSnippet = JSON.stringify(v.state.doc.toString().split('\n').pop());
  ws.getActiveEditor().document.reloadFrom('export const x = 1;\n');
  await ws.save();

  // --- source control
  await app.commands.run('source-control:show');
  const groups = () => [...document.querySelectorAll('.sc-group')].map((g) => g.querySelector('.sc-group-header span').textContent + ': ' + [...g.querySelectorAll('.sc-row')].map((r) => r.querySelector('.sc-code').textContent + ' ' + r.querySelector('.sc-name').textContent).join(', '));
  out.scInitial = await until(() => document.querySelectorAll('.sc-row').length >= 3 && groups());
  out.branch = document.querySelector('.sc-branch')?.textContent;
  // stage notes.md via its + button
  const notesRow = [...document.querySelectorAll('.sc-row')].find((r) => r.textContent.includes('notes.md'));
  notesRow.querySelector('.sc-row-actions button[title="Stage"]').click();
  out.afterStage = await until(() => groups().join(' || ').includes('Staged Changes: M inventory.js, M notes.md') && groups());
  // diff for staged inventory.js
  [...document.querySelectorAll('.sc-row')].find((r) => r.textContent.includes('inventory.js')).click();
  out.diffView = await until(() => { const d = document.querySelector('.sc-diff:not([hidden]) .cm-mergeView'); return d && `side-by-side, changed lines: ${d.querySelectorAll('.cm-changedLine').length}`; });
  document.querySelector('.sc-diff .sc-diff-actions .btn').click(); // toggle layout
  out.inlineDiff = await until(() => document.querySelector('.sc-diff-host .cm-deletedChunk') ? 'inline diff with deleted chunk' : null, 5000);
  // commit staged
  const msg = document.querySelector('.sc-message');
  msg.value = 'Handle missing items; update notes';
  document.querySelector('.sc-commit').click();
  out.commit = await until(() => [...document.querySelectorAll('.notification-title')].map((e) => e.textContent).find((t) => /Committed/.test(t)));
  const log = await window.native.proc.exec('git', ['log', '--oneline', '-n', '2'], { cwd: root });
  out.gitLog = log.stdout.trim().split('\n');
  out.afterCommit = await until(() => !groups().join().includes('Staged') && groups());
  out.errs = errs;
  return out;
})()
