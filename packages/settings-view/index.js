// Settings View: generated from config schemas, so package settings appear automatically.

export function activate(mide) {
  const { h, icon } = mide.ui;
  let item = null;

  const SECTIONS = [
    { id: 'general', title: 'General', icon: 'gear' },
    { id: 'editor', title: 'Editor', icon: 'file' },
    { id: 'themes', title: 'Themes', icon: 'eye' },
    { id: 'packages', title: 'Packages', icon: 'package' },
    { id: 'keybindings', title: 'Keybindings', icon: 'terminal' },
    { id: 'hack', title: 'Make It Yours', icon: 'plus' },
  ];

  class SettingsItem {
    constructor() {
      this.type = 'settings';
      this.id = 'settings-view';
      this.iconName = 'gear';
      this.section = 'general';
      this.filter = '';
      this.nav = h('nav.settings-nav');
      this.content = h('div.settings-content');
      this.element = h('div.settings-view', this.nav, this.content);
      this.subs = [
        mide.config.onDidChangeAny(() => this.maybeRerender()),
        mide.packages.onDidChange(() => this.maybeRerender()),
        mide.keymap.onDidChange(() => { if (this.section === 'keybindings') this.maybeRerender(); }),
      ];
      this.render();
    }
    on() { return { dispose() {} }; }
    getTitle() { return 'Settings'; }
    getElement() { return this.element; }
    focus() { this.content.querySelector('input')?.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { this.subs.forEach((s) => s.dispose()); item = null; }

    maybeRerender() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.element.contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=number], textarea')) return;
        this.renderContent();
      }, 30);
    }

    show(section) { this.section = section; this.render(); }

    render() {
      this.nav.replaceChildren(
        h('div.settings-brand', h('span.logo-mark.small', 'm'), 'Settings'),
        ...SECTIONS.map((s) => h('button.settings-nav-item', { class: s.id === this.section ? 'active' : '', onclick: () => this.show(s.id) }, icon(s.icon, 15), s.title)));
      this.renderContent();
    }

    renderContent() {
      const scroll = this.content.scrollTop;
      const fn = { general: generalSection, editor: editorSection, themes: themesSection, packages: packagesSection, keybindings: keybindingsSection, hack: hackSection }[this.section];
      this.content.replaceChildren(fn(this));
      this.content.scrollTop = scroll;
    }
  }

  // --- controls ------------------------------------------------------------
  function control(def) {
    const value = mide.config.get(def.key);
    const set = (v) => mide.config.set(def.key, v);
    if (def.type === 'boolean') {
      return h('label.switch', h('input', { type: 'checkbox', checked: !!value, onchange: (e) => set(e.target.checked) }), h('span.switch-track'));
    }
    const options = def.enumFrom === 'themes' ? mide.packages.list().filter((p) => p.theme).map((p) => p.name) : def.enum;
    if (options) {
      return h('select.input.settings-select', { onchange: (e) => set(e.target.value) },
        options.map((o) => h('option', { value: o, selected: o === value }, o)));
    }
    if (def.type === 'number') {
      const commit = (e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(n); };
      return h('input.input.settings-number', { type: 'number', value: String(value ?? ''), step: def.key.includes('lineHeight') ? 0.1 : 1, onchange: commit });
    }
    if (def.type === 'object') {
      const count = Object.keys(value || {}).length;
      return h('div.setting-object', h('span', count ? `${count} entr${count === 1 ? 'y' : 'ies'}` : 'Default'),
        h('button.btn.small', { onclick: () => mide.commands.run('settings:open-config-file') }, 'Edit in config.json'));
    }
    if (def.type === 'array') {
      return h('input.input', { type: 'text', value: (value || []).join(', '), onchange: (e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) });
    }
    return h('input.input', { type: 'text', value: value ?? '', onchange: (e) => set(e.target.value) });
  }

  function settingRow(def) {
    const isDefault = JSON.stringify(mide.config.get(def.key)) === JSON.stringify(def.default);
    return h('div.setting', { class: def.type === 'boolean' ? 'inline' : '' },
      h('div.setting-text',
        h('div.setting-title', def.title || def.key,
          !isDefault ? h('button.setting-reset', { title: 'Reset to default', onclick: () => mide.config.set(def.key, undefined) }, 'reset') : null),
        def.description ? h('div.setting-desc', def.description) : null,
        h('code.setting-key', def.key)),
      h('div.setting-control', control(def)));
  }

  function settingsList(prefixes) {
    return mide.config.getSchema()
      .filter((d) => !d.hidden && prefixes.some((p) => d.key.startsWith(p + '.')))
      .map(settingRow);
  }

  function header(title, subtitle) {
    return h('header.settings-header', h('h1', title), subtitle ? h('p', subtitle) : null);
  }

  // --- sections ------------------------------------------------------------
  function generalSection() {
    return h('section', header('General', 'Core behaviour of Minimide. Everything here is also in config.json.'), settingsList(['core', 'ui']));
  }

  function editorSection() {
    const fontPreview = h('div.font-preview', 'const greet = (name) => `Hello, ${name}!`; // 0O 1lI {}[] => !== ->');
    return h('section', header('Editor', 'Typography, indentation and display.'), fontPreview, settingsList(['editor']));
  }

  function themesSection() {
    const current = mide.config.get('core.theme');
    return h('section', header('Themes', 'Themes are packages with a stylesheet of CSS variables — write your own in minutes.'),
      h('div.theme-grid', mide.packages.list().filter((p) => p.theme).map((p) =>
        h('button.theme-card', { class: p.name === current ? 'active' : '', onclick: () => mide.packages.setTheme(p.name) },
          // Themes describe themselves with "swatches": [bg, accent, color, color, color] in package.json.
          h('div.theme-swatch', { dataset: { theme: p.name } }, ...['bg', 'accent', 'c1', 'c2', 'c3'].map((k, i) =>
            h(`span.sw-${k}`, { style: p.manifest.swatches?.[i] ? { background: p.manifest.swatches[i] } : null }))),
          h('div.theme-name', p.manifest.displayName || p.name),
          h('div.theme-desc', p.manifest.description || '')))),
      h('p.settings-note', 'Tip: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); mide.commands.run('theme:select'); } }, 'Select Theme'), ' previews themes live as you move through the list.'));
  }

  function packagesSection(view) {
    const search = h('input.input.settings-search', { type: 'text', placeholder: 'Filter packages', value: view.filter, oninput: (e) => { view.filter = e.target.value; renderList(); } });
    const list = h('div.package-list');
    const renderList = () => {
      const q = view.filter.toLowerCase();
      const pkgs = mide.packages.list().filter((p) => !p.theme && (!q || p.name.includes(q) || (p.manifest.description || '').toLowerCase().includes(q)));
      list.replaceChildren(...pkgs.map((p) => packageCard(p, view)));
    };
    renderList();
    return h('section', header('Packages', 'Everything in Minimide is a package — including the tree view and this screen.'),
      h('div.settings-toolbar', search,
        h('button.btn', { onclick: () => mide.commands.run('packages:create') }, icon('plus', 14), 'New Package'),
        h('button.btn', { onclick: () => mide.commands.run('packages:open-folder') }, 'Open Folder')),
      list);
  }

  function packageCard(p, view) {
    const settings = mide.config.getSchema().filter((d) => !d.hidden && d.key.startsWith(p.name + '.'));
    const open = view.expanded === p.name;
    return h('div.package-card', { class: [p.active ? 'active' : '', p.error ? 'error' : ''].join(' ') },
      h('div.package-main',
        h('div.package-info',
          h('div.package-name', p.manifest.displayName || p.name,
            p.builtin ? h('span.badge', 'built-in') : h('span.badge.user', 'user'),
            p.manifest.version ? h('span.package-version', `v${p.manifest.version}`) : null),
          h('div.package-desc', p.error ? `Error: ${p.error}` : p.manifest.description || '')),
        h('div.package-actions',
          settings.length ? h('button.btn.small', { onclick: () => { view.expanded = open ? null : p.name; view.renderContent(); } }, open ? 'Hide settings' : 'Settings') : null,
          p.active ? h('button.icon-btn', { title: 'Reload package', onclick: () => mide.packages.reload(p.name) }, icon('refresh', 14)) : null,
          h('label.switch', { title: p.disabled ? 'Enable' : 'Disable' },
            h('input', { type: 'checkbox', checked: !p.disabled, onchange: (e) => mide.packages.setEnabled(p.name, e.target.checked) }),
            h('span.switch-track')))),
      open ? h('div.package-settings', settings.map(settingRow)) : null);
  }

  function keybindingsSection(view) {
    const search = h('input.input.settings-search', { type: 'text', placeholder: 'Search by key or command', value: view.kbFilter || '', oninput: (e) => { view.kbFilter = e.target.value; renderRows(); } });
    const table = h('div.kb-table');
    const all = mide.keymap.list().map(({ binding, command }) => {
      const cmd = mide.commands.list().find((c) => c.id === command);
      return { binding, command, title: cmd ? (cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title) : command, pretty: mide.keymap.pretty(binding) };
    }).sort((a, b) => a.title.localeCompare(b.title));
    const renderRows = () => {
      const q = (view.kbFilter || '').toLowerCase();
      table.replaceChildren(...all.filter((r) => !q || r.title.toLowerCase().includes(q) || r.command.includes(q) || r.pretty.toLowerCase().includes(q) || r.binding.toLowerCase().includes(q))
        .map((r) => h('div.kb-row',
          h('kbd', r.pretty),
          h('span.kb-title', r.title),
          h('code.kb-command', r.command),
          h('button.btn.small', { title: 'Copy a keymap.json line for this binding', onclick: () => { mide.clipboard.write(`"${r.binding}": "${r.command}",`); mide.notify.info('Copied keymap line', 'Paste it into keymap.json and change the key.'); } }, 'Copy'))));
    };
    renderRows();
    return h('section', header('Keybindings', 'Override any binding in keymap.json. Chords like "Mod-k Mod-b" are supported.'),
      h('div.settings-toolbar', search, h('button.btn', { onclick: () => mide.commands.run('settings:open-keymap') }, 'Open keymap.json')),
      table);
  }

  function hackSection() {
    const card = (title, desc, cmd, label) => h('div.hack-card', h('div.hack-title', title), h('p', desc), h('button.btn', { onclick: () => mide.commands.run(cmd) }, label));
    return h('section', header('Make It Yours', 'Minimide is hackable to the core. Every file below lives in ~/.minimide and reloads live.'),
      h('div.hack-grid',
        card('Init script', 'JavaScript that runs at startup with the full package API. Add commands, tweak behaviour.', 'settings:open-init-script', 'Open init.js'),
        card('Stylesheet', 'Your CSS, loaded last. Change any color variable, font or spacing.', 'settings:open-stylesheet', 'Open styles.css'),
        card('Keymap', 'Rebind anything. Use "Mod" for ⌘ on macOS and Ctrl elsewhere.', 'settings:open-keymap', 'Open keymap.json'),
        card('Config', 'Every setting as JSON (comments allowed).', 'settings:open-config-file', 'Open config.json'),
        card('New package', 'Scaffold a package with a command, a keybinding, a setting and a status bar item.', 'packages:create', 'Create Package'),
        card('API docs', 'Commands, workspace, editor extensions, panels, services and more.', 'help:plugin-docs', 'Read the docs')));
  }

  function open(section) {
    if (!item) item = new SettingsItem();
    if (section) item.show(section);
    mide.workspace.openItem(item);
  }

  mide.commands.add({
    'settings:open': { title: 'Open Settings', run: () => open() },
    'settings:open-packages': { title: 'Manage Packages', run: () => open('packages') },
    'settings:open-themes': { title: 'Browse Themes', run: () => open('themes') },
    'settings:open-keybindings': { title: 'Browse Keybindings', run: () => open('keybindings') },
  });
  mide.subscriptions.add({ dispose: () => { if (item) mide.workspace.closeItem(item); } });
}
