// The package browser (Settings → Packages): searching GitHub, sorting, the details page with the
// README and the permissions a package asks for, installing from it, update badges and Update All,
// and the messages for rate limiting and being offline. GitHub is a fake server (test/servers.mjs)
// that serves search results, package.json, READMEs, commits and tarballs.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide;
  const T = window.mideTest;
  const fsx = window.native.fs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await wait(80); } return null; };
  const errors = [];
  const oe = console.error; console.error = (...a) => { errors.push(a.map((x) => x?.message || String(x)).join(' ').slice(0, 200)); oe(...a); };
  const out = {};
  const fixtures = app.userInfo.dir.replace(/\/[^/]+$/, '');
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const content = () => document.querySelector('.settings-content');
  const one = (sel) => content().querySelector(sel);
  const all = (sel) => [...content().querySelectorAll(sel)];
  const button = (label, root = content()) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
  const press = (label, root) => { const b = button(label, root); if (!b) throw new Error('no button ' + label + ' in: ' + text(root || content()).slice(0, 300)); b.click(); };
  const tab = (label) => all('.pkg-tab').find((t) => t.firstChild.textContent === label).click();
  const names = () => all('.discover-card .discover-name').map(text);
  const card = (repo) => one(`.discover-card[data-repo="${repo}"]`);
  const requests = async () => JSON.parse(await fsx.read(`${fixtures}/github/requests.json`));
  const count = async (pred) => (await requests()).filter(pred).length;
  const setHead = (heads) => fsx.write(`${fixtures}/github/head.json`, JSON.stringify(heads));
  const record = (name) => { const p = app.packages.packages.get(name); return p && { active: p.active, sandboxed: !!p.sandboxed, install: p.meta.install }; };
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const detailsReady = () => until(() => one('.pkg-detail-body[data-ready]'));
  const status = () => text(one('.discover-status'));

  // --- the list ------------------------------------------------------------
  await until(() => app.commands.has('settings:open-packages'), 20000);
  await app.commands.run('settings:open-packages');
  await until(() => one('.pkg-tab'));
  out.openedOnInstalled = one('.pkg-tab.active').firstChild.textContent;
  tab('Discover');
  await until(() => all('.discover-card').length === 4);
  out.byStars = names();
  out.cardText = text(card('ada/goal-tracker'));
  out.noBadgesYet = all('.discover-card .badge').length;

  // Sorting asks GitHub for the other order; going back reuses the cached answer.
  const sort = one('.discover-sort');
  sort.value = 'updated';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => names()[0] === 'quick-notes');
  out.byUpdated = names();
  sort.value = 'stars';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => names()[0] === 'goal-tracker');
  out.sortOptions = [...sort.options].map(text);

  // Searching narrows the list; an empty search shows everything again.
  type(one('.settings-search'), 'notes');
  await until(() => names().length === 1);
  out.searchNotes = names();
  type(one('.settings-search'), '');
  await until(() => names().length === 4);
  out.emptySearchShowsAll = names().length;
  const searches = (sortBy, term) => count((r) => r.path === '/search/repositories' && r.sort === sortBy && r.term === term);
  out.starsSearchRequests = await searches('stars', '');
  out.updatedSearchRequests = await searches('updated', '');

  // --- details -------------------------------------------------------------
  type(one('.settings-search'), 'tracker');
  await until(() => names().length === 1);
  const content_ = content();
  content_.style.paddingBottom = '3000px'; // so there is something to scroll
  content_.scrollTop = 240;
  await wait(100);
  const scrolled = content_.scrollTop;
  // Images the README may not show are never even requested (an <img> starts loading as soon as it is made).
  const blocked = [];
  const onViolation = (e) => blocked.push(e.blockedURI);
  document.addEventListener('securitypolicyviolation', onViolation);
  const resourcesBefore = performance.getEntriesByType('resource').length;
  press('Details', card('ada/goal-tracker'));
  await detailsReady();
  out.scrolledToTopOnOpen = content_.scrollTop === 0;
  out.title = one('.pkg-detail-title').childNodes[0].textContent;
  out.titleBadges = all('.pkg-detail-title .badge').map(text);
  out.meta = text(one('.pkg-detail-meta'));
  out.description = text(one('.pkg-detail-desc'));
  out.permissions = all('.pkg-perm').map((e) => e.dataset.permission);
  out.permissionLabels = all('.pkg-perm span').map(text);
  out.detailButtons = all('.pkg-detail-actions button').map(text);
  out.readmeHeading = text(one('.pkg-readme h1'));
  out.readmeBold = text(one('.pkg-readme strong'));
  out.readmeCode = text(one('.pkg-readme pre code'));
  const images = all('.pkg-readme img');
  out.readmeImages = images.map((i) => i.getAttribute('src').replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
  out.readmeImagePlaceholders = all('.pkg-readme .pkg-readme-img').map(text);
  const links = Object.fromEntries(all('.pkg-readme a').map((a) => [text(a), a.getAttribute('href')]));
  out.readmeLinks = links;
  out.readmeHasScript = !!one('.pkg-readme script');
  out.readmeAppClasses = all('.pkg-readme [class]').map((e) => e.className).filter((c) => !/^(language-|pkg-readme-img$)/.test(c));
  out.readmeInlineHandlers = all('.pkg-readme *').some((e) => [...e.attributes].some((a) => /^on/i.test(a.name)));
  await wait(300);
  out.readmeXss = window.__readmeXss ?? 'none';
  document.removeEventListener('securitypolicyviolation', onViolation);
  out.readmeForeignRequests = [...blocked, ...performance.getEntriesByType('resource').slice(resourcesBefore).map((r) => r.name)]
    .filter((u) => /shields\.io|tracker\.invalid/.test(u));
  // An anchor in the README scrolls inside the page; it never navigates the window.
  const before = location.href;
  one('.pkg-readme a[href="#install"]').click();
  out.anchorStaysInApp = location.href === before;
  out.readmeRequests = await count((r) => /\/readme$/.test(r.path));

  // Back keeps the search and the scroll position.
  press('← Back to Discover');
  await until(() => one('.discover-card'));
  out.backKeepsSearch = one('.settings-search').value;
  out.backKeepsList = names();
  out.backKeepsScroll = content_.scrollTop === scrolled;
  content_.style.paddingBottom = '';
  type(one('.settings-search'), '');
  await until(() => names().length === 4);
  out.detailFetches = await count((r) => /^\/repos\/ada\/goal-tracker$/.test(r.path));

  // A package that asks for full access says so before anything is installed.
  card('cy/power-tools').querySelector('.discover-name').click();
  await detailsReady();
  out.fullAccessTitleBadges = all('.pkg-detail-title .badge').map(text);
  out.fullAccessWarning = text(one('.pkg-fullaccess strong'));
  out.fullAccessPermissionRows = all('.pkg-perm').length;
  press('← Back to Discover');
  await until(() => one('.discover-card'));
  // A repository without a package.json can't be installed.
  card('dee/not-a-package').click();
  await detailsReady();
  out.problem = text(one('.pkg-problem'));
  out.installDisabled = button('Install').disabled;
  press('← Back to Discover');
  await until(() => one('.discover-card'));

  // --- install from the details page ---------------------------------------
  card('ada/goal-tracker').querySelector('.discover-name').click();
  await detailsReady();
  await T.answers('confirm', 0);
  press('Install');
  await until(() => button('Uninstall'));
  await detailsReady();
  const goal = record('goal-tracker');
  out.installed = { active: goal?.active, sandboxed: goal?.sandboxed, permissions: goal?.install?.permissions, version: goal?.install?.version, source: goal?.install?.source };
  out.installedBadge = all('.pkg-detail-title .badge').map(text);
  out.installedButtons = all('.pkg-detail-actions button').map(text);
  out.allowedLine = text(one('.pkg-allowed'));
  out.statusItem = await until(() => [...document.querySelectorAll('.status-item')].map(text).find((t) => t.startsWith('goal-tracker')));

  // Back in the list the card is marked installed, the others still offer Install.
  press('← Back to Discover');
  await until(() => card('ada/goal-tracker')?.querySelector('.badge.installed'));
  out.cardBadge = text(card('ada/goal-tracker').querySelector('.badge.installed'));
  out.cardActions = {
    tracker: [...card('ada/goal-tracker').querySelectorAll('button')].map(text).filter((t) => t !== 'goal-tracker'),
    notes: [...card('bob/quick-notes').querySelectorAll('button')].map(text).filter((t) => t !== 'quick-notes'),
  };
  // Install from a card.
  await T.answers('confirm', 0);
  press('Install', card('bob/quick-notes'));
  await until(() => card('bob/quick-notes')?.querySelector('.badge.installed'));
  out.notesInstalled = { badge: text(card('bob/quick-notes').querySelector('.badge.installed')), active: record('quick-notes')?.active, permissions: record('quick-notes')?.install.permissions };

  // --- updates -------------------------------------------------------------
  tab('Installed');
  await until(() => one('.pkg-updates'));
  out.upToDate = await until(() => /up to date/.test(text(one('.pkg-updates-text'))) && text(one('.pkg-updates-text')));
  out.noUpdateBadges = all('.package-card .badge.update').length;
  out.githubCards = all('.package-card[data-package] .package-name-link').map(text);
  const commitChecks = () => count((r) => /\/commits\//.test(r.path));
  const checksBefore = await commitChecks();
  // Something new is pushed. A check made today isn't repeated by itself…
  await setHead({ 'ada/goal-tracker': 2, 'bob/quick-notes': 2 });
  const quiet = await window.native.pkgmgr.checkUpdates();
  out.dailyCheckReused = quiet.updates.length === 0 && (await commitChecks()) === checksBefore;
  // …but the button looks right away.
  press('Check for Updates');
  await until(() => /2 updates available/.test(text(one('.pkg-updates-text'))));
  out.updatesText = text(one('.pkg-updates-text'));
  out.updateBadges = all('.package-card[data-package]').filter((c) => c.querySelector('.badge.update')).map((c) => c.dataset.package).sort();
  out.tabCount = text(one('.pkg-tab-count'));
  out.updateAllButton = !!button('Update All');
  out.forcedCheckRequests = (await commitChecks()) - checksBefore;
  tab('Discover');
  await until(() => card('ada/goal-tracker')?.querySelector('.badge.update'));
  out.discoverUpdateBadges = all('.discover-card').filter((c) => c.querySelector('.badge.update')).map((c) => c.dataset.repo).sort();
  out.discoverUpdateButton = !!button('Update', card('ada/goal-tracker'));

  // Update one from its details page: same permissions, so no question is asked (a dialog would hang here).
  card('ada/goal-tracker').querySelector('.discover-name').click();
  await detailsReady();
  out.detailsUpdateBadge = all('.pkg-detail-title .badge').map(text);
  press('Update');
  await until(() => record('goal-tracker')?.install?.version === '1.1.0');
  await until(() => !one('.pkg-detail-title .badge.update') && one('.pkg-detail-body[data-ready]'));
  out.goalUpdated = { version: record('goal-tracker').install.version, permissions: record('goal-tracker').install.permissions, active: record('goal-tracker').active, badges: all('.pkg-detail-title .badge').map(text) };
  out.statusAfterUpdate = await until(() => [...document.querySelectorAll('.status-item')].map(text).find((t) => t === 'goal-tracker v1.1.0'));
  press('← Back to Discover');
  await until(() => one('.discover-card'));

  // The other update asks for a new permission: it is only installed after you agree.
  tab('Installed');
  await until(() => one('.pkg-updates'));
  await T.answers('confirm', 1); // Cancel
  press('Update', one('.package-card[data-package="quick-notes"]'));
  await wait(300);
  await until(() => text(one('.pkg-updates-text')) !== 'Updating…');
  out.cancelledUpdate = { version: record('quick-notes').install.version, permissions: record('quick-notes').install.permissions, stillOffered: !!one('.package-card[data-package="quick-notes"] .badge.update') };
  await T.answers('confirm', 0);
  press('Update All');
  // The new version is recorded before it has finished activating, so wait for both.
  await until(() => record('quick-notes')?.install?.version === '2.0.0' && record('quick-notes').active);
  out.notesUpdated = { version: record('quick-notes').install.version, permissions: record('quick-notes').install.permissions, active: record('quick-notes').active };
  await until(() => /up to date/.test(text(one('.pkg-updates-text'))));
  out.afterUpdates = { text: text(one('.pkg-updates-text')), badges: all('.package-card .badge.update').length, tabCount: !!one('.pkg-tab-count') };

  // GitHub's rate limit cuts a check short: what was found shows, the rest is named, and the check
  // isn't kept as today's, so the next look asks again.
  const updatesFile = `${app.userInfo.dir}/package-updates.json`;
  const checkedAt = async () => JSON.parse(await fsx.read(updatesFile)).checkedAt;
  const checkedBefore = await checkedAt();
  await setHead({ 'ada/goal-tracker': 1, 'bob/quick-notes': 2 }); // a different commit on goal-tracker's branch
  await fsx.write(`${fixtures}/github/limit.json`, JSON.stringify({ commits: 1 }));
  press('Check for Updates');
  await until(() => /Couldn't check/.test(text(one('.pkg-updates-text'))));
  out.limitedCheck = {
    text: text(one('.pkg-updates-text')),
    badges: all('.package-card[data-package]').filter((c) => c.querySelector('.badge.update')).map((c) => c.dataset.package),
    keptAsToday: (await checkedAt()) !== checkedBefore,
  };
  // Until the limit lifts, a look without asking doesn't ask GitHub, and still says what wasn't checked.
  let checksAtLimit = await commitChecks();
  const reused = await window.native.pkgmgr.checkUpdates();
  out.limitedCheck.reused = { unchecked: reused.unchecked, requests: (await commitChecks()) - checksAtLimit };
  // Once it has (the time GitHub gave is moved into the past), it checks again: a full check would be reused for a day.
  const cache = JSON.parse(await fsx.read(updatesFile));
  await fsx.write(updatesFile, JSON.stringify({ ...cache, retryAt: Date.now() - 1000 }));
  await fsx.write(`${fixtures}/github/limit.json`, JSON.stringify({ commits: 99 }));
  checksAtLimit = await commitChecks();
  const again = await window.native.pkgmgr.checkUpdates();
  out.limitedRetried = { requests: (await commitChecks()) - checksAtLimit, unchecked: again.unchecked, updates: again.updates.map((u) => u.name), keptAsToday: (await checkedAt()) !== checkedBefore };
  // Put goal-tracker's branch back where it is installed.
  await setHead({ 'ada/goal-tracker': 2, 'bob/quick-notes': 2 });
  press('Check for Updates');
  await until(() => /up to date/.test(text(one('.pkg-updates-text'))));

  // --- messages ------------------------------------------------------------
  tab('Discover');
  await until(() => one('.discover-card'));
  type(one('.settings-search'), 'limited');
  out.rateLimit = await until(() => /limit/.test(status() || '') && status());
  out.rateLimitCards = all('.discover-card').length;
  out.tryAgain = !!button('Try Again');
  type(one('.settings-search'), 'offline');
  out.offline = await until(() => /Can't reach GitHub/.test(status() || '') && status());
  type(one('.settings-search'), 'zzz-nothing');
  out.noMatches = await until(() => /No packages match/.test(status() || '') && status());
  type(one('.settings-search'), '');
  await until(() => names().length === 4);
  out.recovered = names().length;

  // --- uninstall from the details page -------------------------------------
  card('bob/quick-notes').querySelector('.discover-name').click();
  await detailsReady();
  await T.answers('confirm', 0);
  press('Uninstall');
  await until(() => !record('quick-notes'));
  await until(() => button('Install') && one('.pkg-detail-body[data-ready]'));
  out.uninstalled = { gone: !record('quick-notes'), installButton: !!button('Install'), records: Object.keys(JSON.parse(await fsx.read(`${app.userInfo.dir}/installed.json`)).packages) };

  // Leave the details page of an installed package open for the screenshot.
  press('← Back to Discover');
  await until(() => one('.discover-card'));
  card('ada/goal-tracker').querySelector('.discover-name').click();
  await detailsReady();
  await wait(300);

  out.errors = errors;
  return out;
})()
