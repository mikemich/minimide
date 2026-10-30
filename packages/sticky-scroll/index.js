// Sticky Scroll: shows the enclosing scope headers above the first visible line.
// Scopes come from indentation, so it works for every language; Markdown uses headings.

export function activate(mide) {
  const { ViewPlugin } = mide.cm.view;
  const { syntaxTree } = mide.cm.language;
  const { highlightTree, classHighlighter } = mide.cm.highlight;
  const MAX_SCAN = 3000; // lines to look back for an enclosing header (keeps huge files smooth)
  const instances = new Set();

  const indentOf = (text, tabSize) => {
    let n = 0;
    for (const ch of text) { if (ch === ' ') n++; else if (ch === '\t') n += tabSize - (n % tabSize); else break; }
    return n;
  };
  const isBlank = (t) => !t.trim();
  // Lines that close a block rather than open one.
  const isCloser = (t) => /^\s*[)\]}]/.test(t) || /^\s*(end\b|<\/)/.test(t);

  /** Header lines (outermost first) enclosing line number `n`. */
  function headersFor(state, n, max, markdown) {
    const doc = state.doc;
    const out = [];
    if (markdown) {
      let level = 7;
      for (let i = n - 1; i >= 1 && out.length < max && n - i < MAX_SCAN; i--) {
        const m = /^(#{1,6})\s/.exec(doc.line(i).text);
        if (m && m[1].length < level) { out.unshift(i); level = m[1].length; if (level === 1) break; }
      }
      return out;
    }
    const tab = state.tabSize;
    let line = n;
    while (line <= doc.lines && isBlank(doc.line(line).text)) line++;
    if (line > doc.lines) return out;
    let indent = indentOf(doc.line(line).text, tab);
    for (let i = n - 1; i >= 1 && indent > 0 && n - i < MAX_SCAN; i--) {
      const text = doc.line(i).text;
      if (isBlank(text) || isCloser(text)) continue;
      const ind = indentOf(text, tab);
      if (ind < indent) { out.unshift(i); indent = ind; }
    }
    return out.slice(-max);
  }

  class Sticky {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-sticky';
      this.dom.addEventListener('mousedown', (e) => {
        const row = e.target.closest('.cm-sticky-line');
        if (!row) return;
        e.preventDefault();
        const ln = view.state.doc.line(Number(row.dataset.line));
        view.dispatch({ selection: { anchor: ln.from + indentOf(ln.text, view.state.tabSize) }, scrollIntoView: true });
        view.focus();
      });
      view.dom.appendChild(this.dom);
      instances.add(this);
      this.onScroll = () => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); };
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.onScroll(); // next frame: a plugin added to a live editor is made during an update, when layout can't be read
    }
    update(u) { if (u.docChanged || u.geometryChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.onScroll(); }
    destroy() { instances.delete(this); this.view.scrollDOM.removeEventListener('scroll', this.onScroll); cancelAnimationFrame(this.frame); this.dom.remove(); }

    render() {
      const { view } = this;
      const max = mide.config.get('sticky-scroll.maxLines');
      const scrollTop = view.scrollDOM.scrollTop;
      const lineHeight = view.defaultLineHeight;
      const editor = mide.workspace.getItems().find((i) => i.view === view);
      const markdown = /markdown/i.test(editor?.getLanguageName() || '');
      if (scrollTop < 2 || !max) return this.clear();
      // Lines hidden under the overlay don't count, so settle on a stable header count.
      const top = view.documentTop;
      const lineAt = (offset) => view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - top + offset).from).number;
      let headers = headersFor(view.state, lineAt(0), max, markdown);
      for (let i = 0; i < 2; i++) {
        const next = headersFor(view.state, lineAt(headers.length * lineHeight), max, markdown);
        if (next.join() === headers.join()) break;
        headers = next;
      }
      const first = lineAt(0);
      headers = headers.filter((n) => n < first);
      if (!headers.length) return this.clear();
      const key = headers.join(',');
      const tree = syntaxTree(view.state);
      // Rebuild when the headers, the text, or the parse (late highlighting) change.
      if (this.doc !== view.state.doc || this.tree !== tree) { this.key = ''; this.doc = view.state.doc; this.tree = tree; }
      const gutter = view.dom.querySelector('.cm-gutters');
      const gutterWidth = gutter ? gutter.getBoundingClientRect().width : 0;
      if (key !== this.key) {
        this.key = key;
        this.dom.replaceChildren(...headers.map((n) => this.row(n)));
      }
      // Line numbers end where the real line-number column ends; code starts after all gutters.
      const nums = view.dom.querySelector('.cm-lineNumbers');
      const numEnd = nums && gutter ? nums.getBoundingClientRect().right - gutter.getBoundingClientRect().left : gutterWidth;
      this.dom.style.setProperty('--gutter', `${gutterWidth}px`);
      this.dom.style.setProperty('--num-end', `${numEnd}px`);
      this.dom.style.setProperty('--scroll-left', `${-view.scrollDOM.scrollLeft}px`);
      this.dom.style.top = `${view.scrollDOM.offsetTop}px`; // below panels at the top (breadcrumbs, find)
      this.dom.hidden = false;
    }

    row(n) {
      const { state } = this.view;
      const line = state.doc.line(n);
      const row = document.createElement('div');
      row.className = 'cm-sticky-line';
      row.dataset.line = n;
      const num = document.createElement('span');
      num.className = 'cm-sticky-num';
      num.textContent = n;
      const code = document.createElement('span');
      code.className = 'cm-sticky-code';
      const tree = syntaxTree(state);
      if (tree.length >= line.to) {
        // Highlight just this line's range (no copy of the whole document).
        let pos = line.from;
        const text = (from, to, cls) => { if (to <= from) return; const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = state.sliceDoc(from, to); code.append(s); };
        highlightTree(tree, classHighlighter, (from, to, cls) => { text(pos, from); text(from, to, cls); pos = to; }, line.from, line.to);
        text(pos, line.to);
      } else code.textContent = line.text;
      row.append(num, code);
      return row;
    }

    clear() { this.key = ''; this.dom.hidden = true; this.dom.replaceChildren(); }
  }

  mide.editor.addExtension(ViewPlugin.fromClass(Sticky), { largeFiles: false }); // a header line could be megabytes
  mide.config.onDidChange('sticky-scroll.maxLines', () => { for (const s of instances) { s.key = ''; s.render(); } });

  mide.styles.add(`
    .cm-sticky {
      position: absolute; top: 0; left: 0; right: 0; z-index: 3;
      background: var(--bg); border-bottom: 1px solid var(--border);
      box-shadow: 0 6px 10px -8px rgba(0, 0, 0, 0.45);
      font-family: var(--editor-font); font-size: var(--editor-font-size); line-height: var(--editor-line-height);
      overflow: hidden; cursor: pointer;
    }
    .cm-sticky[hidden] { display: none; }
    .cm-sticky-line { display: flex; white-space: pre; }
    .cm-sticky-line:hover { background: var(--bg-hover); }
    .cm-sticky-num { flex: none; width: var(--num-end); margin-right: calc(var(--gutter) - var(--num-end)); padding-right: 6px; box-sizing: border-box; text-align: right; color: var(--gutter-fg); }
    .cm-sticky-code { padding-left: 6px; transform: translateX(var(--scroll-left)); color: var(--fg); }
  `);
}
