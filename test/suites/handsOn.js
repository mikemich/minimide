// Hands-on QA pass over the `qa` fixture: saving, closing, odd paths, the runner, markdown XSS,
// project replace, live config/keymap reloads, every theme, every package and every command.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  app.commands.on('error', (id, err) => errors.push(`command ${id}: ${err?.message}`));
  const results = {};
  const root = await until(() => ws.project);
  const T = window.mideTest;
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { const r = await fn(); results[name] = r === undefined ? 'ok' : r; }
    catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 200); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal();
    await wait(60);
  };
  const read = (p) => window.native.fs.read(root + '/' + p);
  const type = (view, text) => view.dispatch(view.state.replaceSelection(text));

  await step('untitledSaveAs', async () => {
    const ed = ws.newFile();
    await wait(50);
    type(ed.view, 'print("hi")\n');
    await T.answers('saveAs', root + '/saved_new.py');
    await ws.save(ed);
    return { content: JSON.stringify(await read('saved_new.py')), title: ed.getTitle(), lang: ed.getLanguageName(), dirty: ed.isDirty() };
  });

  await step('dirtyCloseCancelThenDiscard', async () => {
    const ed = await ws.open(root + '/crlf.txt');
    type(ed.view, 'EDIT ');
    await T.answers('confirm', 2);
    const r1 = await ws.closeItem(ed);
    const stillOpen = ws.allItems().includes(ed);
    await T.answers('confirm', 1);
    const r2 = await ws.closeItem(ed);
    return { cancelKeptOpen: !r1 && stillOpen, discardClosed: r2 && !ws.allItems().includes(ed), fileUnchanged: (await read('crlf.txt')) === 'line one\r\nline two\r\n' };
  });

  await step('crlfPreserved', async () => {
    const ed = await ws.open(root + '/crlf.txt');
    ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
    await ws.save(ed);
    const text = await read('crlf.txt');
    return { crlf: text === 'Xline one\r\nline two\r\n' ? 'preserved' : JSON.stringify(text) };
  });

  await step('unicodePathFinderAndSearch', async () => {
    await app.commands.run('fuzzy-finder:toggle');
    const input = await until(() => document.querySelector('.select-list .select-input'));
    input.value = 'my file ü'; input.dispatchEvent(new Event('input'));
    const first = await until(() => document.querySelector('.select-item'));
    first?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const opened = await until(() => ws.getActiveItem()?.getPath?.()?.endsWith('my file ü.txt'));
    const res = await window.native.project.search(root, 'üñí', {});
    return { opened: !!opened, searchHits: res.results.length };
  });

  await step('runnerQuotedFilename', async () => {
    await ws.open(root + "/it's here.py");
    await app.commands.run('runner:run-file');
    const out = await until(() => [...document.querySelectorAll('.term-instance:not([hidden]) .xterm-rows')].map((e) => e.innerText).join('').includes('quoted ok'), 15000);
    return { ran: !!out };
  });

  await step('binaryFile', async () => {
    const item = await ws.open(root + '/data.bin');
    return { type: item?.type };
  });

  await step('fileDeletedWhileOpen', async () => {
    const ed = await ws.open(root + '/sub/gone.txt');
    await window.native.fs.trash(root + '/sub/gone.txt');
    await wait(700);
    const open = ws.allItems().includes(ed);
    type(ed.view, 'resurrected ');
    const saved = await ws.save(ed);
    return { stillOpen: open, saveRecreates: saved && (await read('sub/gone.txt')).startsWith('resurrected') };
  });

  await step('renameOpenFile', async () => {
    const ed = await ws.open(root + '/replace-me.txt');
    const p = app.commands.run('file:rename');
    const input = await until(() => document.querySelector('.select-list.prompt .select-input'));
    input.value = root + '/renamed/moved.txt';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await p; await wait(500);
    const oldGone = !(await window.native.fs.stat(root + '/replace-me.txt'));
    return { newPath: ed.getPath().replace(root, ''), oldGone, newExists: !!(await window.native.fs.stat(root + '/renamed/moved.txt')), tab: ed.getTitle() };
  });

  await step('markdownXss', async () => {
    window.__xss = undefined;
    await ws.open(root + '/README.md');
    await app.commands.run('markdown-preview:toggle');
    await wait(500);
    const body = document.querySelector('.markdown-body');
    body?.querySelectorAll('a').forEach((a) => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await wait(300);
    return { rendered: !!body, xss: window.__xss ?? 'none', hasScriptTag: !!body?.querySelector('script'), hasOnAttrs: !!body?.querySelector('[onerror],[onclick]') };
  });

  // Files open in an editor are replaced in the buffer (and left unsaved), not on disk.
  await step('replaceAllWithOpenEditor', async () => {
    const ed = await ws.open(root + '/replace-open.txt');
    type(ed.view, 'DIRTY ');
    await app.commands.run('find-in-project:show-replace');
    const q = document.querySelector('.fip-query');
    q.value = 'alpha'; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => document.querySelectorAll('.fip-match').length >= 2);
    document.querySelector('.fip-replace').value = 'OMEGA';
    await T.answers('confirm', 0);
    [...document.querySelectorAll('.fip-replace-row .btn')][0].click();
    await wait(800);
    const renamed = ws.allItems().find((i) => i.getPath?.()?.endsWith('/renamed/moved.txt'));
    return { openEditor: JSON.stringify(ed.getText()), stillDirty: ed.isDirty(), renamedBuffer: JSON.stringify(renamed?.getText?.()), diskOfRenamed: JSON.stringify(await read('renamed/moved.txt')) };
  });

  await step('invalidConfigJson', async () => {
    const file = app.userInfo.dir + '/config.json';
    const original = await window.native.fs.read(file);
    await window.native.fs.write(file, '{ "editor": { "fontSize": 15, } oops');
    await wait(900);
    const notified = [...document.querySelectorAll('.notification-title')].some((n) => /config/i.test(n.textContent));
    await window.native.fs.write(file, original);
    await wait(600);
    return { notified, appAlive: !!document.querySelector('#statusbar') };
  });

  await step('userKeymapUnbind', async () => {
    const file = app.userInfo.dir + '/keymap.json';
    const original = await window.native.fs.read(file);
    await window.native.fs.write(file, '{ "Mod-p": null }');
    await wait(900);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', ...MOD, bubbles: true, cancelable: true }));
    await wait(200);
    const opened = !!document.querySelector('.select-list');
    app.ui.closeModal();
    await window.native.fs.write(file, original);
    await wait(700);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', ...MOD, bubbles: true, cancelable: true }));
    const reopens = !!(await until(() => document.querySelector('.select-list'), 1500));
    return { unboundWorks: !opened, restoredWorks: reopens };
  });

  // Every bundled theme applies its own --bg (read from the theme's stylesheet).
  await step('allThemes', async () => {
    const bad = [];
    const themes = app.packages.themes().filter((p) => p.meta.manifest.theme === 'ui');
    for (const pkg of themes) {
      const name = pkg.meta.name;
      await app.packages.setTheme(name);
      await wait(120);
      const css = (await Promise.all((pkg.meta.manifest.styles || []).map((s) => fetch(pkg.meta.url + s).then((r) => r.text())))).join('\n');
      const want = css.match(/--bg:\s*([^;]+);/)?.[1].trim();
      const got = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const others = app.packages.themes().filter((p) => p.active && p.meta.manifest.theme === 'ui' && p.meta.name !== name).map((p) => p.meta.name);
      if (!pkg.active || got.toLowerCase() !== (want || '').toLowerCase() || others.length) bad.push(`${name}: active=${pkg.active} --bg=${got} want=${want} alsoActive=${others}`);
    }
    await app.packages.setTheme('nightfall');
    return bad.length ? bad : `${themes.length} themes applied`;
  });

  await step('disableEnableEveryPackage', async () => {
    const leaks = [];
    const count = () => ({ status: document.querySelectorAll('#statusbar .status-item').length, styles: document.querySelectorAll('head style, head link[rel=stylesheet]').length, sidebar: document.querySelectorAll('#sidebar .dock-view').length, panel: document.querySelectorAll('#panel .dock-view').length, actions: document.querySelectorAll('.pane-action').length });
    const names = [...app.packages.packages.values()].filter((p) => !p.meta.manifest.theme && p.active).map((p) => p.meta.name);
    for (const n of names) {
      const before = JSON.stringify(count());
      await app.packages.setEnabled(n, false);
      await wait(80);
      await app.packages.setEnabled(n, true);
      await wait(250);
      const after = JSON.stringify(count());
      if (before !== after) leaks.push(`${n}: ${before} -> ${after}`);
      if (!app.packages.packages.get(n).active) leaks.push(`${n}: not active after re-enable`);
    }
    return leaks.length ? leaks : `${names.length} packages cycled cleanly`;
  });

  await step('splitAndCloseLast', async () => {
    while (ws.panes.length > 1) ws.removePane(ws.panes[1]);
    const ed = await ws.open(root + '/crlf.txt');
    ws.splitRight();
    const copy = ws.getActiveItem();
    await ws.closeItem(copy);
    return { panes: ws.panes.length, originalStillOpen: ws.allItems().includes(ed) };
  });

  await step('sessionSerializesImage', async () => {
    await ws.open(root + '/image.png');
    const s = ws.serialize();
    return { hasImage: JSON.stringify(s).includes('image.png') };
  });

  await step('terminalTabs', async () => {
    await app.commands.run('terminal:new'); await wait(400);
    await app.commands.run('terminal:new'); await wait(400);
    await app.commands.run('terminal:new'); await wait(600);
    const before = document.querySelectorAll('.term-tab').length;
    document.querySelectorAll('.term-tab')[1].querySelector('.term-tab-close').click();
    await wait(200);
    const after = document.querySelectorAll('.term-tab').length;
    return { before, after };
  });

  await step('smokeEveryCommand', async () => {
    const skip = /^(window:(close|reload|new|toggle-dev-tools|toggle-full-screen)|file:open|project:open-folder|packages:(create|open-folder|reload|install-from-folder)|app:check-for-updates|help:plugin-docs|settings:open-(config-file|keymap|init-script|stylesheet)|file:reveal-in-finder|tab:close-all|source-control:(push|pull|commit)|runner:(run-file|rerun|run-task)|lsp:restart-servers|terminal:|shell:)/;
    const failed = [];
    const ids = app.commands.list().map((c) => c.id).filter((id) => !skip.test(id));
    for (const id of ids) {
      const before = errors.length;
      const p = Promise.resolve(app.commands.run(id)).catch((e) => errors.push(`${id}: ${e.message}`));
      await wait(70);
      app.ui.closeModal();
      await Promise.race([p, wait(1500)]);
      if (errors.length > before) failed.push(id + ' -> ' + errors.slice(before).join(' | ').slice(0, 160));
    }
    return failed.length ? failed : `${ids.length} commands ran without errors`;
  });

  results.totalErrors = errors.length;
  return results;
})()
