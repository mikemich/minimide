# Writing Minimide packages

Everything in Minimide is a package: the tree view, fuzzy finder, command palette,
search, status bar, git integration, terminal, code runner, settings screen and every theme.
They all use the API documented here, so anything they do, your package can do.

The fastest way to start is **Packages: Create New Package…** in the command palette.
It scaffolds a working package in `~/.minimide/packages/<name>` and opens it. Saving
any file in it hot-reloads the package.

## Anatomy

```
~/.minimide/packages/word-count/
├── package.json
├── index.js        # ES module, may import sibling files
└── style.css       # optional
```

```json
{
  "name": "word-count",
  "displayName": "Word Count",
  "description": "Shows the word count in the status bar.",
  "version": "0.1.0",
  "main": "index.js",
  "styles": ["style.css"],
  "keymap": { "Mod-Alt-w": "word-count:toggle" },
  "configSchema": {
    "includeSelection": { "type": "boolean", "default": true, "title": "Count selection only" }
  }
}
```

| Field          | Meaning |
| -------------- | ------- |
| `main`         | Entry module (default `index.js`). Set to `false` for CSS-only packages. |
| `styles`       | Stylesheets loaded while the package is active. |
| `keymap`       | Default keybindings. Users can override them in `keymap.json`. |
| `configSchema` | Settings. Short keys are prefixed with the package name (`word-count.includeSelection`). They appear automatically in the Settings UI. |
| `theme`        | `"ui"` marks a theme. Only the selected theme is active. |
| `priority`     | Activation order among packages (lower first, default 100). |
| `enabledByDefault` | Set to `false` to ship a package switched off until the user enables it. |
| `swatches`     | For themes: five colors (background, accent, three highlights) shown in Settings → Themes. |

```js
// index.js
export function activate(mide) {
  // Register things through `mide`; they are disposed automatically on deactivate.
}

export function deactivate() {
  // Optional: clean up anything you created outside the API.
}
```

`activate` may be `async` and may return a cleanup function or a disposable.

## Conventions

- **Command ids** are `package:verb-noun` (e.g. `word-count:toggle`). The palette shows
  them as `Word Count: Toggle` unless you give a title.
- **Keybindings** use `Mod` for ⌘ on macOS / Ctrl elsewhere: `Mod-Shift-p`, `Alt-z`,
  `Ctrl-\``. Chords are space-separated: `Mod-k Mod-b`.
- **Colors** come from CSS variables (`--bg`, `--fg`, `--accent`, `--c-green`, …) so your
  UI follows every theme. See `src/renderer/styles/base.css` for the full list.

## The `mide` API

### commands

```js
mide.commands.add('word-count:toggle', 'Toggle Word Count', () => { … }, { when: () => !!mide.workspace.getActiveEditor() });
mide.commands.add({ 'pkg:a': () => {}, 'pkg:b': { title: 'B', run: () => {}, when: () => true } });
await mide.commands.run('file:save');
mide.commands.list();   // enabled, visible commands
```

### keymap

```js
mide.keymap.add({ 'Mod-k Mod-c': 'word-count:toggle' });
// A key may map to several commands: the first one whose `when` passes runs, so a package can
// claim ⌘= only while its own view is active and the editor keeps it otherwise.
mide.keymap.bindingsFor('file:save');   // ['Cmd-s']
mide.keymap.pretty('Shift-Cmd-p');      // '⇧⌘P'
```

### config

```js
mide.config.register({ threshold: { type: 'number', default: 3, title: 'Threshold' } }); // → "<pkg>.threshold"
mide.config.get('editor.fontSize');
await mide.config.set('editor.softWrap', true);
mide.config.observe('core.theme', (value) => …);   // runs now and on change
mide.config.onDidChange('editor.tabSize', (value) => …);
```

Schema types: `boolean`, `number`, `string` (with optional `enum`), `array`.

### workspace

