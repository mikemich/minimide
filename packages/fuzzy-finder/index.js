// Fuzzy Finder: Mod-P for files, the default search of the quick-open box. Supports "file:line"
// to jump straight to a line.

export function activate(mide) {
  const { h, fileIcon, highlightMatches } = mide.ui;
  let recent = [];

  mide.workspace.onDidChangeActiveItem((item) => {
    const p = item?.getPath?.();
    if (p) recent = [p, ...recent.filter((r) => r !== p)].slice(0, 50);
  });

  const renderPath = (rel, indices) => {
    const slash = rel.lastIndexOf('/');
    const name = rel.slice(slash + 1);
    const dir = slash >= 0 ? rel.slice(0, slash) : '';
    const nameIdx = indices.filter((i) => i > slash).map((i) => i - slash - 1);
    const dirIdx = indices.filter((i) => i < slash);
    return h('div.select-row',
      fileIcon(name),
      h('div.select-text.finder-text',
        h('span.finder-name', highlightMatches(name, nameIdx)),
        dir ? h('span.finder-dir', highlightMatches(dir, dirIdx)) : null));
  };

  const parseQuery = (q) => {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(q);
    return m ? { query: m[1], line: +m[2], col: m[3] ? +m[3] - 1 : 0 } : { query: q };
  };

  const fileSearch = (items) => ({
    items,
    filterKey: (i) => i.rel,
    maxItems: 80,
    render: (i, indices) => renderPath(i.rel, indices),
    emptyMessage: () => (mide.workspace.project ? 'No matching files' : 'Open a folder to search its files'),
    transformQuery: (q) => parseQuery(q).query,
    footer: (shown, total) => (total > shown ? `${shown} of ${total} files` : ''),
    onSelect: (i, q) => {
      const { line, col } = parseQuery(q);
      mide.workspace.open(i.path, line ? { line, col } : {});
    },
  });

  const projectFiles = async () => {
    const folders = mide.workspace.folders;
    if (!folders.length) return recent.map((p) => ({ path: p, rel: p }));
    // With several folders, `rel` starts with the folder's name (as relativePath() shows it).
    const lists = await Promise.all(folders.map(async (root) => (await mide.project.files(root))
      .map((rel) => ({ rel: folders.length > 1 ? `${mide.path.basename(root)}/${rel}` : rel, path: `${root}/${rel}` }))));
    const recentRank = new Map(recent.map((p, i) => [p, i]));
    const seen = new Set(); // a folder inside another one lists its files twice
    return lists.flat()
      .filter((f) => !seen.has(f.path) && seen.add(f.path))
      .sort((a, b) => (recentRank.get(a.path) ?? 1e9) - (recentRank.get(b.path) ?? 1e9));
  };
  const placeholder = () => {
    const folders = mide.workspace.folders;
    if (!folders.length) return 'Search recent files';
    return folders.length > 1 ? `Search files in ${folders.length} folders` : `Search files in ${mide.path.basename(folders[0])}`;
  };
  mide.ui.addQuickOpenMode({
    ...fileSearch(projectFiles),
    prefix: '', title: 'Files', order: 0,
    description: 'Type a file name. name:42 opens it at line 42',
    placeholder,
  });

  mide.commands.add('fuzzy-finder:toggle', 'Find File', () => mide.ui.quickOpen(''));

  mide.commands.add('fuzzy-finder:toggle-open-tabs', 'Find Open Tab', () => {
    const items = mide.workspace.getItems()
      .filter((i) => i.getPath?.())
      .map((i) => ({ path: i.getPath(), rel: mide.workspace.relativePath(i.getPath()) }));
    mide.ui.selectList({ ...fileSearch(items), id: 'fuzzy-finder-tabs', placeholder: 'Search open tabs' });
  });

  mide.styles.add(`
    .finder-text { display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
    .finder-name { color: var(--fg-strong); flex: none; }
    .finder-dir { color: var(--fg-subtle); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `);
}
