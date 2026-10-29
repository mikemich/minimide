// Core commands and their default keybindings. Packages add the rest.
import { EditorSelection } from '@codemirror/state';
import { copyLineDown, selectLine, cursorMatchingBracket, toggleComment, deleteLine, moveLineUp, moveLineDown } from '@codemirror/commands';
import { basename } from './dom.js';
import { isMac } from './keymap.js';
import { showCheatSheet } from './cheat-sheet.js';

export const CORE_KEYMAP = {
  'Mod-n': 'file:new',
  'Mod-o': 'file:open',
  'Mod-Shift-o': 'project:open-folder',
  'Mod-s': 'file:save',
  'Mod-Shift-s': 'file:save-as',
  'Mod-Alt-s': 'file:save-all',
  'Mod-w': 'tab:close',
  'Mod-Shift-t': 'tab:reopen-closed',
  'Ctrl-Tab': 'tab:next',
  'Ctrl-Shift-Tab': 'tab:previous',
  'Mod-Shift-]': 'tab:next',
  'Mod-Shift-[': 'tab:previous',
  'Mod-1': 'tab:go-1', 'Mod-2': 'tab:go-2', 'Mod-3': 'tab:go-3', 'Mod-4': 'tab:go-4', 'Mod-5': 'tab:go-5',
  'Mod-6': 'tab:go-6', 'Mod-7': 'tab:go-7', 'Mod-8': 'tab:go-8', 'Mod-9': 'tab:go-last',
  'Mod-\\': 'pane:split-right',
  'Mod-k Mod-\\': 'pane:split-down',
  'Mod-k Mod-ArrowUp': 'pane:focus-above',
  'Mod-k Mod-ArrowDown': 'pane:focus-below',
  'Mod-k Mod-ArrowRight': 'pane:focus-next',
  'Mod-k Mod-ArrowLeft': 'pane:focus-previous',
  'Mod-k Mod-w': 'pane:close',
  'Mod-k Mod-s': 'help:keybindings',
  'Mod-k Mod-Shift-s': 'settings:open-keybindings',
  'Mod-b': 'sidebar:toggle',
  'Ctrl-`': 'panel:toggle',
  'Mod-Shift-n': 'window:new',
  'Mod-Shift-w': 'window:close',
  'Mod-Alt-Ctrl-l': 'window:reload',
  'Mod-Alt-i': 'window:toggle-dev-tools',
  'Mod-=': 'editor:font-increase',
  'Mod-Shift-=': 'editor:font-increase',
  'Mod--': 'editor:font-decrease',
  'Mod-0': 'editor:font-reset',
  'Ctrl-g': 'editor:go-to-line',
  'Alt-z': 'editor:toggle-soft-wrap',
  'Mod-Shift-d': 'editor:duplicate-lines',
  'Mod-l': 'editor:select-line',
  'Ctrl-m': 'editor:go-to-matching-bracket',
  'Mod-,': 'settings:open',
  'Mod-/': 'editor:toggle-comment',
  'Mod-Shift-k': 'editor:delete-line',
  'Alt-ArrowUp': 'editor:move-line-up',
  'Alt-ArrowDown': 'editor:move-line-down',
  'Mod-k Mod-h': 'help:cheat-sheet',
  'Escape': 'core:cancel',
  // Back / forward after a jump, as in VS Code.
  ...(isMac ? { 'Ctrl--': 'navigate:back', 'Ctrl-Shift--': 'navigate:forward' } : { 'Alt-ArrowLeft': 'navigate:back', 'Alt-ArrowRight': 'navigate:forward' }),
};

