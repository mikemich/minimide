#!/usr/bin/env node
// End-to-end test runner: builds the app, creates fixtures, then launches Electron once per suite
// with the dev-build test hooks (MINIMIDE_HOME / MINIMIDE_EVAL / MINIMIDE_SCREENSHOT), parses the
// `[eval] <json>` line the suite's renderer script produced and checks it.
//
//   node test/run.mjs                 run every suite
//   node test/run.mjs handsOn core    run some suites (dependencies are added automatically)
//   node test/run.mjs --no-build      skip `node build.mjs`
//   node test/run.mjs --keep          keep the fixture dir even when everything passes
//
// Logs and screenshots go to test/output/<suite>.{log,png}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixtures } from './fixtures.mjs';
import { gistServer, githubServer, vscodeEnv } from './servers.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES_DIR = path.join(REPO, 'test/suites');
const OUTPUT = path.join(REPO, 'test/output');
const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Suites. `expect` maps a dotted path in the result to an expected value: a RegExp (tested against
// the value as a string), a function (must return true) or anything else (compared as JSON).
// `env.has(cmd)` says whether a program is on PATH, for checks that depend on optional tools.
// Every suite also gets the generic checks in genericFailures().
// `env(fixtures)` adds environment variables for the app.
// `knownIssues` maps an expect path to a description of an app bug that is not fixed yet: a failure
// there is reported but doesn't fail the run, and a pass is flagged so the entry can be removed.

const SUITES = [
  {
    name: 'dialogHarness', home: 'dialogh', project: 'qa', timeout: 60,
    expect: () => ({ scripted: 2, savePath: '/tmp/scripted.txt' }),
  },
  {
    name: 'core', home: 'coreh', project: 'corep', timeout: 90,
    expect: () => ({
      helloActivated: 1, init: 'init', chord: 'hi!', dirty: true, saved: JSON.stringify('Xhello\nworld\n'), dirtyAfter: false,
      reloaded: 'changed outside\n', treeAfterDisable: 'false/false', treeAfterEnable: 'true/true', hot: 'reloaded! activations=2',
      files: 'a.txt,sub/deep.js', synced: true, items: 2,
    }),
  },
  {
    name: 'handsOn', home: 'qah', project: 'qa', delay: 4000, timeout: 300,
    expect: () => ({
      'untitledSaveAs.content': JSON.stringify('print("hi")\n'), 'untitledSaveAs.title': 'saved_new.py', 'untitledSaveAs.lang': 'Python', 'untitledSaveAs.dirty': false,
      'dirtyCloseCancelThenDiscard.cancelKeptOpen': true, 'dirtyCloseCancelThenDiscard.discardClosed': true, 'dirtyCloseCancelThenDiscard.fileUnchanged': true,
      'crlfPreserved.crlf': 'preserved',
      'unicodePathFinderAndSearch.opened': true, 'unicodePathFinderAndSearch.searchHits': 1,
      'runnerQuotedFilename.ran': true,
      'binaryFile.type': 'binary',
      'fileDeletedWhileOpen.stillOpen': true, 'fileDeletedWhileOpen.saveRecreates': true,
      'renameOpenFile.newPath': '/renamed/moved.txt', 'renameOpenFile.oldGone': true, 'renameOpenFile.newExists': true, 'renameOpenFile.tab': 'moved.txt',
      'markdownXss.rendered': true, 'markdownXss.xss': 'none', 'markdownXss.hasScriptTag': false, 'markdownXss.hasOnAttrs': false,
      'replaceAllWithOpenEditor.openEditor': JSON.stringify('DIRTY OMEGA gamma\n'), 'replaceAllWithOpenEditor.stillDirty': true,
      'replaceAllWithOpenEditor.renamedBuffer': JSON.stringify('OMEGA beta\n'), 'replaceAllWithOpenEditor.diskOfRenamed': JSON.stringify('alpha beta\n'),
      'invalidConfigJson.notified': true, 'invalidConfigJson.appAlive': true,
      'userKeymapUnbind.unboundWorks': true, 'userKeymapUnbind.restoredWorks': true,
      allThemes: /^\d+ themes applied$/,
      disableEnableEveryPackage: /^\d+ packages cycled cleanly$/,
      'splitAndCloseLast.panes': 1, 'splitAndCloseLast.originalStillOpen': true,
      'sessionSerializesImage.hasImage': true,
      terminalTabs: (t) => t?.before >= 3 && t.after === t.before - 1,
      smokeEveryCommand: /^\d+ commands ran without errors$/,
      totalErrors: 0,
    }),
  },
  {
    name: 'newPackages', home: 'home3', project: 'p4', timeout: 120,
    expect: (env) => ({
      active: 'image-viewer:true sticky-scroll:true snippets:true source-control:true',
      image: /^256 × 256 .*PNG$/, zoomAfterIn: '125%', cmdPlusZoomsImageNotFont: '150% / font unchanged', svg: /^64 × 64 .*SVG$/,
      sticky: ['1class Inventory {', '6 summarize(filter) {', '8 for (const item of this.items) {', '9 if (filter(item)) {'],
      tabExpanded: JSON.stringify('console.log();'),
      completionHasSnippets: /fori.*forof/,
      // Non-snippet completions come from the TypeScript server, when it is installed.
      ...(env.has('typescript-language-server') ? { completionHasLsp: true } : {}),
      userSnippet: JSON.stringify('console.log("hey from new.js");'),
      scInitial: ['Staged Changes: M inventory.js', 'Changes: M notes.md, U new.js'],
      branch: /^master/,
      afterStage: ['Staged Changes: M inventory.js, M notes.md', 'Changes: U new.js'],
      diffView: 'side-by-side, changed lines: 2', inlineDiff: 'inline diff with deleted chunk', commit: /Committed/,
      gitLog: (l) => Array.isArray(l) && l.length === 2 && /Handle missing items; update notes$/.test(l[0]) && /Initial commit$/.test(l[1]),
      afterCommit: ['Changes: U new.js'],
    }),
  },
  {
    name: 'lspPaths', home: 'qah2', project: 'ts space', timeout: 120, requires: ['typescript-language-server'],
    expect: () => ({
      ready: true, typeErrorFlagged: true, definitionOpened: (n) => Number.isInteger(n) && n >= 1, laterFileDiagnostics: true,
      backAfterDefinition: 'main app.ts',
      'peek.file': 'my lib.ts', 'peek.target': /function greetUser/, 'peek.closed': true, 'peek.mainUntouched': true, 'peek.stayedPut': 'main app.ts',
      fileSymbol: 'Symbols in file',
      workspaceSymbol: (l) => Array.isArray(l) && l.some((x) => /^greetUser\|.*my lib\.ts:1$/.test(x)),
      lightbulb: true, quickFixMenu: (l) => Array.isArray(l) && l.some((x) => /import/i.test(x)),
      hoverLinks: (l) => Array.isArray(l) && l.includes('Go to Definition') && l.includes('Peek'),
    }),
  },
  {
    name: 'sessionSave', home: 'sessh', project: 'qa', timeout: 60,
    expect: () => ({ saved: [['crlf.txt', 'image.png'], ['README.md']], 'cursor.line': 2, 'cursor.col': 4, sidebar: 'source-control' }),
  },
  {
    name: 'sessionRestore', home: 'sessh', project: 'qa', timeout: 60, dependsOn: 'sessionSave',
    expect: () => ({ restored: [['crlf.txt', 'image.png'], ['README.md']], 'cursor.line': 2, 'cursor.col': 4, sidebar: 'source-control' }),
  },
  {
    name: 'splitPanes', home: 'splith', project: 'qa', timeout: 90,
    expect: () => ({
      'down.below': true, 'down.sameLeft': true, 'down.sameWidth': true, 'down.shape': 'col(pane,pane)', 'down.divider': true,
      'nested.shape': 'col(pane,row(pane,pane))', 'nested.order': [0, 1, 2], 'nested.rightOfB': true, 'nested.sameTop': true, 'nested.belowA': true, 'nested.topFull': true,
      'focus.next': true, 'focus.wrapped': true, 'focus.above': true, 'focus.below': true, 'focus.nothingAbove': true,
      'keys.splitDown': true, 'keys.above': true, 'keys.below': true,
      'resize.aGrew': true, 'resize.bShrank': true, 'resize.cursorReset': true,
      'tiling.tiledBefore': true, 'tiling.tiledAfter': true, 'tiling.restored': true,
      'dragTab.moved': true, 'dragTab.closed': true,
      'roundTrip.saved': 'col(pane,row(pane,pane))', 'roundTrip.shape': 'col(pane,row(pane,pane))', 'roundTrip.titles': [['crlf.txt'], ['README.md'], ['image.png']], 'roundTrip.sameSizes': true, 'roundTrip.active': true,
      'collapse.afterRight.panes': 2, 'collapse.afterRight.shape': 'col(pane,pane)', 'collapse.afterRight.onlyColumn': true,
      'collapse.afterTop.panes': 1, 'collapse.afterTop.isPane': true, 'collapse.afterTop.shape': 'pane', 'collapse.fills': true,
      'merge.nestedShape': 'row(pane,col(pane,pane))', 'merge.shape': 'row(pane,pane)', 'merge.panes': 2,
      'oldFormat.shape': 'row(pane,pane)', 'oldFormat.titles': [['crlf.txt'], ['README.md']], 'oldFormat.activeIsSecond': true, 'oldFormat.widthRatio': 3,
    }),
  },
  {
    name: 'regressions', home: 'qbh', project: 'qb', timeout: 180,
    expect: () => ({
      'cmdShiftShortcutsInEditor.paletteOpened': true, 'cmdShiftShortcutsInEditor.plainTypingNotIntercepted': true,
      'azertyCmdZ.tabStillOpen': true,
      'previewTabInSplitKeepsPane.panes': 2, 'previewTabInSplitKeepsPane.rightPaneStillListed': true, 'previewTabInSplitKeepsPane.rightItems': ['target.txt'],
      'closePaneWithThreePanes.panesLeft': 2, 'closePaneWithThreePanes.titles': ['lines.txt', 'target.txt'],
      'reloadAsksAboutUnsaved.cancelKeptEdits': true,
      'brokenConfigNotOverwritten.fileUntouched': true,
      'configReloadDuringSetKeepsChange.kept': 19,
      'saveAsOntoOpenFile.oldTabClosed': true, 'saveAsOntoOpenFile.oneDocument': true, 'saveAsOntoOpenFile.disk': JSON.stringify('NEW CONTENT\n'),
      'deletedFileMarkedUnsaved.markedUnsaved': true,
      'snippetSelectionWithDollarBraces.literalPreserved': true,
      'duplicateBinarySafe.identical': true,
      'markdownRemoteImageBlockedAndAnchors.remoteBlocked': true, 'markdownRemoteImageBlockedAndAnchors.headingId': 't',
      'previewClosesWithSource.previewGone': true,
      'replaceAllRegexDoesNotJoinLines.lines': JSON.stringify('one_two\nthree_four\n'), 'replaceAllRegexDoesNotJoinLines.literalDollar': JSON.stringify('$$5:_10\n'),
      'searchCatastrophicRegexDoesNotFreeze.resultOrTimeout': /^(stopped: |\d+ files$)/, 'searchCatastrophicRegexDoesNotFreeze.uiResponsive': true,
      totalErrors: 0,
    }),
  },
  {
    name: 'sandbox', home: 'sbxh', project: 'sbx/proj', timeout: 90,
    expect: () => ({
      installWordCount: 'word-count', sandboxed: true, recordedAccess: 'sandboxed', statusShowsCount: true, commandEdited: true, foreignKeybindingDropped: true,
      installEvil: 'evil', evilGlobals: 'undefined,undefined,undefined,undefined,undefined', evilAllowed: [], foreignCommandRegistered: false,
      foreignConfigHidden: 'hidden', themeUnchanged: 'nightfall', foreignSchemaIgnored: 'nightfall', cssRemoteRemoved: true,
      installReader: 'proj-reader', readerProject: true, readerDotDot: true, readerSymlink: true, readerWrite: true, readerExec: true, readerGitConfig: true, readerNodeModules: true, 'viewer.read': 'ALLOWED', 'viewer.write': 'blocked',
      cssNoFakeUi: true, cssKeepsSafeVars: true, evilChannels: 'undefined,undefined,undefined,undefined,undefined', floodThrottled: true, notifySpamCapped: true,
      installReaper: 'file-reaper', reaperBlocked: [], reaperProjectWrite: 'ALLOWED', clobberOpenInit: 'blocked', initUntouched: true,
      uninstallClean: true, records: ['evil', 'file-reaper', 'net-probe', 'proj-reader', 'proj-viewer'], netProbeRan: true, netLocalRefused: [], reservedNameRefused: true,
    }),
  },
  {
    name: 'packageBrowser', home: 'pkgbh', project: null, timeout: 120,
    server: githubServer(),
    expect: () => ({
      openedOnInstalled: 'Installed',
      // The list comes from the (fake) search, most stars first; sorting and searching ask GitHub, going back reuses the answer.
      byStars: ['goal-tracker', 'quick-notes', 'power-tools', 'not-a-package'],
      cardText: /^goal-tracker★ 42ada · updated .+ agoSet a daily word goal and watch it fill up\.DetailsInstall$/, noBadgesYet: 0,
      byUpdated: ['quick-notes', 'goal-tracker', 'power-tools', 'not-a-package'], sortOptions: ['Most stars', 'Recently updated'],
      searchNotes: ['quick-notes'], emptySearchShowsAll: 4, starsSearchRequests: 1, updatedSearchRequests: 1,
      // The details page: facts, permissions from package.json, the README rendered safely.
      scrolledToTopOnOpen: true, title: 'Goal Tracker', titleBadges: ['sandboxed'],
      meta: /^ada ★ 42 Updated .*2026 Version 1\.0\.0 MIT$/, description: 'Set a daily word goal and watch it fill up.',
      permissions: ['project-files', 'network'], permissionLabels: ['Read files in the open project', 'Connect to the internet'], detailButtons: ['Install', 'View on GitHub'],
      readmeHeading: 'Goal Tracker', readmeBold: 'daily word goal', readmeCode: 'mide.commands.run("goal:set");',
      readmeImages: ['/_raw/ada/goal-tracker/main/docs/shot.png', '/_raw/ada/goal-tracker/main/x.png'], readmeImagePlaceholders: ['[Badge]'],
      readmeLinks: { CONTRIBUTING: 'https://github.com/ada/goal-tracker/blob/main/CONTRIBUTING.md', 'home page': 'https://example.com/goal', Install: '#install' },
      readmeHasScript: false, readmeInlineHandlers: false, readmeXss: 'none', anchorStaysInApp: true, readmeRequests: 1,
      backKeepsSearch: 'tracker', backKeepsList: ['goal-tracker'], backKeepsScroll: true, detailFetches: 1,
      fullAccessTitleBadges: ['full access'], fullAccessWarning: 'Needs full access', fullAccessPermissionRows: 0,
      problem: "This repository has no package.json at its root, so it can't be installed.", installDisabled: true,
      // Installing from the details page, then from a card.
      installed: { active: true, sandboxed: true, permissions: ['project-files', 'network'], version: '1.0.0', source: 'github:ada/goal-tracker' },
      installedBadge: ['installed v1.0.0', 'sandboxed'], installedButtons: ['Uninstall', 'View on GitHub'], allowedLine: 'You allowed: project-files, network.',
      statusItem: 'goal-tracker v1.0.0', cardBadge: 'installed v1.0.0', cardActions: { tracker: ['Details'], notes: ['Details', 'Install'] },
      notesInstalled: { badge: 'installed v1.0.0', active: true, permissions: [] },
      // Updates: checked once a day unless asked, flagged on the Installed tab and in Discover.
      upToDate: /^Everything from GitHub is up to date\. Checked just now\.$/, noUpdateBadges: 0, githubCards: ['Goal Tracker', 'Quick Notes'],
      dailyCheckReused: true, updatesText: '2 updates available', updateBadges: ['goal-tracker', 'quick-notes'], tabCount: '2', updateAllButton: true, forcedCheckRequests: 2,
      discoverUpdateBadges: ['ada/goal-tracker', 'bob/quick-notes'], discoverUpdateButton: true,
      // An update that asks for nothing new installs without a question; one that asks for more waits for a yes.
      detailsUpdateBadge: ['installed v1.0.0', 'update available', 'sandboxed'],
      goalUpdated: { version: '1.1.0', permissions: ['project-files', 'network'], active: true, badges: ['installed v1.1.0', 'sandboxed'] }, statusAfterUpdate: 'goal-tracker v1.1.0',
      cancelledUpdate: { version: '1.0.0', permissions: [], stillOffered: true },
      notesUpdated: { version: '2.0.0', permissions: ['clipboard'], active: true },
      'afterUpdates.text': /^Everything from GitHub is up to date\./, 'afterUpdates.badges': 0, 'afterUpdates.tabCount': false,
      // Messages.
      rateLimit: /^GitHub's search limit was reached; try again in 3 minutes\. Try Again$/, rateLimitCards: 0, tryAgain: true,
      offline: /^Can't reach GitHub\. Check your internet connection and try again\./, noMatches: /^No packages match "zzz-nothing"\./, recovered: 4,
      uninstalled: { gone: true, installButton: true, records: ['goal-tracker'] },
    }),
  },
  {
    name: 'trust', home: 'trusth', project: null, trust: false, timeout: 90,
    expect: () => ({
      restrictedStatus: true, markerAfterOpen: false, markerAfterBlame: false, scRestricted: true, lspRestricted: true,
      trusted: true, gitBranchAfterTrust: true, markerAfterTrust: false, storedTrust: true, restrictedAfterUntrust: true,
    }),
  },
  {
    // The home trusts alpha and beta (fixtures), so adding gamma asks about it.
    name: 'multiRoot', home: 'mrh', project: 'mr/alpha', trust: false, timeout: 120,
    expect: () => ({
      'single.folders': ['alpha'], 'single.rel': 'src/app.js', 'single.title': 'alpha — Minimide', 'single.treeRoots': 0,
      added: ['alpha', 'beta'], title: 'alpha +1 — Minimide', treeRoots: ['alpha', 'beta'], treeShowsBetaFiles: true,
      'rel.alpha': 'alpha/src/app.js', 'rel.beta': 'beta/lib/util.py', 'rel.root': 'beta', folderFor: true, resolved: true,
      'finder.name': 'util.py', 'finder.dir': 'beta/lib', 'finder.placeholder': /^Search files in 2 folders\b/, finderOpened: true,
      search: ['alpha/main.txt', 'beta/readme.md'], searchInBeta: ['beta/readme.md'], apiSearch: ['alpha/main.txt', 'beta/readme.md'], apiFolders: ['alpha', 'beta'],
      gitStatus: 'untracked', treeGit: 'modified', branchForBeta: 'master', noBranchForAlpha: true,
      sourceControl: { folder: 'beta', rows: ['new.txt', 'readme.md'], pickerShown: true },
      'removed.folders': ['alpha'], 'removed.rel': 'src/app.js', 'removed.title': /— alpha — Minimide$/, treeAfterRemove: true, folderForRemoved: null, gitAfterRemove: true,
      restrictedBefore: false, gammaTrusted: false, alphaStillTrusted: true, restrictedAfter: true, restrictedTooltip: /off for gamma\./, noGitInGamma: true,
      saved: ['alpha', 'gamma', 'beta'], sessionFolders: ['gamma', 'beta'], finalTitle: 'util.py — alpha +2 — Minimide',
    }),
  },
  {
    name: 'multiRootRestore', home: 'mrh', project: 'mr/alpha', trust: false, timeout: 60, dependsOn: 'multiRoot',
    expect: () => ({
      folders: ['alpha', 'gamma', 'beta'], treeRoots: ['alpha', 'gamma', 'beta'], tab: 'beta/lib/util.py', title: 'util.py — alpha +2 — Minimide',
      restricted: true, gammaTrusted: false,
      newFilesShown: true, nestedNewFile: 1, nestedBoth: 2, nestedSecondBoth: 2, nestedActiveRows: 2,
    }),
  },
  {
    name: 'languages', home: 'fth', project: 'ftproj', timeout: 90,
    expect: () => ({
      // Each file opens in the right language and gets highlighted.
      langs: (l) => !!l && Object.entries({ Makefile: 'Makefile', 'rules.nft': 'nftables', 'app.log': 'Log', 'data.csv': 'CSV', '.zshrc': 'Shell',
        '.gitignore': 'Ignore', 'main.tf': 'Terraform', '.env': 'Properties files' }).every(([f, lang]) => new RegExp(`^${lang} \\([1-9]`).test(l[f] || '')),
      afterFo: (l) => Array.isArray(l) && l.includes('for|for … in') && l.includes('fori|Counting for loop'),
      afterNs: (l) => Array.isArray(l) && l.includes('nsr1|word'),
      afterDollarNs: (l) => Array.isArray(l) && l.includes('$nsr1|word'),
      expanded: JSON.stringify('for item in list; do\n  \ndone'),
    }),
  },
  {
    name: 'codingHelp', home: 'chh', project: 'chproj', timeout: 90,
    expect: () => ({
      'back.line': 1, 'forward.line': 90, smallMovesNotRecorded: true,
      'crossFile.file': 'long.js', 'crossFile.line': 90, 'crossFileForward.file': 'notes.txt',
      backKey: 90,
      // Right-click: no language server for .txt, so only the clipboard, comment, image and palette entries.
      txtMenu: 'cut,copy,paste,|,Toggle Comment,Copy as Image,|,Show Local History,|,Command Palette…',
      menuMovedCursor: 3, menuRanComment: '// const line3 = 3;',
      modSlash: 'const line3 = 3;',
      'accelerators.back': /^(Ctrl\+-|Alt\+Left)$/, 'accelerators.definition': 'F12', 'accelerators.palette': /P$/,
      'cheatSheet.sections': 4, 'cheatSheet.hasPeek': true, 'cheatSheet.closedByEscape': true, 'cheatSheet.rowRuns': true,
      'holdCmd.notInstant': true, 'holdCmd.shown': true, 'holdCmd.tabBadges': true, 'holdCmd.sidebarBadge': true,
      'holdCmd.cursorCard': /^At the cursor: .*Comment \/ uncomment/, 'holdCmd.anywhereCard': true, 'holdCmd.hiddenOnRelease': true,
      'holdCmd.notForShortcuts': true, 'holdCmd.notOverDialog': true,
      // One box: ⌘P for files, ">" commands (with plain words), ":" line, "?" help.
      'box.filesBadge': 'Files', 'box.editorCommandsKept': true, 'box.paletteOpensOnPrefix': '>|Commands', 'box.removeLine': 'Editor: Delete Line',
      'box.colors': (l) => Array.isArray(l) && l.includes('Theme: Select Theme…'), 'box.backToFiles': 'Files',
      'box.line': 'Go to line 7', 'box.lineJumped': 7, 'box.columnZero': 1, 'box.help': (l) => Array.isArray(l) && l.includes('>  Commands') && l.includes(':  Go to line'),
      'box.sameKeyCloses': true, 'box.deleteLineKey': 'const line8 = 8;',
    }),
  },
  {
    name: 'emmetMarkdown', home: 'emh', project: 'emproj', timeout: 90,
    expect: () => ({
      // Emmet: Tab expands in HTML / CSS / JSX; elsewhere Tab and snippets behave as before.
      'html.loaded': true, 'html.expanded': '<ul>\n  <li></li>\n  <li></li>\n</ul>', 'html.cursorInFirstLi': true, 'html.id': '<div id="app"></div>',
      'html.proseWordKept': true, 'html.indentKept': true, 'html.insideTag': true, 'html.inScript': true,
      'css.margin': 'margin: 10px;', 'css.outsideBlock': true, 'scss.margin': 'margin: 10px;',
      'jsx.inside': '<p className="note"></p>', 'jsx.outsideJsx': true,
      'js.snippetWins': 'console.log();', 'js.plainTabIndents': true, 'txt.plainTabIndents': true,
      'disabled.untouched': true, 'commands.listed': true, 'commands.balance': 'x | <p>x</p> | x',
      'wrap.box': true, 'wrap.doc': '<p><span class="hi">hello</span></p>', 'wrap.closed': true,
      // Markdown preview: scrolling either side moves the other, matched by source line.
      'md.previewHasLines': true, 'md.editorToPreview': true, 'md.previewToEditor': true, 'md.stable': true, 'md.clickMovesCursor': true, 'md.offStaysPut': true,
      totalErrors: 0,
    }),
  },
  {
    name: 'codeImage', home: 'cih', project: 'cimproj', timeout: 90,
    expect: () => ({
      'copy.lines': 4, 'copy.truncated': false, 'copy.onClipboard': true, 'copy.toast': true, 'copy.sizeOk': true,
      'copy.cornerIsBackdrop': true, 'copy.codeColors': (n) => n >= 6, 'copy.titleBarDots': true, 'copy.notBlank': true,
      'wholeFile.lines': 200, 'wholeFile.truncated': true, 'wholeFile.note': true, lineNumbersWider: true,
      'save.path': true, 'save.isPng': true, 'save.notEmpty': true, saveCancelled: true,
      'refuses.html': 'refused', 'refuses.notPng': 'refused', 'refuses.relative': 'refused', 'refuses.clipboard': 'refused', 'refuses.nothingWritten': true,
      'jsMenu.copyAsImage': true, 'jsMenu.afterToggleComment': 'Copy as Image', menuCopies: true,
      'pasteImage.prevented': true, 'pasteImage.linked': true, 'pasteImage.written': true, 'pasteImage.atCursor': true,
      'pasteImage.twoDistinct': true, 'pasteImage.spacedName': true,
      'textPaste.inserted': true, 'textPaste.noNewImage': true,
      'otherFiles.jsIgnored': true, 'otherFiles.txtIgnored': true,
      'untitled.prevented': true, 'untitled.toast': true, 'untitled.empty': true, imagesFolder: 3,
      'spellcheck.md': 'true', 'spellcheck.txt': 'true', 'spellcheck.js': 'false', 'spellcheck.untitled': 'true',
      'spellcheck.offMd': 'false', 'spellcheck.offTxt': 'false', 'spellcheck.backOn': 'true',
      'spellcheck.renamedToMd': 'true', 'spellcheck.renamedToJs': 'false', 'spellcheck.autocorrectMd': 'off', nativeSpell: 'boolean',
      'spellMenu.top': ['Replace with "the"', 'Replace with "tech"', 'Replace with "ten"', 'Replace with "tea"', 'Replace with "tee"', 'Add to Dictionary', '|'],
      'spellMenu.hasDictionary': true, 'spellMenu.hasCopyImage': true, 'spellMenu.asked': 'teh',
      'spellMenu.replaced': 'tech quick brown fox', 'spellMenu.codeFilesNotChecked': true,
    }),
  },
  {
    name: 'welcome', home: 'welh', project: 'qa', timeout: 60,
    expect: () => ({
      notAtTestLaunch: true, shown: 1, flagSet: true, holdKey: true, notAModal: true, savedToDisk: true,
      steps: (s) => Array.isArray(s) && s.length === 3 && s[1] === '… finds anything (type > for commands)' && s[2] === 'Right-click code for more',
      hintsShown: true, hintsHidden: true, boxOpen: true,
      noEditorBefore: true, editorOpened: 'README.md', menu: (m) => Array.isArray(m) && m.includes('Command Palette…') && m.includes('copy'),
      closed: true, notAgain: true, notAfterReload: true, commandShows: 1, inPalette: true, closeButton: true,
    }),
  },
  {
    // The AI package against a fake Anthropic API (test/fake-anthropic.mjs): nothing leaves the machine.
    name: 'ai', home: 'aih', project: 'aiproj', timeout: 300,
    server: (fixtures) => startFakeAnthropic(path.join(fixtures, 'aih')),
    expect: () => ({
      'status.environmentKey': true, badKeyRejected: /sk-ant-/,
      'chat.answer': 'console.log("hi");', 'chat.meta': /^claude-opus-5-5 · 1\.2k in \(800 cached\) · 42 out$/,
      'chat.request': { model: 'claude-opus-5-5', stream: true, max_tokens: 64000, effort: 'medium', fallbacks: 'default', cache: 'ephemeral', apiKey: 'test-key', fallbackBeta: true, systemOk: true, hasContext: true, hasFile: true },
      'chat.second': { messages: 3, thinkingPassedBack: 'sig-test-123', fileUnchangedNote: true },
      inserted: true,
      'edit.applied': 'const total = items.reduce((sum, x) => sum + x, 0);', 'edit.secondLine': 'console.log("sum", total);', 'edit.cache': 'absent', 'edit.selectionMarked': true, 'edit.rejectedUnchanged': true,
      'fix.noProblem': true,
      'suggest.ghost': 'return a + b;', 'suggest.accepted': true, 'suggest.request': { max_tokens: 4096, effort: 'low', cache: 'absent' },
      refusal: /declined in the test/,
      'stop.stopped': true, 'stop.historyKept': true,
      'noFile.sentFile': false,
      'haiku.fallbacks': 'absent',
      missingModel: /model wasn't found/,
      'ollama.answer': 'Local model answer.', 'ollama.remoteRejected': /this machine/,
      claudeCode: [['run', 'claude', true, 'claude-code'], ['show', 'claude-code']],
      noKeyInState: true,
    }),
  },
  {
    name: 'largeProject', home: 'largeh', project: 'large', timeout: 180,
    expect: () => ({
      fileCount: 55000, nodeModulesIgnored: true, searchMatches: 1100, searchError: null,
      relistFast: true, newFileSeen: true, deletedGone: true, responsive: true,
    }),
  },
  {
    name: 'editorExtras', home: 'extrah', project: 'extras', timeout: 90,
    expect: () => ({
      md: '1,234 words · 6 min read', selected: '120 of 1,234 words', typed: '1,236 words · 6 min read',
      txt: '3 words · 1 min read', jsHidden: true,
      offByDefault: 0,
      top: ['(|d0', '{|d1', '[|d2', ']|d2', '}|d1', ')|d0', '(|d0', '{|d1', '[|d2'],
      bottom: [']|d2', '}|d1', ')|d0'],
      commandOff: { config: false, spans: 0 },
    }),
  },
  {
    name: 'localHistory', home: 'lhh', project: 'lhproj', timeout: 120,
    expect: () => ({
      'saves.contents': ['beta\n', 'gamma\n'], 'saves.labels': [null, null], 'saves.shape': 'file,hash,id,size,time',
      'size.bigKept': false, 'size.smallKept': true, 'size.bigKeptAfterRaise': true,
      'ignore.skipped': { nodeModules: true, minified: true, coreIgnoredNames: true, customGlob: true, slashGlob: true },
      'ignore.stillKept': true,
      'view.opened': true, 'view.rows': 2, 'view.selectedLeft': 'beta\n', 'view.right': 'gamma\n', 'view.mergeShown': true,
      'view.title': 'notes.txt (history)', 'view.sameInfo': true,
      'compare.opened': true, 'compare.selectedLeft': 'beta\n',
      'restore.buffer': 'beta\n', 'restore.dirty': true, 'restore.afterUndo': 'gamma\n', 'restore.diskUntouched': 'gamma\n',
      'restore.unsavedKept': 'delta\n', 'restore.unsavedLabel': 'Before restore',
      'quickPick.buffer': 'delta\n',
      'snapshot.text': 'zzz\n', 'snapshot.readOnly': true, 'snapshot.title': /^notes\.txt \(/,
      'retention.contents': ['v4\n', 'v5\n', 'v6\n'], 'retention.files': 4,
      'age.afterClean': ['v5\n', 'v6\n'], 'age.filesLeft': 3,
      'recover.listed': true, 'recover.restored': 'gone v1\n', 'recover.opened': true,
      'rename.fileMoved': ['r1\n'], 'rename.oldGone': true,
      'rename.folderMoved': ['i1\n'], 'rename.folderOldGone': true,
      'reload.disk': { text: 'changed outside\n', label: 'Before reload from disk', saved: 'ext original\n' },
      'reload.revert': { label: 'Before revert', saved: 'scratch\n' },
      'guard.refused': true,
    }),
  },
  {
    // Symbols from the syntax tree, and from a fake language server (test/fake-lsp.mjs) with inlay hints.
    name: 'outline', home: 'outlineh', project: 'outlineproj', timeout: 120,
    expect: () => ({
      jsCrumbs: 'src › app.js › Cart › total', jsSource: 'syntax',
      jsTree: 'Cart:class[constructor:constructor,add:method,total:method],checkout:function,format:function,config:constant[currency:property,round:method]',
      servicePath: ['Cart', 'total'],
      crumbsAfterEdit: 'src › app.js › Cart › total', crumbsInFunction: 'src › app.js › checkout',
      siblings: ['constructor', 'add', 'total'], siblingSelected: 'total',
      'siblingJump.line': 6, 'siblingJump.crumbs': 'src › app.js › Cart › add', 'siblingJump.menuClosed': true,
      outlineRows: ['Cart', 'constructor', 'add', 'total', 'checkout', 'format', 'config', 'currency', 'round'], outlineSource: 'syntax',
      followsCursor: 'total', followsCursorAgain: 'checkout',
      rowJump: { line: 23, col: 3, focused: true },
      filtered: ['config', 'round'], filteredNone: 'No symbols match “nothing-like-this”.',
      collapsed: ['Cart', 'checkout', 'format', 'config', 'currency', 'round'], expanded: 9, collapsedAll: ['Cart', 'checkout', 'format', 'config'],
      mdCrumbs: 'notes.md › Guide › Install › From source', mdInFence: 'notes.md › Guide › Install › From source',
      mdTree: 'Guide:heading[Install:heading[From source:heading],Usage:heading],Appendix:heading',
      mdOutline: (l) => Array.isArray(l) && l.join() === 'Guide,Install,From source,Usage,Appendix',
      pyTree: 'Greeter:class[__init__:constructor,greet:method],main:function,VERSION:constant',
      cssTree: 'body:selector,.card, .panel > h2:selector,@media (max-width: 600px):namespace[.card:selector]',
      jsonTree: 'name:string,scripts:object[build:string,test:string],tags:array',
      lspReady: true, tsCrumbs: 'shapes.ts › Circle › area', tsSource: 'lsp',
      tsTree: 'Circle:class[radius:field,constructor:constructor,area:method],scale:function,big:constant,size:constant',
      tsOutline: ['Circle|fake', 'radius|fake', 'constructor|fake', 'area|fake', 'scale|fake', 'big|fake', 'size|fake'],
      hintsOffByDefault: { drawn: 0, asked: 0 }, capability: { inlayHint: true, refreshSupport: true },
      hintsConfig: true,
      hints: ['16:18:value:', '16:22:factor:', '17:10:: number'],
      hintClasses: ['cm-inlay-hint-parameter cm-inlay-pad-right', 'cm-inlay-hint-parameter cm-inlay-pad-right', 'cm-inlay-hint-type'],
      hintTooltip: 'inferred type number', hintRange: { line: 0, character: 0 }, textUnchanged: true,
      hintsMoved: ['17:18:value:', '17:22:factor:', '18:10:: number'],
      hintsAfterEdit: ['17:18:value:', '17:22:factor:', '18:10:: number', '19:11:: number'], askedAgain: true,
      hintsAfterRefresh: ['17:18:value:', '17:22:factor:', '18:10:: int', '19:11:: int'], refreshes: 1,
      hintsAfterRestart: ['17:18:value:', '17:22:factor:', '18:10:: number', '19:11:: number'],
      hintsOff: 'none',
      breadcrumbsOff: { config: false, bars: 0 }, breadcrumbsOn: { config: true, crumbs: 'shapes.ts › Circle › area' },
    }),
  },
  {
    name: 'vscodeImport', home: 'vsih', project: null, timeout: 90,
    server: (fixtures) => vscodeEnv(fixtures)(),
    expect: () => ({
      opened: true,
      sections: ['Settings (7)', 'Color theme (1)', 'Keybindings (3)', 'Snippets (3)'],
      clashUnticked: true, otherTicked: true,
      themeDetail: /Convert it into a new theme called "Fixture Night", with faint text made easier to read/,
      snippetDetails: (l) => Array.isArray(l) && l.length === 3 && l[0] === 'global.code-snippets|1 snippet' && l[1].startsWith('javascript.json|2 snippets · saved as snippets/javascript.vscode.code-snippets') && l[2] === 'python.json|1 snippet',
      notImported: /3 settings with no Minimide equivalent: editor\.lineHeight, terminal\.integrated\.fontSize, workbench\.iconTheme .*someExtension\.doThing: no matching command .*has arguments/,
      skippedSummary: 'Not imported (3)',
      // Nothing changes until Import is pressed.
      'untouchedBefore.fontSize': true, 'untouchedBefore.keymap': true, 'untouchedBefore.noThemePackage': true, 'untouchedBefore.snippetsUntouched': true, 'untouchedBefore.stickyScrollOn': true,
      importButton: 'Import 12 items',
      'config.fontSize': 17, 'config.tabSize': 3, 'config.softTabs': false, 'config.fontFamily': '"Fira Code", Menlo, monospace', wordWrapSkipped: true, stickyScrollDisabled: true,
      'theme.installed': true, 'theme.selected': 'vscode-fixture-night',
      'themeCss.hasBackground': true, 'themeCss.hasIncludedSidebar': true, 'themeCss.readable': true,
      'keymap.keepsComments': true, 'keymap.keepsOwnKey': true, 'keymap.hasBlock': true, 'keymap.added': true, 'keymap.removedDefault': true, 'keymap.noUnknown': true,
      keymapLive: 'applied',
      'snippetFiles.ownKept': true, 'snippetFiles.beside': 'javascript', 'snippetFiles.python': true, 'snippetFiles.global': true,
      notification: /^Imported from VS Code.*theme Fixture Night.*2 keybindings.*3 snippet files.*Open config\.json$/,
      // A second import offers only what was left unticked.
      'second.labels': (l) => Array.isArray(l) && l.length === 2 && l[0] === 'settings:editor.wordWrap' && l[1].startsWith('keybindings:'),
      'second.matching': /^\d+ settings already match yours\.$/,
      'brokenKeymap.problem': /keymap\.json has a syntax error/, 'brokenKeymap.noKeybindingSection': true,
    }),
  },
  {
    name: 'settingsSync', home: 'sync1', project: null, timeout: 90,
    server: gistServer({ name: 'settingsSync', gh: 'fail' }),
    expect: () => ({
      commands: ['Sync: Download Settings', 'Sync: Set Up…', 'Sync: Sign Out', 'Sync: Upload Settings'],
      notSetUp: true,
      // The token is typed into a masked box; a rejected one is reported and nothing is stored.
      promptMasked: true, shortTokenRefused: true, readyBad: true, badTokenMessage: /GitHub didn't accept the token/, nothingStoredForBadToken: true,
      signedOut: true, 'statusAfterSignOut.hasToken': false, ready: true, 'statusAfterSetUp.hasToken': true,
      // The first upload makes one private gist; the second updates it and removes a deleted file.
      uploaded: true, gistCount: 1, private: true, description: 'Minimide settings sync', contentIdentical: true, manifest: 'minimide',
      uploadedFiles: ['config.json', 'init.js', 'keymap.json', 'minimide-sync.json', 'snippets--extra.json', 'snippets--mine.json', 'styles.css'],
      firstUpload: ['GET /gists', 'POST /gists'], authOnAll: true, headers: true, stateHasGistId: true,
      uploadedAgain: true, secondUpload: ['GET /gists/:id', 'PATCH /gists/:id'], deletedRemotely: ['snippets--extra.json'], stillOneGist: true, updatedKeymap: true, extraGone: true,
      // The token is not in any file the user can see or in anything the page can reach.
      filesScanned: true, tokenInFiles: [], secretsFileExists: true, tokenInPage: false, secretsApi: ['delete', 'has', 'set'],
      otherSecretRefused: 'refused', statusHasNoToken: true, tokenInUploadResult: false,
    }),
  },
  {
    name: 'settingsSyncOther', home: 'sync2', project: null, timeout: 90, dependsOn: 'settingsSync',
    // A gist that also holds names this version must ignore, and a package this computer lacks.
    server: gistServer({
      name: 'settingsSyncOther', gh: 'ok',
      seed: (store) => {
        const g = Object.values(store.gists)[0];
        Object.assign(g.files, {
          'evil.js': 'window.pwned = 1;\n', 'escape.json': '{}\n', 'snippets--../x.json': '{}\n',
          'packages.json': JSON.stringify({ packages: [{ source: 'someone/missing-pkg' }, { source: '../../etc/passwd' }] }),
        });
      },
    }),
    expect: () => ({
      ready: true, noTokenPrompt: true, 'status.hasToken': true,
      // Only what differs is listed; init.js is never ticked for you; names this version doesn't sync are ignored.
      previewOpened: true,
      files: (l) => Array.isArray(l) && l.length === 4 && l[0] === 'config.json|+2 −2|ticked' && l[1] === 'init.js|+1 −1|unticked'
        && l[2] === 'snippets/mine.json|new file|ticked' && /^styles\.css\|\+\d+ −\d+\|ticked$/.test(l[3]),
      initWarning: /code that runs every time Minimide starts/,
      configDiff: ['  {', '−   // computer two', '−   "editor.fontSize": 11', '+   // computer one', '+   "editor.fontSize": 15', '  }', '  '],
      stylesDiffRemovesDefault: true, 'newFile.stat': 'new file',
      missing: ['someone/missing-pkg'], ignored: 'Ignored 2 files this version doesn\'t sync: evil.js, escape.json',
      // Nothing changes until Apply.
      'untouched.config': true, 'untouched.init': true, 'untouched.mineAbsent': true, 'untouched.nothingWrittenOutside': true,
      applyLabel: 'Apply 2 files', applied: true, appliedNote: /^Settings applied2 files updated\. The old versions are in ~\/\.minimide\/backups\//, missingNote: /^1 package is missing heresomeone\/missing-pkg/,
      'after.configFromGist': true, 'after.initKept': true, 'after.stylesKept': true, 'after.newSnippets': true,
      backupCount: 1, backupConfig: true, backupHasOnlyReplaced: 'config.json',
      secondFiles: ['init.js|unticked', 'styles.css|ticked'],
      'final.init': true, 'final.styles': true, 'final.initNeedsReload': true, backupsAfterSecond: 2,
      'third.rows': 0, 'third.intro': /^This computer already has everything/, 'third.missingStill': 1,
      // Only reads, all with the CLI's token; the gist was not changed.
      requests: ['GET'], allWithCliToken: true, gistUntouched: true, tokenInFiles: [],
      signedOut: true, 'statusAfterSignOut.hasToken': false, 'stateAfterSignOut.gistId': null, downloadAfterSignOut: true,
    }),
  },
  {
    name: 'terminal', home: 'termh', project: 'rproj', timeout: 150, requires: ['python3', 'cc'],
    expect: () => ({
      runButton: true, prompt: true, python: 'Hello, Mike! 2+2=4', pyExit: true, buttonBackToPlay: true, c: 'C says 42', task: 'task-ran-ok',
      stopWorks: true, shell: 'shell-42', ctrlBPassedThrough: true, escapeKeptPanel: true, cmdPStillWorks: true,
    }),
  },
  {
    name: 'terminalSplits', home: 'termh', project: 'rproj', timeout: 150, requires: ['python3'],
    expect: () => ({
      splitMade: true, oneTab: true, focusMovesToNewSplit: true,
      outputA: true, outputB: true, outputsSeparate: true,
      nextWorks: true, prevWorks: true, wrapWorks: true,
      fitted: true, fittedAfterResize: true, dividerDragWorks: true, fittedAfterDrag: true,
      closeKeepsOther: true, otherStillLive: true, exitRemovesSplit: true, maxFour: true, tabsAfterSplits: 1,
      taskTabs: ['Task: npm run greet', 'Task: npm run slow'], taskReused: true, taskCleared: true,
      okMarker: true, failMarker: '✗ 3', cancelKeepsRunning: true, restartRestarts: true,
      notifiedWhenHidden: true, showButtonWorks: true, quietWhenVisible: true,
      stopTargetsRecentTask: true, stoppedMarker: true, runFileTab: 'Task: loop.py',
    }),
  },
  {
    name: 'debugger', home: 'dbgh', project: 'dbgproj', timeout: 150,
    expect: (env) => ({
      gutter: true, afterClick: [2], afterSecondClick: [], afterF9: [7], afterF9Again: [],
      afterInsert: [3], listAfterInsert: /app\.js:3/, afterRemove: [2], saved: JSON.stringify([{ line: 2 }]),
      untrustedNotice: true, untrustedStatus: /^Not running/,
      'node.stopped': 'Paused on breakpoint', 'node.line': 2, 'node.value': '0', 'node.stepped': 3,
      'node.evaluated': '10', 'node.ended': true, 'node.output': /total is 6[\s\S]*Program exited with code 0/, 'node.noCurrentLine': true,
      'node.frame': 'add', unverifiedAfter: false,
      // Python needs debugpy (python3 -m pip install debugpy).
      ...(env.debugpy ? {
        'python.stopped': 'Paused on breakpoint', 'python.line': 2, 'python.value': '0', 'python.stepped': 3, 'python.frame': 'add',
        'python.evaluated': '10', 'python.ended': true, 'python.output': /result is 6/, 'python.noCurrentLine': true,
      } : { python: 'skipped' }),
    }),
  },
  {
    // A fake ssh (fixtures: remote/fake-ssh) and the real rsync.
    name: 'remoteSsh', home: 'remoteh', project: null, timeout: 150, requires: ['rsync'],
    env: (fixtures) => ({ MINIMIDE_SSH_BIN: path.join(fixtures, 'remote/fake-ssh') }),
    expect: () => ({
      rejected: 'all', unreachable: /Couldn't connect to downhost: .*Connection refused/, passwordHost: 'needs login',
      opened: true, loggedIn: true, status: /SSH: pwhost/,
      'mirrored.a': 'hello from the server\n', 'mirrored.spaced': 'in a folder with a space\n', 'mirrored.quoted': 'quote in the name\n',
      'mirrored.git': false, 'mirrored.nodeModules': false,
      saveUploads: true, remoteChangePulled: true, dirtyNotOverwritten: true, conflictKeepMine: true, conflictUseTheirs: true,
      'deleteAndRename.deleted': true, 'deleteAndRename.renamed': true, 'deleteAndRename.folderRenamed': true,
      'incompleteMirror.knownDeleted': true, 'incompleteMirror.unknownKept': true, 'incompleteMirror.unknownDownloaded': true,
      'incompleteMirror.missingRedownloaded': true, 'incompleteMirror.serverKeptMissing': true,
      'trust.parentIgnored': true, 'trust.hostTrusted': true, 'trust.otherHost': true,
      terminalCommand: /-t pwhost 'cd \/.*\/remote\/server\/proj && exec "\$\{SHELL:-sh\}" -l'$/,
      'disconnectReconnect.offline': true, 'disconnectReconnect.back': true,
      'secondHost.root': true, 'secondHost.a': 'EDITED hello from the server\n', 'secondHost.lookup': 'devbox',
    }),
  },
];

// ---------------------------------------------------------------------------
// Checks

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function show(v) {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

/** Failure markers any suite can produce: THREW / ERR values, non-empty error lists, totalErrors. */
function genericFailures(result) {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (v.includes('THREW') || v.startsWith('ERR ')) out.push(`${p || '(result)'}: ${show(v)}`);
    } else if (Array.isArray(v)) {
      const key = p.split('.').pop();
      if (['errors', 'errs'].includes(key) && v.length) out.push(`${p}: ${show(v)}`);
      else v.forEach((x, i) => walk(x, p ? `${p}.${i}` : String(i)));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(result, '');
  if (typeof result?.totalErrors === 'number' && result.totalErrors > 0) out.push(`totalErrors: ${result.totalErrors}`);
  return out;
}

/** Returns { failures, known, fixed }: failing checks, failing known issues, known issues that now pass. */
function check(suite, result, env) {
  const failures = genericFailures(result);
  const known = [];
  const fixed = [];
  const knownIssues = suite.knownIssues || {};
  for (const [p, want] of Object.entries(suite.expect(env))) {
    const got = get(result, p);
    let ok;
    if (want instanceof RegExp) ok = got != null && want.test(typeof got === 'string' ? got : JSON.stringify(got));
    else if (typeof want === 'function') { try { ok = !!want(got); } catch { ok = false; } }
    else ok = JSON.stringify(got) === JSON.stringify(want);
    const message = `${p}: got ${show(got)}, want ${want instanceof RegExp ? want : typeof want === 'function' ? 'check to pass' : show(want)}`;
    if (p in knownIssues) (ok ? fixed : known).push(ok ? `${p} passes now: remove it from knownIssues` : `known issue: ${p} (${knownIssues[p]})`);
    else if (!ok) failures.push(message);
  }
  return { failures: [...new Set(failures)], known, fixed };
}

// ---------------------------------------------------------------------------
// Environment

function has(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK); return true; } catch {}
    }
  }
  return false;
}

