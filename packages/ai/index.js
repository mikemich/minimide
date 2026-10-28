// AI: chat about your code, edit a selection with a preview, fix the problem on a line, explain
// code, and (when you turn it on) suggestions as you type. Requests go through mide.ai, which
// the main process runs so the API key never reaches this page. Nothing is sent until you ask,
// and the first time you're shown what will be sent and where.
import { renderMarkdown, firstCodeBlock } from './markdown.js';

const CHAT_SYSTEM = `You are a coding assistant inside Minimide, a small code editor.
A user message may start with a <context> block: the open file's path and language, the selected
lines and the file's text. Use it to answer. Be concise and concrete. When you change code, show
the complete changed code in one fenced block with its language, so it can be inserted as is.
Use Markdown.`;

const EDIT_SYSTEM = `You edit code inside a code editor. You get a file with the code to change
between <selection> and </selection>, and an instruction. Reply with only the new code for that
selection, in one fenced code block. Keep the indentation of the surrounding code. No explanation.`;

const SUGGEST_SYSTEM = `You complete code at the <cursor/> marker. Reply with only the text to
insert at the cursor: no explanation, no code fences, and nothing that is already before or after
the cursor. Keep it short: finish the current line, statement or small block.`;

export function activate(mide) {
  const { h, icon } = mide.ui;
  const { EditorView, Decoration, WidgetType, keymap } = mide.cm.view;
  const { StateField, StateEffect, Prec } = mide.cm.state;
  const cfg = (key) => mide.config.get(`ai.${key}`);
  const textOf = (content) => (typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view);
  const fenceFor = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const isMac = mide.user.platform === 'darwin';

  // ---------------------------------------------------------------------------
  // Model settings, the first-use confirmation and the API key

  function modelOptions(kind) {
    if (cfg('provider') === 'ollama') return { provider: 'ollama', model: cfg('ollamaModel'), ollamaUrl: cfg('ollamaUrl') };
    return { provider: 'anthropic', model: cfg('model'), effort: kind === 'suggest' ? cfg('suggestEffort') : cfg('effort') };
  }
  const modelLabel = () => (cfg('provider') === 'ollama' ? `${cfg('ollamaModel')} (local)` : cfg('model'));

  const consentKey = () => `ai.consent.${cfg('provider')}:${mide.user.dir}`;
  const consented = () => { try { return !!localStorage.getItem(consentKey()); } catch { return false; } };

  async function ensureReady() {
    const local = cfg('provider') === 'ollama';
    if (!consented()) {
      const choice = await mide.ui.confirm({
        type: 'question',
        message: local ? 'Send code to your local model?' : 'Send code to Anthropic?',
        detail: (local
          ? 'AI features send the code you ask about to the Ollama model running on this computer. It doesn\'t leave your machine.'
          : 'AI features send the code you ask about to Anthropic\'s API to get an answer: your question, the selected code and, unless you turn "Send the Open File" off, the rest of the open file. Edit and Fix always send the code around the selection.')
          + '\n\nNothing is sent until you ask, and nothing is sent in the background unless you turn on "Suggest as You Type".',
        buttons: ['Continue', 'Cancel'],
      });
      if (choice !== 0) return false;
      try { localStorage.setItem(consentKey(), '1'); } catch {}
    }
    if (!local) {
      const status = await mide.ai.status();
      if (!status.savedKey && !status.environmentKey) return setKey();
    }
    return true;
  }

  async function setKey() {
    const key = await mide.ui.prompt({
      title: 'Paste your Anthropic API key (console.anthropic.com → API Keys). It\'s stored encrypted on this computer and only used by Minimide to talk to Anthropic.',
      placeholder: 'sk-ant-…',
      secret: true,
    });
    if (!key) return false;
    try {
      await mide.ai.setKey(key);
      mide.notify.success('API key saved', 'Stored encrypted on this computer.');
      return true;
    } catch (err) {
      mide.notify.error('Couldn\'t save the key', String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // What a request sends about the open file

  function contextOf(editor, includeFile) {
    const { state } = editor.view;
    const sel = state.selection.main;
    const ctx = {
      file: editor.getPath() ? mide.workspace.relativePath(editor.getPath()) : editor.getTitle(),
      language: editor.getLanguageName(),
      line: state.doc.lineAt(sel.head).number,
      selection: null,
      text: null,
    };
    if (!sel.empty) ctx.selection = { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(sel.to).number, text: state.sliceDoc(sel.from, sel.to) };
    if (includeFile) {
      if (state.doc.length <= 150_000) ctx.text = { body: state.doc.toString(), note: '' };
      else {
        // A big file: the part around the cursor.
        const from = Math.max(1, ctx.line - 500);
        const to = Math.min(state.doc.lines, ctx.line + 500);
        let start = state.doc.line(from).from;
        let end = state.doc.line(to).to;
        // Minified code can be one huge line: keep to about 150k characters around the cursor.
        if (end - start > 150_000) { start = Math.max(start, sel.head - 75_000); end = Math.min(end, start + 150_000); }
        ctx.text = { body: state.sliceDoc(start, end), note: ` (part of lines ${from}–${to} of ${state.doc.lines})` };
      }
    }
    return ctx;
  }

  function contextBlock(ctx, previousText) {
    const parts = [`File: ${ctx.file} (${ctx.language}), cursor on line ${ctx.line}`];
    if (ctx.selection) {
      const f = fenceFor(ctx.selection.text);
      parts.push(`Selected lines ${ctx.selection.from}–${ctx.selection.to}:\n${f}\n${ctx.selection.text}\n${f}`);
    }
    if (ctx.text) {
      const f = fenceFor(ctx.text.body);
      parts.push(ctx.text.body === previousText ? 'The file is unchanged since the last message.' : `The file${ctx.text.note}:\n${f}\n${ctx.text.body}\n${f}`);
    }
    return `<context>\n${parts.join('\n\n')}\n</context>`;
  }

  // ---------------------------------------------------------------------------
  // Status bar: what's running, and a menu

  let busyCount = 0;
  const statusText = h('span.ai-status-text', 'AI');
  const statusEl = h('span.ai-status', icon('sparkle', 13), statusText);
  const setBusy = (delta) => {
    busyCount = Math.max(0, busyCount + delta);
    statusEl.classList.toggle('busy', busyCount > 0);
    statusText.textContent = busyCount ? 'AI working…' : 'AI';
  };
  mide.statusBar.addItem({ id: 'ai', element: statusEl, align: 'right', priority: 60, tooltip: 'AI', command: 'ai:chat', onClick: () => menu() });

  function menu() {
    const suggest = cfg('suggestAsYouType');
    mide.ui.selectList({
      id: 'ai-menu',
      placeholder: `AI · ${modelLabel()}`,
      items: [
        { label: 'Open Chat', run: () => mide.commands.run('ai:chat') },
        { label: 'Edit Selection…', run: () => mide.commands.run('ai:edit-selection') },
        { label: 'Suggest Code Here', run: () => mide.commands.run('ai:suggest') },
        { label: `Suggest as You Type: ${suggest ? 'On' : 'Off'}`, detail: suggest ? 'Turn off' : 'Turn on (each pause in typing sends a request)', run: () => mide.config.set('ai.suggestAsYouType', !suggest) },
        { label: 'Set API Key…', run: setKey },
        { label: 'Choose Model…', detail: modelLabel(), run: chooseModel },
      ],
      onSelect: (i) => i.run(),
    });
  }

  function chooseModel() {
    const models = [
      ['claude-opus-5-5', 'Most capable (the default)'],
      ['claude-sonnet-5-5', 'Faster and cheaper'],
      ['claude-haiku-5-5', 'Fastest and cheapest, good for suggestions'],
    ];
    mide.ui.selectList({
      id: 'ai-model',
      placeholder: 'Choose the Claude model',
      items: [...models.map(([id, detail]) => ({ label: id, detail, id })), { label: 'A local model (Ollama)…', detail: cfg('ollamaModel'), local: true }],
      onSelect: async (i) => {
        if (i.local) {
          const name = await mide.ui.prompt({ title: 'Ollama model name (run `ollama list` to see yours)', value: cfg('ollamaModel') });
          if (name) { await mide.config.set('ai.ollamaModel', name); await mide.config.set('ai.provider', 'ollama'); }
          return;
        }
        await mide.config.set('ai.model', i.id);
        await mide.config.set('ai.provider', 'anthropic');
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Chat (a sidebar view)

  const chat = { messages: [], lastText: null, controller: null, busy: false };
  const list = h('div.ai-messages', h('div.ai-empty',
    h('p', 'Ask about the open file or the selected code.'),
    h('p.ai-hint', 'Answers come with buttons to insert or copy code. Your question, the selection and the open file are sent; untick "Include the open file" to send less.')));
  const input = h('textarea.ai-input', { rows: 3, placeholder: 'Ask about your code…', spellcheck: true });
  const includeFile = h('input', { type: 'checkbox', checked: true });
  const contextLine = h('div.ai-context');
  const sendButton = h('button.btn.primary.ai-send', { onclick: () => send() }, 'Send');
  const stopButton = h('button.btn.ai-stop', { hidden: true, onclick: () => chat.controller?.abort() }, 'Stop');
  const modelLine = h('span.ai-model');
  const view = h('div.ai-view',
    h('div.ai-header', modelLine, h('button.icon-btn', { title: 'New chat', onclick: () => newChat() }, icon('plus', 14))),
    list,
    h('div.ai-compose', contextLine, input,
      h('div.ai-actions', h('label.ai-include', includeFile, ' Include the open file'), h('span.ai-spacer'), stopButton, sendButton)));
  mide.sidebar.addView({ id: 'ai', title: 'AI', icon: 'sparkle', order: 40, command: 'ai:chat', element: view, focus: () => input.focus(), onShow: refreshContext });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  function refreshContext() {
    modelLine.textContent = modelLabel();
    const editor = mide.workspace.getActiveEditor();
    if (!editor) { contextLine.textContent = 'No file open'; return; }
    const sel = editor.view.state.selection.main;
    const doc = editor.view.state.doc;
    const where = sel.empty ? `line ${doc.lineAt(sel.head).number}` : `lines ${doc.lineAt(sel.from).number}–${doc.lineAt(sel.to).number} selected`;
    contextLine.textContent = `${editor.getTitle()} · ${where}`;
  }
  mide.workspace.onDidChangeActiveItem(refreshContext);
  mide.workspace.onDidUpdateEditor((editor, update) => { if (update?.selectionSet && editor === mide.workspace.getActiveEditor() && mide.sidebar.isActive('ai')) refreshContext(); });
  mide.config.onDidChangeAny(() => { modelLine.textContent = modelLabel(); });

  function newChat() {
    chat.controller?.abort();
    chat.messages = [];
    chat.lastText = null;
    list.replaceChildren();
    input.focus();
  }

  function codeBlock(code, lang) {
    const button = (label, title, run) => h('button.ai-code-btn', { title, onclick: run }, label);
    const insert = (replace) => {
      const editor = mide.workspace.getActiveEditor();
      if (!editor) return mide.notify.info('Open a file to insert the code into.');
      const v = editor.view;
      const sel = v.state.selection.main;
      v.dispatch({ changes: { from: replace ? sel.from : sel.head, to: replace ? sel.to : sel.head, insert: code }, selection: { anchor: (replace ? sel.from : sel.head) + code.length }, userEvent: 'input.ai' });
      editor.focus();
    };
    return h('div.ai-code',
      h('div.ai-code-bar', h('span.ai-code-lang', lang || 'code'), h('span.ai-spacer'),
        button('Copy', 'Copy the code', () => { mide.clipboard.write(code); mide.notify.success('Copied'); }),
        button('Insert', 'Insert at the cursor', () => insert(false)),
        button('Replace', 'Replace the selection', () => insert(true))),
      h('pre', h('code', code)));
  }

  function bubble(role) {
    // Notes (Stopped, errors) sit apart from the answer, so redrawing it while it streams can't drop them.
    const body = h('div.ai-body');
    const notes = h('div.ai-notes');
    const meta = h('div.ai-meta');
    const el = h(`div.ai-msg.${role}`, body, notes, meta);
    list.querySelector('.ai-empty')?.remove();
    list.append(el);
    let frame = 0;
    let latest = '';
    const scroll = () => { list.scrollTop = list.scrollHeight; };
    return {
      el,
      text(t) { body.textContent = t; scroll(); },
      markdown(t) {
        latest = t;
        // While streaming, redraw at most once a frame.
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; body.replaceChildren(renderMarkdown(latest, codeBlock)); scroll(); });
      },
      note(text, cls = 'note', action) { notes.append(h(`div.ai-${cls}`, text, action || null)); scroll(); },
      clearNotes() { notes.replaceChildren(); },
      meta(text) { meta.textContent = text; },
    };
  }

  list.addEventListener('click', (e) => {
    const href = e.target.closest?.('a[data-href]')?.dataset.href;
    if (href) { e.preventDefault(); mide.shell.openExternal(href); }
  });

  async function send(question, editor = mide.workspace.getActiveEditor()) {
    const typed = question == null;
    if (typed) question = input.value.trim();
    if (!question || chat.busy) return;
    chat.busy = true; // set before the first await, so a second Enter can't send it again
    try {
      if (!(await ensureReady())) return;
      await ask(question, editor, typed);
    } finally {
      chat.busy = false;
    }
  }

  async function ask(question, editor, typed) {
    if (typed) input.value = '';
    // "New chat" may replace the conversation while this answer is on its way; it then goes nowhere.
    const conv = chat.messages;
    const current = () => conv === chat.messages;
    const ctx = editor ? contextOf(editor, includeFile.checked && cfg('sendFileContext')) : null;
    conv.push({ role: 'user', content: ctx ? `${contextBlock(ctx, chat.lastText)}\n\n${question}` : question });
    const asked = bubble('user');
    asked.text(question);
    if (ctx) asked.meta(ctx.selection ? `${ctx.file}, lines ${ctx.selection.from}–${ctx.selection.to}` : ctx.file);
    const answer = bubble('assistant');
    answer.note('Thinking…', 'pending');
    chat.controller = new AbortController();
    stopButton.hidden = false;
    sendButton.disabled = true;
    setBusy(1);
    let streamed = '';
    try {
      const res = await mide.ai.request(
        { ...modelOptions('chat'), system: CHAT_SYSTEM, messages: conv, maxTokens: 64000, cache: true },
        { signal: chat.controller.signal, onText: (t) => { if (!streamed) answer.clearNotes(); streamed += t; answer.markdown(streamed); } },
      );
      answer.clearNotes();
      if (!current()) return;
      if (res.refusal) conv.pop(); // a declined question isn't kept in the conversation
      else {
        // Kept exactly as returned, and sent back unchanged with the next question.
        conv.push({ role: 'assistant', content: res.content });
        if (ctx?.text) chat.lastText = ctx.text.body;
      }
      const text = textOf(res.content) || streamed;
      if (text) answer.markdown(text);
      else answer.text('');
      if (res.refusal) answer.note(res.refusal, 'error');
      if (res.stopReason === 'max_tokens') answer.note('The answer was cut off because it got too long.', 'note');
      answer.meta([res.model, usageText(res.usage)].filter(Boolean).join(' · '));
    } catch (err) {
      if (current()) conv.pop(); // unanswered: leave the history as it was before the question
      answer.clearNotes();
      if (streamed) answer.markdown(streamed);
      else answer.text('');
      answer.note(err.kind === 'cancelled' ? 'Stopped.' : err.message, err.kind === 'cancelled' ? 'note' : 'error',
        err.kind === 'auth' ? h('button.ai-code-btn', { onclick: setKey }, 'Set API Key…') : null);
    } finally {
      chat.controller = null;
      stopButton.hidden = true;
      sendButton.disabled = false;
      setBusy(-1);
    }
  }

  const usageText = (u) => (u?.input != null ? `${fmt(u.input)} in${u.cacheRead ? ` (${fmt(u.cacheRead)} cached)` : ''} · ${fmt(u.output)} out` : '');
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

  async function openChat(question) {
    mide.sidebar.show('ai', { focus: true });
    refreshContext();
    if (question) await send(question);
  }

  // ---------------------------------------------------------------------------
  // Edit a selection: the proposal streams into a side-by-side diff to accept or reject

  async function editRange({ from, to, instruction, title }) {
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return mide.notify.info('Open a file first.');
    const v = editor.view;
    if (from == null) {
      ({ from, to } = v.state.selection.main);
      if (from === to) { const line = v.state.doc.lineAt(from); ({ from, to } = line); } // nothing selected: the line
    }
    instruction ??= await mide.ui.prompt({ title: 'How should the selected code change?', placeholder: 'e.g. add error handling, use async/await, rename x to count' });
    if (!instruction) return;
    if (!(await ensureReady())) return;
    const doc = v.state.doc;
    const original = doc.sliceString(from, to);
    const before = doc.sliceString(Math.max(0, from - 60_000), from);
    const after = doc.sliceString(to, Math.min(doc.length, to + 30_000));
    const marked = `${before}<selection>${original}</selection>${after}`;
    const f = fenceFor(marked);
    const ctx = contextOf(editor, false);
    const preview = await diffPreview(editor, original, title || instruction);
    const controller = new AbortController();
    preview.onCancel(() => controller.abort());
    setBusy(1);
    let streamed = '';
    try {
      const res = await mide.ai.request({
        ...modelOptions('edit'),
        system: EDIT_SYSTEM,
        messages: [{ role: 'user', content: `File: ${ctx.file} (${ctx.language})\n${f}\n${marked}\n${f}\n\nInstruction: ${instruction}` }],
        maxTokens: 64000,
      }, { signal: controller.signal, onText: (t) => { streamed += t; preview.propose(firstCodeBlock(streamed)); } });
      if (res.refusal) return preview.fail(res.refusal);
      const proposal = firstCodeBlock(textOf(res.content) || streamed);
      preview.propose(proposal);
      const accepted = await preview.ready();
      if (accepted == null) return;
      if (v.state.doc.sliceString(from, to) !== original || !editor.view) return mide.notify.warn('The code changed while waiting, so the edit wasn\'t applied.');
      v.dispatch({ changes: { from, to, insert: accepted }, selection: { anchor: from, head: from + accepted.length }, userEvent: 'input.ai' });
      editor.focus();
    } catch (err) {
      if (err.kind === 'cancelled') return;
      preview.fail(err.message);
    } finally {
      setBusy(-1);
    }
  }

  async function diffPreview(editor, original, title) {
    const { MergeView } = await mide.cm.extras.merge();
    const language = (editor.getPath() && await mide.editor.languageFor(editor.getPath())) || [];
    const { syntaxHighlighting } = mide.cm.language;
    const { classHighlighter } = mide.cm.highlight;
    const common = [language, syntaxHighlighting(classHighlighter), EditorView.lineWrapping];
    const status = h('span.ai-diff-status', 'Writing…');
    const accept = h('button.btn.primary', { disabled: true }, `Accept  ${isMac ? '⌘↩' : 'Ctrl+Enter'}`);
    const reject = h('button.btn', 'Reject  Esc');
    const body = h('div.ai-diff-body');
    const card = h('div.ai-diff', h('div.ai-diff-head', h('span.ai-diff-title', title), status), body, h('div.ai-diff-foot', h('span.ai-hint', 'You can edit the proposal on the right before accepting it.'), h('span.ai-spacer'), reject, accept));
    const backdrop = h('div.ai-diff-backdrop', card);
    document.body.append(backdrop);
    const merge = new MergeView({
      a: { doc: original, extensions: [...common, mide.cm.state.EditorState.readOnly.of(true)] },
      b: { doc: '', extensions: common },
      parent: body,
    });
    let finish;
    const decided = new Promise((resolve) => { finish = resolve; });
    let cancel = () => {};
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', keys, true);
      backdrop.remove();
      merge.destroy();
      if (value == null) cancel();
      finish(value);
      editor.focus();
    };
    const keys = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); if (!accept.disabled) close(merge.b.state.doc.toString()); }
    };
    window.addEventListener('keydown', keys, true);
    reject.onclick = () => close(null);
    accept.onclick = () => close(merge.b.state.doc.toString());
    return {
      onCancel(fn) { cancel = fn; },
      propose(text) {
        if (done || merge.b.state.doc.toString() === text) return;
        merge.b.dispatch({ changes: { from: 0, to: merge.b.state.doc.length, insert: text } });
      },
      ready() { status.textContent = 'Ready'; accept.disabled = false; accept.focus(); return decided; },
      fail(message) { status.textContent = message; status.classList.add('error'); },
    };
  }

  function fixHere() {
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return;
    const { state } = editor.view;
    const line = state.doc.lineAt(state.selection.main.head);
    const found = [];
    mide.cm.lint.forEachDiagnostic(state, (d, from, to) => {
      if (from <= line.to && to >= line.from) found.push({ d, from, to });
    });
    if (!found.length) return mide.notify.info('No problem on this line', 'Put the cursor on a line with an underlined problem, or use "AI: Edit Selection…".');
    const from = state.doc.lineAt(Math.min(...found.map((f) => f.from))).from;
    const to = state.doc.lineAt(Math.max(...found.map((f) => f.to))).to;
    const problems = found.map(({ d }) => `${d.severity}: ${d.message}`).join('\n');
    return editRange({ from, to, instruction: `Fix this problem:\n${problems}`, title: `Fix: ${found[0].d.message.split('\n')[0]}` });
  }

  function explain() {
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return mide.notify.info('Open a file first.');
    const sel = editor.view.state.selection.main;
    const line = editor.view.state.doc.lineAt(sel.head).number;
    return openChat(sel.empty ? `Explain the code around line ${line}.` : 'Explain what the selected code does.');
  }

  // ---------------------------------------------------------------------------
  // Suggestions: grey text at the cursor; Tab takes it, Esc or typing something else drops it

  class Ghost extends WidgetType {
    constructor(text) { super(); this.text = text; }
    eq(other) { return other.text === this.text; }
    toDOM() { return h('span.cm-ai-ghost', this.text); }
    ignoreEvent() { return true; }
  }
  const setGhost = StateEffect.define();
  const ghostField = StateField.define({
    create: () => null,
    update(ghost, tr) {
      for (const e of tr.effects) if (e.is(setGhost)) return e.value;
      if (!ghost) return ghost;
      if (tr.docChanged) {
        // Typing the suggestion's own next characters keeps the rest of it.
        let typed = null;
        let count = 0;
        tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { count++; if (fromA === ghost.pos && toA === fromA) typed = inserted.toString(); });
        if (count === 1 && typed && ghost.text.startsWith(typed)) return ghost.text.length > typed.length ? { pos: ghost.pos + typed.length, text: ghost.text.slice(typed.length) } : null;
        return null;
      }
      if (tr.selection && tr.state.selection.main.head !== ghost.pos) return null;
      return ghost;
    },
    provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new Ghost(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
  });
  const { completionStatus, hasNextSnippetField } = mide.cm.autocomplete;
  const takeGhost = (v) => {
    const g = v.state.field(ghostField, false);
    // An open completion list or a snippet's next field gets Tab first.
    if (!g || completionStatus(v.state) || hasNextSnippetField(v.state)) return false;
    v.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, effects: setGhost.of(null), userEvent: 'input.ai' });
    return true;
  };
  const dropGhost = (v) => {
    if (!v.state.field(ghostField, false) || completionStatus(v.state)) return false; // Esc closes the list first
    v.dispatch({ effects: setGhost.of(null) });
    return true;
  };
  mide.editor.addExtension([ghostField, Prec.highest(keymap.of([{ key: 'Tab', run: takeGhost }, { key: 'Escape', run: dropGhost }]))]);

  let suggestController = null;
  async function suggest(v, { auto = false } = {}) {
    suggestController?.abort();
    const editor = editorFor(v);
    if (!editor) return;
    if (auto ? !consented() : !(await ensureReady())) return;
    const { state } = v;
    const pos = state.selection.main.head;
    const before = state.sliceDoc(Math.max(0, pos - 8000), pos);
    const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 2000));
    const ctx = contextOf(editor, false);
    const controller = suggestController = new AbortController();
    setBusy(1);
    try {
      const res = await mide.ai.request({
        ...modelOptions('suggest'),
        system: SUGGEST_SYSTEM,
        messages: [{ role: 'user', content: `File: ${ctx.file} (${ctx.language})\n\n${before}<cursor/>${after}` }],
        maxTokens: 4096,
      }, { signal: controller.signal });
      if (controller.signal.aborted || v.state.doc !== state.doc || v.state.selection.main.head !== pos) return;
      if (res.stopReason === 'max_tokens' || res.refusal) return;
      const text = cleanSuggestion(textOf(res.content), before);
      if (text) v.dispatch({ effects: setGhost.of({ pos, text }) });
      else if (!auto) mide.notify.info('No suggestion here');
    } catch (err) {
      if (err.kind !== 'cancelled' && !auto) mide.notify.error('Couldn\'t get a suggestion', err.message);
    } finally {
      if (suggestController === controller) suggestController = null;
      setBusy(-1);
    }
  }

  // Models sometimes wrap the answer in a code block or repeat the start of the line.
  function cleanSuggestion(text, before) {
    let t = text.replace(/^\s*(`{3,})[^\n]*\n([\s\S]*?)\n?\s*\1\s*$/, '$2').replace(/\s+$/, '');
    const lineStart = before.slice(before.lastIndexOf('\n') + 1);
    if (lineStart.trim() && t.startsWith(lineStart)) t = t.slice(lineStart.length);
    return t;
  }

  let typingTimer = null;
  mide.workspace.onDidUpdateEditor((editor, update) => {
    if (!update?.docChanged) return;
    clearTimeout(typingTimer);
    suggestController?.abort();
    if (!cfg('suggestAsYouType') || !update.transactions.some((tr) => tr.isUserEvent('input.type'))) return;
    typingTimer = setTimeout(() => { if (editor.view?.hasFocus) suggest(editor.view, { auto: true }); }, 800);
  });

  // ---------------------------------------------------------------------------
  // Commands

  const withEditor = () => !!mide.workspace.getActiveEditor();
  mide.commands.add({
    'ai:chat': { title: 'Open Chat', category: 'AI', run: () => openChat() },
    'ai:new-chat': { title: 'New Chat', category: 'AI', run: () => { newChat(); openChat(); } },
    'ai:explain': { title: 'Explain This Code', category: 'AI', when: withEditor, run: explain },
    'ai:edit-selection': { title: 'Edit Selection…', category: 'AI', when: withEditor, run: () => editRange({}) },
    'ai:fix': { title: 'Fix Problem Here', category: 'AI', when: withEditor, run: fixHere },
    'ai:suggest': { title: 'Suggest Code Here', category: 'AI', when: withEditor, run: () => suggest(mide.workspace.getActiveEditor().view) },
    'ai:toggle-suggest-as-you-type': { title: 'Toggle Suggest as You Type', category: 'AI', run: () => mide.config.set('ai.suggestAsYouType', !cfg('suggestAsYouType')) },
    'ai:choose-model': { title: 'Choose Model…', category: 'AI', run: chooseModel },
    'ai:set-key': { title: 'Set API Key…', category: 'AI', run: setKey },
    'ai:clear-key': {
      title: 'Remove Saved API Key', category: 'AI',
      run: async () => { await mide.ai.clearKey(); mide.notify.info('Removed the saved API key'); },
    },
  });

  mide.subscriptions.add({ dispose: () => { chat.controller?.abort(); suggestController?.abort(); clearTimeout(typingTimer); } });
  refreshContext();
}
