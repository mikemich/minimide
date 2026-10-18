// Session persistence, part 1 (sessionRestore runs next with the same home): open files in two
// panes, move the cursor, switch the sidebar, then save the session.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const root = await until(() => ws.project);
  for (const i of ws.allItems()) { await window.mideTest.answers('confirm', 1); await ws.closeItem(i); }
  const a = await ws.open(root + '/crlf.txt');
  a.goToLine(2, 3);
  await ws.open(root + '/image.png');
  const pane = ws.splitRight(ws.activePane, null);
  await ws.open(root + '/README.md', { pane });
  await app.commands.run('source-control:show');
  await wait(300);
  app.saveSession(); await app.persistState();
  return { saved: ws.panes.map((p) => p.items.map((i) => i.getTitle())), cursor: a.getCursor?.(), sidebar: app.sidebar.activeId };
})()