/** Kill a process and everything it started (it was spawned as a process group leader). */
function killTree(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// ---------------------------------------------------------------------------
// Running a suite

function runSuite(suite, { electron, fixtures, env: extraEnv = {} }) {
  const script = path.join(SUITES_DIR, `${suite.name}.js`);
  const log = path.join(OUTPUT, `${suite.name}.log`);
  const png = path.join(OUTPUT, `${suite.name}.png`);
  fs.rmSync(png, { force: true });
  // The window is never shown in test mode: keep Chromium from throttling its timers and rendering.
  const args = ['.', '--mide-test', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
  // GitHub's Ubuntu runners can't use Chromium's sandbox (no SUID helper, user namespaces restricted).
  if (IS_LINUX && process.env.CI) args.push('--no-sandbox');
  if (suite.project) args.push(path.join(fixtures, suite.project));
  const env = {
    ...process.env,
    MINIMIDE_HOME: path.join(fixtures, suite.home),
    MINIMIDE_SCREENSHOT: png,
    MINIMIDE_EVAL: script,
    MINIMIDE_SCREENSHOT_DELAY: String(suite.delay ?? 2500),
    MINIMIDE_WINDOW: '1440x900',
    // Suites trust every folder unless they test workspace trust itself.
    ...(suite.trust === false ? {} : { MINIMIDE_TRUST_ALL: '1' }),
    ...suite.env?.(fixtures),
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MINIMIDE_FRAMES;
  delete env.MINIMIDE_PROJECT;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electron, args, { cwd: REPO, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, (suite.timeout ?? 120) * 1000);
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Electron may leave helpers (e.g. a stuck pty) behind; make sure the group is gone.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      fs.writeFileSync(log, output);
      const seconds = (Date.now() - started) / 1000;
      const lines = output.split(/\r?\n/);
      const evalLine = lines.find((l) => l.startsWith('[eval] '));
      const evalError = lines.find((l) => l.startsWith('[eval error]'));
      const exit = signal ? `signal ${signal}` : code ? `exit code ${code}` : null;
      const base = { seconds, log };
      if (spawnError) return resolve({ ...base, status: 'FAIL', failures: [`could not start Electron: ${spawnError.message}`] });
      if (timedOut) return resolve({ ...base, status: 'FAIL', failures: [`timed out after ${suite.timeout ?? 120}s${evalLine ? ' (after the script finished)' : ''}`] });
      if (evalError) return resolve({ ...base, status: 'FAIL', failures: [evalError] });
      if (!evalLine) return resolve({ ...base, status: 'FAIL', failures: [`no [eval] output (${exit || 'exited normally'}); see ${path.relative(REPO, log)}`] });
      let result;
      try { result = JSON.parse(evalLine.slice('[eval] '.length)); } catch (err) {
        return resolve({ ...base, status: 'FAIL', failures: [`unparseable [eval] output: ${err.message}`] });
      }
      const { failures, known, fixed } = check(suite, result, runEnv);
      // A crash after the script reported is an app problem worth seeing, but the checks still count.
      const notes = [...known, ...fixed, ...(exit ? [`app ${exit} after the script finished`] : [])];
      resolve({ ...base, status: failures.length ? 'FAIL' : 'PASS', failures, notes, result });
    });
  });
}

