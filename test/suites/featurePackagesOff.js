// Off really means off, over the `fpoproj` fixture (a repository in the middle of a merge). Each of
// git-history, bookmarks, merge-conflicts, local-history, outline, breadcrumbs, inlay-hints and task-problems is
// turned off and on again. Off: its commands are gone from the palette and from the editor, tab and
// tree menus, its keys do nothing, its gutters, decorations, status items, views and tabs are gone
// from what's open, and the packages around it still work. On again: all of it is back. It starts with
// the settings that switched breadcrumbs and inlay hints before they were packages of their own.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const root = await until(() => ws.project);
  const out = {};
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { out[name] = await fn(); } catch (e) { out[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) out[name] = [out[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };

  // --- helpers ---------------------------------------------------------------------
  const file = (n) => `${root}/${n}`;
  const pkg = (n) => app.packages.packages.get(n);
  const editor = async (n) => { const ed = await ws.open(file(n)); await until(() => ed.view); await wait(100); return ed; };
  const lineOf = (ed) => ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number;
  const toLine = (ed, n) => ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(n).from } });
  const fakeLog = async () => JSON.parse(await native.fs.read(`${app.userInfo.dir}/fake-lsp.json`));
  const clearNotes = () => { for (const n of document.querySelectorAll('.notification')) n.remove(); };
  const ofType = (...types) => ws.allItems().filter((i) => types.includes(i.type)).length;

  // What a package adds, by its name: commands registered, commands in the palette, key bindings.
  const ownCommands = (name) => [...app.commands.commands.keys()].filter((id) => id.startsWith(`${name}:`)).length;
  const inPalette = (name) => app.commands.list().filter((c) => c.id.startsWith(`${name}:`)).length;
  const ownKeys = (name) => [...app.keymap.resolved()].filter(([, id]) => id.startsWith(`${name}:`));

  /** Press a binding as the keymap writes it ("Cmd-k Cmd-g", "Alt-Cmd-k", "F7") on `target`. */
  const press = async (binding, target) => {
    for (const part of binding.split(' ')) {
      const mods = part.split('-');
      const key = mods.pop();
      const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key, code, bubbles: true, cancelable: true,
        metaKey: mods.includes('Cmd'), ctrlKey: mods.includes('Ctrl'), altKey: mods.includes('Alt'), shiftKey: mods.includes('Shift'),
      }));
      await wait(40);
    }
    await wait(300);
    if (document.querySelector('.cm-search')) app.commands.run('core:cancel'); // Cmd-g on its own is find next
  };

  // The labels of the menu a right-click on `target` opens.
  const menuLabels = async (target, x, y) => {
    await T.answers('menu', null);
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await wait(300);
    return ((await T.menus()).shown.at(-1) || []).map((i) => i.label).filter(Boolean);
  };
  const editorMenu = async (n) => {
    const ed = await editor(n);
    const c = ed.view.coordsAtPos(0);
    return menuLabels(ed.view.contentDOM, c.left + 1, (c.top + c.bottom) / 2);
  };
  const tabMenu = async (n) => {
    await editor(n);
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.title === file(n));
    return tab ? menuLabels(tab, 5, 5) : ['no tab'];
  };
  const treeMenu = async (n) => {
    app.sidebar.show('tree-view');
    const row = await until(() => [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.trim() === n));
    return row ? menuLabels(row, 10, 10) : ['no row'];
  };

  /**
   * Off and on again, recording each check before, while off and after: { commands, palette, keys,
   * menus: { where: [bool…] }, pressed: [effect…], probe: [state…] }, plus `others` while off.
   */
  const cycle = async (name, { probe, menus = {}, key, others, turnOn }) => {
    const r = { commands: [], palette: [], keys: [], menus: {}, pressed: [], probe: [] };
    const binding = key && ownKeys(name).find(([, id]) => id === key.command)?.[0];
    const snap = async () => {
      r.commands.push(ownCommands(name));
      r.palette.push(inPalette(name));
      r.keys.push(ownKeys(name).length);
      for (const [where, [fn, label]] of Object.entries(menus)) (r.menus[where] ||= []).push((await fn()).includes(label));
      r.probe.push(await probe());
      if (key) {
        if (!binding) { r.pressed.push('no binding'); return; }
        const target = await key.prepare();
        const before = await key.effect();
        await press(binding, target);
        r.pressed.push(await until(async () => (await key.effect()) !== before && 'changed', 1500) || 'nothing');
        await key.undo?.();
      }
    };
    await snap();
    await app.packages.setEnabled(name, false);
    await wait(300);
    r.active = [pkg(name).active];
    await snap();
    if (others) r.others = await others();
    if (turnOn) await turnOn(); else await app.packages.setEnabled(name, true);
    await wait(500);
    r.active.push(pkg(name).active);
    await snap();
    clearNotes();
    return r;
  };

  // --- the old settings ---------------------------------------------------------------------
  await step('migrated', async () => {
    const config = JSON.parse(await native.fs.read(`${app.userInfo.dir}/config.json`));
    const r = {
      breadcrumbs: pkg('breadcrumbs').active, inlayHints: pkg('inlay-hints').active,
      disabled: app.config.get('core.disabledPackages'), enabled: app.config.get('core.enabledPackages'),
      oldSettingsLeft: [config.outline?.breadcrumbs, config.lsp?.inlayHints].filter((v) => v !== undefined).length,
      serversKept: !!config.lsp?.servers?.typescript,
      toggles: app.commands.list().filter((c) => c.id === 'editor:toggle-breadcrumbs' || c.id === 'editor:toggle-inlay-hints').map((c) => c.title),
    };
    // From here on, everything starts switched on.
    await app.commands.run('editor:toggle-breadcrumbs');
    r.breadcrumbsBack = pkg('breadcrumbs').active;
    r.disabledAfter = app.config.get('core.disabledPackages');
    return r;
  });

  const js = await editor('app.js');
  const ts = await editor('shapes.ts');
  const notes = await editor('notes.txt');
  await editor('conflict.txt');
  await until(() => document.querySelector('.lsp-status[data-state="ready"]'), 15000);

  // --- git-history ------------------------------------------------------------------------------
  const blameActions = async () => {
    clearNotes();
    const ed = await editor('app.js');
    toLine(ed, 1);
    await app.commands.run('git-blame:show-line');
    const note = await until(() => document.querySelector('.notification .btn') && document.querySelector('.notification'), 5000);
    const labels = note ? [...note.querySelectorAll('.btn')].map((b) => b.textContent) : [];
    clearNotes();
    return labels;
  };
  await step('git-history', async () => {
    await app.commands.run('git-history:show');
    await editor('app.js');
    await app.commands.run('git-history:file-history');
    await until(() => ofType('git-history') === 2);
    return cycle('git-history', {
      probe: async () => ({ tabs: ofType('git-history', 'git-commit-diff', 'git-version'), blame: await blameActions() }),
      menus: { editor: [() => editorMenu('app.js'), 'Git: File History'], tab: [() => tabMenu('app.js'), 'Git: File History'], tree: [() => treeMenu('app.js'), 'Git: File History'] },
      key: {
        command: 'git-history:show',
        prepare: async () => (await editor('notes.txt')).view.contentDOM,
        effect: () => ws.getActiveItem()?.type,
        undo: () => editor('notes.txt'),
      },
      // The tree's menu still works without it.
      others: async () => ({ treeMenu: (await treeMenu('app.js')).includes('Copy Path') }),
    });
  });

  // --- bookmarks ------------------------------------------------------------------------------
  const stored = () => Object.values(app.packageState('bookmarks').bookmarks || {}).reduce((n, list) => n + list.length, 0);
  await step('bookmarks', async () => {
    const ed = await editor('notes.txt');
    toLine(ed, 3);
    await app.commands.run('bookmarks:toggle');
    await until(() => stored() === 1);
    const probe = async () => {
      const n = await editor('notes.txt');
      await wait(150);
      return {
        gutter: n.view.dom.querySelectorAll('.cm-bookmark-gutter').length, markers: n.view.dom.querySelectorAll('.cm-bookmark-gutter .bm-marker.bm').length,
        tinted: n.view.dom.querySelectorAll('.cm-bookmark-line').length, view: app.sidebar.views.has('bookmarks'), goTo: app.quickOpen.modes.some((m) => m.prefix === '!'),
        stored: stored(),
      };
    };
    return cycle('bookmarks', {
      probe,
      menus: { editor: [() => editorMenu('notes.txt'), 'Toggle Bookmark'] },
      key: {
        command: 'bookmarks:toggle',
        prepare: async () => { const n = await editor('notes.txt'); toLine(n, 6); n.view.focus(); return n.view.contentDOM; },
        effect: stored,
        undo: async () => { if (stored() === 2 && pkg('bookmarks').active) { toLine(notes, 6); await app.commands.run('bookmarks:toggle'); await until(() => stored() === 1); } },
      },
    });
  });

  // --- merge-conflicts ------------------------------------------------------------------------------
  const scRow = () => [...document.querySelectorAll('.sc-group')].filter((g) => g.querySelector('.sc-group-header span')?.textContent === 'Merge Conflicts')
    .flatMap((g) => [...g.querySelectorAll('.sc-row')]).find((r) => r.querySelector('.sc-name')?.textContent === 'conflict.txt');
  // Source control lists the conflicted file; a click opens it (at its first conflict when merge-conflicts is on).
  const fromSourceControl = async () => {
    await ws.closeItem(ws.allItems().find((i) => i.getPath?.() === file('conflict.txt')));
    await app.commands.run('source-control:show');
    const row = await until(scRow);
    if (!row) return 'no row';
    const title = row.querySelector('.sc-row-actions button')?.title;
    row.click();
    const ed = await until(() => { const a = ws.getActiveEditor(); return a?.getPath() === file('conflict.txt') && a.view && a; });
    await wait(300);
    return { title, line: ed ? lineOf(ed) : null };
  };
  await step('merge-conflicts', async () => {
    const ed = await editor('conflict.txt');
    toLine(ed, 3);
    await app.commands.run('merge-conflicts:compare');
    await until(() => ofType('merge-conflict-compare') === 1);
    const before = await fromSourceControl();
    const r = await cycle('merge-conflicts', {
      probe: async () => {
        const c = await editor('conflict.txt');
        await wait(150);
        return {
          actions: c.view.dom.querySelectorAll('.cm-mc-actions').length, tinted: c.view.dom.querySelectorAll('.cm-mc-ours').length,
          status: !!document.querySelector('#statusbar .status-item[data-id="merge-conflicts"]'), compare: ofType('merge-conflict-compare'),
          service: !!app.packages.services.get('merge-conflicts'),
        };
      },
      key: {
        command: 'merge-conflicts:next',
        prepare: async () => { const c = await editor('conflict.txt'); toLine(c, 1); c.view.focus(); return c.view.contentDOM; },
        effect: () => lineOf(ws.getActiveEditor()),
      },
      others: fromSourceControl,
    });
    r.sourceControl = [before, r.others, await fromSourceControl()];
    delete r.others;
    return r;
  });

  // --- local-history ------------------------------------------------------------------------------
  const hist = app.userInfo.dir + '/history';
  const versions = async () => {
    for (const e of await native.fs.readdir(hist).catch(() => [])) {
      if (!e.isDir) continue;
      try { const idx = JSON.parse(await native.fs.read(e.path + '/index.json')); if (idx.path === file('notes.txt')) return idx.versions.length; } catch {}
    }
    return 0;
  };
  let saves = 0;
  const savedAVersion = async () => {
    const n = await editor('notes.txt');
    const was = await versions();
    n.view.dispatch({ changes: { from: n.view.state.doc.length, insert: `saved ${++saves}\n` } });
    await ws.save(n);
    return !!(await until(async () => (await versions()) > was, 1500));
  };
  await step('local-history', async () => {
    await savedAVersion();
    await editor('notes.txt');
    await app.commands.run('local-history:show');
    await until(() => ofType('local-history') === 1);
    return cycle('local-history', {
      probe: async () => ({ tabs: ofType('local-history', 'local-history-snapshot'), keeps: await savedAVersion() }),
      menus: { editor: [() => editorMenu('notes.txt'), 'Show Local History'], tab: [() => tabMenu('notes.txt'), 'Show Local History'], tree: [() => treeMenu('notes.txt'), 'Show Local History'] },
      key: {
        command: 'local-history:show',
        prepare: async () => (await editor('notes.txt')).view.contentDOM,
        effect: () => ws.getActiveItem()?.type,
        undo: async () => { for (const i of ws.allItems().filter((x) => x.type === 'local-history')) await ws.closeItem(i); await editor('notes.txt'); },
      },
    });
  });

  // --- outline and breadcrumbs ------------------------------------------------------------------------------
  const crumbsOf = (ed) => [...ed.view.dom.querySelectorAll('.cm-breadcrumbs .cm-crumb')].map((c) => c.textContent).join(' › ');
  const inTotal = async () => { const ed = await editor('app.js'); ed.view.dispatch({ selection: { anchor: ed.getText().indexOf('return 1') } }); return ed; };
  const outlineRows = () => [...document.querySelectorAll('.outline-view .outline-row .outline-name')].map((n) => n.textContent);
  const outlineNow = async () => {
    await inTotal();
    if (!app.sidebar.views.has('outline')) return { view: false, rows: [], current: null };
    app.sidebar.show('outline');
    const rows = await until(() => { const l = outlineRows(); return l.length && l; }, 4000) || [];
    const current = await until(() => document.querySelector('.outline-view .outline-row.current .outline-name')?.textContent, 2000);
    return { view: true, rows, current };
  };
  const crumbsNow = async () => {
    const ed = await inTotal();
    const crumbs = pkg('breadcrumbs').active ? await until(() => { const t = crumbsOf(ed); return t.endsWith('total') && t; }, 4000) || crumbsOf(ed) : crumbsOf(ed);
    return { bars: document.querySelectorAll('.cm-breadcrumbs').length, crumbs };
  };
  await step('outline', () => cycle('outline', {
    probe: outlineNow,
    // Breadcrumbs keep working on their own.
    others: crumbsNow,
  }));
  await step('breadcrumbs', () => cycle('breadcrumbs', {
    probe: crumbsNow,
    // The Outline keeps working on its own.
    others: async () => ({ outline: await outlineNow(), toggle: app.commands.list().some((c) => c.id === 'editor:toggle-breadcrumbs') }),
    turnOn: () => app.commands.run('editor:toggle-breadcrumbs'),
  }));

  // With both off nobody asks for symbols; turning one on asks again.
  await step('symbolsOnDemand', async () => {
    await app.packages.setEnabled('outline', false);
    await app.packages.setEnabled('breadcrumbs', false);
    await editor('shapes.ts');
    await wait(800);
    const asked = (await fakeLog()).symbolRequests;
    ts.view.dispatch({ changes: { from: ts.view.state.doc.length, insert: 'const more = 2;\n' } });
    await wait(1200);
    const whileOff = (await fakeLog()).symbolRequests - asked;
    await app.packages.setEnabled('breadcrumbs', true);
    const askedAgain = !!(await until(async () => (await fakeLog()).symbolRequests > asked, 5000));
    await app.packages.setEnabled('outline', true);
    return { whileOff, askedAgain, bars: ts.view.dom.querySelectorAll('.cm-breadcrumbs').length };
  });

  // --- inlay-hints ------------------------------------------------------------------------------
  const hints = () => ts.view.contentDOM.querySelectorAll('.cm-inlay-hint').length;
  await step('inlay-hints', async () => {
    await editor('shapes.ts');
    await until(() => hints() === 2);
    return cycle('inlay-hints', {
      probe: async () => { await editor('shapes.ts'); return { hints: pkg('inlay-hints').active ? await until(() => hints() >= 2 && hints(), 4000) || hints() : hints() }; },
      // While off, editing asks the server for nothing.
      others: async () => {
        const asked = (await fakeLog()).inlayRequests.length;
        ts.view.dispatch({ changes: { from: ts.view.state.doc.length, insert: 'const again = scale(1, 2);\n' } });
        await wait(1200);
        return { asked: (await fakeLog()).inlayRequests.length - asked, toggle: app.commands.list().some((c) => c.id === 'editor:toggle-inlay-hints') };
      },
      turnOn: () => app.commands.run('editor:toggle-inlay-hints'),
    });
  });

  // --- task-problems ------------------------------------------------------------------------------
  // The task runs every time; only while the package is on do its problems reach the list and app.js.
  const lintMarks = (ed) => [...ed.view.contentDOM.querySelectorAll('.cm-lintRange')].map((el) => `${el.className.match(/cm-lintRange-(\w+)/)[1]}:${el.textContent}`);
  const runCheck = async () => {
    const term = app.packages.services.get('terminal');
    term.run('node check.js', { cwd: root, title: 'Task: check', key: 'task:check' });
    await until(() => term.isRunning('task:check'), 3000);
    await until(() => !term.isRunning('task:check'));
    await wait(500);
  };
  const taskProblems = () => app.packages.services.get('diagnostics').all().flatMap((f) => f.list.filter((d) => d.source === 'check')).length;
  await step('task-problems', async () => {
    await runCheck();
    return cycle('task-problems', {
      probe: async () => { await runCheck(); const ed = await editor('app.js'); await wait(200); return { problems: taskProblems(), marks: lintMarks(ed) }; },
      // The runner and the language servers' Problems view don't need it.
      others: async () => ({ runner: app.commands.has('runner:run-task'), lspView: !!document.querySelector('.lsp-problems') }),
    });
  });

  out.errors = errors;
  out.totalErrors = errors.length;
  return out;
})()
