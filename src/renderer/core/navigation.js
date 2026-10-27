// Back / forward through the places the cursor jumped from: go to definition, a search result, a
// click far down the file, another tab. Small moves (typing, arrow keys) are not recorded.
const JUMP_LINES = 10;
const LIMIT = 50;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

export class Navigation {
  constructor(ws) {
    this.ws = ws;
    this.back = [];
    this.forward = [];
    this.current = null; // where the cursor is in the active editor: { item, path, line, col }
    this.navigating = false;
    this.queue = Promise.resolve(); // back / forward run one at a time, so quick repeats can't overlap
    this.quietUntil = 0;
    ws.on('active-item-changed', (item) => this.onActiveItem(item));
    ws.on('editor-updated', (item, update) => this.onUpdate(item, update));
    // The back / forward buttons on a mouse.
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) { e.preventDefault(); this.goBack(); }
      else if (e.button === 4) { e.preventDefault(); this.goForward(); }
    });
  }

  locationOf(item) {
    if (item?.type !== 'editor' || !item.view) return null;
    const { state } = item.view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { item, path: item.getPath(), line: line.number, col: head - line.from };
  }

  onActiveItem(item) {
    const next = this.locationOf(item);
    if (!next) return; // a settings page or an image: keep the last editor location
    if (!this.navigating && this.current && this.current.item !== item) this.record(this.current);
    this.current = next;
    // A newly opened file usually scrolls to its target right away: that isn't a jump of its own.
    this.quietUntil = Date.now() + 600;
  }

  onUpdate(item, update) {
    if (!update || item !== this.ws.getActiveItem() || !(update.selectionSet || update.docChanged)) return;
    const loc = this.locationOf(item);
    const quiet = this.navigating || update.docChanged || Date.now() < this.quietUntil;
    if (!quiet && this.current?.item === item && Math.abs(loc.line - this.current.line) >= JUMP_LINES) this.record(this.current);
    this.current = loc;
  }

  record(loc) {
    const top = this.back.at(-1);
    if (top && same(top, loc)) return;
    this.back.push(loc);
    if (this.back.length > LIMIT) this.back.shift();
    this.forward = [];
  }

  canGoBack() { return this.back.some((l) => this.isAlive(l)); }
  canGoForward() { return this.forward.some((l) => this.isAlive(l)); }
  goBack() { return this.enqueue(() => this.go(this.back, this.forward)); }
  goForward() { return this.enqueue(() => this.go(this.forward, this.back)); }

  enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  isAlive(loc) {
    return (loc.item.view && this.ws.allItems().includes(loc.item)) || !!loc.path;
  }

  async go(from, to) {
    const here = this.locationOf(this.ws.getActiveItem()) || this.current;
    while (from.length) {
      const loc = from.pop();
      if (!this.isAlive(loc) || (here && same(here, loc))) continue;
      const isOpen = loc.item.view && this.ws.allItems().includes(loc.item);
      // Closed since, and the file deleted too: skip it rather than open an empty one.
      if (!isOpen && !(await window.native.fs.stat(loc.path))) continue;
      if (here) to.push(here);
      this.navigating = true;
      try {
        if (isOpen) {
          this.ws.focusItem(loc.item);
          loc.item.goToLine(loc.line, loc.col);
        } else {
          await this.ws.open(loc.path, { line: loc.line, col: loc.col });
        }
        await nextFrame();
      } finally {
        this.navigating = false;
      }
      this.current = this.locationOf(this.ws.getActiveItem()) || this.current;
      return true;
    }
    return false;
  }
}

const same = (a, b) => (a.item === b.item || (a.path && a.path === b.path)) && a.line === b.line;
