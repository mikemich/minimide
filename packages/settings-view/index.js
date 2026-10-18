// Settings View: generated from config schemas, so package settings appear automatically.

export function activate(mide) {
  const { h, icon } = mide.ui;
  let item = null;

  const SECTIONS = [
    { id: 'general', title: 'General', icon: 'gear' },
    { id: 'editor', title: 'Editor', icon: 'file' },
    { id: 'themes', title: 'Themes', icon: 'eye' },
    { id: 'fonts', title: 'Fonts', icon: 'type' },
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
      const fn = { general: generalSection, editor: editorSection, themes: themesSection, fonts: fontsSection, packages: packagesSection, keybindings: keybindingsSection, hack: hackSection }[this.section];
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

  // Shown in the Fonts and Themes sections instead of the generic lists.
  const OWN_SECTION = new Set(['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures', 'ui.fontFamily', 'ui.fontSize', 'ui.accentColor', 'core.theme']);
  const defOf = (key) => mide.config.getSchema().find((d) => d.key === key);

  function settingsList(prefixes) {
    return mide.config.getSchema()
      .filter((d) => !d.hidden && !OWN_SECTION.has(d.key) && prefixes.some((p) => d.key.startsWith(p + '.')))
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
    return h('section', header('Editor', 'Indentation, wrapping and display. Fonts have their own section.'), settingsList(['editor']));
  }

  function fontsSection() {
    const fonts = mide.services.get('fonts');
    const rows = (keys) => keys.map(defOf).filter(Boolean).map(settingRow);
    if (!fonts) {
      return h('section', header('Fonts', 'Enable the Fonts package in Packages to get 27 bundled fonts with previews.'),
        rows(['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures', 'ui.fontFamily', 'ui.fontSize']));
    }
    const editorNow = fonts.currentEditor();
    const uiNow = fonts.currentUi();
    const code = ['const ok = (a, b) => {', '  return a !== b && a >= 0;', '}'];
    const card = ({ family, title, detail, active, sample, onclick, tag }) =>
      h('button.font-card', { class: active ? 'active' : '', onclick },
        h('div.font-card-sample', { style: { fontFamily: family ? `"${family}"` : null } }, sample),
        h('div.font-card-meta', h('span.font-card-name', title), tag ? h('span.font-card-tag', tag) : null),
        h('div.font-card-desc', detail));
    const codeSample = () => code.map((l) => h('div', l));
    const systemMono = !editorNow || /^(SF Mono|Menlo|Consolas|monospace)$/.test(editorNow);
    return h('section', header('Fonts', `${fonts.list().length} open-source fonts are built in. Click one to use it, or use any font installed on your computer.`),
      h('h2.settings-subhead', 'Code'),
      h('div.font-grid',
        fonts.editorFonts().map((f) => card({ family: f.family, title: f.family, detail: f.description, active: f.family === editorNow,
          sample: codeSample(), tag: f.ligatures ? 'ligatures' : '', onclick: () => fonts.setEditorFont(f.family) })),
        card({ family: '', title: 'System Monospace', detail: 'SF Mono on macOS, Consolas on Windows.', active: systemMono,
          sample: h('div.font-card-system', codeSample()), onclick: () => fonts.setEditorFont('') })),
      rows(['editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures']),
      h('h2.settings-subhead', 'Interface'),
      h('div.font-grid',
        card({ family: '', title: 'System Font', detail: 'San Francisco on macOS, Segoe UI on Windows.', active: !uiNow,
          sample: h('div.font-card-ui', h('div', 'Explorer   Search   Git'), h('div.dim', 'The quick brown fox, 1234')), onclick: () => fonts.setUiFont('') }),
        fonts.uiFonts().map((f) => card({ family: f.family, title: f.family, detail: f.description, active: f.family === uiNow,
          sample: h('div.font-card-ui', h('div', 'Explorer   Search   Git'), h('div.dim', 'The quick brown fox, 1234')), onclick: () => fonts.setUiFont(f.family) }))),
      rows(['ui.fontSize']),
      h('h2.settings-subhead', 'Custom'),
      rows(['editor.fontFamily', 'ui.fontFamily']),
      h('p.settings-note', 'Tip: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); mide.commands.run('fonts:select-editor-font'); } }, 'Select Editor Font'),
        ' in the command palette previews each font live in your code.'));
  }

  // Accent presets, chosen to read well on both dark and light themes.
  const ACCENTS = [
    ['Blue', '#4c8dff'], ['Sky', '#38bdf8'], ['Teal', '#14b8a6'], ['Green', '#22c55e'], ['Lime', '#84cc16'], ['Amber', '#f59e0b'],
    ['Orange', '#f97316'], ['Coral', '#ff6b6b'], ['Rose', '#f43f5e'], ['Pink', '#ec4899'], ['Purple', '#a855f7'], ['Indigo', '#6366f1'],
  ];

  function accentRow() {
    const now = (mide.config.get('ui.accentColor') || '').toLowerCase();
    const set = (v) => mide.config.set('ui.accentColor', v || undefined);
    return h('div.accent-row',
      h('button.accent-chip.theme-default', { class: !now ? 'active' : '', title: "Use the theme's own accent", onclick: () => set('') }, 'Theme'),
      ACCENTS.map(([name, hex]) => h('button.accent-chip', { class: now === hex ? 'active' : '', title: name, style: { background: hex }, onclick: () => set(hex) })),
      h('label.accent-chip.accent-custom', { title: 'Custom color', class: now && !ACCENTS.some(([, x]) => x === now) ? 'active' : '' },
        h('input', { type: 'color', value: /^#[0-9a-f]{6}$/.test(now) ? now : '#4c8dff', onchange: (e) => set(e.target.value) }), '+'));
  }

  function themesSection() {
    const current = mide.config.get('core.theme');
    const themes = mide.packages.list().filter((p) => p.theme);
    return h('section', header('Themes', `${themes.length} themes built in. A theme is a package with one stylesheet of CSS variables: write your own in minutes.`),
      h('h2.settings-subhead', 'Accent color'),
      h('p.settings-desc', 'Recolor buttons, the cursor and selections on top of any theme.'),
      accentRow(),
      h('h2.settings-subhead', 'Theme'),
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
