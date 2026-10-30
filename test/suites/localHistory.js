// Local history over the `lhproj` fixture: a version on every save (not when nothing changed), the
// size limit and ignore patterns, the history view with its diff, Restore (one undoable edit) and
// Open, retention by count and age, deleted file recovery, history that follows a rename, and the
// snapshots taken before a revert or a reload from disk.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const MOD = navigator.platform.toLowerCase().includes('mac') ? { metaKey: true } : { ctrlKey: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const root = await until(() => ws.project);
  const hist = app.userInfo.dir + '/history';
  const results = {};
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };

  // --- helpers ---------------------------------------------------------------------
  const histories = async () => {
    let entries = [];
    try { entries = await native.fs.readdir(hist); } catch {}
    const found = [];
    for (const e of entries) {
      if (!e.isDir) continue;
      try { found.push({ dir: e.path, ...JSON.parse(await native.fs.read(e.path + '/index.json')) }); } catch {}
    }
    return found;
  };
  const historyOf = async (p) => (await histories()).find((x) => x.path === p) || null;
  const countOf = async (p) => (await historyOf(p))?.versions.length ?? 0;
  const textsOf = async (p) => {
    const h = await historyOf(p);
    return h ? Promise.all(h.versions.map((v) => native.fs.read(`${h.dir}/${v.file}`))) : [];
  };
  const setText = (ed, text) => ed.view.dispatch({ changes: { from: 0, to: ed.view.state.doc.length, insert: text } });
  const saveWith = async (ed, text) => { setText(ed, text); await ws.save(ed); };
  const bufferOf = (ed) => ed.view.state.doc.toString();
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } };
  const setting = (key, value) => app.config.set(`local-history.${key}`, value);
  const box = () => document.querySelector('.select-list .select-input');
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const historyView = () => ws.allItems().find((i) => i.type === 'local-history');
  // One side of the merge view, as text (the lines of the document joined; a final empty line is the trailing newline).
  const side = (cls) => {
    const content = document.querySelector(`.lh-host .${cls} .cm-content`);
    return content ? [...content.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n') : null;
  };

  const notes = `${root}/notes.txt`;
  const out = {};

  // --- a version on every save ----------------------------------------------------------
  out.saves = await (async () => {
    const ed = await ws.open(notes);
    await saveWith(ed, 'beta\n');
    await until(async () => (await countOf(notes)) === 1);
    await ws.save(ed); // nothing changed since the last version
    await saveWith(ed, 'gamma\n');
    await until(async () => (await countOf(notes)) === 2);
    const h = await historyOf(notes);
    return { contents: await textsOf(notes), labels: h.versions.map((v) => v.label ?? null), sizes: h.versions.map((v) => v.size), shape: Object.keys(h.versions[0]).sort().join(',') };
  })();

  // --- size limit and ignore patterns --------------------------------------------------
  await step('size', async () => {
    await setting('maxFileSizeKB', 1);
    const big = await ws.open(`${root}/big.txt`);
    await saveWith(big, 'x'.repeat(3000) + '\n');
    const small = await ws.open(`${root}/small.txt`);
    await saveWith(small, 'tiny\n');
    const smallKept = !!await until(async () => (await countOf(`${root}/small.txt`)) === 1);
    const r = { bigKept: !!await historyOf(`${root}/big.txt`), smallKept };
    await setting('maxFileSizeKB', undefined);
    await saveWith(big, 'big, but within the limit now\n');
    r.bigKeptAfterRaise = !!await until(async () => (await countOf(`${root}/big.txt`)) === 1);
    return r;
  });
  out.size = results.size;

  await step('ignore', async () => {
    const skipped = {};
    const touch = async (rel) => { const ed = await ws.open(`${root}/${rel}`); await saveWith(ed, `changed ${rel}\n`); return `${root}/${rel}`; };
    const a = await touch('node_modules/dep/index.js');
    const b = await touch('gen.min.js');
    await app.config.set('core.ignoredNames', [...app.config.get('core.ignoredNames'), 'vendorx']);
    const c = await touch('vendorx/lib.txt');
    await setting('ignore', ['*.tmp', 'drafts/*.md']);
    const d = await touch('x.tmp');
    const e = await touch('drafts/a.md');
    const sentinel = await ws.open(`${root}/small.txt`);
    await saveWith(sentinel, 'tiny, again\n');
    const stillKept = !!await until(async () => (await countOf(`${root}/small.txt`)) === 2);
    skipped.nodeModules = !await historyOf(a);
    skipped.minified = !await historyOf(b);
    skipped.coreIgnoredNames = !await historyOf(c);
    skipped.customGlob = !await historyOf(d);
    skipped.slashGlob = !await historyOf(e);
    await setting('ignore', undefined);
    await app.config.set('core.ignoredNames', undefined);
    return { skipped, stillKept };
  });
  out.ignore = results.ignore;
  await closeAll();

  // --- the history view -------------------------------------------------------------------
  await step('viewShow', async () => {
    const ed = await ws.open(notes);
    await app.commands.run('local-history:show');
    const view = await until(historyView);
    const merge = await until(() => document.querySelector('.lh-host .cm-mergeView'));
    await until(() => side('cm-merge-a'));
    const rows = document.querySelectorAll('.lh-row').length;
    const r = {
      opened: !!view, rows, mergeShown: !!merge, title: view?.getTitle(),
      selectedLeft: side('cm-merge-a'), right: side('cm-merge-b'),
      selectedRow: document.querySelector('.lh-row.selected .lh-ago')?.textContent,
      labels: document.querySelector('.lh-toolbar')?.textContent,
    };
    // Asking again focuses the same tab.
    await app.commands.run('local-history:show');
    r.sameInfo = ws.allItems().filter((i) => i.type === 'local-history').length === 1;
    r.editorBufferUntouched = bufferOf(ed) === 'gamma\n';
    return r;
  });
  out.view = results.viewShow;

  // --- compare with previous ----------------------------------------------------------------
  await step('compare', async () => {
    await closeAll();
    await ws.open(notes);
    await app.commands.run('local-history:compare');
    const opened = await until(historyView);
    await until(() => side('cm-merge-a'));
    return { opened: !!opened, selectedLeft: side('cm-merge-a') };
  });
  out.compare = results.compare;

  // --- restore ----------------------------------------------------------------------------------
  await step('restore', async () => {
    const ed = ws.getActiveEditor() || await ws.open(notes);
    await app.commands.run('local-history:show');
    await until(() => document.querySelector('.lh-row.selected'));
    await until(() => side('cm-merge-a'));
    document.querySelector('.lh-actions .btn.primary').click();
    await until(() => bufferOf(ed) === 'beta\n');
    const r = { buffer: bufferOf(ed), dirty: ed.isDirty(), diskUntouched: await native.fs.read(notes) };
    // One edit: undo brings the newer text back.
    ed.view.focus();
    ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ...MOD, bubbles: true, cancelable: true }));
    await until(() => bufferOf(ed) === 'gamma\n');
    r.afterUndo = bufferOf(ed);
    r.diskUntouched = await native.fs.read(notes);

    // Unsaved text in the buffer is kept as a version before it is replaced.
    setText(ed, 'delta\n');
    await app.commands.run('local-history:show');
    await until(() => document.querySelector('.lh-row.selected'));
    document.querySelector('.lh-row:last-child').click(); // the oldest version
    await until(() => document.querySelector('.lh-row.selected:last-child'));
    await until(() => side('cm-merge-a') === 'beta\n' && side('cm-merge-b') === 'delta\n');
    document.querySelector('.lh-actions .btn.primary').click();
    await until(() => bufferOf(ed) === 'beta\n');
    const h = await until(async () => { const x = await historyOf(notes); return x?.versions.some((v) => v.label === 'Before restore') && x; });
    const kept = h.versions.find((v) => v.label === 'Before restore');
    r.unsavedLabel = kept?.label;
    r.unsavedKept = kept ? await native.fs.read(`${h.dir}/${kept.file}`) : null;
    return r;
  });
  out.restore = results.restore;

  await step('quickPick', async () => {
    const ed = ws.getActiveEditor();
    setText(ed, 'zzz\n');
    await app.commands.run('local-history:restore');
    const input = await until(box);
    await until(() => document.querySelector('.select-item .select-label'));
    const first = document.querySelector('.select-item .select-detail')?.textContent;
    enter(input);
    // The newest version is the one that holds the unsaved text from before the restore.
    await until(() => bufferOf(ed) === 'delta\n');
    return { buffer: bufferOf(ed), pickedNewest: !!first };
  });
  out.quickPick = results.quickPick;

  await step('snapshot', async () => {
    await app.commands.run('local-history:show');
    await until(() => document.querySelector('.lh-row.selected'));
    document.querySelector('.lh-row:first-child').click(); // the newest
    const openBtn = [...document.querySelectorAll('.lh-actions .btn')].find((b) => b.textContent === 'Open');
    openBtn.click();
    const item = await until(() => ws.allItems().find((i) => i.type === 'local-history-snapshot'));
    await until(() => item.view);
    return { text: item.view.state.doc.toString(), readOnly: item.view.state.readOnly, title: item.getTitle() };
  });
  out.snapshot = results.snapshot;

  // --- retention ----------------------------------------------------------------------------------
  await step('retention', async () => {
    await closeAll();
    const p = `${root}/prune.txt`;
    await setting('maxVersions', 3);
    const ed = await ws.open(p);
    for (let i = 1; i <= 6; i++) { await saveWith(ed, `v${i}\n`); }
    const settled = async () => { const t = await textsOf(p); return t.length === 3 && t[2] === 'v6\n' && t; };
    await until(settled);
    const h = await historyOf(p);
    const files = (await native.fs.readdir(h.dir)).length;
    return { contents: await textsOf(p), files };
  });
  out.retention = results.retention;

  await step('age', async () => {
    const p = `${root}/prune.txt`;
    const h = await historyOf(p);
    // Make the oldest version 3 days old, then keep 1 day.
    h.versions[0].time -= 3 * 24 * 3600 * 1000;
    const { dir, ...index } = h;
    await native.fs.write(`${dir}/index.json`, JSON.stringify(index));
    await setting('maxAgeDays', 1);
    await setting('maxVersions', undefined);
    await app.commands.run('local-history:clean-up');
    await until(async () => (await countOf(p)) === 2);
    const after = await textsOf(p);
    await setting('maxAgeDays', undefined);
    return { afterClean: after, filesLeft: (await native.fs.readdir(dir)).length };
  });
  out.age = results.age;

  // --- deleted file recovery ---------------------------------------------------------------------
  await step('recover', async () => {
    await closeAll();
    const p = `${root}/gone.txt`;
    const ed = await ws.open(p);
    await saveWith(ed, 'gone v1\n');
    await until(async () => (await countOf(p)) === 1);
    await ws.closeItem(ed);
    await native.fs.trash(p);
    await T.answers('confirm', 0);
    await app.commands.run('local-history:recover-deleted');
    const input = await until(box);
    const label = await until(() => [...document.querySelectorAll('.select-item .select-label')].find((l) => l.textContent === 'gone.txt'));
    const r = { listed: !!label };
    input.value = 'gone'; input.dispatchEvent(new Event('input'));
    await wait(150);
    enter(box());
    // Second pick: which version.
    await until(() => document.querySelector('.select-list input')?.placeholder?.startsWith('Recover gone.txt from'));
    await until(() => document.querySelector('.select-item .select-label'));
    enter(box());
    r.restored = await until(async () => { try { return await native.fs.read(p); } catch { return null; } });
    r.opened = !!await until(() => ws.allItems().some((i) => i.getPath?.() === p));
    return r;
  });
  out.recover = results.recover;

  // --- history follows a rename ----------------------------------------------------------------------
  await step('rename', async () => {
    await closeAll();
    const from = `${root}/ren.txt`, to = `${root}/ren2.txt`;
    const ed = await ws.open(from);
    await saveWith(ed, 'r1\n');
    await until(async () => (await countOf(from)) === 1);
    await native.fs.rename(from, to);
    ws.renamePath(from, to);
    const moved = await until(async () => (await countOf(to)) === 1);
    const r = { fileMoved: moved ? await textsOf(to) : [], oldGone: !await historyOf(from) };

    await closeAll();
    const inner = await ws.open(`${root}/olddir/inner.txt`);
    await saveWith(inner, 'i1\n');
    await until(async () => (await countOf(`${root}/olddir/inner.txt`)) === 1);
    await closeAll();
    await native.fs.rename(`${root}/olddir`, `${root}/newdir`);
    ws.renamePath(`${root}/olddir`, `${root}/newdir`);
    const dirMoved = await until(async () => (await countOf(`${root}/newdir/inner.txt`)) === 1);
    r.folderMoved = dirMoved ? await textsOf(`${root}/newdir/inner.txt`) : [];
    r.folderOldGone = !await historyOf(`${root}/olddir/inner.txt`);
    return r;
  });
  out.rename = results.rename;

  // --- before a reload from disk or a revert --------------------------------------------------------
  await step('reload', async () => {
    await closeAll();
    const p = `${root}/ext.txt`;
    const ed = await ws.open(p);
    await native.fs.write(p, 'changed outside\n');
    await until(() => bufferOf(ed) === 'changed outside\n');
    const diskH = await until(async () => { const h = await historyOf(p); return h?.versions.some((v) => v.label === 'Before reload from disk') && h; });
    const dv = diskH.versions.find((v) => v.label === 'Before reload from disk');
    const disk = { text: bufferOf(ed), label: dv.label, saved: await native.fs.read(`${diskH.dir}/${dv.file}`) };

    setText(ed, 'scratch\n');
    await app.commands.run('file:revert');
    await until(() => bufferOf(ed) === 'changed outside\n');
    const revH = await until(async () => { const h = await historyOf(p); return h?.versions.some((v) => v.label === 'Before revert') && h; });
    const rv = revH.versions.find((v) => v.label === 'Before revert');
    return { disk, revert: { label: rv.label, saved: await native.fs.read(`${revH.dir}/${rv.file}`) } };
  });
  out.reload = results.reload;

  // --- a file with Windows line ends: the versions keep them, and the previous version is still found.
  await step('crlf', async () => {
    await closeAll();
    const p = `${root}/crlf.txt`;
    const ed = await ws.open(p);
    await saveWith(ed, 'one\ntwo\n');
    await until(async () => (await countOf(p)) === 1);
    await saveWith(ed, 'one\ntwo\nthree\n');
    await until(async () => (await countOf(p)) === 2);
    await app.commands.run('local-history:compare');
    await until(() => side('cm-merge-a') || document.querySelector('.lh-empty'));
    return { kept: await textsOf(p), left: side('cm-merge-a'), right: side('cm-merge-b') };
  });
  out.crlf = results.crlf;

  // --- only history can be removed this way --------------------------------------------------------
  await step('guard', async () => {
    let refused = false;
    try { await native.fs.removeHistory(app.userInfo.dir + '/config.json'); } catch { refused = true; }
    // Through a link in history/ that points outside it.
    const outside = app.userInfo.dir.replace(/\/[^/]+$/, '') + '/lh-outside/victim.txt';
    let linkRefused = false;
    try { await native.fs.removeHistory(app.userInfo.dir + '/history/escape/victim.txt'); } catch { linkRefused = true; }
    return { refused, linkRefused, outsideKept: await native.fs.read(outside).catch(() => null) };
  });
  out.guard = results.guard;

  // --- leave the view open for the screenshot ---------------------------------------------------------
  await closeAll();
  await ws.open(notes);
  await app.commands.run('local-history:show');
  await until(() => side('cm-merge-a'));
  await wait(300);

  out.errors = errors;
  out.stepResults = Object.fromEntries(Object.entries(results).filter(([, v]) => typeof v === 'string' || Array.isArray(v)));
  return out;
})()