```js
mide.workspace.project;                       // absolute path or null
await mide.workspace.open(path, { line: 10, col: 0, pending: false, pane });
mide.workspace.newFile();
mide.workspace.getActiveItem();               // any pane item
mide.workspace.getActiveEditor();             // EditorItem or null
mide.workspace.getItems();
mide.workspace.save(item);
mide.workspace.splitRight({ empty: true });   // returns the new pane
mide.workspace.relativePath(absPath);

mide.workspace.observeActiveItem((item) => …);
mide.workspace.onDidChangeActiveItem((item) => …);
mide.workspace.onDidUpdateEditor((editor, update) => { if (update?.docChanged) … });
mide.workspace.onWillSave(async (editor) => { /* format, lint-fix… */ });
mide.workspace.onDidSave((editor) => …);
mide.workspace.onDidChangeProject((root) => …);
mide.workspace.onDidChangeFiles((paths) => …); // debounced fs events in the project
mide.workspace.onDidOpenItem((item, pane) => …);
mide.workspace.onDidCloseItem((item, pane) => …);
mide.workspace.onDidOpenDocument((doc) => …);   // a file is loaded (once, however many tabs show it)
mide.workspace.onDidCloseDocument((doc) => …);  // its last tab closed
mide.workspace.getDocuments();                   // open Documents: { path, getText(), primaryView(), views, on('path') }
mide.workspace.addOpener((path) => customItemOrNull);  // e.g. an image viewer
```

