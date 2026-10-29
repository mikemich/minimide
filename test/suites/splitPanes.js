// Split panes: splitting right and down into a tree of rows and columns, closing panes collapses
// it again, dividers resize, the layout (sizes too) survives save/restore, and the old flat
// session format still loads. Over the `qa` fixture.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const root = await until(() => ws.project);
  const rect = (pane) => pane.element.getBoundingClientRect();
  const near = (a, b, t = 2) => Math.abs(a - b) <= t;
  const titles = () => ws.panes.map((p) => p.items.map((i) => i.getTitle()));
  const shape = (n) => (n.children ? `${n.dir}(${n.children.map(shape).join(',')})` : 'pane');
  const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  const drag = (el, dx, dy) => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    mouse(el, 'mousedown', x, y); mouse(window, 'mousemove', x + dx, y + dy); mouse(window, 'mouseup', x + dx, y + dy);
  };
  const closeAll = async () => { for (const i of ws.allItems()) await ws.closeItem(i); while (ws.panes.length > 1) ws.removePane(ws.panes.at(-1)); };
  const out = {};

  await closeAll();
  const a = ws.activePane;
  await ws.open(root + '/crlf.txt');

  // Split down: a pane below, same width.
  const b = ws.splitDown(a, null);
  await ws.open(root + '/README.md', { pane: b });
  await wait(100);
  out.down = { below: rect(b).top >= rect(a).bottom - 1, sameLeft: near(rect(a).left, rect(b).left), sameWidth: near(rect(a).width, rect(b).width), shape: shape(ws.root.serialize()), divider: !!document.querySelector('#panes .pane-resizer.resizer-h') };

  // Split right inside the bottom pane: a nested row.
  const c = ws.splitRight(b, null);
  await ws.open(root + '/image.png', { pane: c });
  await wait(100);
  out.nested = {
    shape: shape(ws.root.serialize()), order: ws.panes.map((p) => [a, b, c].indexOf(p)),
    rightOfB: rect(c).left >= rect(b).right - 1, sameTop: near(rect(b).top, rect(c).top), belowA: rect(b).top >= rect(a).bottom - 1,
    topFull: near(rect(a).width, rect(b).width + rect(c).width + 1, 3),
  };

  // Focus: reading order, and above / below.
  ws.setActivePane(a);
  ws.focusPaneOffset(1); const next = ws.activePane === b;
  ws.focusPaneOffset(1); ws.focusPaneOffset(1); const wrapped = ws.activePane === a;
  ws.setActivePane(c); ws.focusPaneVertical(-1); const above = ws.activePane === a;
  ws.focusPaneVertical(1); const below = [b, c].includes(ws.activePane);
  ws.setActivePane(a); ws.focusPaneVertical(-1); const nothingAbove = ws.activePane === a;
  out.focus = { next, wrapped, above, below, nothingAbove };

  // Keys.
  out.keys = { splitDown: !!app.keymap.bindingsFor('pane:split-down')[0], above: !!app.keymap.bindingsFor('pane:focus-above')[0], below: !!app.keymap.bindingsFor('pane:focus-below')[0] };

  // Dividers: drag the horizontal one down 40px, the vertical one in the bottom row left 30px.
  const before = { a: rect(a).height, b: rect(b).width };
  drag(document.querySelector('#panes .pane-resizer.resizer-h'), 0, 40);
  drag(ws.root.children[1].element.querySelector('.pane-resizer.resizer-v'), -30, 0);
  // Sizes are applied on the next frame, which can take a while on a slow machine.
  await until(() => near(rect(a).height - before.a, 40, 3) && near(before.b - rect(b).width, 30, 3), 3000);
  out.resize = { aGrew: near(rect(a).height - before.a, 40, 3), bShrank: near(before.b - rect(b).width, 30, 3), cursorReset: !document.body.classList.contains('resizing-v') && !document.body.classList.contains('resizing-h') };

  // Layout follows the sidebar: everything still tiles the pane area.
  const tiles = () => {
    const area = document.getElementById('panes').getBoundingClientRect();
    return near(rect(a).width, area.width, 1) && near(rect(a).height + rect(b).height + 1, area.height, 2) && near(rect(b).width + rect(c).width + 1, area.width, 2) && near(rect(c).right, area.right, 1);
  };
  const tiledBefore = tiles();
  await app.commands.run('sidebar:toggle'); await wait(300);
  const tiledAfter = tiles();
  await app.commands.run('sidebar:toggle'); await wait(300);
  out.tiling = { tiledBefore, tiledAfter, restored: tiles() };

  // Dragging a tab onto another pane's tab bar moves it (an empty tab, so the pane isn't emptied).
  const extra = ws.newFile(b);
  ws.dragging = { item: extra, pane: b };
  a.onDrop({ preventDefault() {}, clientX: 100000 });
  ws.dragging = null;
  const moved = a.items.includes(extra) && !b.items.includes(extra) && ws.panes.length === 3;
  await ws.closeItem(extra);
  out.dragTab = { moved, closed: !ws.allItems().includes(extra) };

  // Save, collapse everything, restore: same tree, files and sizes.
  const state = JSON.parse(JSON.stringify(ws.serialize()));
  const flexes = (n) => (n.children ? [Math.round(n.flex * 100), ...n.children.flatMap(flexes)] : [Math.round(n.flex * 100)]);
  const flexBefore = flexes(state.layout);
  ws.setActivePane(c);
  await closeAll();
  await ws.restore(state);
  await wait(200);
  const again = JSON.parse(JSON.stringify(ws.serialize()));
  out.roundTrip = { saved: shape(state.layout), shape: shape(ws.root.serialize()), titles: titles(), sameSizes: JSON.stringify(flexes(again.layout)) === JSON.stringify(flexBefore), active: again.activePane === state.activePane };

  // Closing the last tab of a pane removes it and collapses its parent.
  const [pa, pb, pc] = ws.panes;
  await ws.closeItem(pc.items[0]);
  const afterRight = { panes: ws.panes.length, shape: shape(ws.root.serialize()), onlyColumn: ws.root.dir === 'col' };
  await ws.closeItem(pa.items[0]);
  const afterTop = { panes: ws.panes.length, isPane: ws.root === pb, shape: shape(ws.root.serialize()) };
  out.collapse = { afterRight, afterTop, fills: near(rect(pb).width, document.getElementById('panes').getBoundingClientRect().width, 1) };

  // Same-direction splits merge when a column collapses: row[a, col[b, c]] without b is row[a, c].
  await closeAll();
  const p1 = ws.activePane; await ws.open(root + '/crlf.txt');
  const p2 = ws.splitRight(p1, null); await ws.open(root + '/README.md', { pane: p2 });
  const p3 = ws.splitDown(p2, null); await ws.open(root + '/image.png', { pane: p3 });
  const nestedShape = shape(ws.root.serialize());
  await ws.closeItem(p2.items[0]);
  out.merge = { nestedShape, shape: shape(ws.root.serialize()), panes: ws.panes.length };

  // The old session format: a flat list of panes is one row.
  await closeAll();
  const file = (name) => ({ path: root + '/' + name });
  await ws.restore({ panes: [{ flex: 1, items: [file('crlf.txt')], active: 0 }, { flex: 3, items: [file('README.md')], active: 0 }], activePane: 1 });
  await wait(200);
  out.oldFormat = { shape: shape(ws.root.serialize()), titles: titles(), activeIsSecond: ws.activePane === ws.panes[1], widthRatio: Math.round((rect(ws.panes[1]).width / rect(ws.panes[0]).width) * 10) / 10 };

  await closeAll();
  return out;
})()
