// The AI package against a fake Anthropic API (test/fake-anthropic.mjs, started by the runner),
// over the `aiproj` fixture: chat (what is sent, history kept exactly, Stop, refusals), edit with
// the diff preview (accept and reject), suggestions at the cursor (Tab), model choices, a local
// Ollama model, error messages, and that the API key never lands in saved files.
(async () => {
  const app = window.minimide, ws = app.workspace, T = window.mideTest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch {} if (v) return v; await sleep(60); } return null; };
  while (!ws.project) await sleep(50);
  const out = {};
  const step = (name) => console.log(`[test] step ${name}`);
  const home = app.userInfo.dir;
  const requests = async () => JSON.parse(await window.native.fs.read(`${home}/ai-requests.json`).catch(() => '[]'));
  const lastRequest = async () => (await requests()).at(-1);
  const editor = await ws.open(`${ws.project}/src/calc.js`);
  editor.view.focus();
  await sleep(300);

  out.status = await window.native.ai.status();
  out.badKeyRejected = await window.native.ai.setKey('not-a-key').then(() => 'accepted', (e) => e.message);

  step('chat');
  // --- chat ------------------------------------------------------------------
  await T.answers('confirm', 0); // "Send code to Anthropic?" → Continue
  await app.commands.run('ai:chat');
  const input = await until(() => document.querySelector('.ai-input'));
  const ask = async (text) => {
    const before = document.querySelectorAll('.ai-msg.assistant').length;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => document.querySelectorAll('.ai-msg.assistant').length > before);
    const answer = [...document.querySelectorAll('.ai-msg.assistant')].at(-1);
    await until(() => answer.querySelector('.ai-meta')?.textContent || answer.querySelector('.ai-error, .ai-note'));
    return answer;
  };
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(4).from, head: editor.view.state.doc.line(4).to } });
  const first = await ask('What does this do?');
  const r1 = await lastRequest();
  const firstUser = r1.body.messages[0].content;
  out.chat = {
    answer: first.querySelector('.ai-code pre')?.textContent,
    meta: first.querySelector('.ai-meta')?.textContent,
    request: {
      model: r1.body.model, stream: r1.body.stream, max_tokens: r1.body.max_tokens, effort: r1.body.output_config?.effort,
      fallbacks: r1.body.fallbacks, cache: r1.body.cache_control?.type, apiKey: r1.apiKey,
      fallbackBeta: r1.beta.includes('server-side-fallback-2026-07-01'),
      systemOk: /coding assistant inside Minimide/.test(r1.body.system),
      hasContext: firstUser.includes('<context>') && firstUser.includes('File: src/calc.js (JavaScript)') && firstUser.includes('Selected lines 4–4'),
      hasFile: firstUser.includes('for (const x of items) total += x;'),
    },
  };
  await ask('And why?');
  const r2 = await lastRequest();
  const assistantTurn = r2.body.messages[1];
  out.chat.second = {
    messages: r2.body.messages.length,
    // The answer goes back exactly as it came, thinking block and signature included.
    thinkingPassedBack: Array.isArray(assistantTurn?.content) && assistantTurn.content[0]?.type === 'thinking' ? assistantTurn.content[0].signature : null,
    fileUnchangedNote: r2.body.messages[2].content.includes('The file is unchanged since the last message.'),
  };

  // Insert the answer's code at the cursor.
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
  [...document.querySelectorAll('.ai-code-btn')].find((b) => b.textContent === 'Insert')?.click();
  await sleep(100);
  out.inserted = editor.getText().includes('console.log("hi");');
  editor.view.dispatch({ changes: { from: editor.getText().indexOf('console.log("hi");'), to: editor.view.state.doc.length } });

  step('edit');
  // --- edit with preview --------------------------------------------------------
  const promptAnswer = async (text) => {
    const box = await until(() => document.querySelector('.select-list.prompt .select-input'));
    box.value = text;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const doc = editor.view.state.doc;
  editor.view.dispatch({ selection: { anchor: doc.line(5).from, head: doc.line(6).to } });
  editor.view.focus();
  const edit = app.commands.run('ai:edit-selection');
  await promptAnswer('use reduce');
  const accept = await until(() => [...document.querySelectorAll('.ai-diff-foot button')].find((b) => b.textContent.startsWith('Accept') && !b.disabled));
  const editRequest = await lastRequest();
  accept?.click();
  await edit;
  await sleep(150);
  out.edit = {
    applied: editor.view.state.doc.line(5).text,
    secondLine: editor.view.state.doc.line(6).text,
    cache: editRequest.body.cache_control ? 'sent' : 'absent',
    selectionMarked: editRequest.body.messages[0].content.includes('<selection>let total = 0;\nfor (const x of items) total += x;</selection>'),
  };
  const textBefore = editor.getText();
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(4).from, head: editor.view.state.doc.line(4).to } });
  const edit2 = app.commands.run('ai:edit-selection');
  await promptAnswer('something else');
  await until(() => [...document.querySelectorAll('.ai-diff-foot button')].find((b) => b.textContent.startsWith('Accept') && !b.disabled));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await edit2;
  out.edit.rejectedUnchanged = editor.getText() === textBefore && !document.querySelector('.ai-diff');

  // No diagnostics in this file: "Fix Problem Here" says so instead of sending anything.
  const sentBefore = (await requests()).length;
  await app.commands.run('ai:fix');
  await sleep(200);
  out.fix = { noProblem: (await requests()).length === sentBefore && [...document.querySelectorAll('.notification')].some((n) => /No problem on this line/.test(n.textContent)) };

  step('suggest');
  // --- suggestion at the cursor --------------------------------------------------
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(2).to } });
  editor.view.focus();
  await app.commands.run('ai:suggest');
  const ghost = await until(() => editor.view.dom.querySelector('.cm-ai-ghost'));
  const sr = await lastRequest();
  out.suggest = { ghost: ghost?.textContent, request: { max_tokens: sr.body.max_tokens, effort: sr.body.output_config?.effort, cache: sr.body.cache_control ? 'sent' : 'absent' } };
  editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  await sleep(100);
  out.suggest.accepted = editor.view.state.doc.line(2).text === '  return a + b;' && !editor.view.dom.querySelector('.cm-ai-ghost');

  step('more');
  // --- refusals, Stop, sending less, other models --------------------------------
  await app.commands.run('ai:chat');
  out.refusal = (await ask('REFUSE this please')).querySelector('.ai-error')?.textContent;

  const historyBefore = (await lastRequest()).body.messages.length;
  input.value = 'SLOW story';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => !document.querySelector('.ai-stop').hidden);
  await sleep(400);
  document.querySelector('.ai-stop').click();
  const stopped = await until(() => [...document.querySelectorAll('.ai-msg.assistant')].at(-1).querySelector('.ai-notes .ai-note')?.textContent === 'Stopped.');
  await ask('Short one');
  out.stop = { stopped: !!stopped, historyKept: (await lastRequest()).body.messages.length === historyBefore };

  const include = document.querySelector('.ai-include input');
  include.checked = false;
  await ask('Without the file');
  const nf = await lastRequest();
  out.noFile = { sentFile: nf.body.messages.at(-1).content.includes('for (const x of items)') || nf.body.messages.at(-1).content.includes('The file') };
  include.checked = true;

  await app.config.set('ai.model', 'claude-haiku-5-5');
  await ask('Haiku please');
  out.haiku = { fallbacks: 'fallbacks' in (await lastRequest()).body ? 'present' : 'absent' };
  await app.config.set('ai.model', 'claude-missing-model');
  out.missingModel = (await ask('Missing model')).querySelector('.ai-error')?.textContent;
  await app.config.set('ai.model', 'claude-opus-5-5');

  const { url } = JSON.parse(await window.native.fs.read(`${home}/fake-server.json`));
  await T.answers('confirm', 0); // "Send code to your local model?" → Continue
  await app.config.set('ai.provider', 'ollama');
  await app.config.set('ai.ollamaUrl', url);
  out.ollama = { answer: (await ask('Local?')).querySelector('.ai-body')?.textContent };
  await app.config.set('ai.ollamaUrl', 'http://example.com:11434');
  out.ollama.remoteRejected = (await ask('Remote?')).querySelector('.ai-error')?.textContent;
  await app.config.set('ai.provider', 'anthropic');

  // Open Claude Code starts `claude` in a terminal in the project, or brings the running one forward.
  const terminal = app.packages.services.get('terminal');
  const calls = [];
  const realRun = terminal.run, realRunning = terminal.isRunning, realShow = terminal.show;
  let running = false;
  terminal.run = (command, opts) => { calls.push(['run', command, opts.cwd === ws.project, opts.key]); running = true; return null; };
  terminal.isRunning = (key) => key === 'claude-code' && running;
  terminal.show = (key) => { calls.push(['show', key]); return true; };
  await app.commands.run('ai:open-claude-code');
  await app.commands.run('ai:open-claude-code');
  Object.assign(terminal, { run: realRun, isRunning: realRunning, show: realShow });
  out.claudeCode = calls;

  // The key is never written into settings or saved state.
  await app.persistState?.();
  await sleep(300);
  const files = await Promise.all(['config.json', 'state.json'].map((f) => window.native.fs.read(`${home}/${f}`).catch(() => '')));
  out.noKeyInState = !files.some((t) => t.includes('sk-ant-'));
  return out;
})();
