// Import from VS Code: reads the user folder of VS Code (or Cursor, VSCodium, Insiders), shows
// what it would bring over with a checkbox for each thing, and only changes anything after you
// press Import. The mappings are in convert.js; the folder is read by the main process.
import { mapSettings, builtinThemeFor, mapKeybindings, appendKeymapBlock, countSnippets } from './convert.js';

export function activate(mide) {
  const { h } = mide.ui;
  const isMac = mide.user.platform === 'darwin';
  const userDir = mide.user.dir;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const readText = (file) => mide.fs.read(file).catch((err) => (/ENOENT/.test(err.message) ? null : Promise.reject(err)));
  const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  let item = null;

  // --- building the preview ------------------------------------------------
  // An entry is one checkbox: { label, detail, note, checked, run }. run() makes the change.

  function settingEntries(map) {
    const entries = [];
    let matching = 0;
    for (const s of map.items) {
      if (s.enable) {
        const pkg = mide.packages.list().find((p) => p.name === s.enable);
        if (!pkg) { map.skipped.push(s.key); continue; }
        if (!pkg.disabled === s.value) { matching++; continue; }
        entries.push({ label: s.key, detail: `${s.from} → turn the ${pkg.manifest.displayName || pkg.name} package ${s.value ? 'on' : 'off'}`, checked: true, run: () => mide.packages.setEnabled(s.enable, s.value) });
        continue;
      }
      const now = mide.config.get(s.to);
      if (same(now, s.value)) { matching++; continue; }
      entries.push({ label: s.key, detail: `${s.from} → ${s.to}`, note: `now ${typeof now === 'string' ? now : JSON.stringify(now)}`, checked: true, run: () => mide.config.set(s.to, s.value) });
    }
    return { entries, matching };
  }

  async function themeEntry(name, install, notImported) {
    const themes = mide.packages.list().filter((p) => p.theme && p.builtin).map((p) => ({ name: p.name, displayName: p.manifest.displayName }));
    const builtin = builtinThemeFor(name, themes);
    if (builtin) {
      if (mide.config.get('core.theme') === builtin.name) return null;
      return { label: `Theme: ${name}`, detail: `Use ${builtin.displayName || builtin.name}, a built-in theme that is close to it`, checked: true, run: () => mide.packages.setTheme(builtin.name) };
    }
    let found = null;
    try { found = await mide.vscode.theme(install.id, name); } catch {}
    if (!found) { notImported.push(`Theme "${name}": not found among your installed VS Code extensions. Pick one with "Theme: Select Theme".`); return null; }
    const converted = mide.vscode.convertTheme(found);
    const pkgName = `vscode-${converted.slug || 'theme'}`;
    const exists = mide.packages.list().some((p) => p.name === pkgName);
    // Already imported, unchanged and in use: nothing to do.
    if (exists && mide.config.get('core.theme') === pkgName && (await readText(`${mide.user.packagesDir}/${pkgName}/theme.css`).catch(() => null)) === converted.themeCss + '\n') return null;
    return {
      label: `Theme: ${name}`,
      detail: `Convert it into a new theme called "${converted.packageJson.displayName}"${converted.contrastChanges?.length ? ', with faint text made easier to read' : ''}${exists ? ' (replaces your earlier import of it)' : ''}`,
      checked: true,
      run: async () => {
        const dir = `${mide.user.packagesDir}/${pkgName}`;
        await mide.fs.write(`${dir}/package.json`, JSON.stringify({ ...converted.packageJson, name: pkgName }, null, 2) + '\n');
        await mide.fs.write(`${dir}/theme.css`, converted.themeCss + '\n');
        await mide.packages.reload(pkgName);
        await mide.packages.setTheme(pkgName);
      },
    };
  }

  async function keybindingEntries(text, notImported, problems) {
    const entries = [];
    let list;
    try { list = mide.config.parseJSONC(text); } catch (err) { problems.push(`keybindings.json couldn't be read: ${err.message}`); return entries; }
    const current = new Map(mide.keymap.list().map(({ binding, command }) => [binding, command]));
    const map = mapKeybindings(list, { isMac, current, normalize: mide.keymap.normalize });
    // Keys you already bind yourself are not replaced unless you tick them.
    let mine = new Map();
    const userText = await readText(`${userDir}/keymap.json`).catch(() => null);
    try { if (userText) mine = new Map(Object.entries(mide.config.parseJSONC(userText)).map(([k, v]) => [mide.keymap.normalize(k), v])); } catch { problems.push('keymap.json has a syntax error, so keybindings can\'t be added to it. Fix it and import again.'); return entries; }
    const titleOf = (id) => { const c = mide.commands.list().find((x) => x.id === id); return c ? (c.category ? `${c.category}: ${c.title}` : c.title) : id; };
    for (const b of [...map.bindings, ...map.removals]) {
      const key = mide.keymap.normalize(b.binding);
      if (same(mine.get(key), b.command) && mine.has(key)) continue;
      const taken = mine.has(key);
      entries.push({
        label: `${mide.keymap.pretty(key)}`,
        detail: b.removal ? `Remove the default shortcut for ${titleOf(b.removes)}` : `${titleOf(b.command)}${b.when ? ` · VS Code only when: ${b.when}` : ''}`,
        note: taken ? 'replaces your own binding of this key' : (b.command && !mide.commands.has(b.command) ? 'that command isn\'t available right now' : ''),
        checked: !taken, binding: b.binding, command: b.command, run: null,
      });
    }
    for (const s of map.skipped) notImported.push(`Keybinding ${s.key} → ${s.command.replace(/^-/, 'remove ')}: ${s.reason}`);
    return entries;
  }

  async function snippetEntries(files, problems) {
    const entries = [];
    for (const f of files) {
      let data;
      try { data = mide.config.parseJSONC(f.text); } catch (err) { problems.push(`snippets/${f.name} couldn't be read: ${err.message}`); continue; }
      const count = countSnippets(data);
      if (!count) continue;
      const there = await readText(`${userDir}/snippets/${f.name}`).catch(() => null);
      if (there === f.text) continue; // already imported
      let name = f.name;
      let text = f.text;
      if (there != null) {
        // Never overwrite your own snippet file: bring the VS Code one in beside it.
        const base = f.name.replace(/\.(json|code-snippets)$/, '');
        name = `${base}.vscode.code-snippets`;
        if (f.name.endsWith('.json')) {
          for (const def of Object.values(data)) if (def && typeof def === 'object' && !def.scope) def.scope = base;
          text = JSON.stringify(data, null, 2) + '\n';
        }
      }
      const earlier = name !== f.name ? await readText(`${userDir}/snippets/${name}`).catch(() => null) : null;
      if (earlier === text) continue; // imported beside yours before
      const replacing = earlier != null;
      entries.push({
        label: f.name, detail: `${count} snippet${count === 1 ? '' : 's'}${name !== f.name ? ` · saved as snippets/${name}, since you have a snippets/${f.name} already` : ''}${replacing ? ' (replaces your earlier import of it)' : ''}`,
        checked: true, run: () => mide.fs.write(`${userDir}/snippets/${name}`, text),
      });
    }
    return entries;
  }

  async function buildPlan(install, data) {
    const notImported = [];
    const problems = [];
    const sections = [];
    let settings = {};
    if (data.settings) {
      try { settings = mide.config.parseJSONC(data.settings); } catch (err) { problems.push(`settings.json couldn't be read: ${err.message}`); }
    }
    const map = mapSettings(settings);
    const { entries: settingEntriesList, matching } = settingEntries(map);
    if (settingEntriesList.length) sections.push({ id: 'settings', title: 'Settings', entries: settingEntriesList });
    if (map.theme) {
      const entry = await themeEntry(map.theme, install, notImported);
      if (entry) sections.push({ id: 'theme', title: 'Color theme', entries: [entry] });
    }
    if (data.keybindings) {
      const entries = await keybindingEntries(data.keybindings, notImported, problems);
      if (entries.length) sections.push({ id: 'keybindings', title: 'Keybindings', entries, note: 'They are added to the end of keymap.json in a marked block. Your own lines stay as they are.' });
    }
    const snippets = await snippetEntries(data.snippets || [], problems);
    if (snippets.length) sections.push({ id: 'snippets', title: 'Snippets', entries: snippets });
    if (map.skipped.length) notImported.unshift(`${map.skipped.length} setting${map.skipped.length === 1 ? '' : 's'} with no Minimide equivalent: ${map.skipped.join(', ')}`);
    return { install, sections, notImported, problems, matching, skippedSettings: map.skipped.length };
  }

  // --- the preview tab -----------------------------------------------------
  class ImportItem {
    constructor(plan) {
      this.type = 'vscode-import';
      this.id = 'vscode-import';
      this.iconName = 'package';
      this.plan = plan;
      this.element = h('div.vi-view');
      this.render();
    }
    on() { return { dispose() {} }; }
    getTitle() { return 'Import from VS Code'; }
    getElement() { return this.element; }
    focus() { this.element.querySelector('.vi-import')?.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { if (item === this) item = null; }

    selected() { return this.plan.sections.flatMap((s) => s.entries).filter((e) => e.checked); }

    render() {
      const { plan } = this;
      const total = plan.sections.flatMap((s) => s.entries).length;
      const picked = this.selected().length;
      const group = (s) => {
        const all = s.entries.every((e) => e.checked);
        const box = h('input', { type: 'checkbox', checked: all, dataset: { section: s.id }, onchange: (e) => { s.entries.forEach((x) => { x.checked = e.target.checked; }); this.render(); } });
        return h('section.vi-section', h('label.vi-section-title', box, h('span', `${s.title} (${s.entries.length})`)),
          s.note ? h('p.vi-note', s.note) : null,
          s.entries.map((e) => h('label.vi-entry', h('input', { type: 'checkbox', checked: e.checked, dataset: { entry: `${s.id}:${e.label}` }, onchange: (ev) => { e.checked = ev.target.checked; this.render(); } }),
            h('span.vi-entry-text', h('span.vi-entry-label', e.label), h('span.vi-entry-detail', e.detail), e.note ? h('span.vi-entry-note', e.note) : null))));
      };
      this.element.replaceChildren(h('div.vi-content',
        h('h1', 'Import from VS Code'),
        h('p.vi-source', `From ${plan.install.label}: ${plan.install.dir}`),
        h('p.vi-intro', total ? 'Nothing has changed yet. Untick anything you don\'t want, then press Import.' : 'There is nothing new to import.'),
        plan.matching ? h('p.vi-note', `${plan.matching} setting${plan.matching === 1 ? '' : 's'} already match${plan.matching === 1 ? 'es' : ''} yours.`) : null,
        plan.sections.map(group),
        plan.problems.length ? h('div.vi-problems', plan.problems.map((p) => h('p', p))) : null,
        plan.notImported.length ? h('details.vi-skipped', h('summary', `Not imported (${plan.notImported.length})`), plan.notImported.map((n) => h('p', n))) : null,
        h('div.vi-actions',
          h('button.btn.primary.vi-import', { disabled: !picked, onclick: () => this.apply() }, picked ? `Import ${picked} item${picked === 1 ? '' : 's'}` : 'Import'),
          h('button.btn.vi-cancel', { onclick: () => mide.workspace.closeItem(this) }, 'Cancel'))));
    }

    async apply() {
      const chosen = (id) => this.plan.sections.find((s) => s.id === id)?.entries.filter((e) => e.checked) || [];
      const done = { settings: 0, keybindings: 0, snippets: 0, theme: null };
      const failed = [];
      const attempt = async (entry, fn) => { try { await fn(); return true; } catch (err) { failed.push(`${entry.label}: ${cleanError(err)}`); return false; } };
      for (const e of chosen('settings')) if (await attempt(e, e.run)) done.settings++;
      for (const e of chosen('theme')) if (await attempt(e, e.run)) done.theme = e.label.replace(/^Theme: /, '');
      const keys = chosen('keybindings');
      if (keys.length) {
        try {
          const file = `${userDir}/keymap.json`;
          const text = (await readText(file)) ?? '';
          const entries = {};
          for (const k of keys) entries[k.binding] = k.command;
          await mide.fs.write(file, appendKeymapBlock(text, entries, `${this.plan.install.label} on ${new Date().toISOString().slice(0, 10)}`));
          done.keybindings = keys.length;
        } catch (err) { failed.push(`keybindings: ${cleanError(err)}`); }
      }
      for (const e of chosen('snippets')) if (await attempt(e, e.run)) done.snippets++;
      if (done.snippets) mide.commands.run('snippets:reload');
      mide.workspace.closeItem(this);
      const parts = [
        done.settings && `${done.settings} setting${done.settings === 1 ? '' : 's'}`,
        done.theme && `theme ${done.theme}`,
        done.keybindings && `${done.keybindings} keybinding${done.keybindings === 1 ? '' : 's'}`,
        done.snippets && `${done.snippets} snippet file${done.snippets === 1 ? '' : 's'}`,
      ].filter(Boolean);
      const skipped = this.plan.skippedSettings;
      const open = { label: 'Open config.json', run: () => mide.workspace.open(`${userDir}/config.json`) };
      if (failed.length) mide.notify.error('Some things couldn\'t be imported', failed.join('\n'), { actions: [open] });
      mide.notify.success(parts.length ? 'Imported from VS Code' : 'Nothing was imported', `${parts.join(', ')}${skipped ? `${parts.length ? '. ' : ''}${skipped} setting${skipped === 1 ? '' : 's'} skipped (no Minimide equivalent)` : ''}.`, { timeout: 12000, actions: [open] });
      this.result = { ...done, failed, skipped };
    }
  }

  // --- the command ---------------------------------------------------------
  function pickInstall(installs) {
    if (installs.length === 1) return Promise.resolve(installs[0]);
    return new Promise((resolve) => {
      mide.ui.selectList({
        id: 'vscode-import-source', placeholder: 'Import settings from…',
        items: installs.map((i) => ({ label: i.label, detail: i.dir, install: i })),
        onSelect: (it) => resolve(it.install), onCancel: () => resolve(null),
      });
    });
  }

  async function run() {
    let installs;
    try { installs = await mide.vscode.scan(); } catch (err) { return mide.notify.error('Import from VS Code', cleanError(err)); }
    if (!installs.length) return mide.notify.info('No VS Code settings found', 'Looked for VS Code, VS Code Insiders, Cursor and VSCodium on this computer.');
    const install = await pickInstall(installs);
    if (!install) return;
    let plan;
    try { plan = await buildPlan(install, await mide.vscode.read(install.id)); } catch (err) { return mide.notify.error('Couldn\'t read the VS Code settings', cleanError(err)); }
    if (item) mide.workspace.closeItem(item);
    item = new ImportItem(plan);
    mide.workspace.openItem(item);
    return item;
  }

  mide.commands.add('vscode-import:run', 'Import Settings from VS Code…', () => { run(); }, { category: 'Settings' });
  mide.subscriptions.add({ dispose: () => { if (item) mide.workspace.closeItem(item); } });
}