// ---------------------------------------------------------------------------
// Main

const runEnv = {
  has,
  // As the debugger finds it: python3 from the user's login shell.
  get debugpy() { return process.platform !== 'win32' && spawnSync(process.env.SHELL || '/bin/sh', ['-lc', 'python3 -c "import debugpy"']).status === 0; },
};

function selectSuites(names) {
  if (!names.length) return SUITES;
  const unknown = names.filter((n) => !SUITES.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`Unknown suite(s): ${unknown.join(', ')}. Available: ${SUITES.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const want = new Set(names);
  // Pull in dependencies (e.g. sessionRestore needs sessionSave to run first).
  for (const s of SUITES) if (want.has(s.name) && s.dependsOn) want.add(s.dependsOn);
  return SUITES.filter((s) => want.has(s.name));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const suites = selectSuites(argv.filter((a) => !a.startsWith('--')));

  // Linux without a display: re-run ourselves under a virtual X server when one is available.
  if (IS_LINUX && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    if (has('xvfb-run') && !process.env.MINIMIDE_TEST_XVFB) {
      const r = spawnSync('xvfb-run', ['-a', '--server-args=-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, MINIMIDE_TEST_XVFB: '1' } });
      process.exit(r.status ?? 1);
    }
    console.error('No DISPLAY: run the tests under a virtual X server, e.g. `xvfb-run -a npm test`.');
    process.exit(2);
  }

  if (!flags.has('--no-build')) {
    console.log('Building…');
    const r = spawnSync(process.execPath, ['build.mjs'], { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr + '\nBuild failed.'); process.exit(1); }
  }

  // The electron package resolves (and on first use downloads) the binary for this platform.
  const electron = createRequire(import.meta.url)('electron');
  const fixtures = createFixtures();
  fs.mkdirSync(OUTPUT, { recursive: true });
  console.log(`Fixtures: ${fixtures}\nOutput:   ${path.relative(REPO, OUTPUT)}/\n`);

  const rows = [];
  for (const suite of suites) {
    const missing = (suite.requires || []).filter((cmd) => !has(cmd));
    if (missing.length) {
      rows.push({ suite, status: 'SKIP', seconds: 0, failures: [], notes: [`${missing.join(', ')} not on PATH`] });
      console.log(`SKIP  ${suite.name}: ${missing.join(', ')} not on PATH`);
      continue;
    }
    const dep = suite.dependsOn && rows.find((r) => r.suite.name === suite.dependsOn);
    if (dep && dep.status !== 'PASS') {
      rows.push({ suite, status: 'FAIL', seconds: 0, failures: [`${suite.dependsOn} did not pass`], notes: [] });
      console.log(`FAIL  ${suite.name}: ${suite.dependsOn} did not pass`);
      continue;
    }
    process.stdout.write(`run   ${suite.name}… `);
    // A suite may need a stand-in server (e.g. the AI API); its settings reach the app as env vars.
    const server = suite.server ? await suite.server(fixtures) : null;
    const r = await runSuite(suite, { electron, fixtures, env: server?.env });
    await server?.close();
    rows.push({ suite, ...r });
    console.log(`${r.status} (${r.seconds.toFixed(1)}s)`);
    for (const f of r.failures) console.log(`        ✗ ${f}`);
    for (const n of r.notes || []) console.log(`        ! ${n}`);
  }

  const w = Math.max(...rows.map((r) => r.suite.name.length), 5);
  console.log(`\n${pad('Suite', w)}  Result  Time    Notes`);
  console.log(`${'-'.repeat(w)}  ------  ------  ${'-'.repeat(30)}`);
  for (const r of rows) {
    const notes = [...(r.failures.length ? [`${r.failures.length} failed check(s)`] : []), ...(r.notes || [])].join('; ');
    console.log(`${pad(r.suite.name, w)}  ${pad(r.status, 6)}  ${pad(r.seconds ? r.seconds.toFixed(1) + 's' : '-', 6)}  ${notes}`);
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);

  const failed = count('FAIL') > 0;
  if (failed || flags.has('--keep')) console.log(`Fixtures kept in ${fixtures}`);
  else fs.rmSync(fixtures, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
