// Breadcrumbs: a bar above each editor with the file's folder, its name and the symbols around the
// cursor (src › app.js › Cart › total). A symbol lists the ones next to it to jump to; a folder or
// the file shows it in the tree. Symbols come from the `symbols` service.

export function activate(mide) {
  const { h, icon, fileIcon, symbolIcon } = mide.ui;
  const { showPanel } = mide.cm.view;
  const symbols = mide.services.get('symbols');

  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view) || null;
  const crumbs = new Set();

  // Every editor shows them, so keep every editor's symbols up to date.
  mide.subscriptions.add(symbols.watch(() => true));
  mide.subscriptions.add(symbols.onDidChange((editor) => { for (const c of crumbs) if (c.view === editor.view) c.render(); }));

  // ---------------------------------------------------------------------------
  // A small list of symbols under a breadcrumb, with a filter

  let menu = null;
  function closeMenu(refocus) {
    if (!menu) return;
    const { el, view } = menu;
    menu = null;
    el.remove();
    window.removeEventListener('mousedown', onOutside, true);
    if (refocus && view?.dom.isConnected) view.focus();
  }
  const onOutside = (e) => { if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu(false); };

  function openMenu(anchor, editor, list, current) {
    closeMenu(false);
    const input = h('input.cm-crumbs-filter', { placeholder: 'Filter', spellcheck: false });
    const listEl = h('div.cm-crumbs-list');
    const el = h('div.cm-crumbs-menu', input, listEl);
    let rows = [];
    let index = 0;
    const select = (i) => {
      rows[index]?.el.classList.remove('selected');
      index = Math.max(0, Math.min(rows.length - 1, i));
      rows[index]?.el.classList.add('selected');
      rows[index]?.el.scrollIntoView({ block: 'nearest' });
    };
    const pick = (sym) => { closeMenu(false); symbols.reveal(editor, sym); };
    const fill = () => {
      const q = input.value.trim();
      rows = [];
      for (const sym of list) {
        const m = q ? mide.ui.fuzzyMatch(q, sym.name) : { indices: [] };
        if (!m) continue;
        const row = h('div.cm-crumbs-item', { onmousedown: (e) => { e.preventDefault(); pick(sym); } },
          symbolIcon(sym.kind), h('span.cm-crumbs-name', mide.ui.highlightMatches(sym.name, m.indices)), sym.detail ? h('span.cm-crumbs-detail', sym.detail) : null);
        if (sym === current) row.classList.add('current');
        rows.push({ sym, el: row });
      }
      listEl.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [h('div.cm-crumbs-none', 'No symbols')]));
      index = 0;
      select(q ? 0 : Math.max(0, rows.findIndex((r) => r.sym === current)));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => {
      const page = 8;
      if (e.key === 'ArrowDown') select(index + 1);
      else if (e.key === 'ArrowUp') select(index - 1);
      else if (e.key === 'PageDown') select(index + page);
      else if (e.key === 'PageUp') select(index - page);
      else if (e.key === 'Enter') { if (rows[index]) pick(rows[index].sym); }
      else if (e.key === 'Escape') closeMenu(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('focusout', (e) => { if (menu?.el === el && !el.contains(e.relatedTarget)) closeMenu(false); });
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${r.bottom + 2}px`;
    el.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 24)}px`;
    menu = { el, anchor, view: editor.view };
    window.addEventListener('mousedown', onOutside, true);
    fill();
    input.focus();
  }
  mide.subscriptions.add({ dispose: () => closeMenu(false) });

  // ---------------------------------------------------------------------------
  // A panel at the top of each editor

  class Breadcrumbs {
    constructor(view) {
      this.view = view;
      this.key = null;
      this.editor = null;
      this.dom = h('div.cm-breadcrumbs', { onmousedown: (e) => this.onMouseDown(e) });
      crumbs.add(this);
      this.render();
    }

    update(u) { if (u.selectionSet || u.docChanged) this.render(); }

    render(force) {
      this.editor ||= editorFor(this.view);
      const { editor } = this;
      const path = editor?.getPath() || null;
      const snap = editor ? symbols.peek(editor) : null;
      const list = editor ? symbols.symbolPathAt(editor) : [];
      const key = `${path}\n${snap?.symbols.length ?? -1}\n${list.map((s) => `${s.kind}:${s.name}`).join('\n')}`;
      if (!force && key === this.key) return;
      this.key = key;
      this.symbols = list;
      const sep = () => h('span.cm-crumb-sep', icon('chevron', 11));
      const parts = [];
      if (path) {
        const rel = mide.workspace.relativePath(path);
        const segs = rel.split('/').filter(Boolean);
        let dirs = segs.slice(0, -1);
        if (dirs.length > 4) dirs = ['…', ...dirs.slice(-3)];
        for (const d of dirs) parts.push(h('span.cm-crumb', { dataset: { type: 'folder' }, title: 'Reveal in the file tree' }, d), sep());
        const name = segs.at(-1) || mide.path.basename(path);
        parts.push(h('span.cm-crumb', { dataset: { type: 'file' }, title: rel }, fileIcon(name), h('span', name)));
      } else {
        parts.push(h('span.cm-crumb', { dataset: { type: 'file' } }, editor?.getTitle() || 'untitled'));
      }
      list.forEach((s, i) => parts.push(sep(), h('span.cm-crumb', { dataset: { type: 'symbol', index: i }, title: s.detail ? `${s.name} ${s.detail}` : s.name }, symbolIcon(s.kind), h('span', s.name))));
      this.dom.replaceChildren(...parts);
    }

    onMouseDown(e) {
      const crumb = e.target.closest('.cm-crumb');
      if (!crumb || e.button !== 0) return;
      e.preventDefault();
      if (crumb.dataset.type === 'symbol') this.openSiblings(Number(crumb.dataset.index), crumb);
      else {
        // The tree reveals the active file, so make this editor the active one first.
        this.view.focus();
        if (mide.commands.has('tree-view:reveal-active-file')) mide.commands.run('tree-view:reveal-active-file');
      }
    }

    /** The symbols next to the one at `index` (the top level for the first), to jump between. */
    openSiblings(index, anchor) {
      const snap = this.editor && symbols.peek(this.editor);
      if (!snap) return;
      const path = this.symbols || [];
      if (menu?.anchor === anchor) { closeMenu(true); return; }
      const siblings = index > 0 ? path[index - 1].children : snap.symbols;
      openMenu(anchor, this.editor, siblings, path[index]);
    }

    /** Keyboard entry: the innermost symbol's list, or the top level. */
    focus() {
      const snap = this.editor && symbols.peek(this.editor);
      if (!snap) return;
      const items = this.dom.querySelectorAll('.cm-crumb[data-type="symbol"]');
      if (items.length) this.openSiblings(items.length - 1, items[items.length - 1]);
      else {
        const file = this.dom.querySelector('.cm-crumb[data-type="file"]') || this.dom;
        openMenu(file, this.editor, snap.symbols, null);
      }
    }

    destroy() { crumbs.delete(this); if (menu?.view === this.view) closeMenu(false); }
  }

  mide.editor.addExtension(showPanel.of((view) => {
    const b = new Breadcrumbs(view);
    return { dom: b.dom, top: true, update: (u) => b.update(u), destroy: () => b.destroy() };
  }));

  // Paths: a tab that was just added, or a file renamed / saved under a new name.
  const recrumb = (item) => { for (const c of crumbs) if (c.view === item?.view) { c.editor = null; c.render(true); } };
  mide.workspace.onDidOpenItem((item) => { if (item?.type === 'editor') setTimeout(() => recrumb(item), 0); });
  mide.workspace.onDidUpdateEditor((editor, update) => { if (!update) recrumb(editor); });

  const activeCrumbs = () => {
    const v = mide.workspace.getActiveEditor()?.view;
    return [...crumbs].find((c) => c.view === v) || null;
  };
  mide.commands.add({
    'breadcrumbs:focus': {
      title: 'Focus Breadcrumbs', when: () => !!activeCrumbs(),
      run: async () => { const c = activeCrumbs(); c.editor ||= editorFor(c.view); await symbols.getSymbols(c.editor); c.render(true); c.focus(); },
    },
  });
}