**EditorItem**: `getPath()`, `getTitle()`, `getText()`, `getSelectedText()`,
`insertText(s)`, `goToLine(line, col)`, `getCursor()`, `getLanguageName()`,
`isDirty()`, and `view`, the underlying CodeMirror
[EditorView](https://codemirror.net/docs/ref/#view.EditorView).

### Custom pane items

Any object with this shape can be opened in a tab with `mide.workspace.openItem(item)`:

```js
const item = {
  type: 'my-view',
  iconName: 'eye',               // optional built-in icon
  getTitle: () => 'My View',
  getElement: () => element,      // a DOM element you own
  getPath: () => null,            // optional
  isDirty: () => false,           // optional
  focus: () => {},
  serialize: () => null,          // not restored across sessions
  destroy: () => {},
  on: (event, fn) => ({ dispose() {} }), // optional; emit 'title-changed' to refresh the tab
};
```

See `packages/markdown-preview` and `packages/settings-view` for complete examples.

### editor (CodeMirror extensions)

Minimide is built on CodeMirror 6. Use the shared modules from `mide.cm`; don't bundle
your own copy, because two copies of `@codemirror/state` don't mix.

```js
const { EditorView, Decoration, ViewPlugin, gutter } = mide.cm.view;
const { StateField, StateEffect } = mide.cm.state;

mide.editor.addExtension(EditorView.theme({ '.cm-content': { letterSpacing: '0.2px' } }));
mide.editor.addExtension(myLinter);   // applied to every open and future editor

const support = await mide.editor.languageFor('src/app.ts'); // LanguageSupport for a path, or null

// Completions that run alongside the language's own and the language server's:
mide.editor.addCompletionSource((ctx) => {
  const word = ctx.matchBefore(/\w+$/);
  return word && { from: word.from, options: [{ label: 'hello', type: 'snippet' }] };
});

mide.editor.registerLanguage({
  name: 'Brainfuck', extensions: ['bf'],
  load: async () => myLanguageSupport,
});
```

Popular add-ons are bundled against the same CodeMirror and load on demand:

```js
const { vim, Vim } = await mide.cm.extras.vim();                         // @replit/codemirror-vim
const { showMinimap } = await mide.cm.extras.minimap();                  // @replit/codemirror-minimap
const { indentationMarkers } = await mide.cm.extras.indentationMarkers(); // @replit/codemirror-indentation-markers
const { MergeView, unifiedMergeView } = await mide.cm.extras.merge();     // @codemirror/merge (diff views)
```

Available: `mide.cm.state`, `.view`, `.language`, `.commands`, `.autocomplete`,
`.search`, `.lint`, `.highlight`. `packages/git` uses a gutter built this way, and
`packages/lsp` is a full example of completions, hover tooltips, diagnostics and
tooltip state fields.

### ui

```js
const { h, icon, fileIcon } = mide.ui;
h('div.card#main', { onclick: () => {}, style: { color: 'red' } }, 'text', h('span', 'child'));
icon('search', 16);   // built-in icons: folder, file, search, branch, terminal, gear, play, …

mide.ui.selectList({
  placeholder: 'Pick a fruit',
  items: [{ label: 'Apple', detail: 'red', hint: '⌘A' }, { label: 'Banana' }],  // or an async fn
  onSelect: (item, query) => …,
  onHighlight: (item) => …,     // live preview, like the theme picker
  onQuery: (q) => itemsOrNull,  // dynamic results
  transformQuery: (q) => q,     // rewrite before fuzzy filtering
});
const name = await mide.ui.prompt({ title: 'Name?', value: 'untitled', validate: (v) => v ? null : 'Required' });
const choice = await mide.ui.confirm({ message: 'Sure?', buttons: ['Yes', 'No'] }); // index
const picked = await mide.ui.contextMenu([{ id: 'a', label: 'A' }, { type: 'separator' }, { id: 'b', label: 'B' }]);
```

### notifications

```js
mide.notify.info('Saved'); mide.notify.success('Done', 'detail');
mide.notify.warn('Careful'); mide.notify.error('Failed', err.message, { actions: [{ label: 'Retry', run }] });
```

### sidebar, panel, statusBar

```js
mide.sidebar.addView({ id: 'outline', title: 'Outline', icon: 'files', order: 20, element, focus() {}, onShow() {} });
mide.sidebar.show('outline'); mide.sidebar.toggle('outline');

mide.panel.addView({ id: 'problems', title: 'Problems', icon: 'terminal', element });
mide.statusBar.addItem({ element, align: 'right', priority: 50, tooltip: '…', onClick() {} });
```

### Files, project and processes

```js
await mide.fs.read(path); await mide.fs.write(path, text);
await mide.fs.readDataUrl(path);  // binary files (images…) as a data: URL
await mide.fs.readdir(dir);   // [{ name, path, isDir }]
await mide.fs.stat(path);     // { isDir, isFile, size, mtime } | null
await mide.fs.mkdir(dir); await mide.fs.rename(a, b); await mide.fs.trash(path);

await mide.project.files();                      // relative paths, respects core.ignoredNames
await mide.project.search('TODO', { regex: false, caseSensitive: false });

const { code, stdout, stderr } = await mide.process.exec('git', ['status'], { cwd });
const proc = mide.process.spawn('npm test', { onData: (chunk, stream) => …, onExit: (code) => … });
proc.write('input\n'); proc.kill(); await proc.done;

// JSON-RPC over stdio with Content-Length framing (language servers, debug adapters).
// Runs through your login shell so PATH matches your terminal.
const server = mide.process.spawnRpc(['clangd'], { onMessage: (msg) => …, onStderr: (text) => …, onExit: (code) => … });
server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { … } });

mide.shell.openExternal(url); mide.shell.reveal(path); mide.clipboard.write(text);
```

### services (packages talking to packages)

```js
// provider (packages/git)
mide.services.provide('git-status', { statuses, onDidChange, refresh });

// consumer (packages/tree-view): called now if available, or whenever it becomes available
mide.services.consume('git-status', (git) => { … });
```

### styles, packages and misc

```js
mide.styles.add('.my-thing { color: var(--accent); }');  // removed on deactivate
mide.packages.list(); mide.packages.setEnabled('git', false); mide.packages.reload('my-pkg');
mide.package;   // { name, dir, url, manifest } of the calling package
mide.user;      // { dir, packagesDir, home, platform }
mide.subscriptions.add(disposable);   // anything with dispose()
```

## Themes

A theme is a package with `"theme": "ui"`, `"main": false` and a stylesheet that sets
CSS variables and syntax token colors:

```css
:root {
  color-scheme: dark;
  --bg: #1e1e2e; --bg-sidebar: #181825; --fg: #cdd6f4; --accent: #f5c2e7;
  --c-red: #f38ba8; --c-green: #a6e3a1; --c-blue: #89b4fa; /* … */
}
.tok-keyword { color: #cba6f7; }
.tok-function { color: #89b4fa; }
```

Token classes: `tok-keyword`, `tok-controlKeyword`, `tok-modifier`, `tok-string`, `tok-string2`,
`tok-number`, `tok-bool`, `tok-null`, `tok-atom`, `tok-constant`, `tok-function`,
`tok-variableName`, `tok-definition`, `tok-propertyName`, `tok-typeName`, `tok-className`,
`tok-namespace`, `tok-tagName`, `tok-attributeName`, `tok-attributeValue`, `tok-operator`,
`tok-punctuation`, `tok-comment`, `tok-docComment`, `tok-meta`, `tok-self`, `tok-builtin`,
`tok-regexp`, `tok-escape`, `tok-heading`, `tok-emphasis`, `tok-strong`, `tok-link`,
`tok-url`, `tok-monospace`, `tok-quote`, `tok-list`, `tok-invalid`, `tok-inserted`, `tok-deleted`.

Start from `packages/theme-nightfall/theme.css`.

## Sharing packages, and the sandbox

### Publishing

A package is a GitHub repository with `package.json` at its root. Add the topic
**`minimide-package`** to the repository and it shows up in **Settings → Packages → Discover**.
People can also install it by name with **Packages: Install Package…** (`owner/repo`,
a github.com link, or `owner/repo#branch-or-tag`).

**Packages: Check for Package Updates** compares each installed package with the latest
commit on its branch.

### Two kinds of package

| | Full access | Sandboxed |
| --- | --- | --- |
| Who | Built-in packages, folders you make yourself, and installed packages with `"access": "full"` | Installed packages (the default), or yours with `"access": "sandboxed"` |
| Runs in | The editor's page, with the whole API above | A worker with no DOM, no Node and no network |
| Can | Anything Minimide can do | Commands, status bar items, notifications, pickers, settings, and the open editor. More only with the permissions below |
| On install | A clear "this package gets full access" warning | A list of the permissions it asks for |

Prefer sandboxed. Ask for full access only if you need DOM-level UI (panels, pane items,
CodeMirror extensions) or the editor's internals. Users see that warning, and fewer of them
will install the package.

What the user agreed to is stored in `~/.minimide/installed.json`, outside the package
folders. If an update asks for new permissions, Minimide asks again before granting them.

### Permissions

List them in `package.json`. Ask for as few as you can; each one is shown to the user.

```json
{
  "name": "word-goal",
  "main": "index.js",
  "access": "sandboxed",
  "permissions": ["project-files", "network"]
}
```

| Permission | Allows |
| --- | --- |
| `project-files` | Read files in the open project: `mide.fs.read/readdir/stat`, `mide.workspace.open()` (symlinks that lead outside are refused) |
| `project-write` | Also `mide.fs.write` in the project, except inside `.git/` and `node_modules/`. Language servers and build tools can run code from project files, so users see this as close to full access |
| `files` | `mide.fs.*` anywhere, except Minimide's own folder (`~/.minimide`). Shown to users as close to full access |
| `shell` | `mide.process.exec()` (effectively full access: say why you need it) |
| `network` | `mide.net.fetch()` and `mide.shell.openExternal()` |
| `clipboard` | `mide.clipboard.readText()` (writing is always allowed) |
| `commands` | `mide.commands.run()` for other packages' commands |

### The sandboxed API

Everything that reaches the editor returns a promise. Command ids must start with your
package name, and names Minimide uses itself (`core`, `editor`, `ui`, `settings`…) are
reserved. Settings are limited to your own namespace (plus `editor.*`, `ui.*` and
`core.theme`, read-only). Keybindings in `package.json` can only point at your own commands.
Prompts and pickers are labelled with your package's name. Calls are rate-limited, and at
most 3 notifications are shown per 10 seconds. `eval` and `new Function` aren't available,
and a package can only load its own files.

Stylesheets go through the browser's CSS parser and keep only visual properties (colors,
borders, shadows, fonts and so on, plus custom properties). Rules that position, hide or add
content are dropped, so a package can't draw fake UI. Images and fonts must be `data:` URLs or
files in your package; nothing loads from the internet. Themes work unchanged.

