// Breadcrumbs, the Outline view and inlay hints over the `outlineproj` fixture. JavaScript, Markdown,
// Python, CSS and JSON symbols come from the syntax tree; shapes.ts is served by the fake language
// server (test/fake-lsp.mjs), which also provides inlay hints and logs what it was asked.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(60); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ').slice(0, 200)); oe(...a); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason?.message || e.reason}`));
  const root = await until(() => ws.project);
  const out = {};
  const symbolsService = () => app.packages.services.get('symbols');
  const crumbsOf = (ed) => [...(ed.view.dom.querySelectorAll('.cm-breadcrumbs .cm-crumb'))].map((c) => c.textContent).join(' › ');
  const tree = (list) => list.map((s) => `${s.name}:${s.kind}${s.children.length ? `[${tree(s.children)}]` : ''}`).join(',');
  const at = (ed, needle, offset = 0) => { const pos = ed.getText().indexOf(needle) + offset; ed.view.dispatch({ selection: { anchor: pos } }); return pos; };
  const outlineRows = () => [...document.querySelectorAll('.outline-view .outline-row')].map((r) => r.querySelector('.outline-name').textContent);
  const currentRow = () => document.querySelector('.outline-view .outline-row.current .outline-name')?.textContent || null;
  const down = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  const lineOf = (ed) => ed.getCursor().line;

  // --- breadcrumbs from the syntax tree: JavaScript --------------------------------------------
  const js = await ws.open(`${root}/src/app.js`);
  js.view.focus();
  at(js, 'reduce');
  out.jsCrumbs = await until(() => { const t = crumbsOf(js); return t.endsWith('total') && t; }) || crumbsOf(js);
  const jsSymbols = await symbolsService().getSymbols(js);
  out.jsSource = jsSymbols?.source;
  out.jsTree = tree(jsSymbols?.symbols || []);
  out.servicePath = symbolsService().symbolPathAt(js).map((s) => s.name);

  // Typing above keeps the breadcrumbs right, then they follow the symbols as they're recomputed.
  js.view.dispatch({ changes: { from: 0, insert: '// a comment\n' } });
  out.crumbsAfterEdit = crumbsOf(js);
  at(js, 'return amount');
  out.crumbsInFunction = await until(() => { const t = crumbsOf(js); return t.endsWith('checkout') && t; }) || crumbsOf(js);

  // Clicking a symbol lists its siblings; picking one jumps there.
  at(js, 'reduce');
  await until(() => crumbsOf(js).endsWith('total'));
  const totalCrumb = [...js.view.dom.querySelectorAll('.cm-crumb[data-type="symbol"]')].pop();
  down(totalCrumb);
  const menuItems = await until(() => { const l = [...document.querySelectorAll('.cm-crumbs-menu .cm-crumbs-name')].map((x) => x.textContent); return l.length && l; });
  out.siblings = menuItems;
  out.siblingSelected = document.querySelector('.cm-crumbs-menu .cm-crumbs-item.selected .cm-crumbs-name')?.textContent;
  const addItem = [...document.querySelectorAll('.cm-crumbs-menu .cm-crumbs-item')].find((x) => x.textContent.includes('add'));
  if (addItem) down(addItem);
  out.siblingJump = { line: lineOf(js), crumbs: await until(() => { const t = crumbsOf(js); return t.endsWith('add') && t; }) || crumbsOf(js), menuClosed: !document.querySelector('.cm-crumbs-menu') };

  // --- the Outline view --------------------------------------------------------------------------
  await app.commands.run('outline:show');
  out.outlineRows = await until(() => { const r = outlineRows(); return r.length >= 9 && r; }) || outlineRows();
  out.outlineSource = document.querySelector('.outline-view')?.dataset.source;
  at(js, 'reduce');
  out.followsCursor = await until(() => currentRow() === 'total' && 'total') || currentRow();
  at(js, 'return amount');
  out.followsCursorAgain = await until(() => currentRow() === 'checkout' && 'checkout') || currentRow();

  // Click a row: the editor jumps to it.
  const roundRow = [...document.querySelectorAll('.outline-view .outline-row')].find((r) => r.querySelector('.outline-name').textContent === 'round');
  roundRow?.click();
  out.rowJump = { line: lineOf(js), col: js.getCursor().col, focused: document.activeElement === js.view.contentDOM };

  // Filter: matches and the symbols they're in.
  const filter = document.querySelector('.outline-view .outline-filter');
  filter.value = 'rou';
  filter.dispatchEvent(new Event('input'));
  out.filtered = outlineRows();
  filter.value = 'nothing-like-this';
  filter.dispatchEvent(new Event('input'));
  out.filteredNone = document.querySelector('.outline-view .outline-message:not([hidden])')?.textContent;
  filter.value = '';
  filter.dispatchEvent(new Event('input'));

  // Collapse a class, then expand everything again.
  const cartRow = [...document.querySelectorAll('.outline-view .outline-row')].find((r) => r.querySelector('.outline-name').textContent === 'Cart');
  cartRow?.querySelector('.outline-twisty').click();
  out.collapsed = outlineRows();
  await app.commands.run('outline:expand-all');
  out.expanded = outlineRows().length;
  await app.commands.run('outline:collapse-all');
  out.collapsedAll = outlineRows();
  await app.commands.run('outline:expand-all');

  // --- Markdown headings -------------------------------------------------------------------------
  const md = await ws.open(`${root}/notes.md`);
  md.view.focus();
  at(md, 'Build it.');
  out.mdCrumbs = await until(() => { const t = crumbsOf(md); return t.endsWith('From source') && t; }) || crumbsOf(md);
  at(md, 'not a heading');
  out.mdInFence = await until(() => { const t = crumbsOf(md); return t.endsWith('From source') && t; }) || crumbsOf(md);
  out.mdTree = tree((await symbolsService().getSymbols(md))?.symbols || []);
  out.mdOutline = await until(() => { const r = outlineRows(); return r.includes('Appendix') && r; }) || outlineRows();

  // --- other languages through the service --------------------------------------------------------
  for (const [key, file] of [['py', 'tool.py'], ['css', 'style.css'], ['json', 'data.json']]) {
    const ed = await ws.open(`${root}/${file}`);
    out[`${key}Tree`] = await until(async () => { const r = await symbolsService().getSymbols(ed); return r?.symbols.length && tree(r.symbols); }) || 'none';
  }

  // --- symbols and inlay hints from the (fake) language server ------------------------------------
  const readLog = async () => JSON.parse(await window.native.fs.read(`${app.userInfo.dir}/fake-lsp.json`));
  const ts = await ws.open(`${root}/shapes.ts`);
  ts.view.focus();
  out.lspReady = !!(await until(() => document.querySelector('.lsp-status[data-state="ready"]'), 15000));
  at(ts, 'Math.PI');
  out.tsCrumbs = await until(() => { const t = crumbsOf(ts); return t.endsWith('area') && t; }, 10000) || crumbsOf(ts);
  const tsSymbols = await until(async () => { const r = await symbolsService().getSymbols(ts); return r?.source === 'lsp' && r; }, 10000);
  out.tsSource = tsSymbols?.source || null;
  out.tsTree = tree(tsSymbols?.symbols || []);
  out.tsOutline = await until(() => document.querySelector('.outline-view')?.dataset.source === 'lsp' && [...document.querySelectorAll('.outline-view .outline-row')]
    .map((r) => `${r.querySelector('.outline-name').textContent}|${r.querySelector('.outline-detail')?.textContent || ''}`), 10000);

  const hints = () => [...ts.view.contentDOM.querySelectorAll('.cm-inlay-hint')].map((el) => {
    const pos = ts.view.posAtDOM(el);
    const line = ts.view.state.doc.lineAt(pos);
    return `${line.number}:${pos - line.from}:${el.textContent}`;
  });
  // Off by default: nothing drawn, nothing asked.
  await until(async () => (await readLog()).symbolRequests > 0);
  out.hintsOffByDefault = { drawn: hints().length, asked: (await readLog()).inlayRequests.length };
  const log0 = await readLog();
  out.capability = { inlayHint: !!log0.initialize?.inlayHint, refreshSupport: log0.initialize?.refreshSupport };

  await app.commands.run('editor:toggle-inlay-hints');
  out.hintsOn = app.packages.packages.get('inlay-hints').active;
  out.hints = await until(() => { const l = hints(); return l.length >= 3 && l; }) || hints();
  out.hintClasses = [...ts.view.contentDOM.querySelectorAll('.cm-inlay-hint')].map((el) => el.className.replace('cm-inlay-hint ', ''));
  out.hintTooltip = ts.view.contentDOM.querySelector('.cm-inlay-hint-type')?.title || null;
  out.hintRange = (await readLog()).inlayRequests.at(-1)?.start;
  out.textUnchanged = ts.view.state.doc.line(16).text === 'const big = scale(10, 3);';

  // An edit: hints move with the text at once, and the server is asked again once typing pauses.
  const asked = (await readLog()).inlayRequests.length;
  const end = ts.view.state.doc.length;
  ts.view.dispatch({ changes: [{ from: 0, insert: '\n' }, { from: end, insert: 'const extra = 7;\n' }] });
  out.hintsMoved = hints();
  out.hintsAfterEdit = await until(() => { const l = hints(); return l.some((x) => x.startsWith('19:')) && l; }) || hints();
  out.askedAgain = (await readLog()).inlayRequests.length > asked;

  // Saving makes the fake server change its answer and send workspace/inlayHint/refresh.
  await ws.save(ts);
  out.hintsAfterRefresh = await until(() => { const l = hints(); return l.some((x) => x.endsWith(': int')) && l; }) || hints();
  out.refreshes = (await readLog()).refreshes;

  // A server that starts after the editor opened is asked as soon as it's ready (no edit needed).
  await app.commands.run('lsp:restart-servers');
  out.hintsAfterRestart = await until(() => { const l = hints(); return l.some((x) => x.endsWith(': number')) && l; }, 15000) || hints();

  // Restart seven times in quick succession, while the servers start and a second file opens: one
  // server is left running, with each file open in it exactly once, and no start is reported as failed.
  const events = async () => (await window.native.fs.read(`${app.userInfo.dir}/fake-lsp.json.events`)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await window.native.fs.write(`${root}/second.ts`, 'export function twice(n: number) {\n  return n * 2;\n}\nconst four = twice(2);\n');
  const errorsShown = () => [...document.querySelectorAll('#notifications .notification.error .notification-title')].map((el) => el.textContent);
  const errorsBefore = errorsShown().length;
  const restarts = [app.commands.run('lsp:restart-servers')];
  const opening = ws.open(`${root}/second.ts`, { activate: false });
  // Gaps that land while a stop is under way, a server is being looked for, and one is starting.
  for (const ms of [0, 0, 1, 2, 4, 8]) { await wait(ms); restarts.push(app.commands.run('lsp:restart-servers')); }
  const second = await opening;
  await Promise.all(restarts);
  const lsp = app.packages.services.get('lsp');
  const attached = await until(() => { const a = lsp.documentFor(ts.view), b = lsp.documentFor(second.view); return a && b && a.client.state === 'ready' && b.client === a.client; }, 15000);
  await wait(1500); // stopped servers have exited
  const evs = await events();
  const exited = new Set(evs.filter((e) => e.event === 'exit').map((e) => e.pid));
  const running = [...new Set(evs.filter((e) => e.event === 'start').map((e) => e.pid))].filter((pid) => !exited.has(pid));
  const openedIn = (pid) => evs.filter((e) => e.pid === pid && e.event === 'open').map((e) => e.file).sort();
  out.restartRace = {
    running: running.length, attached: !!attached,
    opened: running.length === 1 ? openedIn(running[0]) : running.map(openedIn),
    failures: errorsShown().slice(errorsBefore),
    hints: await until(() => hints().length >= 3, 8000) ? 'drawn' : 'none',
  };
  await ws.closeItem(second);

  await app.commands.run('editor:toggle-inlay-hints');
  out.hintsOff = await until(() => hints().length === 0 && 'none') || hints();

  // --- breadcrumbs toggle ------------------------------------------------------------------------
  await app.commands.run('editor:toggle-breadcrumbs');
  out.breadcrumbsOff = { active: app.packages.packages.get('breadcrumbs').active, bars: document.querySelectorAll('.cm-breadcrumbs').length };
  await app.commands.run('editor:toggle-breadcrumbs');
  out.breadcrumbsOn = { active: app.packages.packages.get('breadcrumbs').active, crumbs: await until(() => { const t = crumbsOf(ts); return t.endsWith('area') && t; }) || crumbsOf(ts) };

  // Something to look at in the screenshot: hints in the TS file, the JS file next to it.
  await app.commands.run('editor:toggle-inlay-hints');
  await until(() => hints().length >= 3);
  ws.splitRight();
  await ws.open(`${root}/src/app.js`);
  at(ws.getActiveEditor(), 'reduce');
  out.errors = errors;
  return out;
})()
