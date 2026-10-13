// Command Palette: fuzzy-search every command, most recently used first.

export function activate(mide) {
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('command-palette:recent') || '[]'); } catch {}

  mide.commands.add('command-palette:toggle', 'Toggle Command Palette', () => {
    const items = mide.commands.list()
      .filter((c) => c.id !== 'command-palette:toggle')
      .map((c) => {
        const binding = mide.keymap.bindingsFor(c.id)[0];
        return { id: c.id, label: c.category ? `${c.category}: ${c.title}` : c.title, hint: binding ? mide.keymap.pretty(binding) : null };
      });
    const rank = (id) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    items.sort((a, b) => (rank(a.id) - rank(b.id)) || a.label.localeCompare(b.label));

    mide.ui.selectList({
      id: 'command-palette',
      placeholder: 'Run a command…',
      items,
      maxItems: 300,
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
        // Let the palette close and focus return before running.
        setTimeout(() => mide.commands.run(item.id), 0);
      },
    });
  });

  mide.styles.add('.palette-recent { color: var(--fg-subtle); font-size: 0.85em; margin-right: 6px; }');
}