export function registerCoreCommands(app) {
  const { workspace: ws, commands, config, ui } = app;
  const editor = () => ws.getActiveEditor();
  const hasEditor = () => !!editor();
  const view = () => editor()?.view;
  // The text itself has focus: not a peek preview, which lives in the editor's tooltip layer.
  const editorFocused = () => !!view() && view().contentDOM.contains(document.activeElement);
  const userFile = (name) => `${app.userInfo.dir}/${name}`;

  const transformSelection = (fn) => () => {
    const v = view();
    if (!v) return;
    v.dispatch(v.state.changeByRange((range) => {
      if (range.empty) return { range };
      const text = fn(v.state.sliceDoc(range.from, range.to));
      return { changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.range(range.from, range.from + text.length) };
    }));
  };

  const transformLines = (fn) => () => {
    const v = view();
    if (!v) return;
    const { state } = v;
    const sel = state.selection.main;
    const from = state.doc.lineAt(sel.from).from;
    const to = state.doc.lineAt(sel.to).to;
    const lines = state.sliceDoc(from, to).split('\n');
    const text = fn(lines).join('\n');
    v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.range(from, from + text.length) });
  };

  commands.add({
    // --- files -------------------------------------------------------------
    'file:new': { title: 'New File', run: () => ws.newFile() },
    'file:open': {
      title: 'Open File…',
      run: async () => { for (const p of await window.native.dialog.openFile()) await ws.open(p); },
    },
    'file:save': { title: 'Save', run: () => ws.save(), when: () => !!ws.getActiveItem() },
    'file:save-as': { title: 'Save As…', run: () => ws.saveAs(), when: hasEditor },
    'file:save-all': { title: 'Save All', run: () => ws.saveAll() },
    'file:revert': { title: 'Revert to Saved', run: () => ws.revert(), when: () => !!editor()?.getPath() },
    'file:rename': {
      title: 'Rename / Move Current File…',
      when: () => !!editor()?.getPath(),
      run: async () => {
        const item = editor();
        const old = item.getPath();
        const target = await ui.prompt({ title: 'Enter the new path for the file.', value: old, selection: [old.lastIndexOf('/') + 1, old.length] });
        if (!target || target === old) return;
        // Case-only renames hit the same file on case-insensitive disks (macOS), so allow them.
        const caseOnly = target.toLowerCase() === old.toLowerCase();
        if (!caseOnly && await window.native.fs.stat(target)) return ui.notify.error('A file with that name already exists.');
        try {
          await window.native.fs.mkdir(target.slice(0, target.lastIndexOf('/')));
          await window.native.fs.rename(old, target);
        } catch (err) { return ui.notify.error('Rename failed', err.message); }
        ws.renamePath(old, target);
      },
    },
    'file:copy-path': { title: 'Copy Path', when: () => !!ws.getActiveItem()?.getPath?.(), run: () => window.native.clipboard.write(ws.getActiveItem().getPath()) },
    'file:copy-relative-path': { title: 'Copy Relative Path', when: () => !!ws.getActiveItem()?.getPath?.(), run: () => window.native.clipboard.write(ws.relativePath(ws.getActiveItem().getPath())) },
    'file:reveal-in-finder': { title: 'Reveal in Finder', when: () => !!ws.getActiveItem()?.getPath?.(), run: () => window.native.shell.reveal(ws.getActiveItem().getPath()) },

    // --- project -----------------------------------------------------------
    'project:open-folder': {
      title: 'Open Folder…',
      run: async () => { const p = await window.native.dialog.openFolder(); if (p) await app.openProject(p); },
    },
    'project:add-folder': {
      title: 'Add Folder to Project…',
      run: async () => { const p = await window.native.dialog.openFolder(); if (p) await app.addFolder(p); },
    },
    'project:remove-folder': {
      title: 'Remove Folder from Project',
      when: () => ws.folders.length > 1,
      run: (opts = {}) => (opts.path ? app.removeFolder(opts.path) : ui.selectList({
        id: 'remove-folder',
        placeholder: 'Remove a folder from the project (its files stay on disk)',
        items: ws.folders.map((p) => ({ label: basename(p), detail: p.replace(app.userInfo.home, '~'), path: p })),
        filterKey: (i) => i.detail,
        onSelect: (i) => app.removeFolder(i.path),
      })),
    },
    'project:open-recent': {
      title: 'Open Recent Project…',
      run: () => ui.selectList({
        id: 'recent-projects',
        placeholder: 'Open a recent project',
        items: (app.state.recentProjects || []).map((p) => ({ label: basename(p), detail: p.replace(app.userInfo.home, '~'), path: p })),
        filterKey: (i) => i.detail,
        onSelect: (i) => app.openProject(i.path),
      }),
    },

    // --- tabs & panes ------------------------------------------------------
    'tab:close': { title: 'Close Tab', run: () => { const i = ws.getActiveItem(); if (i) ws.closeItem(i); else if (ws.panes.length > 1) ws.removePane(ws.activePane); } },
    'tab:close-others': {
      title: 'Close Other Tabs',
      run: async () => { const keep = ws.getActiveItem(); for (const i of ws.activePane.items.filter((x) => x !== keep)) if (!await ws.closeItem(i)) break; },
    },
    'tab:close-to-left': {
      title: 'Close Tabs to the Left',
      run: async () => { const p = ws.activePane, at = p.items.indexOf(ws.getActiveItem()); for (const i of p.items.slice(0, Math.max(0, at))) if (!await ws.closeItem(i)) break; },
    },
    'tab:close-to-right': {
      title: 'Close Tabs to the Right',
      run: async () => { const p = ws.activePane, at = p.items.indexOf(ws.getActiveItem()); if (at >= 0) for (const i of p.items.slice(at + 1)) if (!await ws.closeItem(i)) break; },
    },
    'tab:close-all': { title: 'Close All Tabs', run: async () => { for (const i of ws.allItems()) if (!await ws.closeItem(i)) break; } },
    'tab:reopen-closed': {
      title: 'Reopen Closed Tab',
      run: async () => { const p = app.closedPaths.shift(); if (p) await ws.open(p); },
    },
    'tab:next': { title: 'Next Tab', run: () => cycleTab(ws, 1) },
    'tab:previous': { title: 'Previous Tab', run: () => cycleTab(ws, -1) },
    'tab:go-last': { title: 'Go to Last Tab', hidden: true, run: () => { const p = ws.activePane; const last = p.items.at(-1); if (last) p.activate(last); } },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`tab:go-${n}`, {
      title: `Go to Tab ${n}`, hidden: true,
      run: () => { const p = ws.activePane; const it = p.items[n - 1]; if (it) { p.activate(it); it.focus(); } },
    }])),
    'pane:split-right': { title: 'Split Right', run: () => ws.splitRight() },
    'pane:split-down': { title: 'Split Down', run: () => ws.splitDown() },
    'pane:focus-next': { title: 'Focus Next Pane', run: () => ws.focusPaneOffset(1) },
    'pane:focus-previous': { title: 'Focus Previous Pane', run: () => ws.focusPaneOffset(-1) },
    'pane:focus-above': { title: 'Focus Pane Above', run: () => ws.focusPaneVertical(-1) },
    'pane:focus-below': { title: 'Focus Pane Below', run: () => ws.focusPaneVertical(1) },
    'pane:close': { title: 'Close Pane', run: () => ws.closeActivePane() },

    // --- layout ------------------------------------------------------------
    'sidebar:toggle': { title: 'Toggle Sidebar', run: () => app.sidebar.toggle() },
    'panel:toggle': { title: 'Toggle Bottom Panel', run: () => app.panel.toggle() },
    'core:cancel': {
      title: 'Cancel', hidden: true,
      // Escape closes the bottom panel when focus is inside it; otherwise it falls through to the editor.
      when: () => app.panel.visible && document.getElementById('panel').contains(document.activeElement) && !document.activeElement.closest('[data-keymap-passthrough]'),
      run: () => { app.panel.hide(); ws.getActiveItem()?.focus(); },
    },
    'window:new': { title: 'New Window', run: () => window.native.window.newWindow() },
    'window:close': { title: 'Close Window', run: () => app.requestClose() },
    'window:reload': {
      title: 'Reload Window',
      run: async () => {
        if (!await app.confirmUnsaved('reload')) return; // reloading would drop unsaved edits
        app.saveSession(); await app.persistState(); window.native.window.reload();
      },
    },
    'window:toggle-dev-tools': { title: 'Toggle Developer Tools', run: () => window.native.window.toggleDevTools() },
    'window:toggle-full-screen': { title: 'Toggle Full Screen', run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) },
    'window:toggle-zen-mode': {
      title: 'Toggle Zen Mode',
      run: () => {
        const on = document.body.classList.toggle('zen');
        if (on) { app.zenRestore = { sidebar: app.sidebar.visible, panel: app.panel.visible }; app.sidebar.hide(); app.panel.hide(); }
        else if (app.zenRestore) { if (app.zenRestore.sidebar) app.sidebar.show(); if (app.zenRestore.panel) app.panel.show(); }
      },
    },

    // --- editor ------------------------------------------------------------
    'editor:font-increase': { title: 'Increase Font Size', run: () => config.set('editor.fontSize', Math.min(40, config.get('editor.fontSize') + 1)) },
    'editor:font-decrease': { title: 'Decrease Font Size', run: () => config.set('editor.fontSize', Math.max(8, config.get('editor.fontSize') - 1)) },
    'editor:font-reset': { title: 'Reset Font Size', run: () => config.set('editor.fontSize', undefined) },
    'editor:toggle-soft-wrap': { title: 'Toggle Soft Wrap', run: () => config.set('editor.softWrap', !config.get('editor.softWrap')) },
    'editor:toggle-line-numbers': { title: 'Toggle Line Numbers', run: () => config.set('editor.showLineNumbers', !config.get('editor.showLineNumbers')) },
    'editor:toggle-invisibles': { title: 'Toggle Invisibles', run: () => config.set('editor.showInvisibles', !config.get('editor.showInvisibles')) },
    'editor:toggle-bracket-pair-colors': { title: 'Toggle Bracket Pair Colors', run: () => config.set('editor.bracketPairColors', !config.get('editor.bracketPairColors')) },
    'editor:go-to-line': { title: 'Go to Line…', when: hasEditor, run: () => app.quickOpen.open(':') },
    'editor:duplicate-lines': { title: 'Duplicate Lines', when: hasEditor, run: () => copyLineDown(view()) },
    'editor:select-line': { title: 'Select Line', when: hasEditor, run: () => selectLine(view()) },
    'editor:toggle-comment': { title: 'Toggle Comment', when: editorFocused, run: () => toggleComment(view()) },
    'editor:delete-line': { title: 'Delete Line', when: editorFocused, run: () => deleteLine(view()) },
    'editor:move-line-up': { title: 'Move Line Up', when: editorFocused, run: () => moveLineUp(view()) },
    'editor:move-line-down': { title: 'Move Line Down', when: editorFocused, run: () => moveLineDown(view()) },
    'editor:go-to-matching-bracket': { title: 'Go to Matching Bracket', when: hasEditor, run: () => cursorMatchingBracket(view()) },
    'editor:upper-case': { title: 'Transform to Upper Case', when: hasEditor, run: transformSelection((s) => s.toUpperCase()) },
    'editor:lower-case': { title: 'Transform to Lower Case', when: hasEditor, run: transformSelection((s) => s.toLowerCase()) },
    'editor:title-case': { title: 'Transform to Title Case', when: hasEditor, run: transformSelection((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())) },
    'editor:sort-lines': { title: 'Sort Lines', when: hasEditor, run: transformLines((ls) => [...ls].sort((a, b) => a.localeCompare(b))) },
    'editor:sort-lines-reverse': { title: 'Sort Lines (Reverse)', when: hasEditor, run: transformLines((ls) => [...ls].sort((a, b) => b.localeCompare(a))) },
    'editor:unique-lines': { title: 'Remove Duplicate Lines', when: hasEditor, run: transformLines((ls) => [...new Set(ls)]) },
    'editor:reverse-lines': { title: 'Reverse Lines', when: hasEditor, run: transformLines((ls) => [...ls].reverse()) },
    'editor:join-lines': { title: 'Join Lines', when: hasEditor, run: transformLines((ls) => [ls.map((l, i) => (i ? l.trimStart() : l)).join(' ')]) },
    'editor:trim-trailing-whitespace': { title: 'Trim Trailing Whitespace', when: hasEditor, run: () => trimTrailing(view()) },
    'editor:set-language': {
      title: 'Set Language Mode…', when: hasEditor,
      run: async () => {
        const { languages } = await import('./editor.js');
        const item = editor();
        ui.selectList({
          id: 'language', placeholder: 'Select a language mode',
          items: [{ label: 'Plain Text', lang: null }, ...languages.map((l) => ({ label: l.name, detail: l.extensions.map((e) => `.${e}`).join(' '), lang: l }))],
          onSelect: (it) => { item.document.language = it.lang; for (const v of item.document.views) v.applyLanguage(); },
        });
      },
    },
    'editor:set-indentation': {
      title: 'Set Indentation…',
      run: () => ui.selectList({
        id: 'indent', placeholder: 'Indentation',
        items: [
          { label: 'Spaces: 2', softTabs: true, size: 2 }, { label: 'Spaces: 4', softTabs: true, size: 4 },
          { label: 'Tabs: 2 wide', softTabs: false, size: 2 }, { label: 'Tabs: 4 wide', softTabs: false, size: 4 },
        ],
        onSelect: async (it) => { await config.set('editor.softTabs', it.softTabs); await config.set('editor.tabSize', it.size); },
      }),
    },

    // --- settings & hacking ------------------------------------------------
    'settings:open-config-file': { title: 'Open Config File', run: () => ws.open(userFile('config.json')) },
    'settings:open-keymap': { title: 'Open Your Keymap', run: () => ws.open(userFile('keymap.json')) },
    'settings:open-init-script': { title: 'Open Your Init Script', run: () => ws.open(userFile('init.js')) },
    'settings:open-stylesheet': { title: 'Open Your Stylesheet', run: () => ws.open(userFile('styles.css')) },
    'packages:open-folder': { title: 'Open Packages Folder', run: () => window.native.shell.openPath(app.userInfo.packagesDir) },
    'packages:create': { title: 'Create New Package…', run: () => createPackage(app) },
    'packages:reload': {
      title: 'Reload Package…',
      run: () => ui.selectList({
        id: 'reload-pkg', placeholder: 'Reload which package?',
        items: [...app.packages.packages.values()].filter((p) => p.active).map((p) => ({ label: p.meta.name, detail: p.meta.manifest.description || '' })),
        onSelect: async (it) => { await app.packages.reload(it.label); ui.notify.info(`Reloaded ${it.label}`); },
      }),
    },
    'workspace:trust-folder': {
      title: 'Trust This Folder…',
      run: () => (ws.project ? app.trust.prompt() : ui.notify.info('Open a folder first.')),
    },
    'workspace:manage-trusted-folders': {
      title: 'Manage Trusted Folders…',
      run: () => ui.selectList({
        id: 'trusted-folders', placeholder: 'Select a folder to stop trusting it',
        items: app.trust.folders.map((t) => ({ label: t.path.split('/').pop() || t.path, detail: t.path, path: t.path })),
        emptyMessage: 'No trusted folders yet.',
        onSelect: async (it) => { await app.trust.untrust(it.path); ui.notify.info(`No longer trusting ${it.label}`); },
      }),
    },
    'app:check-for-updates': { title: 'Check for Updates…', run: () => app.checkForUpdates({ manual: true }) },
    'packages:install': {
      title: 'Install Package…',
      run: async (source) => {
        source ??= await ui.prompt({ title: 'Install a package from GitHub', placeholder: 'owner/name or https://github.com/owner/name' });
        if (source) await app.packages.install(source);
      },
    },
    'packages:install-from-folder': {
      title: 'Install Package from Folder…',
      run: async () => {
        const dir = await window.native.dialog.openFolder();
        if (dir) await app.packages.install(dir);
      },
    },
    'packages:check-for-updates': {
      title: 'Check for Package Updates',
      run: async () => {
        let updates;
        try { updates = await window.native.pkgmgr.checkUpdates(); } catch (err) { return ui.notify.error("Couldn't check for updates", err.message); }
        const ready = updates.filter((u) => !u.error);
        if (!ready.length) return ui.notify.info(updates.length ? "Couldn't check some packages" : 'All installed packages are up to date', updates.map((u) => `${u.name}: ${u.error}`).join('\n') || undefined);
        ui.notify.info(`${ready.length} package update${ready.length === 1 ? '' : 's'} available`, ready.map((u) => u.name).join(', '), {
          timeout: 0,
          actions: [{ label: 'Update All', run: async () => { for (const u of ready) await app.packages.install(u.source); } }],
        });
      },
    },
    'packages:uninstall': {
      title: 'Uninstall Package…',
      run: () => ui.selectList({
        id: 'uninstall-package', placeholder: 'Uninstall a package',
        items: [...app.packages.packages.values()].filter((p) => !p.meta.builtin).map((p) => ({ label: p.meta.name, detail: p.meta.install ? `from ${p.meta.install.source.replace(/^github:/, '')}` : 'local folder' })),
        emptyMessage: 'No packages installed. Built-in packages can be turned off in Settings → Packages.',
        onSelect: async (it) => {
          const choice = await window.native.dialog.confirm({ message: `Uninstall "${it.label}"?`, detail: 'Its folder is moved to the Trash.', buttons: ['Uninstall', 'Cancel'] });
          if (choice === 0) { await app.packages.uninstall(it.label); ui.notify.success(`Uninstalled ${it.label}`); }
        },
      }),
    },
    'theme:select': {
      title: 'Select Theme…',
      run: () => {
        const original = config.get('core.theme');
        let chosen = false;
        ui.selectList({
          id: 'theme', placeholder: 'Select a theme (↑↓ to preview)',
          items: app.packages.themes().map((p) => ({ label: p.meta.manifest.displayName || p.meta.name, detail: p.meta.manifest.description || '', name: p.meta.name })),
          onHighlight: (it) => app.packages.setTheme(it.name),
          onSelect: (it) => { chosen = true; config.set('core.theme', it.name); },
          onCancel: () => { if (!chosen) app.packages.setTheme(original); },
        });
      },
    },
    'navigate:back': { title: 'Go Back', run: () => app.navigation.goBack() },
    'navigate:forward': { title: 'Go Forward', run: () => app.navigation.goForward() },
    'help:cheat-sheet': { title: 'Keyboard Cheat Sheet', run: () => showCheatSheet(app) },
    'help:plugin-docs': { title: 'Plugin API Docs', run: () => ws.open(`${app.userInfo.appRoot}/docs/PLUGINS.md`) },
    'help:keybindings': {
      title: 'Show Keybindings',
      run: async () => {
        const { prettyBinding } = await import('./keymap.js');
        ui.selectList({
          id: 'keybindings', placeholder: 'Search keybindings',
          items: [...app.keymap.resolved()].map(([k, id]) => ({ label: commands.get(id)?.title || id, detail: id, hint: prettyBinding(k), id }))
            .sort((a, b) => a.label.localeCompare(b.label)),
          filterKey: (i) => `${i.label} ${i.detail}`,
          onSelect: (i) => commands.run(i.id),
        });
      },
    },
  });

  // Save hooks for whitespace settings.
  ws.onWillSave((item) => {
    const v = item.view;
    if (config.get('editor.trimTrailingWhitespace')) trimTrailing(v);
    if (config.get('editor.ensureFinalNewline')) {
      const doc = v.state.doc;
      if (doc.length && doc.sliceString(doc.length - 1) !== '\n') v.dispatch({ changes: { from: doc.length, insert: '\n' } });
    }
  });
}

