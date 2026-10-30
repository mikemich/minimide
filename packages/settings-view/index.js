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
      this.details = new Map(); // owner/name -> { data } or { error }, for the package details page
      this.detailsLoading = new Set();
      this.pkgDetail = null; // owner/name of the package whose details are open
      this.nav = h('nav.settings-nav', { 'aria-label': 'Settings sections' });
      this.content = h('div.settings-content');
      this.element = h('div.settings-view', this.nav, this.content);
      this.subs = [
        mide.config.onDidChangeAny(() => this.maybeRerender()),
        mide.packages.onDidChange(() => { this.details.clear(); this.maybeRerender(); }),
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

    show(section) { this.section = section; this.pkgDetail = null; this.render(); }

    render() {
      this.nav.replaceChildren(
        h('div.settings-brand', h('span.logo-mark.small', 'm'), 'Settings'),
        ...SECTIONS.map((s) => h('button.settings-nav-item', { class: s.id === this.section ? 'active' : '', 'aria-current': s.id === this.section ? 'page' : null, onclick: () => this.show(s.id) }, icon(s.icon, 15), s.title)));
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
    const label = def.title || def.key; // what a screen reader calls the control
    if (def.type === 'boolean') {
      return h('label.switch', h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked: !!value, onchange: (e) => set(e.target.checked) }), h('span.switch-track'));
    }
    const options = def.enumFrom === 'themes' ? mide.packages.list().filter((p) => p.theme).map((p) => p.name) : def.enum;
    if (options) {
      return h('select.input.settings-select', { 'aria-label': label, onchange: (e) => set(e.target.value) },
        options.map((o) => h('option', { value: o, selected: o === value }, o)));
    }
    if (def.type === 'number') {
      const commit = (e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) set(n); };
      return h('input.input.settings-number', { 'aria-label': label, type: 'number', value: String(value ?? ''), step: def.key.includes('lineHeight') ? 0.1 : 1, onchange: commit });
    }
    if (def.type === 'object') {
      const count = Object.keys(value || {}).length;
      return h('div.setting-object', h('span', count ? `${count} entr${count === 1 ? 'y' : 'ies'}` : 'Default'),
        h('button.btn.small', { 'aria-label': `Edit ${label} in config.json`, onclick: () => mide.commands.run('settings:open-config-file') }, 'Edit in config.json'));
    }
    if (def.type === 'array') {
      return h('input.input', { type: 'text', 'aria-label': label, value: (value || []).join(', '), onchange: (e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) });
    }
    return h('input.input', { type: 'text', 'aria-label': label, value: value ?? '', onchange: (e) => set(e.target.value) });
  }

  function settingRow(def) {
    const isDefault = JSON.stringify(mide.config.get(def.key)) === JSON.stringify(def.default);
    return h('div.setting', { class: def.type === 'boolean' ? 'inline' : '' },
      h('div.setting-text',
        h('div.setting-title', def.title || def.key,
          !isDefault ? h('button.setting-reset', { title: 'Reset to default', 'aria-label': `Reset ${def.title || def.key} to default`, onclick: () => mide.config.set(def.key, undefined) }, 'reset') : null),
        def.description ? h('div.setting-desc', def.description) : null,
        h('code.setting-key', def.key)),
      h('div.setting-control', control(def)));
  }

  // Shown in the Fonts and Themes sections instead of the generic lists.
  const OWN_SECTION = new Set(['editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.fontLigatures', 'ui.fontFamily', 'ui.fontSize', 'ui.accentColor', 'ui.themedAppIcon', 'core.theme']);
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
      h('button.font-card', { class: active ? 'active' : '', 'aria-pressed': String(!!active), onclick },
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

  function appIconRow() {
    const img = h('img.app-icon-preview', { alt: 'App icon', width: 64, height: 64 });
    // Give a just-switched theme's stylesheet a moment to apply before drawing.
    setTimeout(async () => { const url = await mide.ui.renderAppIcon(); if (url) img.src = url; }, 250);
    const def = defOf('ui.themedAppIcon');
    return h('div.app-icon-row', img, h('div.app-icon-text',
      h('div.setting-title', 'App icon'),
      h('div.setting-desc', 'The Dock icon follows your theme, accent color and editor font.')),
      def ? h('div.setting-control', control(def)) : null);
  }

  function accentRow() {
    const now = (mide.config.get('ui.accentColor') || '').toLowerCase();
    const set = (v) => mide.config.set('ui.accentColor', v || undefined);
    return h('div.accent-row',
      h('button.accent-chip.theme-default', { class: !now ? 'active' : '', title: "Use the theme's own accent", 'aria-pressed': String(!now), onclick: () => set('') }, 'Theme'),
      ACCENTS.map(([name, hex]) => h('button.accent-chip', { class: now === hex ? 'active' : '', title: name, 'aria-label': `${name} accent`, 'aria-pressed': String(now === hex), style: { background: hex }, onclick: () => set(hex) })),
      h('label.accent-chip.accent-custom', { title: 'Custom color', class: now && !ACCENTS.some(([, x]) => x === now) ? 'active' : '' },
        h('input', { type: 'color', 'aria-label': 'Custom accent color', value: /^#[0-9a-f]{6}$/.test(now) ? now : '#4c8dff', onchange: (e) => set(e.target.value) }), '+'));
  }

  function themesSection() {
    const current = mide.config.get('core.theme');
    const themes = mide.packages.list().filter((p) => p.theme);
    return h('section', header('Themes', `${themes.length} themes built in. A theme is a package with one stylesheet of CSS variables: write your own in minutes.`),
      h('h2.settings-subhead', 'Accent color'),
      h('p.settings-desc', 'Recolor buttons, the cursor and selections on top of any theme.'),
      accentRow(),
      appIconRow(),
      h('h2.settings-subhead', 'Theme'),
      h('div.theme-grid', mide.packages.list().filter((p) => p.theme).map((p) =>
        h('button.theme-card', { class: p.name === current ? 'active' : '', 'aria-pressed': String(p.name === current), onclick: () => mide.packages.setTheme(p.name) },
          // Themes describe themselves with "swatches": [bg, accent, color, color, color] in package.json.
          h('div.theme-swatch', { dataset: { theme: p.name } }, ...['bg', 'accent', 'c1', 'c2', 'c3'].map((k, i) =>
            h(`span.sw-${k}`, { style: p.manifest.swatches?.[i] ? { background: p.manifest.swatches[i] } : null }))),
          h('div.theme-name', p.manifest.displayName || p.name),
          h('div.theme-desc', p.manifest.description || '')))),
      h('p.settings-note', 'Tip: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); mide.commands.run('theme:select'); } }, 'Select Theme'), ' previews themes live as you move through the list.'));
  }

  // --- packages ------------------------------------------------------------
  const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inBrowser = () => !!window.native.web;
  const githubSource = (p) => (p.install?.source?.startsWith('github:') ? p.install.source.slice('github:'.length) : null);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(s >= 0)) return '';
    if (s < 90) return 'just now';
    if (s < 3600) return `${plural(Math.round(s / 60), 'minute')} ago`;
    if (s < 86400) return `${plural(Math.round(s / 3600), 'hour')} ago`;
    const days = Math.round(s / 86400);
    if (days < 45) return `${plural(days, 'day')} ago`;
    return days < 365 ? `${plural(Math.round(days / 30), 'month')} ago` : `${plural(Math.round(days / 365), 'year')} ago`;
  };
  const day = (iso) => (Date.parse(iso) ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  // What the last update check found: { checkedAt, updates: [{ name, fullName, … }], errors }. Kept in
  // main (once a day at most); the button asks for a fresh look.
  const pendingUpdate = (view, name) => view.updates?.updates.find((u) => u.name === name);

  async function checkForUpdates(view, { force }) {
    if (view.checking) return;
    view.checking = true;
    view.updateError = null;
    view.maybeRerender();
    try { view.updates = await mide.packages.checkUpdates({ force }); view.details.clear(); } catch (err) { if (force) view.updateError = cleanErr(err); }
    view.checking = false;
    if (view.section === 'packages') view.maybeRerender();
  }

  /** Updates one package ("name") or all of them (no argument), then refreshes what is shown. */
  async function applyUpdates(view, name) {
    view.updating = name || true;
    view.maybeRerender();
    try {
      if (name) await mide.packages.update(name);
      else await mide.packages.updateAll();
    } catch (err) { mide.notify.error("Couldn't update", cleanErr(err)); }
    view.updating = null;
    view.updates = await mide.packages.checkUpdates().catch(() => view.updates);
    view.details.clear();
    if (view.section === 'packages') view.maybeRerender();
  }

  function openDetails(view, fullName) {
    view.listScroll = view.content.scrollTop;
    view.pkgDetail = fullName;
    view.renderContent();
    view.content.scrollTop = 0;
  }

  function closeDetails(view) {
    view.pkgDetail = null;
    view.renderContent();
    view.content.scrollTop = view.listScroll || 0;
  }

  function packagesSection(view) {
    if (view.pkgDetail) return h('section', detailsView(view));
    view.pkgTab ??= 'installed';
    // The first time this screen opens, look for updates (the check itself runs at most once a day).
    if (!view.autoChecked) {
      view.autoChecked = true;
      if (!inBrowser() && mide.config.get('core.checkForUpdates') !== false) checkForUpdates(view, { force: false });
    }
    const tabs = h('div.pkg-tabs',
      ['installed', 'discover'].map((t) => h('button.pkg-tab', { class: view.pkgTab === t ? 'active' : '', 'aria-pressed': String(view.pkgTab === t), onclick: () => { view.pkgTab = t; view.renderContent(); } },
        t === 'installed' ? 'Installed' : 'Discover',
        t === 'installed' && view.updates?.updates.length ? h('span.pkg-tab-count', { title: 'Updates available' }, String(view.updates.updates.length)) : null)));
    const intro = header('Packages', 'Everything in Minimide is a package — including the tree view and this screen.');
    if (view.pkgTab === 'discover') return h('section', intro, tabs, discoverTab(view));

    const search = h('input.input.settings-search', { type: 'text', placeholder: 'Filter packages', value: view.filter, oninput: (e) => { view.filter = e.target.value; renderList(); } });
    const list = h('div.package-list');
    const renderList = () => {
      const q = view.filter.toLowerCase();
      // Your own and installed packages first, then the built-in ones.
      const pkgs = mide.packages.list().filter((p) => !p.theme && (!q || p.name.includes(q) || (p.manifest.description || '').toLowerCase().includes(q)))
        .sort((a, b) => (a.builtin - b.builtin) || (a.manifest.displayName || a.name).localeCompare(b.manifest.displayName || b.name));
      list.replaceChildren(...pkgs.map((p) => packageCard(p, view)));
    };
    renderList();
    return h('section', intro, tabs,
      h('div.settings-toolbar', search,
        h('button.btn', { onclick: () => mide.commands.run('packages:install') }, 'Install…'),
        h('button.btn', { onclick: () => mide.commands.run('packages:create') }, icon('plus', 14), 'New Package'),
        h('button.btn', { onclick: () => mide.commands.run('packages:open-folder') }, 'Open Folder')),
      updatesBar(view),
      list);
  }

  // "3 updates available · Update All" and the button that looks for new ones. Only shown once something came from GitHub.
  function updatesBar(view) {
    if (inBrowser() || !mide.packages.list().some(githubSource)) return null;
    const found = view.updates;
    const n = found?.updates.length || 0;
    let text = '';
    if (view.checking) text = 'Checking GitHub for updates…';
    else if (view.updateError) text = view.updateError;
    else if (view.updating) text = 'Updating…';
    else if (n) text = `${plural(n, 'update')} available`;
    else if (found?.checkedAt) text = `Everything from GitHub is up to date. Checked ${ago(found.checkedAt)}.`;
    return h('div.pkg-updates', { class: view.updateError ? 'error' : n ? 'available' : '' },
      h('span.pkg-updates-text', text),
      n ? h('button.btn.small.primary', { disabled: !!view.updating, onclick: () => applyUpdates(view) }, 'Update All') : null,
      h('button.btn.small', { disabled: view.checking || !!view.updating, onclick: () => checkForUpdates(view, { force: true }) }, 'Check for Updates'));
  }

  // Packages are GitHub repositories tagged with the "minimide-package" topic.
  function discoverTab(view) {
    if (inBrowser()) return h('p.settings-note', 'Browsing and installing packages from GitHub is available in the desktop app. Download it from the project page to try it.');
    view.discoverSort ??= 'stars';
    const results = h('div.discover-grid');
    const status = h('p.settings-note.discover-status');
    let seq = 0;
    // quiet: refreshing what is already shown (e.g. after an install), so no "Searching…" and errors are ignored.
    const run = async ({ quiet = false } = {}) => {
      const mine = ++seq;
      if (!quiet) { status.className = 'settings-note discover-status'; status.textContent = 'Searching GitHub…'; }
      try {
        const items = await mide.packages.search(view.discoverQuery || '', { sort: view.discoverSort });
        if (mine !== seq) return;
        view.discoverCache = items;
        render(items);
      } catch (err) {
        if (mine !== seq || quiet) return;
        view.discoverCache = null;
        results.replaceChildren();
        status.className = 'settings-note discover-status error';
        status.replaceChildren(cleanErr(err), ' ', h('button.btn.small', { onclick: () => run() }, 'Try Again'));
      }
    };
    const render = (items) => {
      status.className = 'settings-note discover-status';
      status.textContent = items.length ? '' : view.discoverQuery
        ? `No packages match "${view.discoverQuery}". Publish yours by adding the "minimide-package" topic to its GitHub repository.`
        : 'No packages found. Publish yours by adding the "minimide-package" topic to its GitHub repository.';
      results.replaceChildren(...items.map((r) => {
        const busy = (e, fn) => async () => { e.disabled = true; try { await fn(); } finally { e.disabled = false; } };
        const action = r.updateAvailable
          ? h('button.btn.small.primary', { onclick: (e) => busy(e.currentTarget, async () => { await applyUpdates(view, r.installedName); run({ quiet: true }); })() }, 'Update')
          : r.installed ? null : h('button.btn.small.primary', { onclick: (e) => busy(e.currentTarget, async () => { await mide.packages.install(r.fullName); run({ quiet: true }); })() }, 'Install');
        return h('div.discover-card', { dataset: { repo: r.fullName }, onclick: (e) => { if (!e.target.closest('button')) openDetails(view, r.fullName); } },
          h('div.discover-head', h('button.discover-name', { onclick: () => openDetails(view, r.fullName) }, r.name), h('span.discover-stars', `★ ${r.stars}`)),
          h('div.discover-owner', r.owner, r.updatedAt ? ` · updated ${ago(r.updatedAt)}` : ''),
          h('div.discover-desc', r.description || 'No description.'),
          h('div.discover-actions',
            h('button.btn.small', { onclick: () => openDetails(view, r.fullName) }, 'Details'),
            action,
            r.updateAvailable ? h('span.badge.update', 'update available') : null,
            r.installed && !r.updateAvailable ? h('span.badge.installed', r.installedVersion ? `installed v${r.installedVersion}` : 'installed') : null));
      }));
    };
    let timer = null;
    const input = h('input.input.settings-search', {
      type: 'text', placeholder: 'Search packages on GitHub', value: view.discoverQuery || '',
      oninput: (e) => { view.discoverQuery = e.target.value; clearTimeout(timer); timer = setTimeout(run, 450); },
      onkeydown: (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } },
    });
    const sort = h('select.input.settings-select.discover-sort', { title: 'Sort by', onchange: (e) => { view.discoverSort = e.target.value; run(); } },
      [['stars', 'Most stars'], ['updated', 'Recently updated']].map(([value, label]) => h('option', { value, selected: value === view.discoverSort }, label)));
    // Show the last results straight away (so coming back from a details page keeps your place), then refresh the badges.
    if (view.discoverCache) { render(view.discoverCache); run({ quiet: true }); } else run();
    return h('div',
      h('div.settings-toolbar', input, sort, h('button.btn', { onclick: () => mide.commands.run('packages:install-from-folder') }, 'Install from Folder…')),
      h('p.settings-desc.discover-note', 'Installed packages run in a sandbox: they can only touch your files, run programs or use the internet if you allow it when you install them.'),
      status, results);
  }

  // --- package details -----------------------------------------------------
  // The README is Markdown from the internet: rendered with the same marked + DOMPurify the Markdown
  // preview ships, with scripts, styles and forms removed. Images may come from GitHub only, and
  // links open in the browser.
  let markdown = null;
  const loadMarkdown = () => markdown ??= Promise.all(['marked.esm.js', 'purify.es.mjs'].map((f) => import(/* @vite-ignore */ new URL(`../markdown-preview/vendor/${f}`, mide.package.url).href)))
    .then(([m, p]) => ({ marked: m.marked, DOMPurify: p.default }), () => null);

  const isGithubHost = (host) => host === 'github.com' || host.endsWith('.githubusercontent.com');
  const resolveIn = (base, ref) => new URL(ref.startsWith('/') && !ref.startsWith('//') ? ref.slice(1) : ref, base);

  async function renderReadme(d) {
    const box = h('article.pkg-readme');
    if (d.readme == null) { box.append(h('p.pkg-readme-empty', 'This repository has no README.')); return box; }
    const md = await loadMarkdown();
    if (!md) { box.append(h('pre.pkg-readme-plain', d.readme)); return box; }
    box.innerHTML = md.DOMPurify.sanitize(md.marked.parse(d.readme, { gfm: true, breaks: false, async: false }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'picture', 'source', 'video', 'audio', 'track', 'link', 'meta'],
      FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'formaction', 'action', 'xlink:href'],
    });
    for (const img of box.querySelectorAll('img')) {
      let url = null;
      try { url = resolveIn(d.rawBase, img.getAttribute('src') || ''); } catch {}
      const ok = url && (url.href.startsWith(d.rawBase) || (url.protocol === 'https:' && isGithubHost(url.hostname)));
      if (ok) { img.setAttribute('src', url.href); img.setAttribute('loading', 'lazy'); } else {
        img.replaceWith(h('span.pkg-readme-img', { title: img.getAttribute('src') || '' }, img.alt ? `[${img.alt}]` : '[image]'));
      }
    }
    for (const a of box.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) continue;
      let url = null;
      try { url = resolveIn(d.blobBase, href); } catch {}
      if (url && /^(https?:|mailto:)$/.test(url.protocol)) { a.setAttribute('href', url.href); a.title = url.href; } else a.removeAttribute('href');
    }
    const used = new Map();
    for (const el of box.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const base = el.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      el.id = n ? `${base}-${n}` : base;
    }
    // Nothing in the README navigates this window: anchors scroll, everything else opens outside.
    box.addEventListener('click', (e) => {
      const a = e.target.closest?.('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1)).replace(/^user-content-/, '');
        const target = [...box.querySelectorAll('[id]')].find((el) => el.id === id);
        target?.scrollIntoView({ block: 'start' });
      } else if (/^(https?:|mailto:)/.test(href)) mide.shell.openExternal(href);
    });
    return box;
  }

  const RISKY = new Set(['files', 'shell', 'project-write']);

  function permissionsBlock(d, labels) {
    const { manifest, installed } = d;
    const block = h('div.pkg-perms');
    if (d.problem) { block.append(h('p.pkg-problem', d.problem)); if (!manifest) return block; }
    if (manifest.access === 'full') {
      block.append(h('div.pkg-fullaccess',
        h('strong', 'Needs full access'),
        h('p', 'It would run with the same rights as Minimide: it could read and change any file, run any program and use the internet. Only install it if you trust the author.')));
    } else {
      block.append(h('p', manifest.hasCode ? 'Runs in a sandbox. Besides editing the open file and adding commands, it asks to:' : 'Contains no code (styles and settings only), so it needs no permissions.'));
      if (manifest.hasCode) {
        if (!manifest.permissions.length) block.append(h('p.pkg-noperms', 'Nothing more. It can add commands and status bar items and work with the open file, but it can\'t see your other files, run programs or use the internet.'));
        else {
          const allowed = installed?.permissions || [];
          block.append(h('ul.pkg-perm-list', manifest.permissions.map((p) =>
            h('li.pkg-perm', { class: RISKY.has(p) ? 'risky' : '', dataset: { permission: p } }, h('code', p), h('span', labels[p] || p),
              installed && !allowed.includes(p) ? h('span.badge.update', 'new') : null))));
        }
      }
    }
    if (manifest.unknownPermissions.length) block.append(h('p.settings-note', `Ignored unknown permissions: ${manifest.unknownPermissions.join(', ')}`));
    if (installed) block.append(h('p.pkg-allowed', installed.access === 'full' ? 'You installed it with full access.' : installed.permissions.length ? `You allowed: ${installed.permissions.join(', ')}.` : 'You allowed no extra permissions.'));
    return block;
  }

  function detailsView(view) {
    const full = view.pkgDetail;
    const root = h('div.pkg-detail');
    const back = h('button.btn.small.pkg-back', { onclick: () => closeDetails(view) }, `← Back to ${view.pkgTab === 'discover' ? 'Discover' : 'Installed'}`);
    const entry = view.details.get(full);
    if (!entry) {
      root.append(back, h('p.settings-note', 'Loading…'));
      if (!view.detailsLoading.has(full)) {
        view.detailsLoading.add(full);
        mide.packages.details(full).then((data) => ({ data }), (err) => ({ error: cleanErr(err) })).then((result) => {
          view.detailsLoading.delete(full);
          view.details.set(full, result);
          if (view.pkgDetail === full && view.section === 'packages') view.renderContent();
        });
      }
      return root;
    }
    if (entry.error) {
      root.append(back, h('p.settings-note.discover-status.error', entry.error, ' ', h('button.btn.small', { onclick: () => { view.details.delete(full); view.renderContent(); } }, 'Try Again')));
      return root;
    }
    const d = entry.data;
    const body = h('div.pkg-detail-body', h('p.settings-note', 'Loading…'));
    root.append(back, body);
    Promise.all([mide.packages.permissionLabels().catch(() => ({})), renderReadme(d)]).then(([labels, readme]) => {
      body.replaceChildren(detailsHead(view, d), h('h2.settings-subhead', 'Permissions'), permissionsBlock(d, labels), h('h2.settings-subhead', 'README'), readme);
      body.dataset.ready = 'true';
    });
    return root;
  }

  function detailsHead(view, d) {
    const { repo, manifest, installed } = d;
    const full = repo.fullName;
    const refresh = () => { view.details.delete(full); view.renderContent(); };
    const busy = (e, fn) => async () => { e.disabled = true; try { await fn(); } finally { e.disabled = false; } };
    const buttons = [];
    if (!installed) {
      buttons.push(h('button.btn.primary', { disabled: !!d.problem, title: d.problem || '', onclick: (e) => busy(e.currentTarget, async () => { await mide.packages.install(full); refresh(); })() }, 'Install'));
    } else {
      if (d.updateAvailable) buttons.push(h('button.btn.primary', { onclick: (e) => busy(e.currentTarget, async () => { await applyUpdates(view, installed.name); refresh(); })() }, 'Update'));
      buttons.push(h('button.btn', { onclick: (e) => busy(e.currentTarget, async () => {
        const choice = await mide.ui.confirm({ message: `Uninstall "${manifest?.displayName || installed.name}"?`, detail: 'Its folder is moved to the Trash.', buttons: ['Uninstall', 'Cancel'] });
        if (choice !== 0) return;
        await mide.packages.uninstall(installed.name);
        mide.notify.success(`Uninstalled ${installed.name}`);
        refresh();
      })() }, 'Uninstall'));
    }
    buttons.push(h('button.btn', { onclick: () => mide.shell.openExternal(repo.url) }, 'View on GitHub'));
    return h('div.pkg-detail-head',
      h('h1.pkg-detail-title', manifest?.displayName || repo.name,
        installed ? h('span.badge.installed', installed.version ? `installed v${installed.version}` : 'installed') : null,
        d.updateAvailable ? h('span.badge.update', 'update available') : null,
        manifest?.access === 'full' ? h('span.badge.full', 'full access') : manifest ? h('span.badge.sandbox', 'sandboxed') : null),
      h('div.pkg-detail-meta', [
        h('span.pkg-owner', repo.owner), h('span', `★ ${repo.stars}`),
        repo.updatedAt ? h('span.pkg-updated', { title: repo.updatedAt }, `Updated ${day(repo.updatedAt)}`) : null,
        manifest?.version ? h('span.pkg-version-label', `Version ${manifest.version}`) : null,
        repo.license ? h('span', repo.license) : null,
      ].filter(Boolean).flatMap((el, i) => (i ? [' ', el] : [el]))),
      h('p.pkg-detail-desc', repo.description || manifest?.description || 'No description.'),
      h('div.pkg-detail-actions', buttons));
  }

  function accessBadge(p) {
    if (p.builtin) return h('span.badge', 'built-in');
    if (!p.install) return p.sandboxed ? h('span.badge.sandbox', { title: 'Your own package, opted into the sandbox' }, 'local · sandboxed') : h('span.badge.user', { title: 'A folder in your packages directory, trusted as your own code' }, 'local');
    const perms = p.install.permissions || [];
    return p.sandboxed
      ? h('span.badge.sandbox', { title: perms.length ? `Allowed: ${perms.join(', ')}` : 'No extra permissions' }, perms.length ? `sandboxed · ${perms.length} permission${perms.length === 1 ? '' : 's'}` : 'sandboxed')
      : h('span.badge.full', { title: 'Runs with full access to your computer' }, 'full access');
  }

  function packageCard(p, view) {
    const settings = mide.config.getSchema().filter((d) => !d.hidden && d.key.startsWith(p.name + '.'));
    const open = view.expanded === p.name;
    const repo = githubSource(p); // owner/name, when it came from GitHub
    const update = repo && pendingUpdate(view, p.name);
    const name = p.manifest.displayName || p.name;
    return h('div.package-card', { class: [p.active ? 'active' : '', p.error ? 'error' : ''].join(' '), dataset: { package: p.name } },
      h('div.package-main',
        h('div.package-info',
          h('div.package-name', repo ? h('button.package-name-link', { title: `Details for ${repo}`, onclick: () => openDetails(view, repo) }, name) : name,
            accessBadge(p),
            update ? h('span.badge.update', 'update available') : null,
            p.manifest.version ? h('span.package-version', `v${p.manifest.version}`) : null),
          h('div.package-desc', p.error ? `Error: ${p.error}` : p.manifest.description || '')),
        h('div.package-actions',
          update ? h('button.btn.small.primary', { disabled: !!view.updating, 'aria-label': `Update ${name}`, onclick: () => applyUpdates(view, p.name) }, 'Update') : null,
          repo ? h('button.btn.small', { 'aria-label': `Details for ${name}`, onclick: () => openDetails(view, repo) }, 'Details') : null,
          settings.length ? h('button.btn.small', { 'aria-label': `${open ? 'Hide' : 'Show'} settings for ${name}`, 'aria-expanded': String(open), onclick: () => { view.expanded = open ? null : p.name; view.renderContent(); } }, open ? 'Hide settings' : 'Settings') : null,
          p.active ? h('button.icon-btn', { title: 'Reload package', 'aria-label': `Reload ${name}`, onclick: () => mide.packages.reload(p.name) }, icon('refresh', 14)) : null,
          p.install ? h('button.icon-btn', { title: 'Uninstall', 'aria-label': `Uninstall ${name}`, onclick: async () => {
            const choice = await mide.ui.confirm({ message: `Uninstall "${name}"?`, detail: 'Its folder is moved to the Trash.', buttons: ['Uninstall', 'Cancel'] });
            if (choice === 0) { await mide.packages.uninstall(p.name); mide.notify.success(`Uninstalled ${p.name}`); }
          } }, icon('trash', 14)) : null,
          h('label.switch', { title: p.disabled ? 'Enable' : 'Disable' },
            h('input', { type: 'checkbox', role: 'switch', 'aria-label': `Enable ${name}`, checked: !p.disabled, onchange: (e) => mide.packages.setEnabled(p.name, e.target.checked) }),
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
        card('Coming from VS Code?', 'Bring over your settings, keybindings, snippets and color theme. You see a preview first.', 'vscode-import:run', 'Import from VS Code…'),
        card('Settings sync', 'Keep config, keymap, styles, init script and snippets the same on every computer, in a private GitHub gist.', 'settings-sync:set-up', 'Set Up Sync…'),
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
