// The project and settings the browser demo starts with.

export const SAMPLE_FILES = {
  'README.md': `# Welcome to Minimide

You're running the real editor, right in your browser. Edits are kept in this
browser only, so go ahead and break things.

## Try these

- **Hold ⌘** (Ctrl on Windows and Linux) for a moment: every shortcut on screen gets a label.
- **⌘P** finds files. Type **>** for commands, **:** for a line, **?** for everything else.
- Type **>colors** to pick one of 19 themes, or **>remove line** to find Delete Line.
- **Right-click** in a file for the editing menu.
- **⌘K ⌘H** shows the keyboard cheat sheet.
- Open **src/app.js**, type \`fn\` and press **Tab** to expand a snippet.

## Make it yours

Every color is a CSS variable. Run **>stylesheet** to open your stylesheet, add

\`\`\`css
:root { --accent: #ff7ab2; }
\`\`\`

and save with **⌘S**. The editor changes as you save.

## What you need the app for

Terminals, git, running code and language servers (go to definition, peek,
rename) need your computer. Get the app at https://github.com/mikemich/minimide.
`,
  'src/app.js': `// A tiny to-do list. Try ⌘P > "toggle comment", or hold ⌘ to see what you can do here.
import { formatDate, slugify } from './utils.js';

const todos = [];

export function addTodo(title, due = new Date()) {
  const todo = { id: slugify(title), title, due, done: false };
  todos.push(todo);
  return todo;
}

export function completeTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (todo) todo.done = true;
  return todo;
}

export function summary() {
  const open = todos.filter((t) => !t.done);
  // TODO: group by due date
  return open.map((t) => \`\${t.title} (due \${formatDate(t.due)})\`).join('\\n');
}

addTodo('Hold Cmd and look around');
addTodo('Pick a theme you like');
console.log(summary());
`,
  'src/utils.js': `export function formatDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// FIXME: handle non-Latin titles
export const isSlug = (text) => /^[a-z0-9-]+$/.test(text);
`,
  'src/stats.py': `"""Word statistics for a text file."""
from collections import Counter
import sys


def word_counts(text: str) -> Counter:
    words = [w.strip(".,!?;:").lower() for w in text.split()]
    return Counter(w for w in words if w)


def main(path: str) -> None:
    with open(path, encoding="utf-8") as f:
        counts = word_counts(f.read())
    for word, n in counts.most_common(10):
        print(f"{n:>5}  {word}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "README.md")
`,
  'src/main.rs': `use std::collections::HashMap;

fn main() {
    let text = "the quick brown fox jumps over the lazy dog the end";
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    let mut top: Vec<_> = counts.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1));
    for (word, n) in top.iter().take(3) {
        println!("{n:>3} {word}");
    }
}
`,
  'public/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Todos</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="card">
    <h1>Today</h1>
    <ul id="todos"></ul>
  </main>
  <script type="module" src="../src/app.js"></script>
</body>
</html>
`,
  'public/style.css': `:root {
  --bg: #12141a;
  --card: #1e2128;
  --accent: #7cb4ff;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  font-family: system-ui, sans-serif;
}

.card {
  padding: 24px 32px;
  border-radius: 16px;
  background: var(--card);
  color: #e6e9ef;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
`,
  'public/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7cb4ff"/>
      <stop offset="1" stop-color="#c792ea"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="#191c23"/>
  <path d="M64 184V88l40 56 24-32 24 32 40-56v96" fill="none" stroke="url(#g)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`,
  'data/settings.json': `{
  "name": "hello-minimide",
  "version": "1.0.0",
  "features": { "darkMode": true, "reminders": false },
  "tags": ["demo", "editor", "browser"]
}
`,
  'Makefile': `.PHONY: run test

run:
\tnode src/app.js

test:
\tpython3 src/stats.py README.md
`,
  '.gitignore': `node_modules/
dist/
.DS_Store
*.log
`,
};

export const USER_FILES = {
  'config.json': JSON.stringify({ core: { theme: 'nightfall', checkForUpdates: false }, editor: { fontSize: 14 } }, null, 2) + '\n',
  'keymap.json': `{
  // Map keystrokes to command ids. Use "Mod" for Cmd on macOS / Ctrl elsewhere.
  // Chords are space separated, e.g. "Mod-k Mod-b".
  // Bind to null to remove a default binding.
  // "Mod-Shift-d": "editor:duplicate-line"
}
`,
  'styles.css': `/* Your personal stylesheet. Loaded last and reloaded live on save.
 * Every color in Minimide is a CSS variable. Try uncommenting this and saving:
 *
 * :root { --accent: #ff7ab2; }
 */
`,
  'init.js': `// Your init script. It gets the same API every package gets. See docs/PLUGINS.md.
export default function (mide) {
  mide.commands.add('me:hello', 'Say Hello', () => mide.notify.success('Hello from your init script!'));
}
`,
};
