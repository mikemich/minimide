// A small Debug Adapter Protocol server for Node.js programs. It speaks DAP on stdin/stdout and
// the Chrome DevTools Protocol to `node --inspect-brk`, so debugging JavaScript needs nothing
// but Node itself (22 or newer, for the built-in WebSocket). Minimide copies this file to a
// private temp folder and runs it with the `node` on your PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let seq = 0;
function send(msg) {
  const json = JSON.stringify({ seq: ++seq, ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
const event = (name, body = {}) => send({ type: 'event', event: name, body });
const output = (text, category = 'console') => event('output', { category, output: text });

// --- DAP input ---------------------------------------------------------------
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const end = input.indexOf('\r\n\r\n');
    if (end < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(input.subarray(0, end).toString('ascii'));
    if (!m) { input = input.subarray(end + 4); continue; }
    const length = Number(m[1]);
    if (input.length < end + 4 + length) return;
    const body = input.subarray(end + 4, end + 4 + length).toString('utf8');
    input = input.subarray(end + 4 + length);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.type === 'request') handle(msg);
  }
});
process.stdin.on('end', () => quit());

async function handle(req) {
  const fn = handlers[req.command];
  try {
    if (!fn) throw new Error(`Unsupported request: ${req.command}`);
    const body = await fn(req.arguments || {});
    send({ type: 'response', request_seq: req.seq, command: req.command, success: true, body: body || {} });
  } catch (err) {
    send({ type: 'response', request_seq: req.seq, command: req.command, success: false, message: err.message });
  }
  if (req.command === 'disconnect' || req.command === 'terminate') quit();
}

function quit() {
  killChild();
  process.stdout.write('', () => process.exit(0));
}

// --- CDP connection ----------------------------------------------------------
let ws = null;
let cdpSeq = 0;
const cdpPending = new Map();
const cdpHandlers = {};

function cdp(method, params = {}) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error('The program is not running.'));
  const id = ++cdpSeq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => cdpPending.set(id, { resolve, reject }));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`Couldn't connect to the Node inspector at ${url}`)));
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id != null) {
        const p = cdpPending.get(msg.id);
        cdpPending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result);
      } else cdpHandlers[msg.method]?.(msg.params);
    });
    ws.addEventListener('close', () => {
      for (const p of cdpPending.values()) p.reject(new Error('The program has ended.'));
      cdpPending.clear();
    });
  });
}

// --- the program ---------------------------------------------------------------
let child = null;
let childExited = false;
let launchArgs = {};
let cwdReal = null;

function killChild() {
  if (!child || childExited) return;
  child.kill('SIGTERM');
  const c = child;
  setTimeout(() => { if (c.exitCode == null && c.signalCode == null) c.kill('SIGKILL'); }, 1500).unref();
}

// Lines Node prints about the inspector itself, not the program's output.
const INSPECTOR_NOISE = /^(Debugger listening on |For help, see: https:\/\/nodejs\.org|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.|Debugger ending on )/;

