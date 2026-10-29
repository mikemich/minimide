// Language Server Protocol support.
//
// Servers start lazily the first time a matching file opens (one per server per
// window), and everything degrades gracefully when a server isn't installed.
import { LspClient, NOT_FOUND } from './client.js';
import { resolveServers, serverForPath, languageIdFor } from './servers.js';
import {
  toUri, fromUri, toPosition, fromPosition, offsetInText, COMPLETION_KINDS, SYMBOL_KINDS,
  renderMarkdown, markupToMarkdown,
} from './util.js';

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
const isMac = navigator.platform.toLowerCase().includes('mac');

export function activate(mide) {
  const { h, icon } = mide.ui;
  const { EditorView, hoverTooltip, showTooltip, keymap, Decoration, WidgetType } = mide.cm.view;
  const { StateField, StateEffect, Prec } = mide.cm.state;
  const { setDiagnostics, lintGutter } = mide.cm.lint;
  const { autocompletion, snippet, insertCompletionText, pickedCompletion, completeFromList } = mide.cm.autocomplete;

  let servers = resolveServers(mide.config.get('lsp.servers'));
  const clients = new Map(); // server name -> Promise<LspClient | null>
  const live = new Map(); // server name -> LspClient
  const tracked = new Map(); // Document -> entry
  const diagnostics = new Map(); // uri -> LSP Diagnostic[]
  const commandCache = new Map(); // server name -> argv | null
  const missing = new Set();
  const warnedMissing = new Set();

  // ---------------------------------------------------------------------------
  // Logging panel

  const logEl = h('div.lsp-log', { tabIndex: 0 });
  function log(server, text, kind = 'info') {
    if (!text) return;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    for (const line of String(text).split('\n')) {
      logEl.append(h(`div.lsp-log-line.${kind}`, h('span.lsp-log-server', server), line));
    }
    while (logEl.childElementCount > 3000) logEl.firstElementChild.remove();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  mide.panel.addView({ id: 'lsp-log', title: 'Language Servers', icon: 'terminal', order: 30, element: h('div.lsp-log-wrap', logEl), focus: () => logEl.focus() });

  // ---------------------------------------------------------------------------
  // Server lifecycle

  async function findCommand(server) {
    if (commandCache.has(server.name)) return commandCache.get(server.name);
    let found = null;
    for (const argv of server.command) {
      const bin = argv[0];
      const ok = bin.includes('/')
        ? !!(await mide.fs.stat(bin.replace(/^~/, mide.user.home)))
        : mide.user.platform === 'win32'
          ? (await mide.process.exec('where', [bin])).code === 0 // cmd.exe has no `command -v`
          : (await mide.process.exec(mide.user.shell || '/bin/sh', ['-lc', `command -v '${bin.replace(/'/g, '')}'`])).code === 0;
      if (ok) { found = argv.map((a, i) => (i === 0 ? a.replace(/^~/, mide.user.home) : a)); break; }
    }
    commandCache.set(server.name, found);
    return found;
  }

  function promptMissing(server) {
    missing.add(server.name);
    renderStatus();
    if (warnedMissing.has(server.name) || !mide.config.get('lsp.promptToInstall')) return;
    warnedMissing.add(server.name);
    mide.notify.info(`No ${server.displayName || server.name} language server found`, `Install it for completions, diagnostics and navigation:\n${server.install || server.command[0].join(' ')}`, {
      timeout: 12000,
      actions: [
        ...(server.install ? [{ label: 'Copy install command', run: () => mide.clipboard.write(server.install.split('   ')[0]) }] : []),
        { label: "Don't suggest again", run: () => mide.config.set('lsp.promptToInstall', false) },
      ],
    });
  }

  let disposed = false;

  function ensureClient(server) {
    if (disposed) return Promise.resolve(null);
    if (clients.has(server.name)) return clients.get(server.name);
    const promise = (async () => {
      const argv = await findCommand(server);
      if (!argv) { promptMissing(server); return null; }
      missing.delete(server.name);
      // Every trusted project folder is a workspace folder; the first one is the root.
      const folders = mide.workspace.folders.filter((f) => mide.workspace.isTrusted(f));
      const client = new LspClient(mide, server, argv, folders[0] || mide.workspace.project, {
        folders: folders.length ? folders : undefined,
        log: (text, kind) => log(server.name, text, kind),
        onNotification, onRequest, onExit,
      });
      live.set(server.name, client);
      renderStatus();
      log(server.name, `starting: ${argv.join(' ')}`);
      try {
        await client.start();
        client.ready = true;
        log(server.name, `ready${client.serverInfo ? ` (${client.serverInfo.name} ${client.serverInfo.version || ''})` : ''}`);
        setTimeout(trackAll, 0); // attach files that lost their server (e.g. after a crash)
      } catch (err) {
        log(server.name, `failed to start: ${err.message}`, 'stderr');
        // TypeScript 7 is a native rewrite without the tsserver that typescript-language-server drives.
        if (/Could not find a valid TypeScript installation/i.test(err.message)) {
          const fix = 'npm i -g typescript@5 typescript-language-server';
          mide.notify.error('TypeScript language server needs TypeScript 5', `It couldn't find a TypeScript it can use. TypeScript 7 no longer includes the tsserver it relies on. Install TypeScript 5 next to it:\n${fix}`, {
            timeout: 0,
            actions: [{ label: 'Copy Command', run: () => mide.clipboard.write(fix) }, { label: 'Show Log', run: showLog }],
          });
        } else {
          mide.notify.error(`${server.name} language server failed to start`, err.message, { actions: [{ label: 'Show Log', run: showLog }] });
        }
        client.stop();
        if (live.get(server.name) === client) live.delete(server.name);
        if (clients.get(server.name) === promise) clients.delete(server.name);
        renderStatus();
        return null;
      }
      renderStatus();
      return client;
    })();
    clients.set(server.name, promise);
    return promise;
  }

  function onExit(client, code, signal, wasStopping) {
    // Only forget this client: after a restart, a newer one for the same server may already be registered.
    if (live.get(client.name) === client) {
      live.delete(client.name);
      clients.delete(client.name);
    }
    // Its documents get re-attached when the next server for them starts; drop their stale diagnostics.
    for (const [doc, entry] of [...tracked]) {
      if (entry.client !== client) continue;
      entry.sub?.dispose();
      tracked.delete(doc);
      if (diagnostics.delete(entry.uri)) applyDiagnostics(doc);
    }
    scheduleProblems();
    log(client.name, `exited (${signal || `code ${code}`})`, wasStopping ? 'info' : 'stderr');
    renderStatus();
    if (!wasStopping && client.ready) {
      mide.notify.error(`The ${client.name} language server stopped`, signal ? `Signal ${signal}` : `Exit code ${code}`, {
        actions: [{ label: 'Restart', run: () => restartServer(client.name) }, { label: 'Show Log', run: showLog }],
      });
    }
  }

  async function stopAll() {
    const all = [...live.values()];
    live.clear();
    clients.clear();
    await Promise.all(all.map((c) => c.stop()));
  }

  async function restartServer(name) {
    const client = live.get(name);
    live.delete(name);
    clients.delete(name);
    commandCache.delete(name);
    if (client) await client.stop();
    for (const [doc, entry] of [...tracked]) if (entry.server.name === name) { entry.sub?.dispose(); tracked.delete(doc); }
    trackAll();
  }

  async function restartAll() {
    for (const entry of tracked.values()) entry.sub?.dispose();
    tracked.clear();
    commandCache.clear();
    missing.clear();
    await stopAll();
    for (const uri of [...diagnostics.keys()]) { diagnostics.delete(uri); const doc = docByPath(fromUri(uri)); if (doc) applyDiagnostics(doc); }
    renderProblems();
    trackAll();
  }

  // ---------------------------------------------------------------------------
  // Document synchronisation

  const docByPath = (path) => mide.workspace.getDocuments().find((d) => d.path === path);
  const editorForView = (view) => mide.workspace.getItems().find((i) => i.view === view);

  function entryForView(view) {
    const editor = view && editorForView(view);
    const entry = editor && tracked.get(editor.document);
    return entry?.opened ? entry : null;
  }

  function activeEntry() {
    const editor = mide.workspace.getActiveEditor();
    const entry = editor && tracked.get(editor.document);
    return entry?.opened ? { editor, entry, view: editor.view, client: entry.client, caps: entry.client.capabilities } : null;
  }

  async function track(doc) {
    if (disposed || !doc?.path || tracked.has(doc)) return;
    // Servers can run code from the project (e.g. its own TypeScript in node_modules), so they
    // only start for files in trusted folders.
    if (!mide.workspace.isTrusted(doc.path)) { renderStatus(); return; }
    const server = serverForPath(servers, doc.path);
    if (!server) return;
    const entry = { server, path: doc.path, uri: toUri(doc.path), languageId: languageIdFor(doc.path, server), version: 0, client: null, opened: false };
    entry.sub = doc.on('path', () => { untrack(doc); track(doc); });
    tracked.set(doc, entry);
    const client = await ensureClient(server);
    if (tracked.get(doc) !== entry) { renderStatus(); return; }
    // No editor shows it yet (a running server answers before the view exists): forget it, so
    // the item-added call below tracks it again and sends didOpen.
    if (!client || !doc.primaryView()) { entry.sub.dispose(); tracked.delete(doc); renderStatus(); return; }
    entry.client = client;
    entry.version = 1;
    client.notify('textDocument/didOpen', { textDocument: { uri: entry.uri, languageId: entry.languageId, version: 1, text: doc.getText() } });
    entry.opened = true;
    renderStatus();
  }

  function untrack(doc) {
    const entry = tracked.get(doc);
    if (!entry) return;
    entry.sub?.dispose();
    tracked.delete(doc);
    if (entry.opened && entry.client?.state === 'ready') entry.client.notify('textDocument/didClose', { textDocument: { uri: entry.uri } });
  }

  function trackAll() {
    for (const doc of mide.workspace.getDocuments()) track(doc);
  }

  mide.workspace.onDidOpenDocument((doc) => track(doc));
  mide.workspace.onDidCloseDocument((doc) => untrack(doc));
  mide.workspace.onDidOpenItem((item) => {
    if (item.type !== 'editor') return;
    // After the view is attached, so track() can send didOpen.
    setTimeout(() => { track(item.document); applyDiagnostics(item.document); }, 0);
  });
  mide.workspace.onDidSave((editor) => {
    const doc = editor.document;
    if (!tracked.has(doc)) { track(doc); return; }
    const entry = tracked.get(doc);
    if (!entry.opened) return;
    const save = entry.client.capabilities.textDocumentSync?.save;
    entry.client.notify('textDocument/didSave', { textDocument: { uri: entry.uri }, ...(save?.includeText ? { text: doc.getText() } : {}) });
  });

  mide.workspace.onDidUpdateEditor((editor, update) => {
    if (!update || editor.type !== 'editor') return;
    if (update.docChanged && editor.view === editor.document.primaryView()) syncChanges(editor.document, update);
    if (update.docChanged && editor.view?.hasFocus) maybeSignatureHelp(editor, update);
    if (editor === mide.workspace.getActiveEditor() && update.focusChanged) renderStatus();
  });

  function syncChanges(doc, update) {
    const entry = tracked.get(doc);
    if (!entry?.opened) return;
    const sync = entry.client.capabilities.textDocumentSync;
    const kind = typeof sync === 'number' ? sync : sync?.change ?? 1;
    if (kind === 0) return;
    let contentChanges;
    if (kind === 2) {
      contentChanges = [];
      const start = update.startState.doc;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        contentChanges.push({ range: { start: toPosition(start, fromA), end: toPosition(start, toA) }, text: inserted.toString() });
      });
      contentChanges.reverse(); // applied in order, so go from the end to keep earlier positions valid
    } else {
      contentChanges = [{ text: update.state.doc.toString() }];
    }
    entry.client.notify('textDocument/didChange', { textDocument: { uri: entry.uri, version: ++entry.version }, contentChanges });
  }

  // ---------------------------------------------------------------------------
  // Diagnostics

  function applyDiagnostics(doc) {
    if (!doc?.path) return;
    const list = diagnostics.get(toUri(doc.path)) || [];
    for (const item of doc.views) {
      const view = item.view;
      if (!view) continue;
      const converted = list.map((d) => {
        const from = fromPosition(view.state.doc, d.range.start);
        const to = Math.max(from, fromPosition(view.state.doc, d.range.end));
        return {
          from, to,
          severity: SEVERITY[d.severity || 1],
          message: d.message,
          source: [d.source, d.code?.value ?? d.code].filter((x) => x != null && x !== '').join(' ') || undefined,
        };
      });
      view.dispatch(setDiagnostics(view.state, converted));
    }
  }

  function onNotification(client, method, params) {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        // Servers encode URIs differently (%28 vs "("): key everything by our own encoding.
        const path = fromUri(params.uri);
        diagnostics.set(toUri(path), params.diagnostics || []);
        const doc = docByPath(path);
        if (doc) applyDiagnostics(doc);
        scheduleProblems();
        if (doc && doc === mide.workspace.getActiveEditor()?.document) scheduleLightbulb();
        break;
      }
      case 'window/logMessage': log(client.name, params.message, 'log'); break;
      case 'window/showMessage':
        log(client.name, params.message, 'log');
        if (params.type === 1) mide.notify.error(`${client.name}: ${params.message}`);
        else if (params.type === 2) mide.notify.warn(`${client.name}: ${params.message}`);
        break;
      case '$/progress': renderStatus(); break;
    }
  }

  async function onRequest(client, method, params) {
    switch (method) {
      case 'workspace/configuration':
        return (params.items || []).map((it) => getSection(client.server.settings, it.section));
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
        return null;
      case 'workspace/workspaceFolders':
        return client.folders.length ? client.folders.map((f) => ({ uri: toUri(f), name: mide.path.basename(f) })) : null;
      case 'workspace/applyEdit':
        try { await applyWorkspaceEdit(params.edit); return { applied: true }; } catch (err) { return { applied: false, failureReason: err.message }; }
      case 'window/showMessageRequest':
        return new Promise((resolve) => {
          const actions = (params.actions || []).map((a) => ({ label: a.title, run: () => resolve(a) }));
          mide.notify[params.type === 1 ? 'error' : params.type === 2 ? 'warn' : 'info'](`${client.name}: ${params.message}`, null, { timeout: actions.length ? 0 : undefined, actions });
          if (!actions.length) resolve(null);
          else setTimeout(() => resolve(null), 120000);
        });
      case 'window/showDocument':
        if (params.external) mide.shell.openExternal(params.uri);
        else await openLocation({ uri: params.uri, range: params.selection || { start: { line: 0, character: 0 } } });
        return { success: true };
    }
    if (method.endsWith('/refresh')) return null;
    return NOT_FOUND;
  }

  // Unconfigured sections answer {} rather than null: several servers (the vscode-*
  // family in particular) crash on null and silently stop reporting diagnostics.
  function getSection(settings, section) {
    if (!section) return settings ?? {};
    let cur = settings;
    for (const part of section.split('.')) cur = cur?.[part];
    return cur ?? {};
  }

  // ---------------------------------------------------------------------------
  // Completions: LSP when a server is attached, otherwise the language's own sources.

  async function lspCompletions(ctx, entry) {
    const { client } = entry;
    const provider = client.capabilities.completionProvider;
    const word = ctx.matchBefore(/[\w$]+$/);
    const prevChar = ctx.state.sliceDoc(ctx.pos - 1, ctx.pos);
    const isTrigger = (provider.triggerCharacters || []).includes(prevChar);
    if (!ctx.explicit && !isTrigger && !word) return null;
    const ac = new AbortController();
    ctx.addEventListener?.('abort', () => ac.abort());
    let res;
    try {
      res = await client.request('textDocument/completion', {
        textDocument: { uri: entry.uri },
        position: toPosition(ctx.state.doc, ctx.pos),
        context: isTrigger && !word ? { triggerKind: 2, triggerCharacter: prevChar } : { triggerKind: 1 },
      }, { signal: ac.signal, timeout: 8000 });
    } catch { return null; }
    if (!res || ctx.aborted) return null;
    const items = (Array.isArray(res) ? res : res.items || [])
      .slice()
      .sort((a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label));
    if (!items.length) return null;
    const n = items.length;
    const options = items.map((item, i) => {
      const labelDetail = item.labelDetails ? [item.labelDetails.detail, item.labelDetails.description].filter(Boolean).join(' ') : '';
      const shortDetail = labelDetail || (item.detail && item.detail.length <= 48 ? item.detail : undefined);
      const filter = item.filterText || item.label;
      return {
        label: filter,
        displayLabel: filter !== item.label ? item.label : undefined,
        detail: shortDetail,
        type: (COMPLETION_KINDS[item.kind] || 'text') + (item.deprecated || item.tags?.includes(1) ? ' deprecated' : ''),
        boost: -Math.floor((i * 99) / n),
        apply: makeApply(item, entry, ctx.pos, ctx.state.doc),
        info: completionInfo(item, entry),
      };
    });
    return {
      from: word ? word.from : ctx.pos,
      options,
      validFor: res.isIncomplete ? undefined : /^[\w$]*$/,
    };
  }

  function completionInfo(item, entry) {
    const render = (it) => {
      const md = [it.detail && !it.labelDetails ? '```\n' + it.detail + '\n```' : '', markupToMarkdown(it.documentation)].filter(Boolean).join('\n\n');
      if (!md.trim()) return null;
      const dom = h('div.lsp-doc');
      dom.innerHTML = renderMarkdown(md);
      return dom;
    };
    if (item.documentation || !entry.client.capabilities.completionProvider?.resolveProvider) return () => render(item);
    return async () => {
      const resolved = await resolveItem(item, entry);
      return render(resolved);
    };
  }

  async function resolveItem(item, entry) {
    if (item.__resolved) return item.__resolved;
    try { item.__resolved = (await entry.client.request('completionItem/resolve', item, { timeout: 4000 })) || item; } catch { item.__resolved = item; }
    return item.__resolved;
  }

  function makeApply(item, entry, requestPos, requestDoc) {
    return (view, completion, from, to) => {
      const edit = item.textEdit;
      const range = edit?.range || edit?.insert;
      const text = edit?.newText ?? item.insertText ?? item.label;
      const start = range ? Math.min(from, fromPosition(view.state.doc, range.start)) : from;
      // The edit may also cover text after the cursor (e.g. a closing quote): extend to its end,
      // shifted by whatever was typed since the request.
      if (range) {
        const endAtRequest = fromPosition(requestDoc, range.end);
        if (endAtRequest > requestPos) to = Math.min(view.state.doc.length, Math.max(to, endAtRequest + (to - requestPos)));
      }
      if (item.insertTextFormat === 2) snippet(mide.editor.convertSnippet(text))(view, completion, start, to);
      else view.dispatch({ ...insertCompletionText(view.state, text, start, to), annotations: pickedCompletion.of(completion) });
      // Auto-imports and similar edits, which servers often only provide after resolving.
      const extra = (edits) => { if (edits?.length && view.state) applyTextEditsToView(view, edits); };
      if (item.additionalTextEdits) extra(item.additionalTextEdits);
      else if (entry.client.capabilities.completionProvider?.resolveProvider) resolveItem(item, entry).then((r) => extra(r.additionalTextEdits));
    };
  }

  async function fallbackCompletions(ctx) {
    // The shared extra source (snippets…) has its own override slot below, so skip it here.
    const sources = ctx.state.languageDataAt('autocomplete', ctx.pos)
      .filter((s) => s !== mide.editor.extraCompletionSource)
      .map((s) => (typeof s === 'function' ? s : completeFromList(s)));
    const results = (await Promise.all(sources.map((s) => Promise.resolve(s(ctx)).catch(() => null)))).filter(Boolean);
    if (results.length <= 1) return results[0] || null;
    const from = results[0].from;
    const same = results.filter((r) => r.from === from);
    return { from, options: same.flatMap((r) => r.options), validFor: same.every((r) => r.validFor === same[0].validFor) ? same[0].validFor : undefined };
  }

  const completionSource = (ctx) => {
    const entry = entryForView(ctx.view);
    if (entry?.client.capabilities.completionProvider) return lspCompletions(ctx, entry);
    return fallbackCompletions(ctx);
  };

  mide.editor.addExtension([lintGutter(), autocompletion({ override: [completionSource, mide.editor.extraCompletionSource] })]);
  // Lets other parts of the editor (word completion) stand aside where a server already completes.
  mide.services.provide('lsp', { handles: (view) => !!entryForView(view)?.client?.capabilities?.completionProvider });

  // ---------------------------------------------------------------------------
  // Hover

  mide.editor.addExtension(hoverTooltip(async (view, pos) => {
    if (!mide.config.get('lsp.hover')) return null;
    const entry = entryForView(view);
    if (!entry?.client.capabilities.hoverProvider) return null;
    let res;
    try {
      res = await entry.client.request('textDocument/hover', { textDocument: { uri: entry.uri }, position: toPosition(view.state.doc, pos) }, { timeout: 5000 });
    } catch { return null; }
    const md = markupToMarkdown(res?.contents);
    if (!md.trim()) return null;
    const start = res.range ? fromPosition(view.state.doc, res.range.start) : pos;
    const end = res.range ? fromPosition(view.state.doc, res.range.end) : pos;
    const caps = entry.client.capabilities;
    return {
      pos: start, end, above: true,
      create: () => {
        const body = h('div.lsp-hover-body');
        body.innerHTML = renderMarkdown(md);
        const link = (label, keys, run) => h('button.lsp-hover-link', { onmousedown: (e) => e.preventDefault(), onclick: run, title: keys ? `${label} (${keys})` : label }, label);
        const shortcut = (id) => { const b = mide.keymap.bindingsFor(id)[0]; return b ? mide.keymap.pretty(b) : ''; };
        const links = [
          caps.definitionProvider && link('Go to Definition', shortcut('lsp:go-to-definition'), () => navigate('textDocument/definition', view, pos, 'Definitions')),
          caps.definitionProvider && link('Peek', shortcut('lsp:peek-definition'), () => peekDefinition(view, pos)),
          caps.referencesProvider && link('References', shortcut('lsp:find-references'), () => navigate('textDocument/references', view, pos, 'References')),
        ].filter(Boolean);
        return { dom: h('div.lsp-hover', body, links.length ? h('div.lsp-hover-links', ...links) : null) };
      },
    };
  }, { hoverTime: 350, hideOnChange: true }));

  // ---------------------------------------------------------------------------
  // Signature help

  const setSignature = StateEffect.define();
  const signatureField = StateField.define({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setSignature)) return e.value;
      if (!value) return value;
      if (tr.docChanged) return { ...value, pos: tr.changes.mapPos(value.pos) };
      if (tr.selection) {
        const head = tr.state.selection.main.head;
        if (tr.state.doc.lineAt(head).number !== tr.state.doc.lineAt(value.pos).number) return null;
      }
      return value;
    },
    provide: (f) => showTooltip.from(f),
  });
  const closeSignature = (view) => {
    if (!view.state.field(signatureField, false)) return false;
    view.dispatch({ effects: setSignature.of(null) });
    return true;
  };
  mide.editor.addExtension([signatureField, Prec.highest(keymap.of([{ key: 'Escape', run: closeSignature }]))]);

  function maybeSignatureHelp(editor, update) {
    if (!mide.config.get('lsp.signatureHelp')) return;
    const entry = tracked.get(editor.document);
    const provider = entry?.opened && entry.client.capabilities.signatureHelpProvider;
    if (!provider) return;
    let typed = '';
    update.changes.iterChanges((_a, _b, _c, _d, inserted) => { typed = inserted.toString(); });
    const ch = typed.slice(-1);
    const active = !!editor.view.state.field(signatureField, false);
    if (ch === ')' && active) return closeSignature(editor.view);
    const triggers = [...(provider.triggerCharacters || []), ...(active ? provider.retriggerCharacters || [] : [])];
    if (triggers.includes(ch) || (active && typed)) requestSignature(editor, entry, { triggerKind: 2, triggerCharacter: ch, isRetrigger: active });
  }

  async function requestSignature(editor, entry, context = { triggerKind: 1, isRetrigger: false }) {
    const view = editor.view;
    const pos = view.state.selection.main.head;
    let res;
    try {
      res = await entry.client.request('textDocument/signatureHelp', { textDocument: { uri: entry.uri }, position: toPosition(view.state.doc, pos), context }, { timeout: 4000 });
    } catch { return; }
    if (!editor.view) return;
    if (!res?.signatures?.length) { closeSignature(view); return; }
    const sig = res.signatures[res.activeSignature ?? 0] || res.signatures[0];
    const activeParam = sig.activeParameter ?? res.activeParameter ?? 0;
    const dom = renderSignature(sig, activeParam, res.signatures.length);
    view.dispatch({ effects: setSignature.of({ pos, above: true, strictSide: false, create: () => ({ dom }) }) });
  }

  function renderSignature(sig, activeParam, count) {
    const label = sig.label;
    const param = sig.parameters?.[activeParam];
    let range = null;
    if (param) {
      if (Array.isArray(param.label)) range = param.label;
      else {
        const i = label.indexOf(param.label);
        if (i >= 0) range = [i, i + param.label.length];
      }
    }
    const code = h('div.lsp-signature-label');
    if (range) code.append(label.slice(0, range[0]), h('span.lsp-param-active', label.slice(range[0], range[1])), label.slice(range[1]));
    else code.append(label);
    const dom = h('div.lsp-signature', code);
    const doc = markupToMarkdown(param?.documentation) || markupToMarkdown(sig.documentation);
    if (doc) { const d = h('div.lsp-signature-doc'); d.innerHTML = renderMarkdown(doc); dom.append(d); }
    if (count > 1) dom.prepend(h('div.lsp-signature-count', `1/${count}`));
    return dom;
  }

  // ---------------------------------------------------------------------------
  // Navigation

  const toLocations = (res) => (!res ? [] : (Array.isArray(res) ? res : [res]).map((l) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange || l.targetRange } : l)));

  async function openLocation(loc) {
    const path = fromUri(loc.uri);
    await mide.workspace.open(path, { line: loc.range.start.line + 1, col: loc.range.start.character });
  }

  async function lineText(path, line, cache) {
    const doc = docByPath(path);
    if (doc?.primaryView()) {
      const d = doc.primaryView().state.doc;
      return line < d.lines ? d.line(line + 1).text : '';
    }
    if (!cache.has(path)) cache.set(path, mide.fs.read(path).then((t) => t.split('\n')).catch(() => []));
    return (await cache.get(path))[line] || '';
  }

  async function pickLocations(locs, placeholder) {
    if (!locs.length) { mide.notify.info('No results'); return; }
    if (locs.length === 1) return openLocation(locs[0]);
    const cache = new Map();
    const items = await Promise.all(locs.map(async (loc) => {
      const path = fromUri(loc.uri);
      const text = (await lineText(path, loc.range.start.line, cache)).trim();
      return { label: text || mide.path.basename(path), detail: `${mide.workspace.relativePath(path)}:${loc.range.start.line + 1}`, loc };
    }));
    mide.ui.selectList({ id: 'lsp-locations', placeholder, items, filterKey: (i) => `${i.detail} ${i.label}`, onSelect: (i) => openLocation(i.loc) });
  }

  async function navigate(method, view, pos, placeholder) {
    const entry = entryForView(view);
    if (!entry) return mide.notify.info('No language server for this file');
    const params = { textDocument: { uri: entry.uri }, position: toPosition(view.state.doc, pos) };
    if (method === 'textDocument/references') params.context = { includeDeclaration: true };
    try {
      const res = await entry.client.request(method, params);
      await pickLocations(toLocations(res), placeholder);
    } catch (err) { mide.notify.error('Request failed', err.message); }
  }

  const headOf = (view) => view.state.selection.main.head;

  // ⌘/Ctrl-click goes to definition; Alt-click adds a cursor instead.
  mide.editor.addExtension(EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!mide.config.get('lsp.modClickGoesToDefinition') || e.button !== 0 || e.altKey || e.shiftKey) return false;
      if (!(isMac ? e.metaKey : e.ctrlKey) || !entryForView(view)) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      e.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      navigate('textDocument/definition', view, pos, 'Definitions');
      return true;
    },
  }));
  let altClick = null;
  mide.config.observe('lsp.modClickGoesToDefinition', (on) => {
    altClick?.dispose();
    altClick = on ? mide.editor.addExtension(EditorView.clickAddsSelectionRange.of((e) => e.altKey)) : null;
  });

  // ---------------------------------------------------------------------------
  // Peek definition: the definition in a small read-only editor under the line, so you can read
  // it without losing your place. Esc closes it, Enter opens the file.

  const setPeek = StateEffect.define();
  const peekField = StateField.define({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setPeek)) return e.value;
      if (!value) return value;
      if (tr.docChanged) return null;
      if (tr.selection && tr.state.doc.lineAt(tr.state.selection.main.head).number !== tr.state.doc.lineAt(value.pos).number) return null;
      return value;
    },
    provide: (f) => showTooltip.from(f),
  });
  const closePeek = (view) => {
    if (!view.state.field(peekField, false)) return false;
    view.dispatch({ effects: setPeek.of(null) });
    view.focus();
    return true;
  };
  mide.editor.addExtension([peekField, Prec.highest(keymap.of([{ key: 'Escape', run: closePeek }]))]);

  async function peekDefinition(view, pos) {
    const entry = entryForView(view);
    if (!entry) return mide.notify.info('No language server for this file');
    const doc = view.state.doc;
    let locs;
    try {
      locs = toLocations(await entry.client.request('textDocument/definition', { textDocument: { uri: entry.uri }, position: toPosition(view.state.doc, pos) }));
    } catch (err) { return mide.notify.error('Request failed', err.message); }
    if (!locs.length) return mide.notify.info('No definition found');
    if (view.state.doc !== doc || !view.dom.isConnected) return; // typed while the server answered: pos is stale
    if (view.state.selection.main.head !== pos) view.dispatch({ selection: { anchor: pos } });
    await showPeek(view, pos, locs, 0);
  }

  async function showPeek(view, pos, locs, index) {
    const doc = view.state.doc;
    const stale = () => view.state.doc !== doc || !view.dom.isConnected;
    const loc = locs[index];
    const path = fromUri(loc.uri);
    const open = docByPath(path)?.primaryView();
    const text = open ? open.state.doc.toString() : await mide.fs.read(path).catch(() => null);
    if (text == null) return mide.notify.error(`Couldn't read ${mide.path.basename(path)}`);
    if (stale()) return;
    const goThere = () => { closePeek(view); openLocation(loc); return true; };
    const body = h('div.lsp-peek-body');
    const button = (label, title, onclick) => h('button.lsp-peek-btn', { title, onclick, onmousedown: (e) => e.preventDefault() }, label);
    const dom = h('div.lsp-peek',
      h('div.lsp-peek-header',
        mide.ui.fileIcon(path),
        h('span.lsp-peek-file', mide.path.basename(path)),
        h('span.lsp-peek-where', `${mide.workspace.relativePath(mide.path.dirname(path))} · line ${loc.range.start.line + 1}`),
        h('span.lsp-peek-spacer'),
        locs.length > 1 ? button(`${index + 1} of ${locs.length}`, 'Next definition', () => showPeek(view, pos, locs, (index + 1) % locs.length)) : null,
        button('Open', 'Open the file (Enter)', goThere),
        button('✕', 'Close (Esc)', () => closePeek(view))),
      body);
    const preview = await mide.editor.createPreview({
      text, path, line: loc.range.start.line + 1, parent: body,
      extensions: Prec.highest(keymap.of([{ key: 'Escape', run: () => closePeek(view) }, { key: 'Enter', run: goThere }])),
    });
    if (stale()) { preview.destroy(); return; }
    view.dispatch({
      effects: setPeek.of({
        pos, above: false, strictSide: true, arrow: false,
        create: () => ({
          dom,
          mount: () => {
            preview.dispatch({ effects: EditorView.scrollIntoView(preview.state.selection.main.head, { y: 'start', yMargin: 24 }) });
            preview.focus();
          },
          destroy: () => preview.destroy(),
        }),
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // Symbols across the project, from every running server that can search them.

  function workspaceSymbolMode() {
    const searchable = () => [...live.values()].filter((c) => c.state === 'ready' && c.capabilities.workspaceSymbolProvider);
    let asked = null;
    let results = [];
    let timer = null;
    let seq = 0;
    async function search(query, list) {
      const mine = ++seq;
      const answers = await Promise.all(searchable().map((c) => c.request('workspace/symbol', { query }, { timeout: 5000 }).catch(() => null)));
      if (mine !== seq) return;
      results = answers.flat().filter((s) => s?.location?.uri).slice(0, 300).map((s) => {
        const range = s.location.range || { start: { line: 0, character: 0 } };
        const path = fromUri(s.location.uri);
        return {
          label: s.name,
          detail: `${mide.workspace.relativePath(path)}:${range.start.line + 1}`,
          hint: [SYMBOL_KINDS[s.kind], s.containerName].filter(Boolean).join(' · '),
          loc: { uri: s.location.uri, range },
        };
      });
      list.refresh();
    }
    return {
      prefix: '#', title: 'Project symbols', short: 'project symbols', order: 30,
      description: 'Functions, classes and more across the project (needs a language server)',
      items: () => { asked = null; results = []; return []; },
      emptyMessage: () => (searchable().length ? 'Type a name to search' : 'No running language server can search this project. Open a source file first.'),
      // The servers do the matching, so show what they return as is.
      onQuery: (q, list) => {
        if (q !== asked) { asked = q; clearTimeout(timer); if (searchable().length) timer = setTimeout(() => search(q, list), 120); }
        return results;
      },
      onSelect: (i) => openLocation(i.loc),
    };
  }
  mide.ui.addQuickOpenMode(workspaceSymbolMode());

  // ---------------------------------------------------------------------------
  // A lightbulb at the end of the line when the server has a quick fix for a problem on it.

  class LightbulbWidget extends WidgetType {
    eq() { return true; }
    toDOM() {
      const keys = mide.keymap.bindingsFor('lsp:code-actions')[0];
      const bulb = h('span.lsp-lightbulb', {
        title: `Quick fix${keys ? ` (${mide.keymap.pretty(keys)})` : ''}`,
        onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); codeActions(); },
      });
      bulb.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
      return bulb;
    }
    ignoreEvent() { return true; }
  }
  const setBulb = StateEffect.define();
  const bulbField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      for (const e of tr.effects) if (e.is(setBulb)) return e.value;
      if (!deco.size) return deco;
      if (tr.docChanged) return Decoration.none; // asked again once typing pauses
      if (tr.selection && !onBulbLine(tr, deco)) return Decoration.none;
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  // Moving along the bulb's own line keeps it.
  function onBulbLine(tr, deco) {
    let at = -1;
    deco.between(0, tr.state.doc.length, (from) => { at = from; });
    return at >= 0 && tr.state.doc.lineAt(at).number === tr.state.doc.lineAt(tr.state.selection.main.head).number;
  }
  mide.editor.addExtension(bulbField);

  let bulbTimer = null;
  let bulbSeq = 0;
  function scheduleLightbulb() {
    clearTimeout(bulbTimer);
    bulbTimer = setTimeout(updateLightbulb, 300);
  }
  async function updateLightbulb() {
    const mine = ++bulbSeq;
    const a = activeEntry();
    if (!a || !mide.config.get('lsp.lightbulb') || !a.caps.codeActionProvider) return;
    const { view, entry } = a;
    const doc = view.state.doc;
    const line = doc.lineAt(view.state.selection.main.head);
    const n = line.number - 1;
    const onLine = (diagnostics.get(entry.uri) || []).filter((d) => d.range.start.line <= n && d.range.end.line >= n);
    const clear = () => { if (view.state.field(bulbField).size) view.dispatch({ effects: setBulb.of(Decoration.none) }); };
    if (!onLine.length) return clear();
    let actions;
    try {
      actions = await entry.client.request('textDocument/codeAction', {
        textDocument: { uri: entry.uri },
        range: { start: { line: n, character: 0 }, end: { line: n, character: line.length } },
        context: { diagnostics: onLine, triggerKind: 2 },
      }, { timeout: 3000 });
    } catch { return; }
    if (mine !== bulbSeq || !view.dom.isConnected || view.state.doc !== doc) return;
    const fixes = (actions || []).filter((x) => !x.disabled && (!x.kind || x.kind.startsWith('quickfix') || x.isPreferred));
    if (!fixes.length) return clear();
    view.dispatch({ effects: setBulb.of(Decoration.set([Decoration.widget({ widget: new LightbulbWidget(), side: 1 }).range(line.to)])) });
  }
  mide.workspace.onDidUpdateEditor((editor, update) => {
    if (update && (update.selectionSet || update.docChanged) && editor === mide.workspace.getActiveEditor()) scheduleLightbulb();
  });

  // ---------------------------------------------------------------------------
  // Edits

  function applyTextEditsToView(view, edits) {
    const doc = view.state.doc;
    const changes = edits
      .map((e) => ({ from: fromPosition(doc, e.range.start), to: fromPosition(doc, e.range.end), insert: e.newText }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
    view.dispatch({ changes, userEvent: 'lsp.edit' });
  }

  function applyTextEditsToText(text, edits) {
    // Apply from the end; edits at the same spot keep their array order (later ones applied first).
    const resolved = edits.map((e, i) => ({ i, from: offsetInText(text, e.range.start), to: offsetInText(text, e.range.end), text: e.newText }))
      .sort((a, b) => b.from - a.from || b.to - a.to || b.i - a.i);
    for (const e of resolved) text = text.slice(0, e.from) + e.text + text.slice(e.to);
    return text;
  }

  async function applyWorkspaceEdit(edit) {
    const steps = [];
    if (edit.documentChanges) {
      for (const dc of edit.documentChanges) steps.push(dc.kind ? dc : { kind: 'edit', uri: dc.textDocument.uri, edits: dc.edits });
    } else {
      for (const [uri, edits] of Object.entries(edit.changes || {})) steps.push({ kind: 'edit', uri, edits });
    }
    const touched = new Set();
    for (const step of steps) {
      if (step.kind === 'edit') {
        const path = fromUri(step.uri);
        const doc = docByPath(path);
        if (doc?.primaryView()) applyTextEditsToView(doc.primaryView(), step.edits);
        else await mide.fs.write(path, applyTextEditsToText(await mide.fs.read(path), step.edits));
        touched.add(path);
      } else if (step.kind === 'create') {
        const path = fromUri(step.uri);
        if (!(await mide.fs.stat(path)) || step.options?.overwrite) await mide.fs.write(path, '');
        touched.add(path);
      } else if (step.kind === 'rename') {
        const from = fromUri(step.oldUri);
        const to = fromUri(step.newUri);
        await mide.fs.rename(from, to);
        mide.workspace.renamePath(from, to);
        touched.add(to);
      } else if (step.kind === 'delete') {
        await mide.fs.trash(fromUri(step.uri));
      }
    }
    return touched.size;
  }

  async function formatDocument(editor, { quiet = false } = {}) {
    const entry = tracked.get(editor.document);
    if (!entry?.opened || !entry.client.capabilities.documentFormattingProvider) {
      if (!quiet) mide.notify.info('Formatting is not available for this file');
      return;
    }
    const version = entry.version;
    const edits = await entry.client.request('textDocument/formatting', {
      textDocument: { uri: entry.uri },
      options: { tabSize: mide.config.get('editor.tabSize'), insertSpaces: mide.config.get('editor.softTabs'), trimTrailingWhitespace: true, insertFinalNewline: true },
    }, { timeout: 5000 });
    if (entry.version !== version) return; // the file changed while formatting: edits would land in the wrong place
    if (edits?.length && editor.view) applyTextEditsToView(editor.view, edits);
  }

  mide.workspace.onWillSave(async (editor) => {
    if (!mide.config.get('lsp.formatOnSave')) return;
    try { await formatDocument(editor, { quiet: true }); } catch (err) { log(tracked.get(editor.document)?.server.name || 'lsp', `format on save failed: ${err.message}`, 'stderr'); }
  });

  async function rename() {
    const a = activeEntry();
    if (!a) return;
    const { view, entry, caps } = a;
    const pos = headOf(view);
    const position = toPosition(view.state.doc, pos);
    const word = view.state.wordAt(pos);
    let placeholder = word ? view.state.sliceDoc(word.from, word.to) : '';
    if (caps.renameProvider?.prepareProvider) {
      let r;
      try { r = await entry.client.request('textDocument/prepareRename', { textDocument: { uri: entry.uri }, position }); } catch (err) { return mide.notify.warn('Cannot rename here', err.message); }
      if (!r) return mide.notify.info('Nothing to rename here');
      if (r.placeholder) placeholder = r.placeholder;
      else if (r.start || r.range) {
        const range = r.range || r;
        placeholder = view.state.sliceDoc(fromPosition(view.state.doc, range.start), fromPosition(view.state.doc, range.end));
      }
    }
    const newName = await mide.ui.prompt({ title: `Rename "${placeholder}" to:`, value: placeholder });
    if (!newName || newName === placeholder) return;
    try {
      const edit = await entry.client.request('textDocument/rename', { textDocument: { uri: entry.uri }, position, newName });
      if (!edit) return mide.notify.info('The server returned no changes');
      const files = await applyWorkspaceEdit(edit);
      mide.notify.success(`Renamed to "${newName}"`, `${files} file${files === 1 ? '' : 's'} changed`);
    } catch (err) { mide.notify.error('Rename failed', err.message); }
  }

  async function codeActions() {
    const a = activeEntry();
    if (!a) return;
    const { view, entry, caps } = a;
    if (!caps.codeActionProvider) return mide.notify.info('Code actions are not available for this file');
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const range = { start: toPosition(doc, sel.from), end: toPosition(doc, sel.to) };
    const line = range.start.line;
    const context = (diagnostics.get(entry.uri) || []).filter((d) => d.range.start.line <= range.end.line && d.range.end.line >= line);
    let actions;
    try {
      actions = await entry.client.request('textDocument/codeAction', { textDocument: { uri: entry.uri }, range, context: { diagnostics: context, triggerKind: 1 } });
    } catch (err) { return mide.notify.error('Code actions failed', err.message); }
    actions = (actions || []).filter((x) => !x.disabled);
    if (!actions.length) return mide.notify.info('No code actions available here');
    actions.sort((x, y) => (y.isPreferred ? 1 : 0) - (x.isPreferred ? 1 : 0));
    mide.ui.selectList({
      id: 'lsp-code-actions',
      placeholder: 'Code actions',
      items: actions.map((action) => ({ label: action.title, detail: action.kind || (typeof action.command === 'string' ? 'command' : ''), hint: action.isPreferred ? 'preferred' : null, action })),
      onSelect: async ({ action }) => {
        try {
          if (typeof action.command === 'string') {
            await entry.client.request('workspace/executeCommand', { command: action.command, arguments: action.arguments });
            return;
          }
          let resolved = action;
          if (!resolved.edit && caps.codeActionProvider?.resolveProvider) resolved = (await entry.client.request('codeAction/resolve', action)) || action;
          if (resolved.edit) await applyWorkspaceEdit(resolved.edit);
          if (resolved.command) await entry.client.request('workspace/executeCommand', { command: resolved.command.command, arguments: resolved.command.arguments });
        } catch (err) { mide.notify.error('Code action failed', err.message); }
      },
    });
  }

  // "@" in the quick-open box: symbols in the current file, in file order.
  mide.ui.addQuickOpenMode({
    prefix: '@', title: 'Symbols in file', short: 'symbols', order: 20,
    description: 'Functions, classes and more in this file (needs a language server)',
    emptyMessage: () => (activeEntry()?.caps.documentSymbolProvider ? 'No symbols found' : 'No language server for this file'),
    items: async () => {
      const a = activeEntry();
      if (!a?.caps.documentSymbolProvider) return [];
      const { editor, entry } = a;
      const res = await entry.client.request('textDocument/documentSymbol', { textDocument: { uri: entry.uri } }).catch(() => null);
      const symbols = [];
      const walk = (list, container) => {
        for (const s of list || []) {
          if (s.location) symbols.push({ name: s.name, kind: s.kind, container: s.containerName, range: s.location.range });
          else {
            symbols.push({ name: s.name, kind: s.kind, container, range: s.selectionRange || s.range, detail: s.detail });
            walk(s.children, container ? `${container}.${s.name}` : s.name);
          }
        }
      };
      walk(res);
      symbols.sort((x, y) => x.range.start.line - y.range.start.line);
      return symbols.map((sym) => ({
        label: sym.name,
        detail: [SYMBOL_KINDS[sym.kind], sym.container].filter(Boolean).join(' · '),
        hint: `${sym.range.start.line + 1}`,
        sym, editor,
      }));
    },
    onSelect: ({ sym, editor }) => editor.goToLine(sym.range.start.line + 1, sym.range.start.character),
  });

  // ---------------------------------------------------------------------------
  // Problems panel + status bar

  const problemsList = h('div.lsp-problems');
  mide.panel.addView({ id: 'problems', title: 'Problems', icon: 'search', order: 5, command: 'lsp:toggle-problems', element: h('div.lsp-problems-wrap', problemsList) });

  let problemsTimer = null;
  function scheduleProblems() { clearTimeout(problemsTimer); problemsTimer = setTimeout(renderProblems, 150); }

  function renderProblems() {
    const files = [...diagnostics].filter(([, list]) => list.length)
      .map(([uri, list]) => ({ path: fromUri(uri), list: [...list].sort((a, b) => (a.severity || 1) - (b.severity || 1) || a.range.start.line - b.range.start.line) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!files.length) problemsList.replaceChildren(h('div.lsp-problems-empty', 'No problems detected.'));
    else {
      problemsList.replaceChildren(...files.map(({ path, list }) => h('div.lsp-problem-file',
        h('div.lsp-problem-file-header', mide.ui.fileIcon(path), h('span.lsp-problem-file-name', mide.path.basename(path)),
          h('span.lsp-problem-file-dir', mide.workspace.relativePath(mide.path.dirname(path))), h('span.lsp-problem-count', String(list.length))),
        ...list.map((d) => h('div.lsp-problem', {
          tabIndex: 0,
          onclick: () => openLocation({ uri: toUri(path), range: d.range }),
          onkeydown: (e) => { if (e.key === 'Enter') openLocation({ uri: toUri(path), range: d.range }); },
        }, h(`span.lsp-sev.${SEVERITY[d.severity || 1]}`), h('span.lsp-problem-msg', d.message.split('\n')[0]),
          d.source ? h('span.lsp-problem-src', d.source) : null,
          h('span.lsp-problem-pos', `${d.range.start.line + 1}:${d.range.start.character + 1}`))))));
    }
    let errors = 0;
    let warnings = 0;
    for (const list of diagnostics.values()) for (const d of list) { if ((d.severity || 1) === 1) errors++; else if (d.severity === 2) warnings++; }
    countsEl.replaceChildren(h('span.lsp-count.error', h('span.lsp-sev.error'), String(errors)), h('span.lsp-count.warning', h('span.lsp-sev.warning'), String(warnings)));
  }

  const countsEl = h('span.lsp-counts');
  mide.statusBar.addItem({ id: 'lsp-problems', element: countsEl, align: 'left', priority: 15, tooltip: 'Problems', command: 'lsp:toggle-problems', onClick: () => mide.panel.toggle('problems') });

  const statusEl = h('span.lsp-status');
  mide.statusBar.addItem({ id: 'lsp-status', element: statusEl, align: 'right', priority: 45, tooltip: 'Language server', onClick: () => serverMenu() });

  function renderStatus() {
    const editor = mide.workspace.getActiveEditor();
    const path = editor?.getPath();
    const server = path && serverForPath(servers, path);
    if (!server) { statusEl.replaceChildren(); return; }
    const client = live.get(server.name);
    let state = 'off';
    const label = server.displayName || server.name;
    let text = label;
    if (!mide.workspace.isTrusted(path)) { state = 'off'; text = `${label} (restricted)`; }
    else if (missing.has(server.name)) { state = 'missing'; text = `${label} (no server)`; }
    else if (client?.state === 'starting') { state = 'starting'; text = `${label} starting…`; }
    else if (client?.state === 'ready') {
      state = 'ready';
      text = 'LSP'; // the language name already sits next to it
      const progress = [...client.progress.values()].pop();
      if (progress) { state = 'busy'; text = `${label}: ${progress}`; }
    }
    statusEl.dataset.state = state;
    statusEl.title = client?.serverInfo ? `${client.serverInfo.name} ${client.serverInfo.version || ''}`.trim() : client ? client.argv.join(' ') : '';
    statusEl.replaceChildren(h('span.lsp-status-dot'), h('span.lsp-status-text', text));
  }
  mide.workspace.onDidChangeActiveItem(() => renderStatus());

  function serverMenu() {
    const editor = mide.workspace.getActiveEditor();
    const server = editor?.getPath() && serverForPath(servers, editor.getPath());
    const items = [];
    if (server && missing.has(server.name)) items.push({ label: `Copy install command for ${server.name}`, detail: server.install, run: () => mide.clipboard.write((server.install || '').split('   ')[0]) });
    if (server) items.push({ label: `Restart ${server.name} server`, run: () => restartServer(server.name) });
    items.push({ label: 'Restart all language servers', run: restartAll });
    items.push({ label: 'Show language server log', run: showLog });
    items.push({ label: 'Configure servers…', detail: 'lsp.servers in config.json', run: () => mide.commands.run('settings:open-config-file') });
    mide.ui.selectList({ id: 'lsp-menu', placeholder: 'Language servers', items, onSelect: (i) => i.run() });
  }

  function showLog() { mide.panel.show('lsp-log'); logEl.scrollTop = logEl.scrollHeight; }

  // ---------------------------------------------------------------------------
  // Commands

  const has = (cap) => () => { const a = activeEntry(); return !!a && (!cap || !!a.caps[cap]); };
  const editorFocused = () => !!activeEntry()?.view.contentDOM.contains(document.activeElement); // not a peek preview

  mide.commands.add({
    'lsp:go-to-definition': { title: 'Go to Definition', when: has('definitionProvider'), run: () => { const { view } = activeEntry(); navigate('textDocument/definition', view, headOf(view), 'Definitions'); } },
    'lsp:go-to-type-definition': { title: 'Go to Type Definition', when: has('typeDefinitionProvider'), run: () => { const { view } = activeEntry(); navigate('textDocument/typeDefinition', view, headOf(view), 'Type definitions'); } },
    'lsp:go-to-implementation': { title: 'Go to Implementation', when: has('implementationProvider'), run: () => { const { view } = activeEntry(); navigate('textDocument/implementation', view, headOf(view), 'Implementations'); } },
    'lsp:find-references': { title: 'Find References', when: has('referencesProvider'), run: () => { const { view } = activeEntry(); navigate('textDocument/references', view, headOf(view), 'References'); } },
    'lsp:rename': { title: 'Rename Symbol', when: () => has('renameProvider')() && editorFocused(), run: rename },
    'lsp:format-document': { title: 'Format Document', when: has('documentFormattingProvider'), run: () => formatDocument(mide.workspace.getActiveEditor()).catch((err) => mide.notify.error('Format failed', err.message)) },
    'lsp:go-to-symbol': { title: 'Go to Symbol in File', when: has('documentSymbolProvider'), run: () => mide.ui.quickOpen('@') },
    'lsp:go-to-workspace-symbol': { title: 'Go to Symbol in Project', run: () => mide.ui.quickOpen('#') },
    'lsp:peek-definition': { title: 'Peek Definition', when: has('definitionProvider'), run: () => { const { view } = activeEntry(); peekDefinition(view, headOf(view)); } },
    'lsp:code-actions': { title: 'Code Actions / Quick Fix', when: has('codeActionProvider'), run: codeActions },
    'lsp:signature-help': { title: 'Show Signature Help', when: has('signatureHelpProvider'), run: () => { const { editor, entry } = activeEntry(); requestSignature(editor, entry); } },
    'lsp:toggle-problems': { title: 'Toggle Problems Panel', run: () => mide.panel.toggle('problems') },
    'lsp:show-log': { title: 'Show Server Log', run: showLog },
    'lsp:restart-servers': { title: 'Restart Language Servers', run: restartAll },
    'lsp:server-menu': { title: 'Language Server Status…', run: serverMenu },
  });

  // ---------------------------------------------------------------------------
  // Wiring

  mide.config.onDidChange('lsp.servers', (value) => { servers = resolveServers(value); restartAll(); });
  mide.workspace.onDidChangeFolders(() => restartAll());
  mide.workspace.onDidChangeTrust(() => restartAll());
  mide.subscriptions.add({
    dispose: () => {
      disposed = true;
      clearTimeout(problemsTimer);
      clearTimeout(bulbTimer);
      for (const entry of tracked.values()) entry.sub?.dispose();
      tracked.clear();
      stopAll();
      for (const doc of mide.workspace.getDocuments()) {
        for (const item of doc.views) if (item.view) item.view.dispatch(setDiagnostics(item.view.state, []));
      }
    },
  });

  renderProblems();
  renderStatus();
  trackAll();
}
