// Session persistence, part 2: a fresh launch restores what sessionSave left in the same home.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  await until(() => ws.allItems().length >= 3);
  await wait(500);
  const crlf = ws.allItems().find((i) => i.getTitle() === 'crlf.txt');
  return { restored: ws.panes.map((p) => p.items.map((i) => i.getTitle())), cursor: crlf?.getCursor?.(), sidebar: app.sidebar.activeId };
})()
