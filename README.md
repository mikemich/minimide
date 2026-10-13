# Minimide

**The editor you can read in an afternoon.**

Minimide is a small, beautiful code editor in the spirit of Atom. The whole thing is
about 6,000 lines of plain JavaScript. Every feature, from the file tree to language
servers, is a package built on the same API you get, and packages reload the moment
you save. Make it yours.

![Minimide with the Nightfall theme](docs/screenshots/dark.png)

## Why

Remember when your editor felt like *yours*? Atom made hacking your tools feel fun:
open a file, change how the editor works, see it happen. GitHub shut Atom down in
2022, and editors have since grown into platforms nobody fully understands. You can
configure them, but you can't really change them.

Minimide picks up Atom's idea, small enough to own:

- **Readable.** The core is about 3,500 lines; the rest is packages. No framework and no
  build magic. You can read every line that runs.
- **Everything is a package.** The tree view, search, git, the language-server client,
  the settings screen and every theme use the same public API yours will. There's no
  private back door.
- **Change it while it runs.** Save a package and it reloads instantly. `init.js`,
  `styles.css`, `keymap.json` and `config.json` in `~/.minimide` do the same.
- **Simple by default.** A file tree, tabs, a command palette and a fuzzy finder, built
  on CodeMirror 6 with syntax highlighting for 100+ languages. Power tools such as LSP,
  split panes, multi-cursor and project-wide replace are there when you reach for them.

## Getting started

