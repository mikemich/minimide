// AI requests for the ai package. They run here, in the main process, so the API key never
// reaches page JavaScript: the page sends a prompt and gets streamed text back.
//
// Claude goes through the official Anthropic SDK. The key comes from (in order) the one saved
// with "AI: Set API Key" (encrypted with the OS keychain via safeStorage), or the SDK's own
// lookup: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile. A local
// model can be used instead through Ollama's own HTTP API on this machine.
import Anthropic from '@anthropic-ai/sdk';
import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_MODEL = /^claude-[a-z0-9-]{1,60}$/;
const OLLAMA_MODEL = /^[\w.:/-]{1,100}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const REQUEST_ID = /^[\w-]{1,40}$/;
const MAX_REQUEST_CHARS = 1_500_000; // everything a request sends, together
// Models that take server-side fallbacks: a declined request is re-run on another model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

export function registerAi({ handle, userDir, testBaseUrl }) {
  const keyFile = path.join(userDir, 'ai-key.bin');
  const running = new Map(); // `${webContentsId}:${requestId}` -> AbortController

  async function savedKey() {
    if (!fss.existsSync(keyFile)) return null;
    try { return safeStorage.decryptString(await fs.readFile(keyFile)); } catch { return null; }
  }
  const environmentKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    || fss.existsSync(path.join(os.homedir(), '.config', 'anthropic'));

  async function client() {
    const apiKey = await savedKey();
    const baseURL = testBaseUrl || undefined;
    return apiKey ? new Anthropic({ apiKey, baseURL }) : new Anthropic({ baseURL });
  }

  // Doesn't touch the keychain: macOS may ask the user for access, which only makes sense once
  // they save a key (and, after that, when a request needs it).
  handle('ai:status', async () => ({ savedKey: fss.existsSync(keyFile), environmentKey: environmentKey() }));

  handle('ai:set-key', async (_e, key) => {
    key = typeof key === 'string' ? key.trim() : '';
    if (!/^sk-ant-[\w-]{10,300}$/.test(key)) throw new Error('That doesn\'t look like an Anthropic API key (they start with "sk-ant-").');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system has no secure storage for the key. Set ANTHROPIC_API_KEY in your environment instead.');
    await fs.writeFile(keyFile, safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  });

  handle('ai:clear-key', async () => { await fs.rm(keyFile, { force: true }); return true; });

  handle('ai:cancel', (event, id) => { running.get(`${event.sender.id}:${id}`)?.abort(); });

  // start(id, request): streams { type: 'text', text } events, then one { type: 'done', … } or
  // { type: 'error', … } event, all on the 'ai:event' channel.
  handle('ai:start', (event, id, request) => {
    if (typeof id !== 'string' || !REQUEST_ID.test(id)) throw new Error('Bad request id');
    const req = validate(request);
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    const controller = new AbortController();
    running.set(key, controller);
    const send = (payload) => { if (!sender.isDestroyed()) sender.send('ai:event', id, payload); };
    // Closing, reloading or crashing the page stops the request: nobody is left to read the answer.
    const stopOnClose = () => controller.abort();
    const stopOnNavigate = (details) => { if (details?.isMainFrame && !details.isSameDocument) controller.abort(); };
    sender.once('destroyed', stopOnClose);
    sender.once('render-process-gone', stopOnClose);
    sender.on('did-start-navigation', stopOnNavigate);
    const run = req.provider === 'ollama' ? runOllama(req, controller.signal, send) : runClaude(req, controller.signal, send);
    run.catch((err) => send(describeError(err)))
      .finally(() => {
        running.delete(key);
        if (sender.isDestroyed()) return;
        sender.removeListener('destroyed', stopOnClose);
        sender.removeListener('render-process-gone', stopOnClose);
        sender.removeListener('did-start-navigation', stopOnNavigate);
      });
    return true;
  });

  async function runClaude(req, signal, send) {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: req.messages,
      output_config: { effort: req.effort },
    };
    // A chat resends the same file context each turn, so it's worth caching; edits and suggestions aren't reused.
    if (req.cache) params.cache_control = { type: 'ephemeral' };
    if (req.system) params.system = req.system;
    if (FALLBACK_MODELS.has(req.model)) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });
    // A chat that went through a fallback keeps that block in its history; sending it back needs the beta.
    else if (req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'fallback'))) params.betas = [FALLBACK_BETA];
    const ai = await client();
    const stream = ai.beta.messages.stream(params, { signal });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send({ type: 'text', text: ev.delta.text });
    }
    const message = await stream.finalMessage();
    send({
      type: 'done',
      stopReason: message.stop_reason,
      refusal: message.stop_reason === 'refusal' ? (message.stop_details?.explanation || 'The model declined this request.') : null,
      // The whole content goes back to the page, which sends it again unchanged with the next turn.
      content: message.content,
      model: message.model,
      usage: { input: message.usage?.input_tokens, output: message.usage?.output_tokens, cacheRead: message.usage?.cache_read_input_tokens },
    });
  }

  async function runOllama(req, signal, send) {
    const res = await fetch(`${req.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          ...req.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
        ],
      }),
      signal,
      redirect: 'error', // a redirect could carry the code off this machine
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let text = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const take = (line) => {
      if (!line) return;
      const part = JSON.parse(line);
      if (part.error) throw new Error(part.error);
      if (part.message?.content) { text += part.message.content; send({ type: 'text', text: part.message.content }); }
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    }
    take((buffer + decoder.decode()).trim()); // the last line may have no newline
    send({ type: 'done', stopReason: 'end_turn', refusal: null, content: [{ type: 'text', text }], model: req.model, usage: {} });
  }
}

const textOf = (content) => (typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(''));

function validate(r) {
  if (!r || typeof r !== 'object') throw new Error('Bad request');
  const provider = r.provider === 'ollama' ? 'ollama' : 'anthropic';
  if (typeof r.model !== 'string' || !(provider === 'ollama' ? OLLAMA_MODEL : CLAUDE_MODEL).test(r.model)) throw new Error('Unknown model name');
  if (r.system != null && typeof r.system !== 'string') throw new Error('Bad system prompt');
  if (!Array.isArray(r.messages) || !r.messages.length || r.messages.length > 400) throw new Error('Bad messages');
  for (const m of r.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('Bad message role');
    const ok = typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every((b) => b && typeof b.type === 'string'));
    if (!ok) throw new Error('Bad message content');
  }
  if (JSON.stringify(r.messages).length + (r.system?.length || 0) > MAX_REQUEST_CHARS) throw new Error('This request is too large to send. In a long chat, start a new one.');
  const maxTokens = Number.isInteger(r.maxTokens) ? Math.min(Math.max(r.maxTokens, 256), 64000) : 16000;
  const effort = EFFORTS.has(r.effort) ? r.effort : 'medium';
  let ollamaUrl = 'http://127.0.0.1:11434';
  if (provider === 'ollama' && r.ollamaUrl) {
    // Only a model on this machine: the code being sent must not leave it by a typo'd setting.
    const u = new URL(r.ollamaUrl);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('Ollama must run on this machine (http://127.0.0.1:…)');
    ollamaUrl = u.origin;
  }
  return { provider, model: r.model, system: r.system || '', messages: r.messages, maxTokens, effort, ollamaUrl, cache: r.cache === true };
}

// Typed SDK errors, most specific first, turned into something a person can act on.
function describeError(err) {
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return { type: 'error', kind: 'cancelled', message: 'Stopped.' };
  if (err instanceof Anthropic.AuthenticationError) return { type: 'error', kind: 'auth', message: 'The API key was not accepted. Run "AI: Set API Key" to enter a new one.' };
  if (err instanceof Anthropic.PermissionDeniedError) return { type: 'error', kind: 'auth', message: 'This API key isn\'t allowed to use that model.' };
  if (err instanceof Anthropic.NotFoundError) return { type: 'error', kind: 'model', message: 'That model wasn\'t found. Check the AI model setting.' };
  if (err instanceof Anthropic.RateLimitError) return { type: 'error', kind: 'rate', message: 'Too many requests right now. Try again in a moment.' };
  if (err instanceof Anthropic.BadRequestError) return { type: 'error', kind: 'request', message: err.message };
  if (err instanceof Anthropic.APIConnectionError) return { type: 'error', kind: 'network', message: 'Couldn\'t reach the Anthropic API. Check your connection.' };
  if (err instanceof Anthropic.APIError) return { type: 'error', kind: 'api', message: `The API returned an error (${err.status ?? 'no status'}).` };
  if (/credentials|api ?key|auth/i.test(String(err?.message))) return { type: 'error', kind: 'auth', message: 'No API key found. Run "AI: Set API Key", or set ANTHROPIC_API_KEY.' };
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(String(err?.message))) return { type: 'error', kind: 'network', message: 'Couldn\'t reach the model. Is it running?' };
  return { type: 'error', kind: 'other', message: String(err?.message || err).slice(0, 300) };
}
