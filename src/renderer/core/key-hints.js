// Hold ⌘ (Ctrl on Linux and Windows) for a moment and the shortcuts show up where they apply:
// on tabs, sidebar and panel buttons and the status bar, next to the cursor, plus a short list
// of the ones that work anywhere. Let go and they're gone. Nothing to memorize up front.
//
// Anything with a `data-command` attribute gets labelled; views, status bar items and pane
// actions set it from their `command` option.
import { h } from './dom.js';
import { prettyBinding, isMac } from './keymap.js';
import { isModalOpen } from './ui.js';

const HOLD_MS = 450;

const AT_CURSOR = [
  ['lsp:go-to-definition', 'Go to definition'],
  ['lsp:peek-definition', 'Peek definition'],
  ['lsp:find-references', 'Find every use'],
  ['lsp:rename', 'Rename everywhere'],
  ['lsp:code-actions', 'Quick fix'],
  ['lsp:signature-help', 'Parameter hints'],
  ['editor:toggle-comment', 'Comment / uncomment'],
  ['editor:duplicate-lines', 'Duplicate line'],
  ['editor:select-line', 'Select line'],
];

const ANYWHERE = [
  ['fuzzy-finder:toggle', 'Go to a file'],
  ['command-palette:toggle', 'Run any command'],
  ['lsp:go-to-workspace-symbol', 'Symbol in the project'],
  ['find-in-project:show', 'Search the project'],
  ['navigate:back', 'Go back'],
  ['sidebar:toggle', 'Sidebar'],
  ['terminal:toggle', 'Terminal'],
  ['pane:split-right', 'Split right'],
  ['help:cheat-sheet', 'All the shortcuts'],
];

export function bindKeyHints(app) {
  const holdKey = isMac ? 'Meta' : 'Control';
  let timer = null;
  let layer = null;

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    layer?.remove();
    layer = null;
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === holdKey) {
      // Only ⌘ on its own: ⌘ pressed while Shift or Alt is down is the start of a shortcut.
      if (e.repeat || e.shiftKey || e.altKey || (isMac ? e.ctrlKey : e.metaKey)) return;
      hide();
      if (app.config.get('ui.holdToShowShortcuts') !== false) timer = setTimeout(() => { timer = null; if (!isModalOpen()) layer = render(app); }, HOLD_MS);
    } else {
      hide(); // any other key: it's a shortcut, not a look around
    }
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === holdKey) hide(); }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('mousedown', hide, true);
  window.addEventListener('wheel', hide, { capture: true, passive: true });
  // Without holding anything: for the welcome card's "Try it". Goes away with the next key, click or scroll.
  const show = () => { hide(); layer = render(app); timer = setTimeout(hide, 6000); };
  return { hide, show, isShown: () => !!layer };
}

function render(app) {
  const keyFor = (id) => {
    const b = app.keymap.bindingsFor(id)[0];
    return b ? prettyBinding(b) : null;
  };
  const layer = h('div.key-hints', { 'aria-hidden': 'true' }); // a visual aid; the shortcuts are in the cheat sheet and menus
  document.body.append(layer); // badges are measured as they go in
  const placed = [];
  const badge = (el, text) => {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;
    const b = h('kbd.key-hint', text);
    layer.append(b);
    const { width, height } = b.getBoundingClientRect();
    const clampX = (x) => Math.max(2, Math.min(window.innerWidth - width - 2, x));
    // Labels hang from the bottom edge of what they label (sit on top of it in the status bar),
    // so they never cover a tab's name or an icon.
    let left = clampX(r.left + r.width / 2 - width / 2);
    let top = el.closest('#statusbar') ? r.top - height - 3 : r.bottom - height / 2;
    const hits = (x, y) => placed.find((p) => x < p.right + 3 && x + width + 3 > p.left && y < p.bottom + 2 && y + height + 2 > p.top);
    // Buttons close together (the sidebar icons): slide along first, stack only if that fails.
    for (let p = hits(left, top); p;) {
      const slid = clampX(p.right + 3);
      if (slid - left <= width && !hits(slid, top)) { left = slid; break; }
      top = p.bottom + 3;
      p = hits(left, top);
    }
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
    placed.push({ left, top, right: left + width, bottom: top + height });
  };

  // Buttons and items that say which command they run.
  for (const el of document.querySelectorAll('[data-command]')) {
    if (el.checkVisibility && !el.checkVisibility()) continue;
    const keys = keyFor(el.dataset.command);
    if (keys) badge(el, keys);
  }
  // Tabs in the active pane: ⌘1…⌘8, and ⌘9 for the last one.
  const tabs = [...(app.workspace.activePane?.tabsEl?.children || [])];
  tabs.forEach((tab, i) => {
    const id = i === tabs.length - 1 && i >= 8 ? 'tab:go-last' : i < 8 ? `tab:go-${i + 1}` : null;
    const keys = id && keyFor(id);
    if (keys) badge(tab, keys);
  });

  const card = (title, rows) => {
    const shown = rows.filter(([id]) => app.commands.isEnabled(id) && keyFor(id))
      .map(([id, label]) => h('div.key-hints-row', h('span', label), h('kbd', keyFor(id))));
    return shown.length ? h('div.key-hints-card', h('div.key-hints-title', title), ...shown) : null;
  };

  // What works on the code under the cursor, right next to it.
  const editor = app.workspace.getActiveEditor();
  const view = editor?.view;
  const cursorCard = view && view.dom.checkVisibility?.() !== false && card('At the cursor', AT_CURSOR);
  if (cursorCard) {
    const at = view.coordsAtPos(view.state.selection.main.head);
    const box = view.scrollDOM.getBoundingClientRect();
    const inView = at && at.top >= box.top && at.bottom <= box.bottom;
    layer.append(cursorCard);
    place(cursorCard, inView ? at.left : box.left + 24, inView ? at.bottom + 8 : box.top + 16);
  }

  const anywhere = card('Anywhere', ANYWHERE);
  if (anywhere) {
    anywhere.classList.add('anywhere');
    layer.append(anywhere);
  }
  if (cursorCard) {
    place(cursorCard, parseFloat(cursorCard.style.left), parseFloat(cursorCard.style.top));
    // Never cover the corner card: step left of it, or above it when there's no room.
    if (anywhere) {
      const a = anywhere.getBoundingClientRect();
      const c = cursorCard.getBoundingClientRect();
      if (c.right > a.left - 8 && c.bottom > a.top - 8) {
        if (a.left - 12 - c.width >= 12) cursorCard.style.left = `${a.left - 12 - c.width}px`;
        else cursorCard.style.top = `${Math.max(12, a.top - 12 - c.height)}px`;
      }
    }
  }
  return layer;
}

// Keep a card on screen: flip above the cursor line when there's no room below.
function place(el, left, top) {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  if (!el.isConnected) return;
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 12) el.style.left = `${Math.max(12, window.innerWidth - 12 - r.width)}px`;
  if (r.bottom > window.innerHeight - 40) el.style.top = `${Math.max(12, top - r.height - 32)}px`;
}
