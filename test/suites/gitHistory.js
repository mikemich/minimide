// Git history over the `ghproj` fixture (458 commits on master, a merge, a tag, a rename, a stash):
// the history view with its graph, labels, paging, filter and branch picker; a commit's details,
// files and diffs; a file's history across the rename and a version opened read-only; creating a
// branch, revert, cherry-pick, a checkout refused on a dirty tree; stashes; git blame's
// "Show Commit"; and no git at all for a folder nobody trusted.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const root = await until(() => ws.project);
  const results = {};
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };

  // --- helpers ---------------------------------------------------------------------
  const git = async (...args) => (await native.proc.exec('git', args, { cwd: root })).stdout.trim();
  const headSubject = () => git('log', '-1', '--format=%s');
  const hashOf = async (subject, rev = '--all') => git('log', rev, '--fixed-strings', `--grep=${subject}`, '--format=%H', '-1');
  const repoView = () => ws.allItems().find((i) => i.type === 'git-history' && !i.file && i.root === root);
  const fileView = (file) => ws.allItems().find((i) => i.type === 'git-history' && i.file === file);
  const rows = (view) => [...view.element.querySelectorAll('.gh-commits .gh-row')];
  const subjects = (view) => rows(view).map((r) => r.querySelector('.gh-subject').textContent);
  const rowOf = (view, subject) => rows(view).find((r) => r.querySelector('.gh-subject').textContent === subject);
  const settled = (view) => !view.loading && !/Loading/.test(view.status.textContent);
  const details = (view) => view.element.querySelector('.gh-details');
  const detailsOf = async (view, subject) => until(() => details(view)?.querySelector('.gh-message-subject')?.textContent === subject && details(view));
  const files = (view) => [...view.element.querySelectorAll('.gh-file')].map((f) => `${f.querySelector('.gh-status').textContent} ${f.dataset.path} ${f.querySelector('.gh-counts').textContent.trim()}`);
  const pick = async (view, subject) => { const r = rowOf(view, subject); r.click(); return detailsOf(view, subject); };
  const action = (view, id) => view.element.querySelector(`.gh-actions [data-action="${id}"], [data-action="${id}"]`).click();
  const setFilter = async (view, q) => {
    view.filter.value = q;
    view.filter.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(350);
    await until(() => settled(view));
    return subjects(view);
  };
  const side = (el, cls) => {
    const content = el.querySelector(`.${cls} .cm-content`);
    return content ? [...content.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n') : null;
  };
  const notes = () => [...document.querySelectorAll('.notification')].map((n) => n.textContent);
  const clearNotes = () => { for (const n of document.querySelectorAll('.notification')) n.remove(); };
  const answerPrompt = async (text) => {
    const input = await until(() => document.querySelector('.select-list.prompt .select-input'));
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const stashes = async () => (await git('stash', 'list', '--format=%gs')).split('\n').filter(Boolean);
  const clean = async () => { await git('checkout', '--', '.'); await git('clean', '-fdq'); };
  const out = {};

  const app_js = `${root}/src/app.js`;
  const total = Number(await git('rev-list', '--count', 'HEAD'));
  out.total = total;

  // --- the history view: rows, labels, graph, paging -------------------------------------------
  await step('view', async () => {
    await ws.open(app_js);
    await until(() => app.packages.services.get('git-status')?.rootFor?.(app_js));
    await app.commands.run('git-history:show');
    const view = await until(repoView);
    await until(() => rows(view).length);
    const first = rows(view)[0];
    const merge = rowOf(view, "Merge branch 'feature'");
    return {
      title: view.getTitle(),
      firstRows: subjects(view).slice(0, 4),
      count: rows(view).length,
      headRefs: [...first.querySelectorAll('.gh-ref')].map((r) => `${r.textContent}${r.classList.contains('current') ? '*' : ''}`),
      tag: [...merge.querySelectorAll('.gh-ref-tag')].map((r) => r.textContent.replace(/^\S+ /, '')),
      mergeRow: merge.classList.contains('gh-merge'),
      mergeDot: !!merge.querySelector('svg circle.gh-merge-dot'),
      // The merge's second parent opens a second lane: two lines leave the dot.
      graphLanes: rowOf(view, 'Add feature work').querySelector('svg circle').getAttribute('cx') !== first.querySelector('svg circle').getAttribute('cx'),
      cells: [first.querySelector('.gh-author').textContent, /ago|just now/.test(first.querySelector('.gh-date').textContent), first.querySelector('.gh-hash').textContent.length],
      status: view.status.textContent,
    };
  });

  await step('paging', async () => {
    const view = repoView();
    const counts = [rows(view).length];
    for (let i = 0; i < 4 && !view.done; i++) {
      view.list.scrollTop = view.list.scrollHeight;
      view.list.dispatchEvent(new Event('scroll'));
      await until(() => rows(view).length > counts.at(-1) || view.done);
      await until(() => settled(view));
      counts.push(rows(view).length);
    }
    return { counts, done: view.done, status: view.status.textContent, last: subjects(view).at(-1), unique: new Set(rows(view).map((r) => r.dataset.hash)).size };
  });

  // --- filter: message, author, hash; and the branch picker --------------------------------------
  await step('filter', async () => {
    const view = repoView();
    view.list.scrollTop = 0;
    const message = await setFilter(view, 'rename');
    const author = await setFilter(view, 'grace');
    const hash = (await hashOf('Edit old name')).slice(0, 8);
    const byHash = await setFilter(view, hash);
    const none = await setFilter(view, 'zzz-nothing');
    const noneStatus = view.status.textContent;
    const graphWhileFiltering = !!view.element.querySelector('.gh-commits svg');
    await setFilter(view, '');
    return { message, author, byHash, none, noneStatus, graphWhileFiltering, cleared: rows(view).length };
  });

  await step('branches', async () => {
    const view = repoView();
    const options = [...view.branchSelect.options].map((o) => o.textContent);
    const before = !!rowOf(view, 'Add pick.txt');
    view.branchSelect.value = 'all';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => rowOf(view, 'Add pick.txt'));
    const after = !!rowOf(view, 'Add pick.txt');
    const pickRefs = [...(rowOf(view, 'Add pick.txt')?.querySelectorAll('.gh-ref') || [])].map((r) => r.textContent);
    view.branchSelect.value = 'refs/heads/feature';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => settled(view) && rows(view).length && !rowOf(view, 'Final tweak'));
    const feature = subjects(view).slice(0, 2);
    view.branchSelect.value = 'HEAD';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => settled(view) && rowOf(view, 'Final tweak'));
    return { options, before, after, pickRefs, feature };
  });

  // --- a commit's details, files and diffs ------------------------------------------------------
  await step('details', async () => {
    const view = repoView();
    const d = await pick(view, 'Fix the widget');
    const meta = [...d.querySelectorAll('.gh-meta-key')].map((k) => k.textContent);
    const body = d.querySelector('.gh-message-body')?.textContent;
    const author = d.querySelector('.gh-person')?.textContent;
    const fixFiles = files(view);
    const merge = await pick(view, "Merge branch 'feature'");
    const parents = [...merge.querySelectorAll('.gh-parent')].map((a) => a.textContent);
    const mergeFiles = files(view);
    const refs = [...merge.querySelectorAll('.gh-meta .gh-ref')].map((r) => r.textContent.replace(/^\S+ /, ''));
    // A parent link selects that commit.
    merge.querySelectorAll('.gh-parent')[1].click();
    const parentShown = !!(await detailsOf(view, 'Add feature work'));
    const selected = view.element.querySelector('.gh-row.selected .gh-subject')?.textContent;
    await pick(view, 'Rename old-name.js to app.js');
    const renameFiles = files(view);
    const head = view.element.querySelector('.gh-files-head').textContent;
    return { meta, body, author, fixFiles, parents: parents.length, mergeFiles, refs, parentShown, selected, renameFiles, head };
  });

  await step('fileDiff', async () => {
    const view = repoView();
    await pick(view, 'Rename old-name.js to app.js');
    view.element.querySelector('.gh-file[data-path="src/app.js"]').click();
    const item = await until(() => ws.allItems().find((i) => i.type === 'git-commit-diff'));
    await until(() => item.element.querySelector('.cm-mergeView .cm-merge-b .cm-content'));
    const left = side(item.element, 'cm-merge-a');
    const right = side(item.element, 'cm-merge-b');
    const r = {
      title: item.getTitle(),
      path: item.element.querySelector('.gh-diff-path').textContent,
      leftHasOld: /line1 = 'older'/.test(left), rightHasNew: /line1 = 'app'/.test(right), leftNotNew: !/'app'/.test(left),
      readOnly: [...item.element.querySelectorAll('.cm-editor')].every((e) => e.querySelector('.cm-content').getAttribute('contenteditable') === 'false'),
    };
    await ws.closeItem(item);
    return r;
  });

  // --- a file's history, across the rename ------------------------------------------------------
  await step('fileHistory', async () => {
    const ed = await ws.open(app_js);
    await T.answers('menu', 'git-history:file-history');
    const coords = ed.view.coordsAtPos(2);
    ed.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: coords.left + 1, clientY: (coords.top + coords.bottom) / 2 }));
    const view = await until(() => fileView('src/app.js'));
    const menu = ((await T.menus()).shown[0] || []).map((i) => i.label).filter(Boolean);
    await until(() => view.done && rows(view).length);
    // The newest change is selected and shown.
    await until(() => view.element.querySelector('.gh-file-diff .cm-merge-b .cm-content'));
    const firstRight = side(view.element, 'cm-merge-b');
    const renamedBadge = !!rowOf(view, 'Rename old-name.js to app.js')?.querySelector('.gh-renamed');
    rowOf(view, 'Initial commit').click();
    await until(() => /Initial commit/.test(view.element.querySelector('.gh-file-commit-subject')?.textContent || '') && view.element.querySelector('.gh-file-diff .cm-mergeView'));
    const initialRight = side(view.element, 'cm-merge-b');
    const initialLeft = side(view.element, 'cm-merge-a');
    view.element.querySelector('[data-action="open-version"]').click();
    const version = await until(() => ws.allItems().find((i) => i.type === 'git-version'));
    await until(() => version.view);
    const r = {
      menuHasEntry: menu.includes('Git: File History'),
      title: view.getTitle(), rows: subjects(view), renamedBadge,
      firstRight: /line1 = 'tuned'/.test(firstRight),
      initialLeft: initialLeft === '', initialRight: /line1 = 'old'/.test(initialRight),
      version: { title: version.getTitle(), text: version.view.state.doc.line(1).text, readOnly: version.view.state.readOnly, notEditable: version.view.contentDOM.getAttribute('contenteditable') === 'false' },
    };
    await ws.closeItem(version);
    return r;
  });

  // The tree's right-click menu offers it too.
  await step('treeMenu', async () => {
    app.sidebar.show('tree-view');
    const row = await until(() => [...document.querySelectorAll('.tree-view .tree-row, .tree-row')].find((r) => r.textContent.trim() === 'README.md'));
    if (!row) return 'no tree row';
    await T.answers('menu', null);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await wait(300);
    return ((await T.menus()).shown.at(-1) || []).map((i) => i.label).includes('Git: File History');
  });

  // --- actions ------------------------------------------------------------------------------
  await step('createBranch', async () => {
    const view = repoView();
    await ws.openItem(view);
    await pick(view, 'Edit old name');
    action(view, 'branch');
    await answerPrompt('from-history');
    const at = await until(() => git('rev-parse', '--verify', '--quiet', 'from-history'));
    return { created: at === await hashOf('Edit old name'), stillOnMaster: await git('symbolic-ref', '--short', 'HEAD') };
  });

  await step('revert', async () => {
    const view = repoView();
    await pick(view, 'Final tweak');
    await T.answers('confirm', 1); // Cancel
    action(view, 'revert');
    await wait(800);
    const afterCancel = await headSubject();
    await T.answers('confirm', 0); // Revert
    action(view, 'revert');
    const head = await until(async () => { const s = await headSubject(); return s !== 'Final tweak' && s; });
    await until(() => rows(view)[0]?.querySelector('.gh-subject').textContent === head);
    return { afterCancel, head, listed: subjects(view)[0], notes: await git('show', 'HEAD:notes.txt') };
  });

  await step('cherryPick', async () => {
    const view = repoView();
    view.branchSelect.value = 'all';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => rowOf(view, 'Add pick.txt'));
    await pick(view, 'Add pick.txt');
    await T.answers('confirm', 0);
    action(view, 'cherry');
    const head = await until(async () => { const s = await headSubject(); return s === 'Add pick.txt' && s; });
    const picked = await native.fs.read(`${root}/pick.txt`).catch(() => null);
    // Picking it again stops (its change is already there): git's own words, and an Abort button.
    clearNotes();
    await pick(view, 'Add pick.txt');
    await T.answers('confirm', 0);
    action(view, 'cherry');
    const error = await until(() => [...document.querySelectorAll('.notification.error')].find((n) => /git cherry-pick failed/.test(n.textContent)));
    const errorText = error?.querySelector('.notification-detail')?.textContent || '';
    const abort = error && [...error.querySelectorAll('.btn')].find((b) => b.textContent === 'Abort Cherry-Pick');
    abort?.click();
    const aborted = !!(await until(async () => (await native.proc.exec('git', ['rev-parse', '--quiet', '--verify', 'CHERRY_PICK_HEAD'], { cwd: root })).code !== 0));
    view.branchSelect.value = 'HEAD';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => settled(view) && rows(view).length);
    return { head, picked, onMaster: await git('symbolic-ref', '--short', 'HEAD'), again: { gitSays: errorText.length > 10 && !/^git exited/.test(errorText), abortOffered: !!abort, aborted, head: await headSubject() } };
  });

  await step('checkout', async () => {
    const view = repoView();
    clearNotes();
    await native.fs.write(`${root}/README.md`, '# History\n\nDirty!\n');
    await pick(view, 'Edit old name');
    action(view, 'checkout');
    const refused = await until(() => notes().find((n) => /Checkout refused/.test(n)));
    const stillOnMaster = await git('symbolic-ref', '--short', 'HEAD');
    await clean();
    await T.answers('confirm', 0);
    action(view, 'checkout');
    const target = await hashOf('Edit old name');
    const detached = await until(async () => (await git('rev-parse', 'HEAD')) === target);
    const symbolic = (await native.proc.exec('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root })).code;
    await git('checkout', '-q', 'master');
    await app.packages.services.get('git-status')?.refresh?.();
    return { refused: !!refused, mentionsFile: /README\.md/.test(refused || ''), stillOnMaster, detached: !!detached, symbolic };
  });

  // --- stashes --------------------------------------------------------------------------------
  await step('stashes', async () => {
    const view = repoView();
    view.reload();
    const stashRows = () => [...view.element.querySelectorAll('.gh-stash-row')];
    await until(() => stashRows().length === 1);
    const listed = stashRows().map((r) => r.querySelector('.gh-subject').textContent);
    stashRows()[0].click();
    await until(() => details(view)?.querySelector('.gh-ref-stash'));
    const fixtureFiles = files(view);
    const buttons = [...details(view).querySelectorAll('.gh-actions button')].map((b) => b.textContent);

    // Stash with a message, untracked files included.
    await native.fs.write(`${root}/README.md`, '# History\n\nMaster work.\nmine\n');
    await native.fs.write(`${root}/scratch.txt`, 'scratch\n');
    await T.answers('confirm', 1); // "Stash Including Untracked"
    const run = app.commands.run('git-history:stash');
    await answerPrompt('test stash');
    await run;
    await until(async () => (await stashes()).length === 2);
    const afterStash = { list: await stashes(), readme: await native.fs.read(`${root}/README.md`), scratchGone: !(await native.fs.stat(`${root}/scratch.txt`)) };
    await until(() => stashRows().length === 2);
    stashRows()[0].click();
    await until(() => details(view)?.querySelector('.gh-message-subject')?.textContent === 'On master: test stash' && files(view).length === 2);
    const newFiles = files(view);

    // Apply keeps the stash; pop removes it.
    action(view, 'apply');
    const applied = await until(async () => /mine/.test(await native.fs.read(`${root}/README.md`)) && !!(await native.fs.stat(`${root}/scratch.txt`)));
    const afterApply = (await stashes()).length;
    await clean();
    stashRows()[0].click();
    await until(() => details(view)?.querySelector('.gh-message-subject')?.textContent === 'On master: test stash');
    action(view, 'pop');
    await until(async () => (await stashes()).length === 1);
    const popped = /mine/.test(await native.fs.read(`${root}/README.md`));
    await clean();

    // Drop asks first.
    await until(() => stashRows().length === 1);
    stashRows()[0].click();
    await until(() => details(view)?.querySelector('.gh-message-subject')?.textContent === 'On master: fixture stash');
    await T.answers('confirm', 1);
    action(view, 'drop');
    await wait(600);
    const keptOnCancel = (await stashes()).length;
    await T.answers('confirm', 0);
    action(view, 'drop');
    await until(async () => (await stashes()).length === 0);
    await until(() => stashRows().length === 0);
    return { listed, fixtureFiles, buttons, afterStash, newFiles, applied: !!applied, afterApply, popped, keptOnCancel, left: (await stashes()).length, rowsLeft: stashRows().length };
  });

  // --- git blame → Show Commit -------------------------------------------------------------------
  await step('blame', async () => {
    const view = repoView();
    const tuned = await hashOf('Tune app name');
    await app.commands.run('git-history:show-commit', { hash: (await hashOf('Edit old name')).slice(0, 9), path: app_js });
    const direct = await until(() => details(view)?.querySelector('.gh-message-subject')?.textContent === 'Edit old name' && view.element.querySelector('.gh-row.selected')?.dataset.hash);
    clearNotes();
    const ed = await ws.open(app_js);
    ed.view.dispatch({ selection: { anchor: 0 } });
    await app.commands.run('git-blame:show-line');
    const button = await until(() => [...document.querySelectorAll('.notification .btn')].find((b) => b.textContent === 'Show Commit'));
    button?.click();
    const shown = await until(() => details(repoView())?.querySelector('.gh-message-subject')?.textContent === 'Tune app name');
    return { direct: direct === (await hashOf('Edit old name')), button: !!button, shown: !!shown, selected: repoView().element.querySelector('.gh-row.selected')?.dataset.hash === tuned };
  });

  // --- a folder nobody trusted: no git at all ------------------------------------------------------
  await step('untrusted', async () => {
    const other = root.replace(/\/[^/]+$/, '/ghuntrusted');
    await T.answers('openFolder', other);
    await T.answers('confirm', 2); // "Restricted Mode"
    await app.commands.run('project:add-folder');
    await until(() => ws.folders.includes(other));
    const trusted = app.trust.isTrusted(other);
    // test/fixtures.mjs puts a git on PATH that logs the folder of every git command.
    const log = root.replace(/\/[^/]+$/, '/ghshim/calls.log');
    const logged = async () => (await native.fs.read(log).catch(() => '')).split('\n').filter(Boolean);
    clearNotes();
    await ws.open(`${other}/u.txt`);
    await wait(300);
    await app.commands.run('git-history:show');
    await app.commands.run('git-history:file-history-for', `${other}/u.txt`);
    await app.commands.run('git-history:show-commit', { hash: 'HEAD', path: `${other}/u.txt` });
    await app.commands.run('git-history:stash');
    await wait(800);
    window.dispatchEvent(new Event('focus')); // the git and source control packages refresh on focus
    await wait(800);
    const views = ws.allItems().filter((i) => i.type === 'git-history' && i.root?.startsWith(other)).length;
    const all = await logged();
    return {
      trusted, views, restrictedNotice: notes().some((n) => /Restricted Mode/.test(n)),
      shimLogs: all.some((l) => l.startsWith(`${root} `)),
      gitCallsInUntrusted: all.filter((l) => l.startsWith(`${other} `) || l.startsWith(`${other}/`)).length,
      fileMenu: app.commands.isEnabled('git-history:file-history'),
    };
  });

  // Leave the history on screen for the screenshot.
  await step('screenshot', async () => {
    const ed = await ws.open(app_js);
    await wait(100);
    const view = repoView();
    await ws.openItem(view);
    view.branchSelect.value = 'all';
    view.branchSelect.dispatchEvent(new Event('change'));
    await until(() => settled(view) && rowOf(view, "Merge branch 'feature'"));
    await pick(view, "Merge branch 'feature'");
    return !!ed;
  });

  results.out = out;
  results.totalErrors = errors.length;
  return results;
})()
