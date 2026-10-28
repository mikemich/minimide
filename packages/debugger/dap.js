// A minimal Debug Adapter Protocol client on top of mide.process.spawnRpc (DAP uses the same
// Content-Length framing as LSP, with its own message shapes).

export class DapClient {
  constructor(mide, argv, { cwd, onEvent, onStderr, onExit }) {
    this.seq = 0;
    this.pending = new Map();
    this.onEvent = onEvent;
    this.proc = mide.process.spawnRpc(argv, {
      cwd,
      onMessage: (msg) => this.handle(msg),
      onStderr,
      onExit: (code, signal) => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The debugger stopped.')); }
        this.pending.clear();
        this.exited = true;
        onExit(code, signal);
      },
    });
  }

  request(command, args = {}, { timeout = 15000 } = {}) {
    if (this.exited) return Promise.reject(new Error('The debugger stopped.'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(seq); reject(new Error(`The debugger didn't answer "${command}" in time.`)); }, timeout) : null;
      this.pending.set(seq, { resolve, reject, timer });
      this.proc.send({ seq, type: 'request', command, arguments: args });
    });
  }

  handle(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(new Error(errorText(msg)));
    } else if (msg.type === 'event') {
      this.onEvent(msg.event, msg.body || {});
    } else if (msg.type === 'request') {
      // Reverse requests (runInTerminal, startDebugging) aren't supported; say so instead of hanging.
      this.proc.send({ seq: ++this.seq, type: 'response', request_seq: msg.seq, command: msg.command, success: false, message: 'Not supported' });
    }
  }

  kill() { this.proc.kill(); }
}

function errorText(msg) {
  const err = msg.body?.error;
  if (err?.format) return err.format.replace(/\{(\w+)\}/g, (m, k) => err.variables?.[k] ?? m);
  return msg.message || 'Request failed';
}
