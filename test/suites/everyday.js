// Everyday editing flows over the `ev` fixture: encodings and line endings, odd and huge files,
// undo across saves, find/replace in a file, multiple cursors, comments, auto-indent, external
// changes, live settings and zoom. Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const results = {};
  const root = await until(() => ws.project);
  const T = window.mideTest;
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };
  const read = (p) => window.native.fs.read(root + '/' + p);
  // The bytes of a file as hex, to see exactly what was written.
  const hex = async (p) => { const url = await window.native.fs.readDataUrl(root + '/' + p); return [...atob(url.split(',')[1])].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); };
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } while (ws.panes.length > 1) ws.removePane(ws.panes[ws.panes.length - 1]); };
  const press = (view, key, mods = {}, code) => { view.focus(); return view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: mods.shiftKey && key.length === 1 ? key.toUpperCase() : key, code: code || (key.length === 1 ? 'Key' + key.toUpperCase() : key), keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, ...mods, bubbles: true, cancelable: true })); };
  const type = (view, text) => view.dispatch(view.state.replaceSelection(text));
  const openEd = async (f) => { const ed = await ws.open(root + '/' + f); await until(() => ed.view.hasFocus, 1500); ed.view.focus(); await wait(30); return ed; };
  const sel = (view) => view.state.selection.ranges.map((r) => [r.from, r.to]);

  const statusText = (id) => document.querySelector(`#statusbar .status-item[data-id="${id}"]`)?.textContent.trim();
  const statusFor = async (ed) => { ws.activePane.activate(ed); await wait(250); return { encoding: statusText('encoding'), eol: statusText('eol') }; };

  await step('bom', async () => {
    const ed = await ws.open(root + '/bom.txt');
    const text = ed.getText();
    const status = await statusFor(ed);
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: 'more' } });
    await ws.save(ed);
    return { text: JSON.stringify(text), status, disk: await hex('bom.txt'), eol: ed.document.lineEnding };
  });

  await step('bomJson', async () => {
    const ed = await ws.open(root + '/bom.json');
    ed.view.dispatch({ changes: { from: 0, insert: ' ' } });
    await ws.save(ed);
    return { text: JSON.stringify(ed.getText()), lang: ed.getLanguageName(), disk: await hex('bom.json') };
  });

  await step('latin1', async () => {
    const ed = await ws.open(root + '/latin1.txt');
    const text = ed.getText();
    const status = await statusFor(ed);
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: 'added\n' } });
    await ws.save(ed);
    const kept = await hex('latin1.txt');
    // Typing something Windows-1252 can't hold switches the file to UTF-8 and says so.
    ed.view.dispatch({ changes: { from: 0, insert: '\u2713' } });
    await ws.save(ed);
    return { type: ed.type, text: JSON.stringify(text), status, kept, convertedTo: ed.document.encoding, warned: [...document.querySelectorAll('.notification-title')].some((n) => /now saved as UTF-8/.test(n.textContent)), utf8: await hex('latin1.txt') };
  });

  await step('utf16', async () => {
    const ed = await ws.open(root + '/utf16.txt');
    const text = ed?.getText?.();
    ed.view.dispatch({ changes: { from: ed.view.state.doc.length, insert: 'x' } });
    await ws.save(ed);
    return { type: ed?.type, text: JSON.stringify(text), disk: await hex('utf16.txt') };
  });

  await step('oldMac', async () => {
    const ed = await ws.open(root + '/oldmac.txt');
    const text = ed.getText();
    ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
    const dirty = ed.isDirty();
    ed.view.dispatch({ changes: { from: 0, to: 1 } });
    const dirtyAfterRoundTrip = ed.isDirty();
    const status = await statusFor(ed);
    ed.view.dispatch({ changes: { from: 0, insert: 'Y' } });
    await ws.save(ed);
    // Our own save must not read back as an outside change.
    await wait(1800);
    await ws.syncFromDisk(ed.document);
    return { text: JSON.stringify(text), dirty, dirtyAfterRoundTrip, status, disk: JSON.stringify(await read('oldmac.txt')), cleanAfterSave: !ed.isDirty() };
  });

  await step('mixedEol', async () => {
    const ed = await ws.open(root + '/mixed.txt');
    ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
    await ws.save(ed);
    return { eol: JSON.stringify(ed.document.lineEnding), disk: JSON.stringify(await read('mixed.txt')) };
  });

  await step('unterminated', async () => {
    const ed = await ws.open(root + '/unterminated.txt');
    ed.view.dispatch({ changes: { from: 0, insert: 'X' } });
    await ws.save(ed);
    return JSON.stringify(await read('unterminated.txt'));
  });

  await step('longLine', async () => {
    await window.native.fs.write(root + '/long.txt', 'x'.repeat(400000) + '\nsecond\n');
    const t0 = performance.now();
    const ed = await ws.open(root + '/long.txt');
    const openMs = Math.round(performance.now() - t0);
    ed.view.focus();
    type(ed.view, 'Q');
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) type(ed.view, 'k');
    const typeMs = Math.round(performance.now() - t1);
    return { openMs, typeMs, lines: ed.view.state.doc.lines };
  });

  await step('fiveMb', async () => {
    const line = 'const value = 1234567890; // some text to make the line longer\n';
    await window.native.fs.write(root + '/big.js', line.repeat(Math.ceil(5 * 1024 * 1024 / line.length)));
    const t0 = performance.now();
    const ed = await ws.open(root + '/big.js');
    const openMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    ed.view.dispatch({ changes: { from: 0, insert: 'Y' } });
    const editMs = Math.round(performance.now() - t1);
    const t2 = performance.now();
    await ws.save(ed);
    return { type: ed.type, openMs, editMs, saveMs: Math.round(performance.now() - t2), lines: ed.view.state.doc.lines };
  });

  // Types one character the way the keyboard does: through the editor's input handlers (auto-closing brackets…).
  const typeChar = (view, ch) => {
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' });
    for (const handler of view.state.facet(view.constructor.inputHandler)) if (handler(view, from, to, ch, insert)) return;
    view.dispatch(insert());
  };

  await step('undoAcrossSaves', async () => {
    await closeAll();
    await window.native.fs.write(root + '/undo.txt', 'start\n');
    const ed = await openEd('undo.txt');
    ed.view.dispatch({ selection: { anchor: 0 } });
    type(ed.view, 'A');
    await ws.save(ed);
    const dirtyAfterSave = ed.isDirty();
    await wait(600); // typing within half a second is one undo step
    type(ed.view, 'B');
    await ws.save(ed);
    press(ed.view, 'z', MOD);
    const afterUndo1 = ed.getText();
    const dirty1 = ed.isDirty(); // differs from what was saved last
    press(ed.view, 'z', MOD);
    const afterUndo2 = ed.getText();
    press(ed.view, 'z', { ...MOD, shiftKey: true });
    press(ed.view, 'z', { ...MOD, shiftKey: true });
    return { dirtyAfterSave, afterUndo1, dirty1, afterUndo2, afterRedo: ed.getText(), dirtyBackAtSaved: ed.isDirty(), disk: JSON.stringify(await read('undo.txt')) };
  });

  await step('findReplace', async () => {
    await closeAll();
    await window.native.fs.write(root + '/find.txt', 'alpha beta\nBeta beta gamma\nalphabet\n');
    const ed = await openEd('find.txt');
    press(ed.view, 'f', MOD);
    const panel = await until(() => ed.element.querySelector('.cm-search'));
    if (!panel) return 'no search panel';
    const field = (n) => panel.querySelector(`[name="${n}"]`);
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const toggle = (n, on) => { const c = field(n); if (c.checked !== on) c.click(); };
    const matches = async () => { await wait(120); return ed.element.querySelectorAll('.cm-searchMatch').length; };
    const out = {};
    set(field('search'), 'beta');
    out.insensitive = await matches();
    toggle('case', true);
    out.caseSensitive = await matches();
    toggle('case', false);
    set(field('search'), 'alpha');
    toggle('word', true);
    out.wholeWord = await matches();
    toggle('word', false);
    toggle('re', true);
    set(field('search'), '(al)pha');
    set(field('replace'), '$1PHA');
    await wait(120);
    panel.querySelector('[name="replaceAll"]').click();
    out.replaced = ed.getText();
    press(ed.view, 'z', MOD);
    out.undoneInOneStep = ed.getText() === 'alpha beta\nBeta beta gamma\nalphabet\n';
    press(ed.view, 'Escape');
    return out;
  });

  await step('multiCursor', async () => {
    await closeAll();
    await window.native.fs.write(root + '/multi.txt', 'alpha beta\nBeta beta gamma\nalphabet\n');
    const ed = await openEd('multi.txt');
    ed.view.dispatch({ selection: { anchor: 6, head: 10 } });
    press(ed.view, 'd', MOD);
    const afterNextOccurrence = sel(ed.view);
    type(ed.view, 'Z');
    const typed = ed.getText();
    press(ed.view, 'z', MOD);
    ed.view.dispatch({ selection: { anchor: 0 } });
    press(ed.view, 'ArrowDown', { ...MOD, altKey: true });
    const cursorBelow = sel(ed.view);
    return { afterNextOccurrence, typed, undone: ed.getText() === 'alpha beta\nBeta beta gamma\nalphabet\n', cursorBelow };
  });

  await step('commentToggle', async () => {
    await closeAll();
    const out = {};
    for (const f of ['code.js', 'style.css', 'page.html', 'script.py', 'conf.yml', 'run.sh']) {
      const ed = await openEd(f);
      ed.view.dispatch({ selection: { anchor: 0 } });
      await app.commands.run('editor:toggle-comment');
      const once = ed.view.state.doc.line(1).text;
      await app.commands.run('editor:toggle-comment');
      out[f.replace('.', '_')] = [once, ed.view.state.doc.line(1).text];
    }
    return out;
  });

  await step('autoIndentAndBrackets', async () => {
    await closeAll();
    await window.native.fs.write(root + '/brackets.js', 'if (x) {\n  y();\n}\n');
    const ed = await openEd('brackets.js');
    const out = {};
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(2).to } });
    press(ed.view, 'Enter');
    out.keepsIndent = ed.view.state.doc.line(3).text === '  ';
    ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: '' }, selection: { anchor: 0 } });
    typeChar(ed.view, 'f'); typeChar(ed.view, '(');
    out.paren = ed.getText();
    typeChar(ed.view, ')');
    out.skipsClosing = ed.getText();
    typeChar(ed.view, ' '); typeChar(ed.view, '{');
    out.brace = ed.getText();
    press(ed.view, 'Enter');
    out.blockOnEnter = JSON.stringify(ed.getText());
    typeChar(ed.view, '"');
    out.quote = JSON.stringify(ed.view.state.doc.line(2).text);
    return out;
  });

  await step('previewTabs', async () => {
    await closeAll();
    const a = await ws.open(root + '/plain.txt', { pending: true });
    const b = await ws.open(root + '/code.js', { pending: true });
    const replaced = ws.allItems().map((i) => i.getTitle());
    type(b.view, '// ');
    const pinned = !b.pending;
    await ws.open(root + '/style.css', { pending: true });
    const kept = ws.allItems().map((i) => i.getTitle());
    return { replaced, pinned, kept, firstGone: !ws.allItems().includes(a) };
  });

  await step('closeDirtyAndSave', async () => {
    await closeAll();
    await window.native.fs.write(root + '/closesave.txt', 'start\n');
    const ed = await openEd('closesave.txt');
    ed.view.dispatch({ selection: { anchor: 0 } });
    type(ed.view, 'edit ');
    await T.answers('confirm', 0); // Save
    const closed = await ws.closeItem(ed);
    return { closed, gone: !ws.allItems().includes(ed), disk: JSON.stringify(await read('closesave.txt')) };
  });

  await step('externalChange', async () => {
    await closeAll();
    await window.native.fs.write(root + '/ext-clean.txt', 'one\n');
    await window.native.fs.write(root + '/ext-dirty.txt', 'one\n');
    const clean = await ws.open(root + '/ext-clean.txt');
    await window.native.fs.write(root + '/ext-clean.txt', 'changed outside\n');
    const reloaded = await until(() => clean.getText() === 'changed outside\n', 4000);
    const dirty = await ws.open(root + '/ext-dirty.txt');
    type(dirty.view, 'mine ');
    await window.native.fs.write(root + '/ext-dirty.txt', 'theirs\n');
    const warned = await until(() => [...document.querySelectorAll('.notification-title')].some((n) => /ext-dirty.txt changed on disk/.test(n.textContent)), 4000);
    const keptMine = dirty.getText().startsWith('mine ');
    await app.commands.run('file:revert');
    return { reloaded: !!reloaded, warned: !!warned, keptMine, revertedTo: JSON.stringify(dirty.getText()), dirtyAfterRevert: dirty.isDirty() };
  });

  await step('folderDeleteWithOpenFile', async () => {
    await closeAll();
    await window.native.fs.write(root + '/gonedir/deep/a.txt', 'a\n');
    await wait(500);
    const ed = await ws.open(root + '/gonedir/deep/a.txt');
    await window.native.fs.trash(root + '/gonedir');
    const flagged = await until(() => ed.isDirty() && ed.getTitle().includes('deleted'), 4000);
    await T.answers('confirm', 1); await ws.closeItem(ed);
    return { markedUnsaved: !!flagged };
  });

  await step('folderRenameWithOpenFiles', async () => {
    await closeAll();
    await window.native.fs.write(root + '/dirA/x.txt', 'x\n');
    await window.native.fs.write(root + '/dirA/deep/y.txt', 'y\n');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    await window.native.fs.writeDataUrl(root + '/dirA/pic.png', canvas.toDataURL('image/png'));
    const x = await ws.open(root + '/dirA/x.txt');
    const y = await ws.open(root + '/dirA/deep/y.txt');
    const pic = await ws.open(root + '/dirA/pic.png');
    await window.native.fs.mkdir(root + '/dirB');
    await window.native.fs.rename(root + '/dirA', root + '/dirB/moved');
    ws.renamePath(root + '/dirA', root + '/dirB/moved');
    await wait(600);
    type(x.view, 'edited ');
    await ws.save(x);
    const tabTitle = (item) => ws.panes.find((p) => p.items.includes(item)).tabEls.get(item).title;
    return {
      x: x.getPath().replace(root, ''), y: y.getPath().replace(root, ''), pic: pic.getPath().replace(root, ''), picTab: tabTitle(pic).replace(root, ''),
      saved: JSON.stringify(await read('dirB/moved/x.txt')), oldDirRecreated: !!(await window.native.fs.stat(root + '/dirA')),
      session: JSON.stringify(ws.serialize()).includes('/dirA/') ? 'still has the old path' : 'ok',
    };
  });

  await step('splitAndMoveTab', async () => {
    await closeAll();
    await ws.open(root + '/plain.txt');
    const b = await ws.open(root + '/code.js');
    const right = ws.splitRight(ws.activePane, null);
    const left = ws.panes[0];
    ws.dragging = { item: b, pane: left };
    const evt = new Event('drop'); evt.preventDefault = () => {}; evt.dataTransfer = { getData: () => '' }; evt.clientX = 1; evt.target = right.tabBar;
    right.onDrop(evt);
    await wait(100);
    return { panes: ws.panes.map((p) => p.items.map((i) => i.getTitle())), editorsLive: ws.allItems().every((i) => !i.view || i.view.dom.isConnected) };
  });

  await step('goToLine', async () => {
    await closeAll();
    const ed = await openEd('code.js');
    const jump = async (text) => {
      await app.commands.run('editor:go-to-line');
      const input = await until(() => document.querySelector('.select-list .select-input'));
      input.value = text; input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(200);
      return ed.getCursor().line;
    };
    return { line: await jump(':3'), clamped: await jump(':999') };
  });

  await step('settingsLiveAndZoom', async () => {
    await closeAll();
    const ed = await openEd('code.js');
    const size = () => parseFloat(getComputedStyle(ed.view.contentDOM).fontSize);
    const base = size();
    await app.commands.run('editor:font-increase');
    await wait(150);
    const grew = size() > base;
    await app.commands.run('editor:font-reset');
    await wait(150);
    const reset = size() === base;
    await app.config.set('editor.softWrap', true);
    const wrapOn = ed.view.lineWrapping;
    await app.config.set('editor.softWrap', undefined);
    await app.config.set('editor.showLineNumbers', false);
    await wait(100);
    const gutterOff = !ed.element.querySelector('.cm-lineNumbers');
    await app.config.set('editor.showLineNumbers', undefined);
    await wait(100);
    const gutterBack = !!ed.element.querySelector('.cm-lineNumbers');
    await app.config.set('editor.tabSize', 8);
    await wait(100);
    const tab8 = ed.view.state.tabSize;
    await app.config.set('editor.tabSize', undefined);
    return { grew, reset, wrapOn, gutterOff, gutterBack, tab8 };
  });

  await step('statusBar', async () => {
    await openEd('code.js');
    await wait(250);
    return ['file-path', 'cursor', 'indent', 'eol', 'encoding', 'language'].map((id) => `${id}=${statusText(id)}`);
  });

  results.totalErrors = errors.length;
  return results;
})()
