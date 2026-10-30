// Accessibility: roles, names and keyboard behaviour of the main window, over the `ev` fixture.
// Checks the ARIA a screen reader relies on (tree, tabs, dialogs, comboboxes, live regions), that
// focus is trapped in dialogs and given back, that focus rings are visible and readable in a light
// and a dark theme, and that no button or field in the common panels lacks a name.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(50); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 300)); oe(...a); };
  window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason?.stack || e.reason)));
  const results = {};
  const root = await until(() => ws.project);
  const T = window.mideTest;
  const step = async (name, fn) => {
    console.log('[test] step ' + name);
    const before = errors.length;
    try { results[name] = await fn(); } catch (e) { results[name] = 'THREW: ' + (e?.stack || e).toString().slice(0, 300); }
    if (errors.length > before) results[name] = [results[name], ...errors.slice(before).map((e) => 'ERR ' + e)];
    app.ui.closeModal(); await wait(60);
  };
  const closeAll = async () => { for (const i of ws.allItems()) { if (i.isDirty?.()) await T.answers('confirm', 1); await ws.closeItem(i); } while (ws.panes.length > 1) ws.removePane(ws.panes[ws.panes.length - 1]); };
  const key = (el, k, mods = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
  const attr = (el, name) => el?.getAttribute(name) ?? null;

  // The name a screen reader would speak: aria-label, a referenced element, a <label>, or visible text.
  // A tooltip or placeholder alone doesn't count here: controls are expected to carry a real label.
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label')?.trim();
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() || '').join(' ').trim();
    if (el.labels?.length) return [...el.labels].map((l) => l.innerText.trim()).join(' ').trim();
    return (el.innerText || '').trim();
  };
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]');
  const unnamed = (scope = document) => $$('button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], a[href], input:not([type="hidden"]), select, textarea, [role="combobox"], [role="treeitem"], [role="option"]', scope)
    .filter((el) => visible(el) && !nameOf(el))
    .map((el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`);

  await ws.open(root + '/code.js');
  await wait(500);

  await step('landmarks', async () => ({
    sidebar: attr($('#sidebar'), 'aria-label'), main: $('main#center') ? attr($('main#center'), 'aria-label') : null, panel: attr($('#panel'), 'aria-label'),
    status: attr($('#statusbar'), 'aria-label'), notifications: [attr($('#notifications'), 'role'), attr($('#notifications'), 'aria-label')],
    lang: document.documentElement.lang,
  }));

  await step('dockTabs', async () => {
    app.sidebar.show('tree-view');
    await wait(100);
    const header = $('#sidebar .dock-header');
    const tabs = $$('[role="tab"]', header);
    const selected = () => tabs.map((t) => attr(t, 'aria-selected'));
    const out = {
      role: attr(header, 'role'), label: attr(header, 'aria-label'), count: tabs.length >= 3,
      allNamed: tabs.every((t) => nameOf(t)), oneSelected: selected().filter((v) => v === 'true').length === 1,
      oneTabStop: $$('[tabindex="0"]', header).length === 1,
      panelFor: attr($('#sidebar .dock-view:not([hidden])'), 'role') === 'tabpanel' && attr($('#sidebar .dock-view:not([hidden])'), 'aria-labelledby') === $$('[aria-selected="true"]', header)[0].id,
    };
    $$('[aria-selected="true"]', header)[0].focus();
    const first = app.sidebar.activeId;
    key(document.activeElement, 'ArrowRight');
    await wait(100);
    out.arrowMoved = app.sidebar.activeId !== first;
    out.focusFollows = document.activeElement?.getAttribute('aria-selected') === 'true' && header.contains(document.activeElement);
    key(document.activeElement, 'Home');
    await wait(100);
    out.homeIsFirst = app.sidebar.activeId === app.sidebar.sortedViews()[0].id;
    app.sidebar.show('tree-view');
    return out;
  });

  await step('treeView', async () => {
    app.sidebar.show('tree-view');
    await wait(200);
    await app.commands.run('tree-view:focus');
    await wait(200);
    const tree = $('.tree-list');
    const rows = $$('[role="treeitem"]', tree);
    const dir = rows.find((r) => r.classList.contains('dir'));
    const file = rows.find((r) => !r.classList.contains('dir'));
    const out = {
      role: attr(tree, 'role'), label: attr(tree, 'aria-label'), focused: document.activeElement === tree, rows: rows.length > 3,
      levels: [...new Set(rows.map((r) => attr(r, 'aria-level')))].sort(),
      dirExpanded: attr(dir, 'aria-expanded'), fileHasExpanded: file.hasAttribute('aria-expanded'),
      oneSelected: rows.filter((r) => attr(r, 'aria-selected') === 'true').length === 1,
      uniqueIds: new Set(rows.map((r) => r.id)).size === rows.length,
    };
    out.activeDescendant = attr(tree, 'aria-activedescendant') === rows.find((r) => attr(r, 'aria-selected') === 'true')?.id;
    const before = attr(tree, 'aria-activedescendant');
    key(tree, 'ArrowDown');
    out.arrowMovesSelection = attr(tree, 'aria-activedescendant') !== before && attr($(`#${CSS.escape(attr(tree, 'aria-activedescendant'))}`), 'aria-selected') === 'true';
    // Open "sub" with the keyboard: it expands and its children are one level deeper.
    const sub = $$('[role="treeitem"]', tree).find((r) => r.querySelector('.tree-name')?.textContent === 'sub');
    sub.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    key(tree, 'ArrowRight');
    await wait(300);
    const sub2 = $$('[role="treeitem"]', tree).find((r) => r.querySelector('.tree-name')?.textContent === 'sub');
    const inner = $$('[role="treeitem"]', tree).find((r) => r.querySelector('.tree-name')?.textContent === 'inner.txt');
    out.expanded = attr(sub2, 'aria-expanded');
    out.childLevel = attr(inner, 'aria-level');
    key(tree, 'ArrowLeft');
    await wait(300);
    out.collapsed = attr($$('[role="treeitem"]', tree).find((r) => r.querySelector('.tree-name')?.textContent === 'sub'), 'aria-expanded');
    out.headerButtons = $$('.tree-actions button').map((b) => attr(b, 'aria-label'));
    return out;
  });

  await step('editorTabs', async () => {
    await closeAll();
    const a = await ws.open(root + '/code.js');
    const b = await ws.open(root + '/plain.txt');
    await ws.open(root + '/style.css');
    await wait(200);
    ws.activePane.activate(a);
    const bar = $('.tabs', ws.activePane.element);
    const tabs = $$('[role="tab"]', bar);
    const out = {
      role: attr(bar, 'role'), label: attr(bar, 'aria-label'), tabs: tabs.map((t) => attr(t, 'aria-label')),
      selected: tabs.map((t) => attr(t, 'aria-selected')), tabStops: tabs.map((t) => t.tabIndex),
      closeLabels: tabs.map((t) => attr($('.tab-close', t), 'aria-label')),
    };
    // Unsaved changes and preview state are part of the name.
    a.view.dispatch({ changes: { from: 0, insert: ' ' } });
    await wait(100);
    out.dirtyName = attr(tabs[0], 'aria-label');
    // Arrow keys move between tabs and open them; Home/End jump.
    tabs[0].focus();
    key(tabs[0], 'ArrowRight');
    out.afterRight = [ws.getActiveItem().getTitle(), document.activeElement === tabs[1]];
    key(document.activeElement, 'End');
    out.afterEnd = [ws.getActiveItem().getTitle(), document.activeElement === tabs[2]];
    key(document.activeElement, 'ArrowRight');
    out.wraps = ws.getActiveItem().getTitle();
    // Reorder and move between panes without the mouse.
    await app.commands.run('tab:move-right');
    out.movedRight = ws.activePane.items.map((i) => i.getTitle());
    await app.commands.run('tab:move-left');
    out.movedLeft = ws.activePane.items.map((i) => i.getTitle());
    ws.splitRight(ws.activePane, null);
    out.paneLabels = ws.panes.map((p) => attr(p.element, 'aria-label'));
    ws.setActivePane(ws.panes[0]);
    const moving = ws.getActiveItem().getTitle();
    await app.commands.run('tab:move-to-next-pane');
    out.movedToPane = [ws.panes.length, ws.panes.at(-1).items.map((i) => i.getTitle()).includes(moving), ws.activePane === ws.panes.at(-1)];
    // Delete closes the focused tab (a clean one here: a dirty one asks first).
    const clean = ws.allItems().find((i) => !i.isDirty());
    const tab = ws.panes.find((p) => p.items.includes(clean)).tabEls.get(clean);
    tab.focus();
    const count = ws.allItems().length;
    key(tab, 'Delete');
    await wait(200);
    out.deleteClosed = ws.allItems().length === count - 1 && !ws.allItems().includes(clean);
    return out;
  });

  await step('editorLabel', async () => {
    await closeAll();
    const ed = await ws.open(root + '/code.js');
    await wait(200);
    const before = attr(ed.view.contentDOM, 'aria-label');
    await T.answers('saveAs', root + '/renamed-for-a11y.js');
    await ws.saveAs(ed);
    await wait(200);
    return { role: attr(ed.view.contentDOM, 'role'), multiline: attr(ed.view.contentDOM, 'aria-multiline'), before, after: attr(ed.view.contentDOM, 'aria-label') };
  });

  await step('quickOpenCombobox', async () => {
    await closeAll();
    const ed = await ws.open(root + '/code.js');
    ed.view.focus();
    await wait(100);
    const trigger = document.activeElement;
    await app.commands.run('fuzzy-finder:toggle');
    const input = await until(() => $('.select-list .select-input'));
    await until(() => $$('.select-item').length > 3);
    await wait(100);
    const dialog = $('.select-list');
    const list = $('.select-items');
    const options = $$('[role="option"]', list);
    const out = {
      dialog: [attr(dialog, 'role'), attr(dialog, 'aria-modal'), !!attr(dialog, 'aria-label')],
      combobox: [attr(input, 'role'), attr(input, 'aria-expanded'), attr(input, 'aria-controls') === list.id, attr(input, 'aria-autocomplete'), !!attr(input, 'aria-label')],
      listbox: [attr(list, 'role'), !!attr(list, 'aria-label')],
      options: options.length > 3, oneSelected: options.filter((o) => attr(o, 'aria-selected') === 'true').length === 1,
      uniqueIds: new Set(options.map((o) => o.id)).size === options.length,
      activeDescendant: attr(input, 'aria-activedescendant') === options.find((o) => attr(o, 'aria-selected') === 'true')?.id,
      focusInInput: document.activeElement === input,
    };
    const first = attr(input, 'aria-activedescendant');
    key(input, 'ArrowDown');
    const second = attr(input, 'aria-activedescendant');
    out.arrowMoves = first !== second && attr(document.getElementById(second), 'aria-selected') === 'true' && attr(document.getElementById(first), 'aria-selected') === 'false';
    // Typing narrows the list and says how many results are left.
    input.value = 'zzzz-nothing'; input.dispatchEvent(new Event('input'));
    await wait(100);
    out.noMatch = [attr(input, 'aria-activedescendant'), $('.select-list [role="status"]').textContent];
    input.value = 'plain'; input.dispatchEvent(new Event('input'));
    await wait(150);
    out.results = /^\d+ results?$/.test($('.select-list [role="status"]').textContent);
    // Tab must not leave the dialog, and Escape hands focus back to where it was.
    key(input, 'Tab');
    out.tabStaysInside = dialog.contains(document.activeElement);
    key(input, 'Tab', { shiftKey: true });
    out.shiftTabStaysInside = dialog.contains(document.activeElement);
    key(input, 'Escape');
    await wait(200);
    out.closed = !$('.select-list');
    out.focusRestored = document.activeElement === trigger;
    return out;
  });

  await step('promptDialog', async () => {
    const trigger = document.activeElement;
    const pending = app.ui.prompt({ title: 'Name the thing', validate: (v) => (v ? null : 'A name is required.') });
    const input = await until(() => $('.select-list.prompt .select-input'));
    await until(() => document.activeElement === input);
    const dialog = $('.select-list.prompt');
    const out = { dialog: [attr(dialog, 'role'), attr(dialog, 'aria-modal'), attr(dialog, 'aria-label')], inputLabel: attr(input, 'aria-label'), described: !!document.getElementById(attr(input, 'aria-describedby')) };
    input.value = '';
    key(input, 'Enter');
    out.invalid = [attr(input, 'aria-invalid'), $('.prompt-message').textContent, attr($('.prompt-message'), 'aria-live')];
    input.value = 'x'; input.dispatchEvent(new Event('input'));
    out.clearedOnInput = !input.hasAttribute('aria-invalid');
    key(input, 'Escape');
    out.cancelled = (await pending) === null;
    await wait(200);
    out.focusRestored = document.activeElement === trigger;
    return out;
  });

  await step('notifications', async () => {
    const err = app.ui.notify.error('Something broke', 'details');
    const info = app.ui.notify.info('All saved');
    const warn = app.ui.notify.warn('Careful');
    const list = $$('#notifications .notification');
    const out = { roles: list.map((n) => attr(n, 'role')), dismiss: list.map((n) => attr($('.notification-close', n), 'aria-label')) };
    err.close(); info.close(); warn.close();
    await wait(300);
    // A notification someone is reading with the keyboard isn't dismissed from under them.
    const sticky = app.ui.notify.info('Sticky', 'detail', { timeout: 400, actions: [{ label: 'Do it', run() {} }] });
    const n = $$('#notifications .notification').at(-1);
    $('.btn', n).focus();
    n.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); // the test window isn't the focused one, so focus events don't fire on their own
    await wait(1200);
    out.keptWhileFocused = n.isConnected && !n.classList.contains('closing');
    key($('.btn', n), 'Escape');
    await wait(400);
    out.escapeCloses = !n.isConnected;
    // The command puts the keyboard on the newest notification's action.
    app.ui.notify.info('Reachable', 'detail', { timeout: 0, actions: [{ label: 'Go', run() {} }] });
    document.body.focus();
    await app.commands.run('notifications:focus');
    out.focusCommand = document.activeElement?.textContent === 'Go';
    $$('#notifications .notification').forEach((x) => x.remove());
    return out;
  });

  await step('statusBarItems', async () => {
    await closeAll();
    await ws.open(root + '/code.js');
    await wait(400);
    const clickable = $$('#statusbar .status-item.clickable');
    const cursor = $('#statusbar .status-item[data-id="cursor"]');
    const out = {
      clickable: clickable.length >= 3, allButtons: clickable.every((e) => attr(e, 'role') === 'button' && e.tabIndex === 0), named: clickable.every((e) => nameOf(e) || attr(e, 'title')),
      cursorText: cursor.textContent.trim(), cursorName: nameOf(cursor), cursorTooltip: attr(cursor, 'title'),
    };
    cursor.focus();
    key(cursor, 'Enter');
    out.enterActivates = !!(await until(() => $('.select-list .select-input'), 2000));
    app.ui.closeModal();
    return out;
  });

  await step('settingsControls', async () => {
    await app.commands.run('settings:open');
    await until(() => $('.settings-view'));
    await wait(300);
    const out = {};
    for (const [section, label] of [['general', 'General'], ['editor', 'Editor'], ['themes', 'Themes'], ['fonts', 'Fonts'], ['packages', 'Packages'], ['keybindings', 'Keybindings'], ['hack', 'Make It Yours']]) {
      $$('.settings-nav-item').find((b) => b.textContent.trim() === label).click();
      await wait(350);
      out[section] = unnamed($('.settings-content'));
    }
    $$('.settings-nav-item').find((b) => b.textContent.trim() === 'Editor').click();
    await wait(300);
    out.navCurrent = $$('.settings-nav-item').map((b) => attr(b, 'aria-current')).filter(Boolean);
    out.switches = $$('.settings-content input[type="checkbox"]').every((c) => attr(c, 'role') === 'switch' && nameOf(c));
    out.selects = $$('.settings-content select').every((s) => nameOf(s));
    $$('.settings-nav-item').find((b) => b.textContent.trim() === 'Themes').click();
    await wait(300);
    out.themeCardsPressed = $$('.theme-card').filter((c) => attr(c, 'aria-pressed') === 'true').length === 1;
    return out;
  });

  // Result rows are plain elements that were clicked: they must be reachable and operable from the keyboard too.
  await step('clickableRowsKeyboard', async () => {
    await app.commands.run('find-in-project:show');
    const q = await until(() => $('.fip-query'));
    q.value = 'inner'; key(q, 'Enter');
    const header = await until(() => $('.fip-file'));
    const out = { role: attr(header, 'role'), tabindex: header.tabIndex, expanded: attr(header, 'aria-expanded') };
    header.focus();
    key(header, 'Enter');
    await wait(200);
    out.collapsedByEnter = attr($('.fip-file'), 'aria-expanded');
    out.match = (() => { key($('.fip-file'), ' '); return true; })();
    await wait(200);
    out.reopenedBySpace = attr($('.fip-file'), 'aria-expanded');
    out.toggles = $$('.fip-toggle').map((b) => [attr(b, 'aria-label'), attr(b, 'aria-pressed')]);
    $$('.fip-toggle')[1].click();
    out.togglePressed = attr($$('.fip-toggle')[1], 'aria-pressed');
    $$('.fip-toggle')[1].click();
    out.summaryLive = attr($('.fip-summary'), 'role');
    app.sidebar.show('tree-view');
    return out;
  });

  // The window under test isn't the focused one, so :focus-visible never matches here; check the rule
  // itself and the color it resolves to in a dark and a light theme.
  await step('focusRings', async () => {
    const sheetRules = [];
    for (const sheet of document.styleSheets) { try { for (const r of sheet.cssRules) if (r.selectorText) sheetRules.push(r); } catch {} }
    const rule = sheetRules.find((r) => r.selectorText === ':focus-visible');
    const out = {
      rule: rule ? [/solid/.test(rule.style.outline), /2px/.test(rule.style.outline), /var\(--focus-ring, var\(--accent\)\)/.test(rule.style.outline + rule.style.outlineColor)] : null,
      editorExempt: sheetRules.some((r) => /\.cm-content:focus-visible/.test(r.selectorText) && r.style.outlineStyle === 'none'),
      resizerFocus: sheetRules.some((r) => /\.resizer:focus-visible/.test(r.selectorText)),
      hoverControlsShowOnFocus: sheetRules.some((r) => /\.tree-actions:focus-within/.test(r.selectorText) && r.style.opacity === '1'),
    };
    const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const probe = document.createElement('div');
    probe.style.cssText = 'outline: 2px solid var(--focus-ring, var(--accent)); position: fixed; left: -99px;';
    document.body.append(probe);
    for (const theme of ['nightfall', 'daylight']) {
      await app.packages.setTheme(theme);
      await wait(300);
      const ring = rgb(getComputedStyle(probe).outlineColor);
      const surfaces = ['--bg', '--bg-sidebar', '--bg-tabbar', '--bg-statusbar', '--bg-elevated'].map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()]);
      const low = surfaces.filter(([, c]) => /^#[0-9a-f]{6}$/i.test(c)).map(([v, c]) => [v, ratio(ring, [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)))]).filter(([, r]) => r < 3);
      out[theme] = { lightBackground: ratio(rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().replace(/^#(..)(..)(..)$/, (m, r, g, b) => `${parseInt(r, 16)} ${parseInt(g, 16)} ${parseInt(b, 16)}`)), [255, 255, 255]) < 3, ringReadable: low.length === 0, low };
    }
    probe.remove();
    await app.packages.setTheme('nightfall');
    return out;
  });

  await step('reducedMotion', async () => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list; try { list = sheet.cssRules; } catch { continue; }
      for (const r of list) if (r.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion:\s*reduce/.test(r.conditionText)) rules.push(...[...r.cssRules].map((x) => x.cssText));
    }
    const text = rules.join(' ');
    return { hasRule: rules.length > 0, shortensAnimations: /animation-duration: 0\.01ms/.test(text), shortensTransitions: /transition-duration: 0\.01ms/.test(text), noLooping: /animation-iteration-count: 1/.test(text), noSmoothScroll: /scroll-behavior: auto/.test(text) };
  });

  // Open every sidebar and panel view and the common dialogs, then look for anything without a name.
  await step('everyControlHasAName', async () => {
    await closeAll();
    await ws.open(root + '/code.js');
    await wait(300);
    const checked = [];
    const offenders = {};
    const audit = (where) => { checked.push(where); const u = unnamed(); if (u.length) offenders[where] = [...new Set(u)]; };
    audit('editor');
    for (const view of app.sidebar.sortedViews()) {
      app.sidebar.show(view.id);
      await wait(400);
      audit('sidebar:' + view.id);
    }
    app.sidebar.show('tree-view');
    for (const view of app.panel.sortedViews()) {
      app.panel.show(view.id);
      await wait(500);
      audit('panel:' + view.id);
    }
    app.panel.hide();
    // Dialogs and menus built by the core.
    await app.commands.run('help:cheat-sheet'); await wait(250); audit('cheat-sheet'); app.ui.closeModal();
    await app.commands.run('command-palette:toggle'); await wait(300); audit('command-palette'); app.ui.closeModal();
    app.ui.notify.error('Check', 'detail', { actions: [{ label: 'Act', run() {} }] }); await wait(100); audit('notification');
    await app.commands.run('settings:open'); await wait(400); audit('settings');
    const ids = $$('[id]').map((e) => e.id);
    return { checked: checked.length, offenders, duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i), positiveTabindex: $$('[tabindex]').filter((e) => e.tabIndex > 0).length };
  });

  results.totalErrors = errors.length;
  return results;
})()
