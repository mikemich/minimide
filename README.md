<div align="center">

<img src="build/icon.png" width="96" alt="Minimide icon">

# Minimide

**The editor you can read in an afternoon.**

A small, beautiful code editor in the spirit of Atom. Every feature is a package
you can change while it runs.

[![MIT license](https://img.shields.io/badge/license-MIT-6aa8ff)](LICENSE)
![Platforms](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-c792ea)
![Core](https://img.shields.io/badge/core-~5k%20lines-a3d385)
[![Download](https://img.shields.io/badge/download-latest-f0b866)](https://github.com/mikemich/minimide/releases/latest)

<a href="docs/media/minimide-demo.mp4"><img src="docs/media/minimide-demo.gif" alt="Creating a package in Minimide: type one line, save, and it's live" width="840"></a>

*Create a package, add a feature in one line, save: it's live. No restart.*

</div>

Minimide's core is about 5,000 lines of plain JavaScript, and the whole editor, all 42
built-in packages included, is about 10,000. The file tree, git panel, terminal, language
servers, Vim mode and every theme are packages built on the same API you get, and they
reload the moment you save. Make it yours.

```bash
curl -fsSL https://mikemich.github.io/minimide/install.sh | sh
```

<a href="docs/media/theme-reel.mp4"><img src="docs/media/theme-reel.gif" alt="Minimide cycling through its 19 themes and 5 of its fonts, with the app icon changing to match" width="840"></a>

*19 themes and 27 fonts, built in. Even the Dock icon follows your theme.*

## Why

Remember when your editor felt like *yours*? Atom made hacking your tools feel fun:
open a file, change how the editor works, see it happen. GitHub shut Atom down in
2022, and editors have since grown into platforms nobody fully understands. You can
configure them, but you can't really change them.

Minimide picks up Atom's idea, small enough to own:

- **Readable.** The core is about 5,000 lines; the rest is packages. No framework and no
  build magic. You can read every line that runs.
- **Everything is a package.** The tree view, search, git, the language-server client,
  the settings screen and every theme use the same public API yours will. There's no
  private back door.
- **Change it while it runs.** Save a package and it reloads instantly. `init.js`,
  `styles.css`, `keymap.json` and `config.json` in `~/.minimide` do the same.
- **Safe to share.** Atom's packages could do anything, and opening a repo was blind trust.
  Minimide's installed packages run in a sandbox: no access to your files, programs or the
  internet unless you approve the permissions they ask for. Folders you haven't trusted open
  in Restricted Mode, with git and language servers off. See [SECURITY.md](SECURITY.md).
- **Simple by default.** A file tree, tabs, a command palette and a fuzzy finder, built
  on CodeMirror 6 with syntax highlighting for 100+ languages. Power tools such as LSP,
  split panes, multi-cursor and project-wide replace are there when you reach for them.

## Getting started

**macOS or Linux**, in one line (downloads the latest release and checks its SHA-256):

```bash
curl -fsSL https://mikemich.github.io/minimide/install.sh | sh
```

**Or download** from the [Releases page](https://github.com/mikemich/minimide/releases/latest):
`-arm64.dmg` for Apple Silicon, plain `.dmg` for Intel, `Setup-…-x64.exe` for Windows,
`.AppImage` for Linux. The builds aren't signed yet, so a downloaded app needs one extra
click the first time: **System Settings → Privacy & Security → Open Anyway** on a Mac, or
**More info → Run anyway** in Windows SmartScreen. The install script avoids this.

Minimide checks for updates once a day and can update itself (**Check for Updates…**
in the app menu). Turn that off with `core.checkForUpdates`.

Or run from source (Node 20+):

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
| `⌃⇧G` | Source control panel (`⌘K ⌘D` diffs the current file) |
| `log` + `Tab` | Expand a snippet (`Snippets: Insert Snippet…` lists them all) |

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
| `source-control` | Git panel (`⌃⇧G`): stage, unstage, discard, commit, amend, push, pull, and side-by-side or inline diffs |
| `terminal` | A real terminal (xterm.js + node-pty) in tabs; click `file:line` in output to jump there |
| `runner` | Run the current file with `F5` (Python, JS/TS, Go, Rust, C/C++, Java, Ruby, shell and more) or a project task with `⌘⇧B` |
| `markdown-preview` | Live, sanitized preview in a split pane |
| `settings-view` | Settings, themes, packages and keybindings, generated from schemas |
| `status-bar` | Cursor, selection, language, indentation, line endings |
| `editor-guides` | Scope-aware indent guides; optional rainbow brackets |
| `image-viewer` | Opens PNG, JPG, GIF, WebP, SVG and more in a tab with zoom (`⌘+` / `⌘-` / pinch) |
| `sticky-scroll` | Pins the headers of the function, class or block you're in to the top of the editor |
| `snippets` | Type a prefix and press Tab. Built-ins for popular languages, plus your own in VS Code format |
| `color-preview` | Inline swatches for `#hex`, `rgb()` and `hsl()`; click a hex swatch to pick a new color |
| `git-blame` | Who changed the current line, and when, shown at its end (like GitLens) |
| `todos` | Highlights TODO / FIXME / HACK / NOTE in comments, plus a sidebar listing them all (`⌘K ⌘T`) |
| `vim-mode` | Full Vim emulation with `:w`, `:q`, `:wq`, `gt`, `jj` escape and relative numbers. *Off by default* |
| `minimap` | A zoomed-out map of the file (`⌘K ⌘M`). *Off by default* |
| `focus-mode` | Typewriter scrolling and paragraph dimming for writing. *Off by default* |
| `fonts` | 27 bundled open-source fonts for code and UI (JetBrains Mono, Fira Code, Cascadia Code, Geist, Iosevka, Monaspace, Inter…) with live previews in **Settings → Fonts**. Each font keeps its own license (SIL OFL or Ubuntu Font License) in `packages/fonts/licenses` |
| `nightfall`, `midnight`, `fjord`, `daylight`, `dune`, `ember`, `grove`, `rosewood`, `nocturne`, `cocoa`, `harvest`, `metro`, `volcano`, `abyss`, `contrast`, `paper`, `glacier`, `blossom`, `solstice` | 19 themes, from true-black and high-contrast to paper and blossom (`Theme: Select Theme…` previews them live). Pick any accent color on top in **Settings → Themes** |

Packages marked *off by default* are installed but switched off to keep the default
editor simple. Turn them on in **Settings → Packages**.

Power-user extras: multi-cursor and rectangular selection, chord keybindings, split panes
that stay in sync, session restore, auto-save, Zen mode, line sort / unique / join /
case transforms, trim-whitespace-on-save, reopen closed tab, live reload of every config file.

![Settings with the Daylight theme](docs/screenshots/light.png)

## Language servers

The `lsp` package starts a server the first time you open a matching file. It only
needs the server to be on your `PATH`; if it's missing, Minimide shows the install command.

| Server | Languages | Install |
| --- | --- | --- |
| `typescript-language-server` | TS / JS / JSX / TSX | `npm i -g typescript@5 typescript-language-server` (TypeScript 7 doesn't work with it yet) |
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
| `snippets.json` | Your snippets in VS Code's format. Or drop VS Code snippet files into `snippets/`. |
| `packages/` | Your packages. **Packages: Create New Package…** scaffolds one. |
| `installed.json` | Packages you installed, and the permissions you gave them. |

### Sharing packages

Install other people's packages from **Settings → Packages → Discover**, or with
**Packages: Install Package…** and a GitHub `owner/repo`. To publish yours, push it to GitHub
and add the `minimide-package` topic.

Installed packages run **sandboxed**: in a separate worker with no access to your files,
programs or the internet. A package that needs more asks for specific permissions
(`project-files`, `network`, …), and you see them before you install it.

Folders get the same care: the first time you open one, Minimide asks whether you trust it.
Until you do, git and language servers stay off for it, because both can run code that comes
with a repository (a command in its git settings, a TypeScript copy in `node_modules`). A package that
asks for full access gets a clear warning. Packages you write yourself are trusted like
the rest of your code. See [Sharing packages, and the sandbox](docs/PLUGINS.md#sharing-packages-and-the-sandbox).

The full API is in [docs/PLUGINS.md](docs/PLUGINS.md) (or **Help → Plugin API Docs** in the app).

## Convert a VS Code theme

`scripts/vscode-theme.mjs` turns any VS Code color theme file into a Minimide theme package.
It accepts JSON with comments and trailing commas (JSONC), which is the format VS Code themes
use in the wild.

```bash
node scripts/vscode-theme.mjs path/to/your-theme.json
# writes packages/theme-<slug>/package.json and theme.css
```

To write into a different directory:

```bash
node scripts/vscode-theme.mjs path/to/your-theme.json --out /tmp/my-themes
```

The script maps VS Code `colors` keys (`editor.background`, `sideBar.background`,
`terminal.ansi*`, …) to Minimide's CSS variables, and maps `tokenColors` scopes
(`comment`, `string`, `keyword`, `entity.name.function`, …) to the `.tok-*` syntax
classes. Colors that aren't present in the VS Code theme are derived from `bg` and `fg`
so every variable is always defined. The `type` field (`"dark"` / `"light"`) sets
`color-scheme` automatically.

You can also import the converter directly:

```js
import { parseJsonc, convertTheme } from './scripts/vscode-theme.mjs';
const vsTheme = parseJsonc(await fs.readFile('my-theme.json', 'utf-8'));
const { slug, packageJson, themeCss } = convertTheme(vsTheme);
```

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

Debug adapter (DAP) package · signed and notarized builds · a sandboxed API for panels.

## License

MIT. See [LICENSE](LICENSE).
