// What a VS Code setup becomes in Minimide: plain data tables and pure functions, no UI.

// --- settings.json ------------------------------------------------------------

const num = (min, max) => (v) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const choice = (map) => (v) => map[v];

// VS Code setting -> Minimide config key. `to` is a config key, or { enable: 'package' } for a
// setting that is a package here (the minimap, sticky scroll). `convert` returns undefined when
// the value has no equivalent.
export const SETTINGS = {
  'editor.fontSize': { to: 'editor.fontSize', convert: num(6, 100) },
  // VS Code writes font names with single quotes; Minimide's default uses double ones.
  'editor.fontFamily': { to: 'editor.fontFamily', convert: (v) => (typeof v === 'string' && v.trim() ? v.replace(/'/g, '"') : undefined) },
  'editor.fontLigatures': { to: 'editor.fontLigatures', convert: (v) => (typeof v === 'boolean' ? v : typeof v === 'string' ? !!v.trim() : undefined) },
  'editor.tabSize': { to: 'editor.tabSize', convert: num(1, 16) },
  'editor.insertSpaces': { to: 'editor.softTabs', convert: bool },
  'editor.wordWrap': { to: 'editor.softWrap', convert: choice({ on: true, bounded: true, wordWrapColumn: true, off: false }) },
  'editor.lineNumbers': { to: 'editor.showLineNumbers', convert: choice({ on: true, relative: true, interval: true, off: false }) },
  'editor.renderWhitespace': { to: 'editor.showInvisibles', convert: choice({ none: false, boundary: true, selection: true, trailing: true, all: true }) },
  'editor.renderLineHighlight': { to: 'editor.highlightActiveLine', convert: choice({ none: false, gutter: true, line: true, all: true }) },
  'editor.lineHeight': { to: 'editor.lineHeight', convert: (v) => (typeof v === 'number' && v >= 1 && v <= 4 ? v : undefined) }, // pixel values don't carry over
  'files.autoSave': { to: 'core.autoSave', convert: choice({ off: 'off', afterDelay: 'afterDelay', onFocusChange: 'onFocusChange', onWindowChange: 'onFocusChange' }) },
  'files.autoSaveDelay': { to: 'core.autoSaveDelay', convert: num(100, 600000) },
  'editor.formatOnSave': { to: 'lsp.formatOnSave', convert: bool },
  'files.trimTrailingWhitespace': { to: 'editor.trimTrailingWhitespace', convert: bool },
  'files.insertFinalNewline': { to: 'editor.ensureFinalNewline', convert: bool },
  'editor.minimap.enabled': { enable: 'minimap', convert: bool },
  'editor.stickyScroll.enabled': { enable: 'sticky-scroll', convert: bool },
};

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * { items, skipped, theme }: what can be imported from a parsed settings.json. `items` have the
 * VS Code key, the Minimide target, and the converted value; `skipped` lists the keys with no
 * equivalent (or a value that has none). `theme` is workbench.colorTheme, handled separately.
 */
export function mapSettings(settings) {
  const items = [];
  const skipped = [];
  let theme = null;
  for (const [key, value] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
    if (key === 'workbench.colorTheme') { if (typeof value === 'string' && value.trim()) theme = value.trim(); continue; }
    const rule = SETTINGS[key];
    const converted = rule ? rule.convert(value) : undefined;
    if (converted === undefined) { skipped.push(key); continue; }
    items.push({ key, from: show(value), ...(rule.enable ? { enable: rule.enable } : { to: rule.to }), value: converted });
  }
  return { items, skipped, theme };
}

// --- themes ---------------------------------------------------------------------

// VS Code themes that ship with it (or are everywhere) and have a close Minimide cousin.
export const BUILTIN_THEMES = {
  'default dark+': 'nightfall', 'dark+': 'nightfall', 'default dark modern': 'nightfall', 'dark modern': 'nightfall', 'visual studio dark': 'nightfall',
  'default light+': 'daylight', 'light+': 'daylight', 'default light modern': 'daylight', 'light modern': 'daylight', 'visual studio light': 'daylight',
  'solarized light': 'solstice',
  monokai: 'volcano', 'monokai dimmed': 'volcano',
  dracula: 'nocturne', 'dracula official': 'nocturne', 'dracula soft': 'nocturne',
  nord: 'fjord',
  'tokyo night': 'metro', 'tokyo night storm': 'metro',
  'gruvbox dark hard': 'harvest', 'gruvbox dark medium': 'harvest', 'gruvbox dark soft': 'harvest',
  'catppuccin mocha': 'cocoa', 'catppuccin macchiato': 'cocoa', 'catppuccin frappé': 'cocoa',
  abyss: 'abyss',
  'default high contrast': 'contrast', 'high contrast': 'contrast',
};

/** The Minimide theme package matching a VS Code theme name, or null. `themes`: [{ name, displayName }]. */
export function builtinThemeFor(vscodeName, themes) {
  const wanted = String(vscodeName).trim().toLowerCase();
  const exact = themes.find((t) => (t.displayName || t.name).toLowerCase() === wanted);
  if (exact) return exact;
  const mapped = BUILTIN_THEMES[wanted];
  return mapped ? themes.find((t) => t.name === mapped) || null : null;
}

// --- keybindings.json -----------------------------------------------------------

// VS Code command id -> Minimide command id, where there is a clear equivalent.
export const COMMANDS = {
  'workbench.action.quickOpen': 'fuzzy-finder:toggle',
  'workbench.action.quickOpenView': 'fuzzy-finder:toggle-open-tabs',
  'workbench.action.showCommands': 'command-palette:toggle',
  'workbench.action.files.save': 'file:save',
  'workbench.action.files.saveAll': 'file:save-all',
  'workbench.action.files.saveAs': 'file:save-as',
  'workbench.action.files.revert': 'file:revert',
  'workbench.action.files.newUntitledFile': 'file:new',
  'workbench.action.files.openFile': 'file:open',
  'workbench.action.files.openFolder': 'project:open-folder',
  'workbench.action.openRecent': 'project:open-recent',
  'workbench.action.files.copyPathOfActiveFile': 'file:copy-path',
  'workbench.action.files.copyRelativePathOfActiveFile': 'file:copy-relative-path',
  'workbench.action.files.revealActiveFileInWindows': 'file:reveal-in-finder',
  'workbench.action.closeActiveEditor': 'tab:close',
  'workbench.action.closeOtherEditors': 'tab:close-others',
  'workbench.action.closeAllEditors': 'tab:close-all',
  'workbench.action.reopenClosedEditor': 'tab:reopen-closed',
  'workbench.action.nextEditor': 'tab:next',
  'workbench.action.previousEditor': 'tab:previous',
  'workbench.action.openEditorAtIndex1': 'tab:go-1', 'workbench.action.openEditorAtIndex2': 'tab:go-2',
  'workbench.action.openEditorAtIndex3': 'tab:go-3', 'workbench.action.openEditorAtIndex4': 'tab:go-4',
  'workbench.action.openEditorAtIndex5': 'tab:go-5', 'workbench.action.openEditorAtIndex6': 'tab:go-6',
  'workbench.action.openEditorAtIndex7': 'tab:go-7', 'workbench.action.openEditorAtIndex8': 'tab:go-8',
  'workbench.action.openEditorAtIndex9': 'tab:go-last',
  'workbench.action.splitEditor': 'pane:split-right',
  'workbench.action.splitEditorRight': 'pane:split-right',
  'workbench.action.focusNextGroup': 'pane:focus-next',
  'workbench.action.focusPreviousGroup': 'pane:focus-previous',
  'workbench.action.toggleSidebarVisibility': 'sidebar:toggle',
  'workbench.action.togglePanel': 'panel:toggle',
  'workbench.action.terminal.toggleTerminal': 'terminal:toggle',
  'workbench.action.terminal.new': 'terminal:new',
  'workbench.action.terminal.kill': 'terminal:kill',
  'workbench.action.terminal.clear': 'terminal:clear',
  'workbench.action.terminal.runSelectedText': 'terminal:run-selection',
  'workbench.action.navigateBack': 'navigate:back',
  'workbench.action.navigateForward': 'navigate:forward',
  'workbench.action.gotoLine': 'editor:go-to-line',
  'workbench.action.gotoSymbol': 'lsp:go-to-symbol',
  'workbench.action.showAllSymbols': 'lsp:go-to-workspace-symbol',
  'workbench.action.findInFiles': 'find-in-project:show',
  'workbench.action.replaceInFiles': 'find-in-project:show-replace',
  'workbench.view.explorer': 'tree-view:focus',
  'workbench.files.action.showActiveFileInExplorer': 'tree-view:reveal-active-file',
  'workbench.files.action.collapseExplorerFolders': 'tree-view:collapse-all',
  'explorer.newFile': 'tree-view:new-file',
  'explorer.newFolder': 'tree-view:new-folder',
  'workbench.view.scm': 'source-control:show',
  'workbench.action.openSettings': 'settings:open',
  'workbench.action.openGlobalSettings': 'settings:open',
  'workbench.action.openSettingsJson': 'settings:open-config-file',
  'workbench.action.openGlobalKeybindings': 'settings:open-keybindings',
  'workbench.action.openGlobalKeybindingsFile': 'settings:open-keymap',
  'workbench.action.selectTheme': 'theme:select',
  'workbench.action.toggleZenMode': 'window:toggle-zen-mode',
  'workbench.action.toggleFullScreen': 'window:toggle-full-screen',
  'workbench.action.reloadWindow': 'window:reload',
  'workbench.action.newWindow': 'window:new',
  'workbench.action.closeWindow': 'window:close',
  'workbench.action.toggleDevTools': 'window:toggle-dev-tools',
  'workbench.actions.view.problems': 'lsp:toggle-problems',
  'workbench.action.tasks.build': 'runner:run-task',
  'workbench.action.editor.changeLanguageMode': 'editor:set-language',
  'editor.action.commentLine': 'editor:toggle-comment',
  'editor.action.revealDefinition': 'lsp:go-to-definition',
  'editor.action.peekDefinition': 'lsp:peek-definition',
  'editor.action.goToReferences': 'lsp:find-references',
  'editor.action.referenceSearch.trigger': 'lsp:find-references',
  'editor.action.goToImplementation': 'lsp:go-to-implementation',
  'editor.action.goToTypeDefinition': 'lsp:go-to-type-definition',
  'editor.action.rename': 'lsp:rename',
  'editor.action.formatDocument': 'lsp:format-document',
  'editor.action.quickFix': 'lsp:code-actions',
  'editor.action.triggerParameterHints': 'lsp:signature-help',
  'editor.action.copyLinesDownAction': 'editor:duplicate-lines',
  'editor.action.deleteLines': 'editor:delete-line',
  'editor.action.moveLinesUpAction': 'editor:move-line-up',
  'editor.action.moveLinesDownAction': 'editor:move-line-down',
  'expandLineSelection': 'editor:select-line',
  'editor.action.jumpToBracket': 'editor:go-to-matching-bracket',
  'editor.action.joinLines': 'editor:join-lines',
  'editor.action.transformToUppercase': 'editor:upper-case',
  'editor.action.transformToLowercase': 'editor:lower-case',
  'editor.action.transformToTitlecase': 'editor:title-case',
  'editor.action.sortLinesAscending': 'editor:sort-lines',
  'editor.action.sortLinesDescending': 'editor:sort-lines-reverse',
  'editor.action.trimTrailingWhitespace': 'editor:trim-trailing-whitespace',
  'editor.action.toggleWordWrap': 'editor:toggle-soft-wrap',
  'editor.action.fontZoomIn': 'editor:font-increase',
  'editor.action.fontZoomOut': 'editor:font-decrease',
  'editor.action.fontZoomReset': 'editor:font-reset',
  'editor.action.toggleMinimap': 'minimap:toggle',
  'markdown.showPreview': 'markdown-preview:toggle',
  'markdown.showPreviewToSide': 'markdown-preview:toggle',
  'git.checkout': 'git:checkout-branch',
};

const KEY_NAMES = {
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', pageup: 'PageUp', pagedown: 'PageDown',
  home: 'Home', end: 'End', enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
};
// "[BracketLeft]" is how VS Code names a key by its position.
const POSITION_KEYS = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'" };
const MODIFIER = /^(ctrl|control|shift|alt|option|cmd|command|meta|win|windows|super)\+(.+)$/i;

/**
 * One VS Code keystroke ("ctrl+shift+p") as a Minimide one ("Mod-Shift-p"), or null if it has no
 * equivalent (numpad keys, …). VS Code's cmd is ⌘ on a Mac and ctrl is Ctrl; elsewhere ctrl is the
 * "Mod" key and the Windows/Super key is Cmd.
 */
export function convertStroke(stroke, isMac) {
  const mods = new Set();
  let rest = String(stroke).trim();
  for (let m; (m = MODIFIER.exec(rest));) {
    const name = m[1].toLowerCase();
    if (name === 'shift') mods.add('Shift');
    else if (name === 'alt' || name === 'option') mods.add('Alt');
    else if (name === 'ctrl' || name === 'control') mods.add(isMac ? 'Ctrl' : 'Mod');
    else mods.add(isMac ? 'Mod' : 'Cmd');
    rest = m[2];
  }
  let key;
  const lower = rest.toLowerCase();
  const position = /^\[(\w+)\]$/.exec(rest);
  if (position) key = POSITION_KEYS[position[1]];
  else if (KEY_NAMES[lower]) key = KEY_NAMES[lower];
  else if (/^f([1-9]|1[0-9])$/.test(lower)) key = lower.toUpperCase();
  else if (rest.length === 1 && rest !== ' ') key = rest.toLowerCase();
  if (!key) return null;
  return [...['Mod', 'Cmd', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('-');
}

/** "cmd+k cmd+s" as "Mod-k Mod-s", or null. */
export function convertKey(key, isMac) {
  const strokes = String(key).trim().split(/\s+/).map((s) => convertStroke(s, isMac));
  return strokes.length && strokes.every(Boolean) ? strokes.join(' ') : null;
}

/**
 * Map a parsed keybindings.json. `current` is Map<binding, command> of the keys Minimide has now
 * (to tell which removals matter); `normalize` is mide.keymap.normalize. Returns
 * { bindings: [{ binding, command, vscode, key, when }], removals: [{ binding, command }], skipped: [{ key, command, reason }] }.
 * Later entries win, as in VS Code.
 */
export function mapKeybindings(list, { isMac, current = new Map(), normalize = (b) => b }) {
  const out = new Map(); // binding -> { binding, command|null, ... }
  const skipped = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.command !== 'string') continue;
    const removing = entry.command.startsWith('-');
    const vscode = removing ? entry.command.slice(1) : entry.command;
    const command = COMMANDS[vscode];
    const skip = (reason) => skipped.push({ key: entry.key, command: entry.command, reason });
    if (!command) { skip('no matching command'); continue; }
    const binding = convertKey(entry.key, isMac);
    if (!binding) { skip('key not supported'); continue; }
    try { normalize(binding); } catch { skip('key not supported'); continue; }
    if (removing) {
      // Unbind the key only if Minimide really has this command there.
      if (current.get(normalize(binding)) === command && !out.has(binding)) out.set(binding, { binding, command: null, removes: command, vscode, key: entry.key, removal: true });
      continue;
    }
    if (entry.args !== undefined) { skip('has arguments'); continue; }
    out.set(binding, { binding, command, vscode, key: entry.key, when: typeof entry.when === 'string' ? entry.when : null });
  }
  const all = [...out.values()];
  return { bindings: all.filter((b) => !b.removal), removals: all.filter((b) => b.removal), skipped };
}

// --- writing keymap.json ----------------------------------------------------------

/** Index of the last character that isn't whitespace or inside a comment, and of the last "}". */
function significant(text) {
  let last = -1;
  let lastBrace = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      last = i = j;
    } else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else if (!/\s/.test(c)) { last = i; if (c === '}') lastBrace = i; }
  }
  return { last, lastBrace };
}

/**
 * Add `entries` ({ binding: command|null }) to keymap.json text as a clearly marked block at the
 * end, leaving everything already in the file (comments included) untouched. Later keys win, so
 * these take effect over earlier entries for the same key.
 */
export function appendKeymapBlock(text, entries, label) {
  const lines = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const block = [`  // --- Imported from ${label} ---`, ...lines, '  // --- end of import ---'].join('\n');
  const { last, lastBrace } = significant(text);
  if (lastBrace < 0 || lastBrace !== last) return `{\n${block}\n}\n`;
  const before = text.slice(0, lastBrace);
  // A property just before the block needs a comma after it.
  const idx = significant(before).last;
  const needsComma = idx >= 0 && before[idx] !== '{' && before[idx] !== ',';
  const head = needsComma ? before.slice(0, idx + 1) + ',' + before.slice(idx + 1) : before;
  return `${head.replace(/\s*$/, '')}\n\n${block}\n${text.slice(lastBrace)}`;
}

// --- snippets ----------------------------------------------------------------------

/** How many snippets a parsed snippets file defines. */
export function countSnippets(data) {
  return data && typeof data === 'object' ? Object.values(data).filter((d) => d && typeof d === 'object').length : 0;
}
