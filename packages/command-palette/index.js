// Command Palette: fuzzy-search every command, most recently used first. It's the ">" mode of the
// quick-open box, so ⇧⌘P is ⌘P with ">" typed for you. Plain words work too: "remove line" finds
// Delete Line, "colors" finds Select Theme.

// Words people type -> the word the command titles use.
const SYNONYMS = {
  remove: 'delete', erase: 'delete', kill: 'delete', del: 'delete', delete: 'remove',
  exit: 'close', dismiss: 'close', quit: 'close',
  search: 'find', lookup: 'find', locate: 'find', find: 'search',
  create: 'new', make: 'new', add: 'new',
  preferences: 'settings', prefs: 'settings', options: 'settings', config: 'settings', setting: 'settings',
  colors: 'theme', color: 'theme', colour: 'theme', colours: 'theme', appearance: 'theme', skin: 'theme', dark: 'theme', light: 'theme',
  bigger: 'increase', larger: 'increase', zoom: 'font', smaller: 'decrease',
  show: 'toggle', hide: 'toggle',
  shell: 'terminal', console: 'terminal', cli: 'terminal',
  explorer: 'sidebar', tree: 'sidebar',
  prettify: 'format', beautify: 'format', tidy: 'format', prettier: 'format',
  uncomment: 'comment',
  copy: 'duplicate', clone: 'duplicate',
  jump: 'go', goto: 'go', navigate: 'go',
  declaration: 'definition', source: 'definition',
  usages: 'references', uses: 'references', callers: 'references',
  refactor: 'rename',
  errors: 'problems', warnings: 'problems', diagnostics: 'problems', lint: 'problems',
  restart: 'reload', refresh: 'reload',
  plugin: 'package', plugins: 'packages', extension: 'package', extensions: 'packages', addon: 'package',
  shortcuts: 'keybindings', shortcut: 'keybindings', hotkeys: 'keybindings', keys: 'keybindings',
  uppercase: 'upper', lowercase: 'lower', capitalize: 'title', caps: 'upper',
  dedupe: 'duplicate', unique: 'duplicate',
  fullscreen: 'full screen', execute: 'run', exec: 'run', start: 'run',
  git: 'source control', vcs: 'source control',
};

/** "remove line" -> ["delete line"]: the query again in the commands' own words. */
function alternateQueries(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const swapped = words.map((w) => SYNONYMS[w] || w).filter((w, i, all) => w !== all[i - 1]);
  const alt = swapped.join(' ');
  return alt !== words.join(' ') ? [alt] : [];
}

export function activate(mide) {
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('command-palette:recent') || '[]'); } catch {}

  // Which commands apply depends on what has focus (Toggle Comment needs the editor), so the list
  // is taken as the box opens, not when ">" is typed inside it.
  let snapshot = null;
  const commandItems = () => {
    const list = mide.commands.list()
      .filter((c) => c.id !== 'command-palette:toggle')
      .map((c) => {
        const binding = mide.keymap.bindingsFor(c.id)[0];
        return { id: c.id, label: c.category ? `${c.category}: ${c.title}` : c.title, hint: binding ? mide.keymap.pretty(binding) : null };
      });
    const rank = (id) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    return list.sort((a, b) => (rank(a.id) - rank(b.id)) || a.label.localeCompare(b.label));
  };

  mide.ui.addQuickOpenMode({
    prefix: '>', title: 'Commands', short: 'commands', order: 10,
    description: 'Run any command by name',
    onOpen: () => { snapshot = commandItems(); },
    items: () => snapshot || commandItems(),
    maxItems: 300,
    alternateQueries,
    render: (item, indices) => {
      const { h, highlightMatches } = mide.ui;
      return h('div.select-row',
        h('div.select-text', h('div.select-label', highlightMatches(item.label, indices))),
        recent.includes(item.id) && !indices.length ? h('span.palette-recent', 'recent') : null,
        item.hint ? h('kbd.select-hint', item.hint) : null);
    },
    onSelect: (item) => {
      recent = [item.id, ...recent.filter((r) => r !== item.id)].slice(0, 12);
      try { localStorage.setItem('command-palette:recent', JSON.stringify(recent)); } catch {}
      // Let the box close and focus return before running.
      setTimeout(() => mide.commands.run(item.id), 0);
    },
  });

  mide.commands.add('command-palette:toggle', 'Toggle Command Palette', () => mide.ui.quickOpen('>'));

  mide.styles.add('.palette-recent { color: var(--fg-subtle); font-size: 0.85em; margin-right: 6px; }');
}
