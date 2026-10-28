// The page side of AI requests (mide.ai). The main process holds the API key and makes the
// request (src/main/ai.js); this starts one and hands over its text as it streams in.
let seq = 0;
let listening = false;
const pending = new Map(); // request id -> { onText, resolve, reject }

function listen() {
  if (listening) return;
  listening = true;
  window.native.ai.onEvent((id, ev) => {
    const p = pending.get(id);
    if (!p) return;
    if (ev.type === 'text') { p.onText?.(ev.text); return; }
    pending.delete(id);
    if (ev.type === 'done') p.resolve(ev);
    else p.reject(Object.assign(new Error(ev.message), { kind: ev.kind }));
  });
}

export const aiClient = {
  /** { savedKey, environmentKey } */
  status: () => window.native.ai.status(),
  setKey: (key) => window.native.ai.setKey(key),
  clearKey: () => window.native.ai.clearKey(),
  /**
   * request({ provider?, model, system?, messages, maxTokens?, effort?, ollamaUrl? }, { onText?, signal? })
   * resolves with { content, stopReason, refusal, model, usage } once the answer is complete, or
   * rejects with an Error whose `kind` is cancelled | auth | model | rate | network | request | api | other.
   */
  request(req, { onText, signal } = {}) {
    listen();
    const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { onText, resolve, reject });
      if (signal?.aborted) window.native.ai.cancel(id);
      signal?.addEventListener('abort', () => window.native.ai.cancel(id), { once: true });
      window.native.ai.start(id, req).catch((err) => {
        pending.delete(id);
        reject(Object.assign(new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), { kind: 'request' }));
      });
    });
  },
};
