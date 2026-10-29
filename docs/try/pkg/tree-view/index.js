// Tree View: the project file browser. With one folder its contents are the top level; with several
// each folder is a top-level row under a hidden root node (`multi`).

export function activate(mide) {
  const { h, icon, fileIcon } = mide.ui;
  class Node {
    constructor(path, name, isDir, depth, parent) {
      Object.assign(this, { path, name, isDir, depth, parent, children: null, expanded: false, row: null });
    }
  }

  function Tree(mide) {
    this.mide = mide;
    this.root = null;
    this.multi = false;
    this.nodes = new Map();
    this.selected = null;
    this.git = null;
    this.list = h('div.tree-list', { tabIndex: 0, role: 'tree' });
    this.header = h('div.tree-header');
    this.element = h('div.tree-view', this.header, this.list);
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target === this.list) { e.preventDefault(); this.contextMenu(this.root); }
    });
    this.list.addEventListener('dragover', (e) => { if (e.target === this.list && this.dragging) { e.preventDefault(); } });
    this.list.addEventListener('drop', (e) => { if (e.target === this.list && this.dragging) { e.preventDefault(); this.moveInto(this.dragging, this.root); } });
  }

  Object.assign(Tree.prototype, {
    focus() { this.list.focus(); if (!this.selected && this.root) this.select(this.root.children?.[0]); },

    storageKey(folder) { return `tree-view:expanded:${folder.path}`; },

    readStored(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } },

    saveExpanded() {
      if (!this.root) return;
      const dirs = [...this.nodes.values()].filter((n) => n.isDir && n.expanded && !n.folder);
      for (const f of this.folders()) {
        const expanded = dirs.filter((n) => this.folderOf(n) === f).map((n) => n.path);
        try { localStorage.setItem(this.storageKey(f), JSON.stringify(expanded)); } catch {}
      }
      if (!this.multi) return;
      const collapsed = new Set(this.readStored('tree-view:collapsed-folders'));
      for (const f of this.folders()) if (f.expanded) collapsed.delete(f.path); else collapsed.add(f.path);
      try { localStorage.setItem('tree-view:collapsed-folders', JSON.stringify([...collapsed].slice(-50))); } catch {}
    },

    async setRoots(paths) {
      this.nodes.clear();
      this.selected = null;
      this.multi = paths.length > 1;
      if (!paths.length) { this.root = null; return this.render(); }
      const folderNode = (path, parent) => {
        const n = new Node(path, mide.path.basename(path), true, parent ? 0 : -1, parent);
        n.folder = true;
        this.nodes.set(path, n);
        return n;
      };
      const collapsed = new Set(this.multi ? this.readStored('tree-view:collapsed-folders') : []);
      if (this.multi) {
        this.root = new Node(null, '', true, -1, null);
        this.root.children = paths.map((p) => folderNode(p, this.root));
      } else this.root = folderNode(paths[0], null);
      this.root.expanded = true;
      for (const f of this.folders()) {
        f.expanded = !collapsed.has(f.path);
        await this.load(f);
        const saved = this.readStored(this.storageKey(f)).sort((a, b) => a.length - b.length);
        for (const p of saved) {
          const node = this.nodes.get(p);
          if (node?.isDir) { node.expanded = true; await this.load(node); }
        }
      }
      this.render();
      this.revealActive(false);
    },

    /** The project folders' nodes. */
    folders() { return !this.root ? [] : this.multi ? this.root.children : [this.root]; },

    folderOf(node) { while (node && !node.folder) node = node.parent; return node; },

    folderNodeFor(path) {
      return this.folders().filter((f) => path === f.path || path.startsWith(f.path + '/')).sort((a, b) => b.path.length - a.path.length)[0] || null;
    },

    /** `path` relative to its project folder (no folder name in front). */
    localPath(path, folder = this.folderNodeFor(path)) { return path === folder.path ? '' : path.slice(folder.path.length + 1); },

    isHidden(name) {
      if (!mide.config.get('tree-view.hideIgnored')) return false;
      return (mide.config.get('core.ignoredNames') || []).includes(name);
    },

    async load(node) {
      if (node.path == null) return; // the hidden root of several folders: its children are fixed
      let entries = [];
      try { entries = await mide.fs.readdir(node.path); } catch { entries = []; }
      const prev = new Map((node.children || []).map((c) => [c.path, c]));
      node.children = entries
        .filter((e) => !this.isHidden(e.name))
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((e) => {
          const existing = prev.get(e.path);
          if (existing && existing.isDir === e.isDir) { prev.delete(e.path); return existing; }
          const n = new Node(e.path, e.name, e.isDir, node.depth + 1, node);
          this.nodes.set(e.path, n);
          return n;
        });
      for (const gone of prev.values()) this.forget(gone);
    },

    forget(node) {
      this.nodes.delete(node.path);
      if (this.selected === node) this.selected = null;
      for (const c of node.children || []) this.forget(c);
    },

    async refresh() {
      if (!this.root) return;
      const reload = async (node) => {
        await this.load(node);
        for (const c of node.children) if (c.isDir && c.expanded) await reload(c);
      };
      await reload(this.root);
      this.render();
    },

    onFilesChanged(paths) {
      if (!this.root) return;
      const dirs = new Set();
      for (const p of paths) {
        const parent = p.slice(0, p.lastIndexOf('/'));
        const node = this.nodes.get(parent);
        if (node?.isDir && node.expanded) dirs.add(node);
      }
      if (!dirs.size) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(async () => {
        for (const d of dirs) if (this.nodes.has(d.path)) await this.load(d);
        this.render();
      }, 60);
    },

    visible() {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          out.push(c);
          if (c.isDir && c.expanded) walk(c);
        }
      };
      if (this.root) walk(this.root);
      return out;
    },

    render() {
      this.renderHeader();
      if (!this.root) {
        this.list.replaceChildren(h('div.tree-empty',
          h('p', 'No folder open.'),
          h('button.btn.primary', { onclick: () => mide.commands.run('project:open-folder') }, 'Open Folder')));
        return;
      }
      const scroll = this.list.scrollTop;
      const rows = this.visible().map((node) => this.renderRow(node));
      this.list.replaceChildren(...rows);
      if (!rows.length) this.list.append(h('div.tree-empty', h('p', 'This folder is empty.')));
      this.list.scrollTop = scroll;
      this.markActive();
      this.decorate();
    },

    renderHeader() {
      const actions = this.root ? [
        h('button.icon-btn', { title: 'New File', onclick: () => this.newEntry(false) }, icon('plus', 15)),
        h('button.icon-btn', { title: 'Refresh', onclick: () => this.refresh() }, icon('refresh', 14)),
        h('button.icon-btn', { title: 'Collapse All', onclick: () => this.collapseAll() }, icon('collapse', 14)),
      ] : [];
      const folders = this.folders();
      this.header.replaceChildren(
        h('span.tree-title', { title: folders.map((f) => f.path).join('\n') }, folders.length ? folders[0].name + (this.multi ? ` +${folders.length - 1}` : '') : 'Explorer'),
        h('div.tree-actions', actions));
    },

    renderRow(node) {
      const row = h('div.tree-row', {
        role: 'treeitem',
        draggable: !node.folder,
        ...(node.folder ? { title: node.path } : {}),
        style: { paddingLeft: `${10 + node.depth * 14}px` },
        dataset: { path: node.path },
        onmousedown: (e) => { if (e.button === 0) this.select(node); },
        onclick: (e) => {
          if (e.detail > 1) return;
          if (node.isDir) this.toggle(node);
          else mide.workspace.open(node.path, { pending: mide.config.get('tree-view.singleClickPreview'), focus: false });
        },
        ondblclick: () => { if (!node.isDir) mide.workspace.open(node.path, { pending: false }); },
        oncontextmenu: (e) => { e.preventDefault(); this.select(node); this.contextMenu(node); },
        ondragstart: (e) => { this.dragging = node; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.path); },
        ondragend: () => { this.dragging = null; this.list.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target')); },
        ondragover: (e) => {
          const target = node.isDir ? node : node.parent;
          if (!this.dragging || !this.canMove(this.dragging, target)) return;
          e.preventDefault();
          this.list.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
          target.row?.classList.add('drop-target');
        },
        ondrop: (e) => {
          e.preventDefault();
          const target = node.isDir ? node : node.parent;
          if (this.dragging && this.canMove(this.dragging, target)) this.moveInto(this.dragging, target);
        },
      });
      const chevron = node.isDir ? icon('chevron', 12) : h('span.tree-spacer');
      if (node.isDir) chevron.classList.add('tree-chevron');
      const ic = node.isDir ? icon(node.expanded ? 'folder-open' : 'folder', 15) : fileIcon(node.name);
      if (node.isDir) ic.classList.add('tree-folder-icon');
      row.append(chevron, ic, h('span.tree-name', node.name));
      row.classList.toggle('expanded', node.expanded);
      row.classList.toggle('dir', node.isDir);
      row.classList.toggle('selected', node === this.selected);
      row.classList.toggle('dotfile', node.name.startsWith('.'));
      row.classList.toggle('project-folder', !!node.folder);
      node.row = row;
      return row;
    },

    async toggle(node, force) {
      if (!node?.isDir) return;
      node.expanded = force ?? !node.expanded;
      if (node.expanded && !node.children) await this.load(node);
      else if (node.expanded) await this.load(node);
      this.saveExpanded();
      this.render();
    },

    collapseAll() {
      for (const n of this.nodes.values()) if (n !== this.root) n.expanded = false;
      this.saveExpanded();
      this.render();
    },

    select(node) {
      if (this.selected?.row) this.selected.row.classList.remove('selected');
      this.selected = node || null;
      if (node?.row) { node.row.classList.add('selected'); node.row.scrollIntoView({ block: 'nearest' }); }
    },

    markActive() {
      const path = mide.workspace.getActiveItem()?.getPath?.();
      this.list.querySelector('.tree-row.active')?.classList.remove('active');
      if (path) this.nodes.get(path)?.row?.classList.add('active');
    },

    async revealActive(focus) {
      const path = mide.workspace.getActiveItem()?.getPath?.();
      const folder = path && this.folderNodeFor(path);
      if (!folder || path === folder.path) return;
      const parts = this.localPath(path, folder).split('/');
      let cur = folder;
      let changed = !folder.expanded;
      folder.expanded = true;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = cur.children?.find((c) => c.name === parts[i]);
        if (!next) return;
        if (!next.expanded) { next.expanded = true; await this.load(next); changed = true; }
        else if (!next.children) await this.load(next);
        cur = next;
      }
      if (changed) { this.saveExpanded(); this.render(); }
      const node = this.nodes.get(path);
      if (node) { this.select(node); this.markActive(); }
      if (focus) this.list.focus();
    },

    decorate() {
      if (!this.git || !this.root) return;
      const statuses = this.git.statuses();
      for (const node of this.visible()) {
        if (!node.row) continue;
        const s = node.isDir ? this.git.dirStatus(node.path) : statuses.get(node.path);
        node.row.dataset.git = s || '';
      }
    },

    // --- keyboard ----------------------------------------------------------
    onKey(e) {
      const rows = this.visible();
      const i = rows.indexOf(this.selected);
      const node = this.selected;
      const mod = e.metaKey || e.ctrlKey;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); this.select(rows[Math.min(rows.length - 1, i + 1)] || rows[0]); break;
        case 'ArrowUp': e.preventDefault(); this.select(rows[Math.max(0, i - 1)] || rows[0]); break;
        case 'Home': e.preventDefault(); this.select(rows[0]); break;
        case 'End': e.preventDefault(); this.select(rows.at(-1)); break;
        case 'ArrowRight':
          e.preventDefault();
          if (node?.isDir && !node.expanded) this.toggle(node, true);
          else if (node?.isDir) this.select(node.children?.[0]);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (node?.isDir && node.expanded) this.toggle(node, false);
          else if (node?.parent && node.parent !== this.root) this.select(node.parent);
          break;
        case 'Enter':
          e.preventDefault();
          if (!node) break;
          if (node.isDir) this.toggle(node);
          else mide.workspace.open(node.path);
          break;
        case ' ':
          e.preventDefault();
          if (node && !node.isDir) mide.workspace.open(node.path, { pending: true, focus: false });
          break;
        case 'F2': e.preventDefault(); if (node) this.rename(node); break;
        case 'Backspace': case 'Delete':
          if (mod || e.key === 'Delete') { e.preventDefault(); if (node) this.remove(node); }
          break;
        case 'a': if (!mod) { e.preventDefault(); this.newEntry(false, node); } break;
        case 'A': e.preventDefault(); this.newEntry(true, node); break;
        case 'd': if (!mod && node && !node.isDir) { e.preventDefault(); this.duplicate(node); } break;
        case 'm': case 'r': if (!mod && node) { e.preventDefault(); this.rename(node); } break;
      }
    },

    // --- file operations ---------------------------------------------------
    targetDir(node) {
      if (!node || node.path == null) return this.folders()[0];
      return node.isDir ? node : node.parent;
    },

    async newEntry(isDir, near = this.selected) {
      if (!this.root) return mide.commands.run('project:open-folder');
      const dir = this.targetDir(near);
      const folder = this.folderOf(dir);
      const base = dir === folder ? '' : this.localPath(dir.path, folder) + '/';
      const value = await mide.ui.prompt({
        title: (isDir ? 'Enter the path for the new folder.' : 'Enter the path for the new file. Use / to create folders.') + (this.multi ? ` (in ${folder.name})` : ''),
        value: base,
        selection: [base.length, base.length],
      });
      if (!value || value === base) return;
      const full = `${folder.path}/${value.replace(/^\/+/, '')}`.replace(/\/+$/, '');
      if (await mide.fs.stat(full)) return mide.notify.error(`"${value}" already exists.`);
      try {
        if (isDir) await mide.fs.mkdir(full);
        else await mide.fs.write(full, '');
        await this.refreshPath(full);
        if (!isDir) mide.workspace.open(full);
      } catch (err) { mide.notify.error('Could not create entry', err.message); }
    },

    async refreshPath(full) {
      const parent = full.slice(0, full.lastIndexOf('/'));
      let cur = this.folderNodeFor(full);
      if (!cur) return;
      const segments = this.localPath(parent, cur).split('/').filter(Boolean);
      cur.expanded = true;
      await this.load(cur);
      for (const seg of segments) {
        const next = cur.children?.find((c) => c.name === seg);
        if (!next) break;
        next.expanded = true;
        await this.load(next);
        cur = next;
      }
      this.saveExpanded();
      this.render();
      const node = this.nodes.get(full);
      if (node) this.select(node);
    },

    async rename(node) {
      if (node.folder) return;
      const folder = this.folderOf(node);
      const rel = this.localPath(node.path, folder);
      const nameStart = rel.lastIndexOf('/') + 1;
      const dot = node.isDir ? -1 : rel.lastIndexOf('.');
      const value = await mide.ui.prompt({
        title: 'Enter the new path.',
        value: rel,
        selection: [nameStart, dot > nameStart ? dot : rel.length],
      });
      if (!value || value === rel) return;
      const target = `${folder.path}/${value}`;
      // A case-only rename is the same file on case-insensitive disks (macOS): allow it.
      if (target.toLowerCase() !== node.path.toLowerCase() && await mide.fs.stat(target)) return mide.notify.error(`"${value}" already exists.`);
      await this.move(node, target);
    },

    async move(node, target) {
      try {
        await mide.fs.mkdir(target.slice(0, target.lastIndexOf('/')));
        await mide.fs.rename(node.path, target);
        // Keep open editors (and the workspace's document map) pointing at the right files.
        mide.workspace.renamePath(node.path, target);
        await this.refreshPath(target);
        await this.load(node.parent);
        this.render();
      } catch (err) { mide.notify.error('Move failed', err.message); }
    },

    canMove(node, target) {
      if (!target || target.path == null || node.folder || node === target || node.parent === target) return false;
      return !target.path.startsWith(node.path + '/');
    },

    async moveInto(node, dir) {
      if (!this.canMove(node, dir)) return;
      const target = `${dir.path}/${node.name}`;
      if (await mide.fs.stat(target)) return mide.notify.error(`"${node.name}" already exists in ${dir.name}.`);
      await this.move(node, target);
    },

    async duplicate(node) {
      const dot = node.name.lastIndexOf('.');
      const copyName = dot > 0 ? `${node.name.slice(0, dot)} copy${node.name.slice(dot)}` : `${node.name} copy`;
      const folder = this.folderOf(node);
      const rel = this.localPath(`${node.parent.path}/${copyName}`, folder);
      const value = await mide.ui.prompt({ title: 'Duplicate to:', value: rel });
      if (!value) return;
      const target = `${folder.path}/${value}`;
      if (await mide.fs.stat(target)) return mide.notify.error(`"${value}" already exists.`);
      try {
        await mide.fs.copy(node.path, target); // byte-for-byte, so images and other binaries survive
      } catch (err) { return mide.notify.error('Duplicate failed', err.message); }
      await this.refreshPath(target);
    },

    async remove(node) {
      if (node.folder) return;
      const choice = await mide.ui.confirm({
        type: 'warning',
        message: `Move "${node.name}" to the Trash?`,
        detail: node.isDir ? 'The folder and its contents will be moved to the Trash.' : 'You can restore it from the Trash.',
        buttons: ['Move to Trash', 'Cancel'],
      });
      if (choice !== 0) return;
      try {
        await mide.fs.trash(node.path);
        const rows = this.visible();
        const next = rows[rows.indexOf(node) + 1] || rows[rows.indexOf(node) - 1];
        await this.load(node.parent);
        this.render();
        if (next && this.nodes.has(next.path)) this.select(next);
      } catch (err) { mide.notify.error('Delete failed', err.message); }
    },

    async contextMenu(node) {
      if (node.path == null) { // the empty space below several folders
        if (await mide.ui.contextMenu([{ id: 'add-folder', label: 'Add Folder to Project…' }]) === 'add-folder') mide.commands.run('project:add-folder');
        return;
      }
      const isRoot = !!node.folder;
      const choice = await mide.ui.contextMenu([
        ...(isRoot ? [
          { id: 'add-folder', label: 'Add Folder to Project…' },
          ...(this.multi ? [{ id: 'remove-folder', label: 'Remove Folder from Project' }] : []),
          { type: 'separator' },
        ] : []),
        { id: 'new-file', label: 'New File' },
        { id: 'new-folder', label: 'New Folder' },
        { type: 'separator' },
        { id: 'open-split', label: 'Open to the Side', enabled: !node.isDir },
        { id: 'rename', label: 'Rename…', enabled: !isRoot },
        { id: 'duplicate', label: 'Duplicate…', enabled: !node.isDir },
        { id: 'delete', label: 'Move to Trash', enabled: !isRoot },
        { type: 'separator' },
        { id: 'copy-path', label: 'Copy Path' },
        { id: 'copy-rel', label: 'Copy Relative Path', enabled: !isRoot },
        { id: 'reveal', label: 'Reveal in Finder' },
        ...(!node.isDir && mide.commands.has('local-history:show') ? [{ id: 'history', label: 'Show Local History' }] : []),
        { id: 'search', label: 'Find in Folder…', enabled: node.isDir },
        { id: 'run', label: 'Open Terminal Here', enabled: node.isDir },
      ]);
      switch (choice) {
        case 'add-folder': return mide.commands.run('project:add-folder');
        case 'remove-folder': return mide.workspace.removeFolder(node.path);
        case 'new-file': return this.newEntry(false, node);
        case 'new-folder': return this.newEntry(true, node);
        case 'open-split': { const pane = mide.workspace.splitRight({ empty: true }); return mide.workspace.open(node.path, { pane }); }
        case 'rename': return this.rename(node);
        case 'duplicate': return this.duplicate(node);
        case 'delete': return this.remove(node);
        case 'copy-path': return mide.clipboard.write(node.path);
        case 'copy-rel': return mide.clipboard.write(mide.workspace.relativePath(node.path));
        case 'reveal': return mide.shell.reveal(node.path);
        case 'history': return mide.commands.run('local-history:show-for', node.path);
        case 'search': return mide.commands.run('find-in-project:show', { folder: mide.workspace.relativePath(node.path) });
        case 'run': return mide.commands.run('terminal:new', { cwd: node.path });
      }
    },
  });

  const tree = new Tree(mide);

  mide.sidebar.addView({
    id: 'tree-view', title: 'Files', icon: 'files', order: 0, command: 'tree-view:focus',
    element: tree.element, focus: () => tree.focus(),
  });

  mide.commands.add({
    'tree-view:focus': { title: 'Focus Tree View', run: () => { mide.sidebar.show('tree-view'); tree.focus(); } },
    'tree-view:toggle': { title: 'Toggle Tree View', run: () => mide.sidebar.toggle('tree-view') },
    'tree-view:reveal-active-file': { title: 'Reveal Active File', run: () => { mide.sidebar.show('tree-view'); tree.revealActive(true); } },
    'tree-view:collapse-all': { title: 'Collapse All', run: () => tree.collapseAll() },
    'tree-view:refresh': { title: 'Refresh', run: () => tree.refresh() },
    'tree-view:new-file': { title: 'New File in Project…', run: () => tree.newEntry(false) },
    'tree-view:new-folder': { title: 'New Folder in Project…', run: () => tree.newEntry(true) },
  });

  mide.workspace.onDidChangeFolders((folders) => tree.setRoots(folders));
  mide.workspace.onDidChangeFiles((paths) => tree.onFilesChanged(paths));
  mide.workspace.onDidChangeActiveItem(() => { tree.markActive(); if (mide.config.get('tree-view.autoReveal')) tree.revealActive(false); });
  mide.config.onDidChange('core.ignoredNames', () => tree.refresh());
  mide.config.onDidChange('tree-view.hideIgnored', () => tree.refresh());
  mide.services.consume('git-status', (git) => { tree.git = git; mide.subscriptions.add(git.onDidChange(() => tree.decorate())); tree.decorate(); });

  if (mide.workspace.project) tree.setRoots(mide.workspace.folders);
  else tree.render();
}
