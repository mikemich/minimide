// A minimal JSON-RPC / LSP client on top of mide.process.spawnRpc.

export class LspClient {
  constructor(mide, server, argv, root, { log, onNotification, onRequest, onExit }) {
    Object.assign(this, { mide, server, argv, root, log, onNotification, onRequest, onExitCb: onExit });
    this.name = server.name;
    this.seq = 0;
    this.pending = new Map();
    this.state = 'stopped';
    this.capabilities = {};
    this.progress = new Map(); // token -> title
  }

  async start() {
    this.state = 'starting';
    this.proc = this.mide.process.spawnRpc(this.argv, {
      cwd: this.root,
      onMessage: (msg) => this.handle(msg),
      onStderr: (text) => this.log(text.trimEnd(), 'stderr'),
      onExit: (code, signal) => this.exited(code, signal),
    });
    const rootUri = this.root ? 'file://' + this.root.split('/').map(encodeURIComponent).join('/') : null;
    const result = await this.request('initialize', {
      processId: null,
      clientInfo: { name: 'Minimide', version: this.mide.version },
      rootPath: this.root,
      rootUri,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: this.root.split('/').pop() }] : null,
      initializationOptions: this.server.initializationOptions,
      capabilities: CLIENT_CAPABILITIES,
    }, { timeout: 60000 });
    this.capabilities = result?.capabilities || {};
    this.serverInfo = result?.serverInfo;
    this.notify('initialized', {});
    if (this.server.settings) this.notify('workspace/didChangeConfiguration', { settings: this.server.settings });
    this.state = 'ready';
    return this;
  }

  request(method, params, { timeout = 15000, signal } = {}) {
    const id = ++this.seq;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.trace('→', msg);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        this.notify('$/cancelRequest', { id });
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      });
      this.proc.send(msg);
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    this.trace('→', msg);
    this.proc?.send(msg);
  }

  async handle(msg) {
    this.trace('←', msg);
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null) {
      let response;
      try {
        const result = await this.onRequest(this, msg.method, msg.params);
        response = result === NOT_FOUND
          ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unhandled method ${msg.method}` } }
          : { jsonrpc: '2.0', id: msg.id, result: result ?? null };
      } catch (err) {
        response = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } };
      }
      this.trace('→', response);
      this.proc.send(response);
      return;
    }
    if (msg.method === '$/progress') return this.onProgress(msg.params);
    this.onNotification(this, msg.method, msg.params);
  }

  onProgress({ token, value }) {
    if (!value) return;
    if (value.kind === 'begin') this.progress.set(token, value.title + (value.message ? ` ${value.message}` : ''));
    else if (value.kind === 'report' && this.progress.has(token)) {
      const title = this.progress.get(token).split(' — ')[0];
      this.progress.set(token, value.message ? `${title} — ${value.message}` : title);
    } else if (value.kind === 'end') this.progress.delete(token);
    this.onNotification(this, '$/progress', null);
  }

  trace(dir, msg) {
    if (this.mide.config.get('lsp.trace')) this.log(`${dir} ${JSON.stringify(msg).slice(0, 2000)}`, 'trace');
  }

  async stop() {
    if (this.state === 'stopped') return;
    this.stopping = true;
    try {
      if (this.state === 'ready') await this.request('shutdown', null, { timeout: 1500 });
      this.notify('exit', null);
    } catch {}
    setTimeout(() => this.proc?.kill(), 500);
  }

  exited(code, signal) {
    const wasStopping = this.stopping;
    this.state = 'stopped';
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Server exited')); }
    this.pending.clear();
    this.onExitCb(this, code, signal, wasStopping);
  }
}

export const NOT_FOUND = Symbol('not-found');

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: false } } },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    symbol: { dynamicRegistration: false },
    executeCommand: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        labelDetailsSupport: true,
        insertReplaceSupport: false,
        deprecatedSupport: true,
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
      contextSupport: true,
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } },
      resolveSupport: { properties: ['edit'] },
      isPreferredSupport: true,
    },
    publishDiagnostics: { relatedInformation: false, versionSupport: false, codeDescriptionSupport: true },
  },
};
