// Markdown Preview: a custom pane item (not a text editor) rendered with marked
// and sanitized with DOMPurify. A good reference for building your own item types.
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

export function activate(mide) {
  const { h } = mide.ui;
  const previews = new Map(); // editor -> PreviewItem

  marked.setOptions({ gfm: true, breaks: false });

  class PreviewItem {
    constructor(editor) {
      this.type = 'markdown-preview';
      this.id = `md-preview-${Math.random().toString(36).slice(2)}`;
      this.iconName = 'eye';
      this.editor = editor;
      this.listeners = new Map();
      this.quiet = { editor: 0, preview: 0 }; // until when a side's scroll events are our own doing
      this.body = h('article.markdown-body');
      this.element = h('div.md-preview', { tabIndex: -1 }, this.body);
      this.element.addEventListener('click', (e) => this.onClick(e));
      this.element.addEventListener('scroll', () => this.onScroll('preview', () => this.fromPreview()), { passive: true });
      this.render();
    }
    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    getTitle() { return `Preview ${this.editor.getTitle()}`; }
    getElement() { return this.element; }
    focus() { this.element.focus(); }
    serialize() { return null; }
    render() {
      if (!this.editor.view) return;
      // Each top-level block remembers the source line it starts on, for scroll syncing.
      let html = '';
      let line = 1;
      for (const token of marked.lexer(this.editor.getText())) {
        html += marked.parser([token]).replace(/^<([a-z][\w-]*)/i, `<$1 data-line="${line}"`);
        line += (token.raw.match(/\n/g) || []).length;
      }
      // No inline styles (they could overlay fake UI) and no element that can load a remote file
      // other than <img src>, which is checked below.
      this.body.innerHTML = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'picture', 'source', 'video', 'audio', 'track', 'link', 'meta'],
        FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'formaction', 'action', 'xlink:href'],
      });
      // Remote images would tell their server when you opened this file, so they're opt-in.
      const remote = mide.config.get('markdown-preview.remoteImages');
      for (const img of this.body.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        const allowed = src.startsWith('data:') || (remote && src.startsWith('https:'));
        if (!allowed) img.replaceWith(h('span.md-img-placeholder', { title: src }, `🖼 ${img.alt || src}${src.startsWith('https:') ? ' (remote image blocked)' : ''}`));
      }
      // Give headings GitHub-style ids so #section links work.
      const used = new Map();
      for (const el of this.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        const base = el.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
        const n = used.get(base) || 0;
        used.set(base, n + 1);
        el.id = n ? `${base}-${n}` : base;
      }
    }
    // --- scroll syncing: editor and preview follow each other, matched by source line ---
    blocks() { return [...this.body.children].filter((el) => el.dataset.line).map((el) => ({ line: +el.dataset.line, el })); }
    top(el) { return el.getBoundingClientRect().top - this.element.getBoundingClientRect().top + this.element.scrollTop; }
    // Moving one side makes the other fire a scroll event; ignore those so they don't bounce back.
    scrollTo(el, y, side) {
      this.quiet[side] = performance.now() + 150;
      el.scrollTop = y;
    }
    fromEditor() {
      const view = this.editor.view;
      const blocks = this.blocks();
      if (!view || !blocks.length || !mide.config.get('markdown-preview.syncScroll')) return;
      const scroller = view.scrollDOM;
      const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
      const y = Math.max(0, scroller.scrollTop - view.documentPadding.top);
      const lb = view.lineBlockAtHeight(y);
      const line = view.state.doc.lineAt(lb.from).number + Math.min(1, (y - lb.top) / Math.max(1, lb.height));
      const i = blocks.findLastIndex((b) => b.line <= line);
      let target = 0;
      if (atEnd) target = this.element.scrollHeight;
      else if (i >= 0) {
        const last = i === blocks.length - 1;
        const from = this.top(blocks[i].el);
        const to = last ? from + blocks[i].el.offsetHeight : this.top(blocks[i + 1].el);
        const end = last ? view.state.doc.lines + 1 : blocks[i + 1].line;
        target = from + Math.min(1, (line - blocks[i].line) / Math.max(1, end - blocks[i].line)) * (to - from);
      }
      this.scrollTo(this.element, target, 'preview');
    }
    fromPreview() {
      const view = this.editor.view;
      const blocks = this.blocks();
      if (!view || !blocks.length || !mide.config.get('markdown-preview.syncScroll')) return;
      const y = this.element.scrollTop;
      const atEnd = y >= this.element.scrollHeight - this.element.clientHeight - 1;
      const i = blocks.findLastIndex((b) => this.top(b.el) <= y + 1);
      let target = 0;
      if (atEnd) target = view.scrollDOM.scrollHeight;
      else if (i >= 0) {
        const last = i === blocks.length - 1;
        const from = this.top(blocks[i].el);
        const to = last ? from + blocks[i].el.offsetHeight : this.top(blocks[i + 1].el);
        const end = last ? view.state.doc.lines + 1 : blocks[i + 1].line;
        const line = blocks[i].line + Math.min(1, (y - from) / Math.max(1, to - from)) * (end - blocks[i].line);
        const lb = view.lineBlockAt(view.state.doc.line(Math.min(view.state.doc.lines, Math.floor(line))).from);
        target = lb.top + (line % 1) * lb.height + view.documentPadding.top;
      }
      this.scrollTo(view.scrollDOM, target, 'editor');
    }
    // Run at most once a frame, and not for scrolls we caused ourselves.
    onScroll(side, sync) {
      if (performance.now() < this.quiet[side] || this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; sync(); });
    }
    // Clicking text in the preview puts the editor's cursor on that block's first line.
    jumpToSource(e) {
      const view = this.editor.view;
      let el = e.target;
      while (el && el.parentElement !== this.body) el = el.parentElement;
      if (!view || !el?.dataset.line || !mide.config.get('markdown-preview.syncScroll') || window.getSelection().toString()) return;
      this.quiet.editor = performance.now() + 150; // don't let the editor's scroll move the preview
      const anchor = view.state.doc.line(Math.min(+el.dataset.line, view.state.doc.lines)).from;
      view.dispatch({ selection: { anchor }, effects: mide.cm.view.EditorView.scrollIntoView(anchor, { y: 'nearest', yMargin: 40 }) });
    }
    onClick(e) {
      const a = e.target.closest('a');
      if (!a) return this.jumpToSource(e);
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:|^mailto:/.test(href)) return mide.shell.openExternal(href);
      const decode = (t) => { try { return decodeURIComponent(t); } catch { return t; } }; // e.g. "#100%"
      if (href.startsWith('#')) {
        const target = this.body.querySelector(`[id="${CSS.escape(decode(href.slice(1)))}"]`);
        return target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // other schemes (javascript:, file:…) are ignored
      const base = mide.path.dirname(this.editor.getPath() || '');
      const file = decode(href.split('#')[0]); // marked percent-encodes spaces / accents
      if (!file) return;
      const parts = [];
      for (const seg of (file.startsWith('/') ? file : `${base}/${file}`).split('/')) {
        if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
      }
      mide.workspace.open('/' + parts.join('/'));
    }
    destroy() {
      previews.delete(this.editor);
      cancelAnimationFrame(this.frame);
      this.scrollOff?.();
    }
  }

  const isMarkdown = (editor) => editor && /markdown/i.test(editor.getLanguageName());

  mide.commands.add('markdown-preview:toggle', 'Toggle Markdown Preview', async () => {
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return;
    const existing = previews.get(editor);
    if (existing) return mide.workspace.closeItem(existing);
    if (!isMarkdown(editor)) return mide.notify.info('Markdown Preview works with Markdown files.');
    const item = new PreviewItem(editor);
    previews.set(editor, item);
    const off = editor.on('destroyed', () => { off.dispose(); if (previews.get(editor) === item) mide.workspace.closeItem(item); });
    const panes = mide.workspace.getPanes();
    const current = panes.find((p) => p.items.includes(editor));
    const target = panes[panes.indexOf(current) + 1] || mide.workspace.splitRight({ empty: true });
    mide.workspace.openItem(item, { pane: target });
    const onScroll = () => item.onScroll('editor', () => item.fromEditor());
    editor.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    item.scrollOff = () => editor.view?.scrollDOM.removeEventListener('scroll', onScroll);
    requestAnimationFrame(() => { item.fromEditor(); editor.focus(); });
  }, { when: () => isMarkdown(mide.workspace.getActiveEditor()) });

  const timers = new WeakMap();
  mide.workspace.onDidUpdateEditor((editor, update) => {
    const item = previews.get(editor) || [...previews.values()].find((p) => p.editor.document === editor.document);
    if (!item || !update?.docChanged) return;
    clearTimeout(timers.get(item));
    timers.set(item, setTimeout(() => { item.render(); if (editor.view?.hasFocus) item.fromEditor(); }, 120));
  });
  mide.config.onDidChange('markdown-preview.syncScroll', (on) => { if (on) for (const p of previews.values()) p.fromEditor(); });
  mide.config.onDidChange('markdown-preview.remoteImages', () => { for (const p of previews.values()) p.render(); });
  mide.subscriptions.add({ dispose: () => { for (const p of [...previews.values()]) mide.workspace.closeItem(p); } });
}
