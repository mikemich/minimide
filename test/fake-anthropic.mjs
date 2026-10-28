// A stand-in for the Anthropic Messages API (and Ollama's /api/chat) for the ai suite. It
// answers by keyword, streams the way the real API does (server-sent events, with a thinking
// block whose signature the app must send back unchanged) and writes every request it gets to
// <dir>/ai-requests.json, so the suite can check exactly what was sent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const TEST_KEY = 'sk-ant-test-key-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserText(messages) {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function replyFor(body) {
  const system = typeof body.system === 'string' ? body.system : (body.system || []).map((b) => b.text).join('');
  const text = lastUserText(body.messages || []);
  if (body.model === 'claude-missing-model') return { status: 404, error: { type: 'not_found_error', message: 'model: claude-missing-model' } };
  if (text.includes('REFUSE')) return { refusal: 'This request was declined in the test.' };
  if (system.includes('<cursor/>')) return { text: 'return a + b;' };
  if (system.includes('<selection>')) {
    if (text.includes('Fix this problem')) return { text: '```js\nconst fixed = true;\n```' };
    return { text: 'Here you go:\n```js\nconst total = items.reduce((sum, x) => sum + x, 0);\nconsole.log("sum", total);\n```' };
  }
  if (text.includes('SLOW')) return { text: 'Counting slowly. '.repeat(20), slow: true };
  return { text: 'It logs a greeting.\n\n```js\nconsole.log("hi");\n```' };
}

async function stream(res, body, reply) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800 } } });
  send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-test-123' } });
  send('content_block_stop', { index: 0 });
  if (reply.text) {
    send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    for (const piece of reply.text.match(/[\s\S]{1,12}/g)) {
      if (res.destroyed) return;
      send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: piece } });
      if (reply.slow) await sleep(150);
    }
    send('content_block_stop', { index: 1 });
  }
  const stop = reply.refusal ? { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: reply.refusal } } : { stop_reason: 'end_turn', stop_sequence: null };
  send('message_delta', { delta: stop, usage: { output_tokens: 42 } });
  send('message_stop', {});
  res.end();
}

async function ollama(res, body) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const piece of ['Local ', 'model ', 'answer.']) res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: piece }, done: false }) + '\n');
  res.end(JSON.stringify({ model: body.model, done: true }) + '\n');
}

export async function startFakeAnthropic(dir) {
  const requests = [];
  const logFile = path.join(dir, 'ai-requests.json');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      // The SDK sends the key as x-api-key or as a Bearer token, depending on its version.
      const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');
      requests.push({ url: req.url, apiKey: key === TEST_KEY ? 'test-key' : key ? 'other' : 'none', beta: req.headers['anthropic-beta'] || '', body });
      fs.writeFileSync(logFile, JSON.stringify(requests));
      if (req.url.startsWith('/api/chat')) return ollama(res, body);
      if (key !== TEST_KEY) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      const reply = replyFor(body);
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: reply.error }));
      }
      return stream(res, body, reply);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'fake-server.json'), JSON.stringify({ url }));
  return {
    env: { MINIMIDE_AI_BASE_URL: url, ANTHROPIC_API_KEY: TEST_KEY },
    close: () => new Promise((r) => server.close(r)),
  };
}
