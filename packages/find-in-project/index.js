// Find in Project: a sidebar search with regex, case and folder filters, plus replace-all.

export function activate(mide) {
  const { h, icon, fileIcon } = mide.ui;
  const state = { regex: false, caseSensitive: false, results: [], collapsed: new Set(), seq: 0 };

  const query = h('input.input.fip-query', { placeholder: 'Search', spellcheck: false });
  const replace = h('input.input.fip-replace', { placeholder: 'Replace', spellcheck: false });
  const folder = h('input.input.fip-folder', { placeholder: 'Folder to search (e.g. src/lib)', spellcheck: false });
  const toggle = (key, label, title) => {
    const btn = h('button.fip-toggle', { title, onclick: () => { state[key] = !state[key]; btn.classList.toggle('on', state[key]); run(); } }, label);
    return btn;
  };
  const replaceRow = h('div.fip-row.fip-replace-row', { hidden: true }, replace,
    h('button.btn.small', { title: 'Replace all matches', onclick: () => replaceAll() }, 'Replace All'));
  const summary = h('div.fip-summary');
  const results = h('div.fip-results');
  const el = h('div.fip',
    h('div.fip-form',
      h('div.fip-row', h('button.icon-btn.fip-expand', { title: 'Toggle Replace', onclick: () => { replaceRow.hidden = !replaceRow.hidden; expandBtnState(); } }, icon('chevron', 12)),
        h('div.fip-query-wrap', query, h('div.fip-toggles', toggle('caseSensitive', 'Aa', 'Match Case'), toggle('regex', '.*', 'Use Regular Expression')))),
      replaceRow,
      h('div.fip-row', folder)),
    summary, results);
  const expandBtn = el.querySelector('.fip-expand');
  const expandBtnState = () => expandBtn.classList.toggle('open', !replaceRow.hidden);

  let timer = null;
  query.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  folder.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 400); });
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); run(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('.fip-match')?.focus(); }
  });
  replace.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) replaceAll(); });

  async function run() {
    const q = query.value;
    const seq = ++state.seq;
    if (!mide.workspace.project) { summary.textContent = 'Open a folder to search.'; results.replaceChildren(); return; }
    if (!q) { summary.textContent = ''; results.replaceChildren(); state.results = []; return; }
    summary.textContent = 'Searching…';
    // With several folders, the filter may start with a folder's name (as relative paths do).
    const root = folder.value.trim() ? mide.workspace.resolvePath(folder.value.trim().replace(/^\/+|\/+$/g, '')) : undefined;
    const res = await mide.project.search(q, { regex: state.regex, caseSensitive: state.caseSensitive, root });
    if (seq !== state.seq) return;
    if (res.error) { summary.textContent = res.error; summary.classList.add('error'); results.replaceChildren(); return; }
    summary.classList.remove('error');
    state.results = res.results;
    const count = res.results.reduce((n, r) => n + r.matches.length, 0);
    summary.textContent = count
      ? `${count}${res.truncated ? '+' : ''} result${count === 1 ? '' : 's'} in ${res.results.length} file${res.results.length === 1 ? '' : 's'}`
      : 'No results.';
    if (res.notice) summary.append(h('div.fip-notice', res.notice));
    render();
  }

  function render() {
    results.replaceChildren(...state.results.map((r) => {
      const rel = mide.workspace.relativePath(r.file);
      const slash = rel.lastIndexOf('/');
      const collapsed = state.collapsed.has(r.file);
      const header = h('div.fip-file', {
        class: collapsed ? 'collapsed' : '',
        title: rel,
        onclick: () => { if (collapsed) state.collapsed.delete(r.file); else state.collapsed.add(r.file); render(); },
      }, icon('chevron', 11), fileIcon(rel), h('span.fip-file-name', rel.slice(slash + 1)),
      slash > 0 ? h('span.fip-file-dir', rel.slice(0, slash)) : null, h('span.fip-count', String(r.matches.length)));
      const group = h('div.fip-group', header);
      if (!collapsed) {
        for (const m of r.matches) {
          const start = Math.max(0, m.col - 40);
          const before = (start > 0 ? '…' : '') + m.text.slice(start, m.col).trimStart();
          group.append(h('div.fip-match', {
            tabIndex: 0,
            onclick: () => mide.workspace.open(r.file, { line: m.line, col: m.col, length: m.length, pending: true }),
            onkeydown: (e) => {
              if (e.key === 'Enter') mide.workspace.open(r.file, { line: m.line, col: m.col, length: m.length });
              if (e.key === 'ArrowDown') { e.preventDefault(); nextMatch(e.target, 1)?.focus(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); (nextMatch(e.target, -1) || query).focus(); }
            },
          }, h('span.fip-line', String(m.line)),
          h('span.fip-text', before, h('mark', m.text.slice(m.col, m.col + m.length)), m.text.slice(m.col + m.length, m.col + m.length + 120))));
        }
      }
      return group;
    }));
  }

  function nextMatch(el, dir) {
    const all = [...results.querySelectorAll('.fip-match')];
    return all[all.indexOf(el) + dir];
  }

  async function replaceAll() {
    // Re-run the search first so we never replace using results from an older query.
    clearTimeout(timer);
    await run();
    const q = query.value;
    if (!q || !state.results.length) return;
    const total = state.results.reduce((n, r) => n + r.matches.length, 0);
    const choice = await mide.ui.confirm({
      type: 'warning',
      message: `Replace ${total} occurrence${total === 1 ? '' : 's'} across ${state.results.length} file${state.results.length === 1 ? '' : 's'}?`,
      detail: `"${q}" → "${replace.value}"\nOpen files are changed in the editor (undoable); other files are written to disk.`,
      buttons: ['Replace', 'Cancel'],
    });
    if (choice !== 0) return;
    const source = state.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(source, state.caseSensitive ? 'g' : 'gi');
    const value = replace.value;
    // Search matched line by line, so replace line by line too (a pattern like \s+ must not join lines).
    // With regex off the replacement is literal: "$&" or "$5" are inserted as typed.
    const replaceLine = (line) => (state.regex ? line.replace(re, value) : line.replace(re, () => value));
    let changed = 0;
    const failed = [];
    for (const r of state.results) {
      try {
        const editor = mide.workspace.getItems().find((i) => i.type === 'editor' && i.getPath() === r.file);
        if (editor) {
          const doc = editor.view.state.doc;
          const changes = [];
          for (let n = 1; n <= doc.lines; n++) {
            const line = doc.line(n);
            const next = replaceLine(line.text);
            if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
          }
          if (changes.length) { editor.view.dispatch({ changes, userEvent: 'input.replace.all' }); changed++; }
        } else {
          const text = await mide.fs.read(r.file);
          if (text.includes('\ufffd')) { failed.push(`${mide.workspace.relativePath(r.file)} (not UTF-8, skipped)`); continue; }
          const next = text.split('\n').map(replaceLine).join('\n');
          if (next !== text) { await mide.fs.write(r.file, next); changed++; }
        }
      } catch (err) {
        failed.push(`${mide.workspace.relativePath(r.file)}: ${err.message}`);
      }
    }
    if (failed.length) mide.notify.warn(`Replaced in ${changed} file${changed === 1 ? '' : 's'}; ${failed.length} skipped`, failed.slice(0, 5).join('\n'));
    else mide.notify.success(`Replaced in ${changed} file${changed === 1 ? '' : 's'}`);
    run();
  }

  mide.sidebar.addView({
    id: 'find-in-project', title: 'Search', icon: 'search', order: 10, command: 'find-in-project:show', element: el,
    focus: () => { query.focus(); query.select(); },
  });

  const show = (opts = {}) => {
    const editor = mide.workspace.getActiveEditor();
    const sel = editor?.getSelectedText();
    if (sel && !sel.includes('\n')) query.value = sel;
    if (opts.folder != null) folder.value = opts.folder;
    mide.sidebar.show('find-in-project');
    query.focus();
    query.select();
    if (query.value) run();
  };
  mide.commands.add('find-in-project:show', 'Find in Project', (opts) => show(opts));
  mide.commands.add('find-in-project:show-replace', 'Replace in Project', () => { replaceRow.hidden = false; expandBtnState(); show(); });
  mide.workspace.onDidChangeFolders(() => { state.results = []; results.replaceChildren(); summary.textContent = ''; });
}