function launch(args) {
  launchArgs = args;
  if (typeof WebSocket === 'undefined') {
    throw new Error(`Debugging JavaScript needs Node.js 22 or newer (this is ${process.version}).`);
  }
  const program = path.resolve(args.cwd || process.cwd(), args.program);
  try { cwdReal = fs.realpathSync(args.cwd || path.dirname(program)); } catch {}
  remember(program);
  const runtime = args.runtimeExecutable || process.execPath;
  return new Promise((resolve, reject) => {
    child = spawn(runtime, [...(args.runtimeArgs || []), '--inspect-brk=127.0.0.1:0', program, ...(args.args || [])], {
      cwd: args.cwd || path.dirname(program),
      env: { ...process.env, ...args.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let connected = false;
    let stderrLine = '';
    const timer = setTimeout(() => { if (!connected) reject(new Error('Node did not start its inspector in time.')); }, 15000);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Couldn't start ${runtime}: ${err.message}`)); });
    child.stdout.on('data', (d) => output(d.toString(), 'stdout'));
    child.stderr.on('data', (d) => {
      stderrLine += d.toString();
      const lines = stderrLine.split('\n');
      stderrLine = lines.pop();
      const shown = [];
      for (const line of lines) {
        const url = !connected && /Debugger listening on (ws:\/\/\S+)/.exec(line)?.[1];
        if (url) {
          connected = true;
          clearTimeout(timer);
          attach(url).then(resolve, reject);
        }
        // Node waits for us once the program is done; let go so it can exit.
        if (/^Waiting for the debugger to disconnect/.test(line)) ws?.close();
        if (!INSPECTOR_NOISE.test(line)) shown.push(line + '\n');
      }
      if (shown.length) output(shown.join(''), 'stderr');
    });
    child.on('exit', (code, signal) => {
      childExited = true;
      clearTimeout(timer);
      if (stderrLine && !INSPECTOR_NOISE.test(stderrLine)) output(stderrLine, 'stderr');
      ws?.close();
      if (!connected) reject(new Error(`Node exited before the debugger could attach (code ${code ?? signal}).`));
      event('exited', { exitCode: code ?? (signal ? 128 : 1) });
      event('terminated');
    });
  });
}

async function attach(url) {
  await connect(url);
  await cdp('Runtime.enable');
  await cdp('Debugger.enable');
  // Stepping skips Node's own internals.
  await cdp('Debugger.setBlackboxPatterns', { patterns: ['^node:'] }).catch(() => {});
  event('initialized');
}

// --- paths ---------------------------------------------------------------------
// Node reports real paths (symlinks resolved, file:// URLs for ES modules); the editor knows
// files by the path it opened them with.
const realToClient = new Map();
function remember(p) {
  try { const real = fs.realpathSync(p); if (real !== p) realToClient.set(real, p); } catch {}
}
function clientPath(url) {
  let p = url.startsWith('file://') ? fileURLToPath(url) : url.startsWith('/') || /^[A-Za-z]:\\/.test(url) ? url : null;
  if (!p) return null;
  if (realToClient.has(p)) return realToClient.get(p);
  const cwd = launchArgs.cwd;
  if (cwdReal && cwd && cwdReal !== cwd && p.startsWith(cwdReal + path.sep)) return cwd + p.slice(cwdReal.length);
  return p;
}
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
function urlRegexFor(p) {
  const forms = new Set([p]);
  try { forms.add(fs.realpathSync(p)); } catch {}
  for (const f of [...forms]) forms.add(pathToFileURL(f).href);
  return `^(${[...forms].map(escapeRegex).join('|')})$`;
}

// --- state while paused ----------------------------------------------------------
const scripts = new Map(); // scriptId -> url
let frames = null; // CDP call frames while paused
let refs = new Map(); // variablesReference -> objectId
let nextRef = 1;
let started = false;
let lastAction = null; // 'step' | 'pause' while one is in flight
let bpSeq = 0;
const bpsByPath = new Map(); // path -> CDP breakpoint ids
const dapBreakpoints = new Map(); // CDP breakpoint id -> DAP breakpoint

const ref = (objectId) => { const id = nextRef++; refs.set(id, objectId); return id; };
const childRef = (v) => (v?.objectId && v.type === 'object' && v.subtype !== 'null' ? ref(v.objectId) : 0);

function describe(v) {
  if (!v) return 'undefined';
  switch (v.type) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(v.value);
    case 'function': return `ƒ ${(v.description || '').split('\n')[0].replace(/^(async )?function\s*/, '$1').replace(/\s*\{$/, '').slice(0, 80) || 'anonymous'}`;
    case 'object': return v.subtype === 'null' ? 'null' : v.description || v.className || 'Object';
    default: return v.description ?? (v.unserializableValue || String(v.value));
  }
}

cdpHandlers['Debugger.scriptParsed'] = (p) => { if (p.url) scripts.set(p.scriptId, p.url); };
cdpHandlers['Debugger.breakpointResolved'] = ({ breakpointId, location }) => {
  const bp = dapBreakpoints.get(breakpointId);
  if (!bp || bp.verified) return;
  bp.verified = true;
  bp.line = location.lineNumber + 1;
  event('breakpoint', { reason: 'changed', breakpoint: bp });
};
cdpHandlers['Debugger.paused'] = (p) => {
  const hit = (p.hitBreakpoints || []).map((id) => dapBreakpoints.get(id)?.id).filter(Boolean);
  // --inspect-brk stops before the first line; go on unless asked to stop on entry.
  if (!started) {
    started = true;
    if (!hit.length && !launchArgs.stopOnEntry) { cdp('Debugger.resume').catch(() => {}); return; }
  }
  frames = p.callFrames;
  refs = new Map();
  const exception = p.reason === 'exception' || p.reason === 'promiseRejection';
  const reason = hit.length ? 'breakpoint' : exception ? 'exception' : lastAction === 'step' ? 'step' : started && !lastAction && p.reason === 'Break on start' ? 'entry' : 'pause';
  lastAction = null;
  event('stopped', {
    reason, threadId: 1, allThreadsStopped: true,
    ...(hit.length ? { hitBreakpointIds: hit } : {}),
    ...(exception ? { text: p.data?.description?.split('\n')[0] || 'Exception' } : {}),
  });
};
cdpHandlers['Debugger.resumed'] = () => {
  frames = null;
  refs = new Map();
};
// The program is done when its main context goes away (Node then waits for us to let go).
let mainContext = null;
cdpHandlers['Runtime.executionContextCreated'] = ({ context }) => { mainContext ??= context.id; };
cdpHandlers['Runtime.executionContextDestroyed'] = ({ executionContextId }) => { if (executionContextId === mainContext) ws?.close(); };

function frame(frameId) {
  const f = frames?.[(frameId || 1) - 1];
  if (!f) throw new Error('Not paused.');
  return f;
}

function sourceFor(f) {
  const url = f.url || scripts.get(f.location.scriptId) || '';
  const p = clientPath(url);
  return p ? { name: path.basename(p), path: p } : { name: url || '(unknown)', presentationHint: 'deemphasize' };
}

const SCOPES = { local: 'Local', closure: 'Closure', block: 'Block', script: 'Script', module: 'Module', global: 'Global', catch: 'Catch', with: 'With', eval: 'Eval' };

function step(method) {
  lastAction = method === 'Debugger.pause' ? 'pause' : 'step';
  return cdp(method).then(() => ({ allThreadsContinued: true }));
}

const handlers = {
  initialize: () => ({
    supportsConfigurationDoneRequest: true,
    supportsConditionalBreakpoints: true,
    supportsEvaluateForHovers: true,
    supportsTerminateRequest: true,
    exceptionBreakpointFilters: [
      { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
      { filter: 'all', label: 'All Exceptions', default: false },
    ],
  }),
  launch: (args) => launch(args),
  configurationDone: () => cdp('Runtime.runIfWaitingForDebugger'),
  setExceptionBreakpoints: ({ filters = [] }) => cdp('Debugger.setPauseOnExceptions', { state: filters.includes('all') ? 'all' : filters.includes('uncaught') ? 'uncaught' : 'none' }),
  async setBreakpoints({ source, breakpoints = [] }) {
    const p = source.path;
    remember(p);
    for (const id of bpsByPath.get(p) || []) {
      dapBreakpoints.delete(id);
      await cdp('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
    }
    const ids = [];
    const out = [];
    for (const b of breakpoints) {
      try {
        const r = await cdp('Debugger.setBreakpointByUrl', { urlRegex: urlRegexFor(p), lineNumber: b.line - 1, condition: b.condition || '' });
        const loc = r.locations[0];
        const bp = { id: ++bpSeq, verified: !!loc, line: loc ? loc.lineNumber + 1 : b.line };
        dapBreakpoints.set(r.breakpointId, bp);
        ids.push(r.breakpointId);
        out.push(bp);
      } catch (err) {
        out.push({ verified: false, line: b.line, message: err.message });
      }
    }
    bpsByPath.set(p, ids);
    return { breakpoints: out };
  },
  threads: () => ({ threads: [{ id: 1, name: 'main' }] }),
  stackTrace: () => ({
    stackFrames: (frames || []).map((f, i) => {
      const source = sourceFor(f);
      return {
        id: i + 1, name: f.functionName || '(anonymous)', source,
        line: f.location.lineNumber + 1, column: (f.location.columnNumber || 0) + 1,
        ...(source.path ? {} : { presentationHint: 'subtle' }),
      };
    }),
    totalFrames: frames?.length || 0,
  }),
  scopes: ({ frameId }) => ({
    scopes: frame(frameId).scopeChain.map((s) => ({
      name: SCOPES[s.type] || s.type, variablesReference: ref(s.object.objectId), expensive: s.type === 'global',
    })),
  }),
  async variables({ variablesReference }) {
    const objectId = refs.get(variablesReference);
    if (!objectId) return { variables: [] };
    const r = await cdp('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false });
    const variables = [];
    for (const p of r.result) {
      if (p.name === '__proto__' || variables.length >= 500) continue;
      if (!p.value && p.get) { variables.push({ name: p.name, value: '(getter)', variablesReference: 0 }); continue; }
      variables.push({ name: p.name, value: describe(p.value), type: p.value?.subtype || p.value?.type, variablesReference: childRef(p.value) });
    }
    return { variables };
  },
  async evaluate({ expression, frameId, context }) {
    const opts = { expression, objectGroup: 'dap', includeCommandLineAPI: context === 'repl', silent: context !== 'repl', throwOnSideEffect: context === 'hover' };
    const r = frames
      ? await cdp('Debugger.evaluateOnCallFrame', { callFrameId: frame(frameId).callFrameId, ...opts })
      : await cdp('Runtime.evaluate', opts);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
    return { result: describe(r.result), type: r.result.subtype || r.result.type, variablesReference: childRef(r.result) };
  },
  continue: () => cdp('Debugger.resume').then(() => ({ allThreadsContinued: true })),
  next: () => step('Debugger.stepOver'),
  stepIn: () => step('Debugger.stepInto'),
  stepOut: () => step('Debugger.stepOut'),
  pause: () => step('Debugger.pause'),
  disconnect: () => { ws?.close(); killChild(); },
  terminate: () => { ws?.close(); killChild(); },
};
