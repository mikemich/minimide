#!/usr/bin/env node
// A tiny stand-in language server for the outline suite, so symbols and inlay hints are tested
// the same way everywhere (no typescript-language-server needed). It speaks LSP over stdio and
// understands just enough of a TypeScript-like file:
//
//   textDocument/documentSymbol  classes, their methods / constructor / fields, functions and
//                                top-level consts, as hierarchical DocumentSymbols (detail "fake")
//   textDocument/inlayHint       `name:` before each argument of a call to a function declared in
//                                the file, and `: number` after `const x = <number>` (label parts)
//   publishDiagnostics           an error on each `lsp-error` in the text, on open and on change
//
// Saving the file switches the type hints to `: int` and sends workspace/inlayHint/refresh, to
// check the client asks again. Everything it is asked is logged to the JSON file named by argv[2].
import fs from 'node:fs';

const logFile = process.argv[2];
const log = { initialize: null, inlayRequests: [], symbolRequests: 0, refreshes: 0 };
const save = () => { if (logFile) fs.writeFileSync(logFile, JSON.stringify(log, null, 2)); };
const docs = new Map(); // uri -> text
const flagged = new Set(); // uris with diagnostics published
let typeName = 'number';
let seq = 0;

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const pos = (line, character) => ({ line, character });
const range = (l1, c1, l2, c2) => ({ start: pos(l1, c1), end: pos(l2, c2) });

/** Line index of the brace that closes the block opened on line `start`. */
function blockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i;
    }
  }
  return lines.length - 1;
}

function symbols(text) {
  const lines = text.split('\n');
  const out = [];
  const sym = (name, kind, line, col, endLine, children = []) => ({
    name, kind, detail: 'fake', children,
    range: range(line, 0, endLine, lines[endLine].length),
    selectionRange: range(line, col, line, col + name.length),
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^(?:export\s+)?class\s+(\w+)/.exec(line))) {
      const end = blockEnd(lines, i);
      const members = [];
      for (let j = i + 1; j < end; j++) {
        const member = /^ {2}(\w+)\s*(\(|=)/.exec(lines[j]);
        if (!member) continue;
        const name = member[1];
        const col = lines[j].indexOf(name);
        if (member[2] === '=') members.push(sym(name, 8, j, col, j));
        else {
          const close = blockEnd(lines, j);
          members.push(sym(name, name === 'constructor' ? 9 : 6, j, col, close));
          j = close;
        }
      }
      out.push(sym(m[1], 5, i, line.indexOf(m[1]), end, members));
      i = end;
    } else if ((m = /^(?:export\s+)?function\s+(\w+)/.exec(line))) {
      const end = blockEnd(lines, i);
      out.push(sym(m[1], 12, i, line.indexOf(m[1]), end));
      i = end;
    } else if ((m = /^(?:export\s+)?const\s+(\w+)/.exec(line))) {
      out.push(sym(m[1], 14, i, line.indexOf(m[1]), i));
    }
  }
  return out;
}

function inlayHints(text, r) {
  const lines = text.split('\n');
  const params = new Map();
  for (const m of text.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)) {
    params.set(m[1], m[2].split(',').map((p) => p.trim().split(/[\s:]/)[0]).filter(Boolean));
  }
  const hints = [];
  for (let i = r.start.line; i <= Math.min(r.end.line, lines.length - 1); i++) {
    const line = lines[i];
    if (/^\s*(export\s+)?function\s/.test(line)) continue;
    const decl = /^(\s*const\s+)(\w+)\s*=\s*\d+;/.exec(line);
    if (decl) {
      hints.push({ position: pos(i, decl[1].length + decl[2].length), kind: 1, label: [{ value: ': ' }, { value: typeName, tooltip: `inferred type ${typeName}` }] });
    }
    for (const call of line.matchAll(/(\w+)\(([^()]*)\)/g)) {
      const names = params.get(call[1]);
      if (!names) continue;
      let col = call.index + call[1].length + 1;
      call[2].split(',').forEach((arg, k) => {
        const start = col + (arg.length - arg.trimStart().length);
        if (names[k] && arg.trim()) hints.push({ position: pos(i, start), kind: 2, label: `${names[k]}:`, paddingRight: true });
        col += arg.length + 1;
      });
    }
  }
  return hints;
}

function publishDiagnostics(uri) {
  const diagnostics = [];
  (docs.get(uri) || '').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/lsp-error/g)) diagnostics.push({ range: range(i, m.index, i, m.index + m[0].length), severity: 1, source: 'fake', message: 'flagged by the fake server' });
  });
  if (!diagnostics.length && !flagged.has(uri)) return; // only files that use it
  if (diagnostics.length) flagged.add(uri); else flagged.delete(uri);
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id != null && !method) return; // a response to our refresh request
  switch (method) {
    case 'initialize':
      log.initialize = { inlayHint: params.capabilities?.textDocument?.inlayHint ?? null, refreshSupport: params.capabilities?.workspace?.inlayHint?.refreshSupport ?? null };
      save();
      return send({ id, result: { capabilities: { textDocumentSync: 1, documentSymbolProvider: true, inlayHintProvider: true }, serverInfo: { name: 'fake-lsp', version: '1.0' } } });
    case 'shutdown': return send({ id, result: null });
    case 'exit': process.exit(0); return;
    case 'textDocument/didOpen': docs.set(params.textDocument.uri, params.textDocument.text); return publishDiagnostics(params.textDocument.uri);
    case 'textDocument/didChange': docs.set(params.textDocument.uri, params.contentChanges.at(-1).text); return publishDiagnostics(params.textDocument.uri);
    case 'textDocument/didClose': docs.delete(params.textDocument.uri); return;
    case 'textDocument/didSave':
      typeName = 'int';
      log.refreshes++;
      save();
      return send({ id: `refresh-${++seq}`, method: 'workspace/inlayHint/refresh', params: null });
    case 'textDocument/documentSymbol':
      log.symbolRequests++;
      save();
      return send({ id, result: symbols(docs.get(params.textDocument.uri) || '') });
    case 'textDocument/inlayHint':
      log.inlayRequests.push(params.range);
      save();
      return send({ id, result: inlayHints(docs.get(params.textDocument.uri) || '', params.range) });
  }
  if (id != null) send({ id, error: { code: -32601, message: `Unhandled method ${method}` } });
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1] || 0);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    try { handle(JSON.parse(body)); } catch (err) { process.stderr.write(`fake-lsp: ${err.stack}\n`); }
  }
});
process.stdin.on('end', () => process.exit(0));