function trimTrailing(v) {
  if (!v) return;
  const changes = [];
  const { doc } = v.state;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /[ \t]+$/.exec(line.text);
    if (m) changes.push({ from: line.from + m.index, to: line.to });
  }
  if (changes.length) v.dispatch({ changes });
}

function cycleTab(ws, delta) {
  const pane = ws.activePane;
  if (!pane.items.length) return;
  const i = (pane.items.indexOf(pane.active) + delta + pane.items.length) % pane.items.length;
  pane.activate(pane.items[i]);
  pane.items[i].focus();
}

async function createPackage(app) {
  const name = await app.ui.prompt({
    title: 'Name your package (lowercase, dashes).',
    placeholder: 'my-package',
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'Use lowercase letters, numbers and dashes.'),
  });
  if (!name) return;
  const dir = `${app.userInfo.packagesDir}/${name}`;
  if (await window.native.fs.stat(dir)) return app.ui.notify.error(`A package named "${name}" already exists.`);
  const fs = window.native.fs;
  await fs.write(`${dir}/package.json`, JSON.stringify({
    name,
    displayName: name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    version: '0.1.0',
    description: 'A new Minimide package.',
    main: 'index.js',
    styles: ['style.css'],
    keymap: { 'Mod-Alt-h': `${name}:hello` },
    configSchema: { greeting: { type: 'string', default: 'Hello from ' + name + '!', title: 'Greeting' } },
  }, null, 2) + '\n');
  await fs.write(`${dir}/index.js`, `// ${name} — edit and save: Minimide hot-reloads packages in ~/.minimide/packages.
// Full API reference: Help → Plugin API Docs.

export function activate(mide) {
  mide.commands.add('${name}:hello', 'Say Hello', () => {
    mide.notify.success(mide.config.get('${name}.greeting'));
  });

  // A status bar item that shows the number of words in the active editor.
  const label = mide.ui.h('span.${name}-words');
  mide.statusBar.addItem({ element: label, align: 'right', priority: 50 });
  const update = () => {
    const editor = mide.workspace.getActiveEditor();
    label.textContent = editor ? \`\${editor.getText().split(/\\s+/).filter(Boolean).length} words\` : '';
  };
  mide.workspace.onDidChangeActiveItem(update);
  mide.workspace.onDidUpdateEditor((_editor, update_) => { if (update_?.docChanged) update(); });
  update();

  // Everything registered through \`mide\` is cleaned up automatically on deactivate.
}

export function deactivate() {}
`);
  await fs.write(`${dir}/style.css`, `.${name}-words { opacity: 0.7; }\n`);
  await fs.write(`${dir}/README.md`, `# ${name}\n\nA Minimide package. Try **${name}: Say Hello** from the command palette.\n`);
  await app.packages.discover();
  await app.packages.activate(name);
  await app.workspace.open(`${dir}/index.js`);
  app.ui.notify.success(`Created package "${name}"`, `It lives in ${dir.replace(app.userInfo.home, '~')} and reloads when you save.`);
}
