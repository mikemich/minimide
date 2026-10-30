// Core editor behaviour over the `corep` fixture with the `coreh` home: init.js, a user package
// with a chord, save hooks, external reloads, live package disable/enable, hot reload and splits.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const errs = [];
  const oe = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); oe(...a); };
  const app = window.minimide, ws = app.workspace;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const key = (code, key, mods = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...mods }));
  const root = await until(() => ws.project);
  // init.js runs after the project opens; the body gets `ready` once it has.
  await until(() => document.body.classList.contains('ready'));
  const out = {};
  out.helloActivated = window.__hello; out.init = window.__init;
  // chord: Mod-k Mod-h, bound by the user package
  key('KeyK', 'k', MOD); key('KeyH', 'h', MOD); await wait(50);
  out.chord = window.__hi;
  // open + edit + save with whitespace hooks
  await app.config.set('editor.trimTrailingWhitespace', true);
  await app.config.set('editor.ensureFinalNewline', true);
  const ed = await ws.open(root + '/a.txt');
  ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
  out.dirty = ed.isDirty();
  key('KeyS', 's', MOD); await wait(300);
  out.saved = JSON.stringify(await window.native.fs.read(root + '/a.txt'));
  out.dirtyAfter = ed.isDirty();
  // external change reload
  await window.native.fs.write(root + '/a.txt', 'changed outside\n');
  out.reloaded = await until(() => ed.getText() === 'changed outside\n' && ed.getText(), 3000) || ed.getText();
  // disable/enable tree-view live
  await app.packages.setEnabled('tree-view', false);
  out.treeAfterDisable = !!document.querySelector('.tree-view') + '/' + app.commands.has('tree-view:focus');
  await app.packages.setEnabled('tree-view', true);
  out.treeAfterEnable = !!document.querySelector('.tree-view') + '/' + app.commands.has('tree-view:focus');
  // hot reload user package
  await window.native.fs.write(app.userInfo.packagesDir + '/hello/lib.js', "export const greet = () => 'reloaded!';");
  await until(() => window.__hello >= 2, 5000);
  await app.commands.run('hello:hi');
  out.hot = window.__hi + ' activations=' + window.__hello;
  // fuzzy file finder items
  out.files = (await app.projectFiles()).sort().join(',');
  // split + sync
  ws.splitRight();
  const copy = ws.getActiveEditor();
  copy.view.dispatch({ changes: { from: 0, insert: 'SYNC ' } });
  out.synced = ed.getText().startsWith('SYNC ');
  out.items = ws.allItems().length;
  out.errs = errs;
  return out;
})()