```js
export async function activate(mide) {
  mide.sandboxed;                      // true
  mide.package;                        // { name, manifest, permissions }
  mide.project;                        // the open folder's path, or null

  mide.commands.add('word-goal:show', 'Show Word Goal', async () => { … });
  await mide.commands.run('word-goal:show');

  const item = mide.statusBar.addItem({ text: '…', tooltip: 'Words', align: 'right', onClick: () => {} });
  item.setText('120 words'); item.dispose();

  mide.notify.info('Saved', 'detail', { actions: [{ label: 'Undo', run: () => {} }] });
  const pick = await mide.ui.selectList({ items: [{ label: 'One', detail: '…' }], placeholder: 'Pick' });
  const name = await mide.ui.prompt({ title: 'Name?', value: 'x' });

  mide.config.get('word-goal.target', 500); await mide.config.set('word-goal.target', 800);
  mide.config.observe('word-goal.target', (v) => {});

  await mide.workspace.getActiveEditor();   // { path, language, dirty } or null
  mide.workspace.onDidChangeActiveEditor((info) => {});
  mide.workspace.onDidSave(({ path }) => {});
  await mide.editor.getText(); await mide.editor.getSelectedText(); await mide.editor.getCursor();
  await mide.editor.insertText('hi'); await mide.editor.replaceSelection('x'); await mide.editor.setText('…');
  mide.editor.onDidChange(({ path }) => {});   // debounced

  // With permissions:
  await mide.fs.read('src/app.js');            // relative to the project
  await mide.fs.write('notes.md', '…'); await mide.fs.readdir('src'); await mide.fs.stat('x');
  await mide.process.exec('git', ['log', '-1']); // { code, stdout, stderr }
  await mide.net.fetch('https://api.example.com', { method: 'POST', headers: {}, body: '…' }); // { status, ok, headers, body }
  await mide.clipboard.readText(); await mide.clipboard.writeText('…');
  await mide.shell.openExternal('https://example.com');
}
```

## Workspace trust

git and language servers can run code that comes with a folder (a command in `.git/config`, a
TypeScript copy in `node_modules`, a Rust build script). So the first time a folder is opened,
Minimide asks whether to trust it; until then it's in **Restricted Mode**, and packages that run
such tools should stay off. Check it with:

```js
mide.workspace.isTrusted();          // the open project; or pass a file path
mide.workspace.onDidChangeTrust(() => { /* start or stop your tool */ });
await mide.workspace.requestTrust(); // shows the prompt; resolves to true if trusted
```

The built-in git, source control, blame and language-server packages do this. Trusted folders
are listed in `~/.minimide/trusted-folders.json` and managed with **Workspace: Manage Trusted
Folders…**; set `security.workspaceTrust` to `false` to trust everything.

## Your init script and stylesheet

`~/.minimide/init.js` receives the same API, for quick personal tweaks without a package:

```js
export default function (mide) {
  mide.commands.add('me:insert-date', 'Insert Date', () =>
    mide.workspace.getActiveEditor()?.insertText(new Date().toISOString().slice(0, 10)));
  mide.keymap.add({ 'Mod-Alt-d': 'me:insert-date' });
}
```

`~/.minimide/styles.css` is loaded last and reloads the moment you save it.