Run from source (downloadable builds are coming to the [Releases page](https://github.com/mikemich/minimide/releases)):

```bash
npm install
npm start                  # or: npm start -- /path/to/project
npm run dev                # same, with DevTools open
```

### Building the app

```bash
npm run dist:mac           # Minimide.app, .dmg and .zip (Apple Silicon + Intel) in release/
npm run dist:dir           # just the unpacked app, for a quick local test
npm run dist               # installers for the current platform
```

Local Mac builds are ad-hoc signed: they run on your machine, but other people's Macs
will block them until they allow the app in **System Settings → Privacy & Security**.
For a download anyone can open, you need a *Developer ID Application* certificate (Apple
Developer Program) and notarization. Add them as secrets and the release workflow in
`.github/workflows/release.yml` does the rest. Push a tag like `v0.1.0` to build
macOS, Windows and Linux installers into a draft GitHub release. Regenerate the icon
with `npm run icon`.

## Your first package, in one minute

Run **Packages: Create New Package…** from the command palette (`⌘⇧P`), or drop
this into `~/.minimide/packages/hello/index.js`:

```js
export function activate(mide) {
  mide.commands.add('hello:greet', 'Say Hello', () => mide.notify.success('Hello from my editor!'));
  mide.statusBar.addItem({ element: mide.ui.h('span', '👋 mine'), align: 'right' });
}
```

with a one-line `package.json`: `{ "name": "hello", "main": "index.js" }`.

Save it and the status bar changes immediately. Edit it, save again, and it reloads.
That's the whole loop. The full API is in [docs/PLUGINS.md](docs/PLUGINS.md).

## Everyday keys

| Key | Action |
| --- | --- |
| `⌘⇧P` | Command palette: every action lives here |
| `⌘P` | Find file (`name:42` jumps to line 42) |
| `⌘E` | Find among open tabs |
| `⌘⇧F` / `⌘⇧H` | Find / replace in project |
| `⌘F` / `⌘D` / `⌘⇧L` | Find in file / add next match / select all matches |
| `⌘B` | Toggle sidebar |
| ``Ctrl-` `` | Toggle terminal (``Ctrl-⇧-` `` for a new one) |
| `F5` / `⌘⇧R` | Run the current file (`⇧F5` stops, `⌘⌥R` runs it again) |
| `⌘⇧B` | Run a task: npm scripts, Makefile targets, Cargo, Go, or any command |
| `⌘⇧↩` | Send the selection (or current line) to the terminal |
| `⌘\` | Split right |
| `⌘K ⌘→` / `⌘K ⌘←` | Focus next / previous pane |
| `Ctrl-G` | Go to line |
| `⌘,` | Settings |
| `⌘K ⌘S` | Search all keybindings (`⌘K ⌘⇧S` opens them in Settings) |
| `Ctrl-⇧M` | Markdown preview |
| `F12` / `⌘`-click | Go to definition (LSP) |
| `⇧F12` | Find references (LSP) |
| `F2` | Rename symbol (LSP) |
| `⌘.` | Code actions / quick fix (LSP) |
| `⌘R` | Go to symbol in file (LSP) |
| `⇧⌥F` | Format document (LSP) |
| `F8` / `⇧F8` | Next / previous problem |
| `⌘K ⌘P` | Problems panel |

On Linux and Windows, read `⌘` as `Ctrl`. Every binding can be changed in `keymap.json`.

## What's included

| Package | What it does |
| --- | --- |
| `tree-view` | File tree with preview tabs, keyboard navigation (`a`, `A`, `m`, `d`, `F2`, `Delete`), drag-to-move and git colors |
| `command-palette` | Fuzzy-search every command, most recently used first |
| `fuzzy-finder` | Open files and tabs by fuzzy name |
| `find-in-project` | Regex / case-sensitive search and replace across the project |
| `lsp` | Language servers: completions (with auto-import), diagnostics, hover, signature help, definition, references, rename, code actions, formatting, symbols, Problems panel |
| `git` | Branch switcher, tree status, change markers in the editor gutter |
| `terminal` | A real terminal (xterm.js + node-pty) in tabs; click `file:line` in output to jump there |
| `runner` | Run the current file with `F5` (Python, JS/TS, Go, Rust, C/C++, Java, Ruby, shell and more) or a project task with `⌘⇧B` |
| `markdown-preview` | Live, sanitized preview in a split pane |
| `settings-view` | Settings, themes, packages and keybindings, generated from schemas |
| `status-bar` | Cursor, selection, language, indentation, line endings |
| `nightfall`, `daylight`, `fjord` | Themes (`Theme: Select Theme…` previews them live) |

Power-user extras: multi-cursor and rectangular selection, chord keybindings, split panes
that stay in sync, session restore, auto-save, Zen mode, line sort / unique / join /
case transforms, trim-whitespace-on-save, reopen closed tab, live reload of every config file.

![Settings with the Daylight theme](docs/screenshots/light.png)

## Language servers

The `lsp` package starts a server the first time you open a matching file. It only
needs the server to be on your `PATH`; if it's missing, Minimide shows the install command.

| Server | Languages | Install |
| --- | --- | --- |
| `typescript-language-server` | TS / JS / JSX / TSX | `npm i -g typescript typescript-language-server` |
| `pyright-langserver` (or `pylsp`) | Python | `npm i -g pyright` |
| `rust-analyzer` | Rust | `rustup component add rust-analyzer` |
| `gopls` | Go | `go install golang.org/x/tools/gopls@latest` |
| `clangd` | C / C++ / Obj-C | `xcode-select --install` |
| `vscode-{css,html,json}-language-server` | CSS / HTML / JSON | `npm i -g vscode-langservers-extracted` |
| plus | Bash, YAML, Lua, Ruby, PHP, Zig, Svelte | see `packages/lsp/servers.js` |

Add or override servers in `config.json`:

```jsonc
"lsp": {
  "formatOnSave": true,
  "servers": {
    "elixir": { "command": ["elixir-ls"], "extensions": ["ex", "exs"] },
    "python": { "command": ["pylsp"], "settings": { "pylsp": { "plugins": { "ruff": { "enabled": true } } } } },
    "typescript": { "initializationOptions": { "tsserver": { "path": "/path/to/typescript/lib" } } }
  }
}
```

Server status and restarts live in the status bar; server output is in the
**Language Servers** panel (turn on `lsp.trace` to log every message).

## Make it yours

Everything personal lives in `~/.minimide/`:

| File | Purpose |
| --- | --- |
| `config.json` | Settings (comments allowed). Also editable in the Settings UI. |
| `keymap.json` | Your keybindings. Wins over every package. |
| `styles.css` | Your CSS, loaded last. Every color is a variable. |
| `init.js` | JavaScript run at startup with the full package API. |
| `packages/` | Your packages. **Packages: Create New Package…** scaffolds one. |

The full API is in [docs/PLUGINS.md](docs/PLUGINS.md) (or **Help → Plugin API Docs** in the app).

## Architecture

```
src/main/main.js        Electron main: windows, mide:// protocol, fs / process / dialog IPC
src/preload/preload.cjs The only bridge to Node (contextIsolation + sandbox)
src/renderer/
  app.js                Boot, session, welcome screen, user files
  core/                 commands, keymap, config, workspace (panes/tabs), editor (CodeMirror),
                        ui (select lists, docks, status bar), packages (loader + scoped API)
  styles/base.css       Layout and components; reads only CSS variables
packages/               Built-in packages, loaded exactly like user packages
```

The renderer has no Node access. Packages are loaded as ES modules from
`mide://pkg/<name>/`. Each package gets its own API object, which records everything the
package registers, so it can be disabled, enabled or reloaded at runtime without restarting.

## Roadmap ideas

Debug adapter (DAP) package · minimap · package installation from git URLs · auto-update.

## License

MIT. See [LICENSE](LICENSE).
