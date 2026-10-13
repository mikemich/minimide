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
      for (const img of this.body.querySelectorAll('img')) {
        if (!/^(https:|data:)/.test(img.getAttribute('src') || '')) {
          img.replaceWith(h('span.md-img-placeholder', `🖼 ${img.alt || img.getAttribute('src')}`));
        }
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
      if (href.startsWith('#')) {
        const target = this.body.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
        return target?.scrollIntoView({ behavior: 'smooth' });
      }
      const base = mide.path.dirname(this.editor.getPath() || '');
      const file = href.split('#')[0];
      if (file) mide.workspace.open(file.startsWith('/') ? file : `${base}/${file}`.replace(/\/\.\//g, '/'));
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
  mide.workspace.onDidCloseItem((item) => {
    const preview = previews.get(item);
    if (preview && !item.view) mide.workspace.closeItem(preview);
  });
  mide.subscriptions.add({ dispose: () => { for (const p of [...previews.values()]) mide.workspace.closeItem(p); } });
}
