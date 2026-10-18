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
      this.body = h('article.markdown-body');
      this.element = h('div.md-preview', { tabIndex: -1 }, this.body);
      this.element.addEventListener('click', (e) => this.onClick(e));
      this.render();
    }
    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    getTitle() { return `Preview ${this.editor.getTitle()}`; }
    getElement() { return this.element; }
    focus() { this.element.focus(); }
    serialize() { return null; }
    render() {
      if (!this.editor.view) return;
      const html = marked.parse(this.editor.getText());
      this.body.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'] });
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
    syncScroll() {
      const scroller = this.editor.view?.scrollDOM;
      if (!scroller) return;
      const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      this.element.scrollTop = ratio * (this.element.scrollHeight - this.element.clientHeight);
    }
    onClick(e) {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:|^mailto:/.test(href)) return mide.shell.openExternal(href);
      const decode = (t) => { try { return decodeURIComponent(t); } catch { return t; } }; // e.g. "#100%"
      if (href.startsWith('#')) {
        const target = this.body.querySelector(`[id="${CSS.escape(decode(href.slice(1)))}"]`);
        return target?.scrollIntoView({ behavior: 'smooth' });
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
    const onScroll = () => item.syncScroll();
    editor.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    item.scrollOff = () => editor.view?.scrollDOM.removeEventListener('scroll', onScroll);
    requestAnimationFrame(() => editor.focus());
  }, { when: () => isMarkdown(mide.workspace.getActiveEditor()) });

  const timers = new WeakMap();
  mide.workspace.onDidUpdateEditor((editor, update) => {
    const item = previews.get(editor) || [...previews.values()].find((p) => p.editor.document === editor.document);
    if (!item || !update?.docChanged) return;
    clearTimeout(timers.get(item));
    timers.set(item, setTimeout(() => item.render(), 120));
  });
  mide.config.onDidChange('markdown-preview.remoteImages', () => { for (const p of previews.values()) p.render(); });
  mide.subscriptions.add({ dispose: () => { for (const p of [...previews.values()]) mide.workspace.closeItem(p); } });
}
