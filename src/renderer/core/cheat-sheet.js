// One page with the shortcuts worth knowing, grouped by what you're trying to do. Keys come from
// the live keymap, so your own bindings show up; click a row to run it.
import { h } from './dom.js';
import { openModal, closeModal, isModalOpen } from './ui.js';
import { prettyBinding, isMac } from './keymap.js';

const mod = isMac ? '⌘' : 'Ctrl+';

const SECTIONS = [
  ['Find your way', [
    ['Go to a file (then > @ # : for more)', 'fuzzy-finder:toggle'],
    ['Run any command, in plain words', 'command-palette:toggle'],
    ['Go to a symbol in this file', 'lsp:go-to-symbol'],
    ['Go to a symbol in the project', 'lsp:go-to-workspace-symbol'],
    ['Go to line', 'editor:go-to-line'],
    ['Back / forward', ['navigate:back', 'navigate:forward']],
    ['Search the project', 'find-in-project:show'],
  ]],
  ['Understand code', [
    ['Go to definition', 'lsp:go-to-definition', `${mod}click`],
    ['Peek definition, without leaving', 'lsp:peek-definition'],
    ['Find every use', 'lsp:find-references'],
    ['Docs and types', null, 'hover the mouse'],
    ['Parameter hints', 'lsp:signature-help'],
    ['Problems', 'lsp:toggle-problems'],
  ]],
  ['Change code', [
    ['Suggestions and snippets', null, 'Ctrl+Space, Tab'],
    ['Quick fix', 'lsp:code-actions'],
    ['Rename everywhere', 'lsp:rename'],
    ['Format the file', 'lsp:format-document'],
    ['Comment / uncomment', 'editor:toggle-comment'],
    ['Select next match', null, `${mod}D`],
    ['Duplicate lines', 'editor:duplicate-lines'],
  ]],
  ['Layout', [
    ['Sidebar', 'sidebar:toggle'],
    ['Terminal', 'terminal:toggle'],
    ['Split right', 'pane:split-right'],
    ['Split down', 'pane:split-down'],
    ['Zen mode', 'window:toggle-zen-mode'],
  ]],
];

export function showCheatSheet(app) {
  if (isModalOpen('cheat-sheet')) return closeModal();
  const keysFor = (id) => app.keymap.bindingsFor(id)[0];
  const row = ([label, ids, extra]) => {
    const list = [ids].flat().filter((id) => id && app.commands.has(id));
    if (ids && !list.length) return null; // its package is turned off
    const keys = list.map((id) => keysFor(id)).filter(Boolean).map((b) => h('kbd', prettyBinding(b)));
    const run = list[0];
    return h(run ? 'button.cheat-row' : 'div.cheat-row', {
      onclick: run ? () => { closeModal(); requestAnimationFrame(() => app.commands.run(run)); } : undefined,
      title: run ? app.commands.get(run).title : undefined,
    }, h('span.cheat-label', label), h('span.cheat-keys', ...keys, extra ? h('span.cheat-extra', keys.length ? `or ${extra}` : extra) : null));
  };
  const link = (text, id) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); closeModal(); app.commands.run(id); } }, text);
  const panel = h('div.cheat-sheet', { tabIndex: -1 },
    h('h2.cheat-title', 'Keyboard cheat sheet'),
    h('div.cheat-grid', ...SECTIONS.map(([title, rows]) => h('section.cheat-section', h('h3', title), ...rows.map(row)))),
    h('div.cheat-footer', `Tip: hold ${isMac ? '⌘' : 'Ctrl'} anywhere to see the keys for what's on screen. Everything else is in the command palette. `, link('All keybindings', 'help:keybindings'), ' · ', link('Change a key', 'settings:open-keymap')));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } });
  openModal(panel, { id: 'cheat-sheet', label: 'Keyboard cheat sheet' });
  requestAnimationFrame(() => panel.focus());
}
