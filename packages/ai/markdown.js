// A small, safe Markdown renderer for answers: all text is escaped, links only open https pages
// in the browser, and each code block gets the buttons the caller passes in. It copes with
// unfinished input, so it can render an answer while it streams in.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="#" data-href="$2">$1</a>');
}

/** renderMarkdown(text, codeBlock(code, lang) => Node) -> DocumentFragment */
export function renderMarkdown(md, codeBlock) {
  const out = document.createDocumentFragment();
  const add = (html, tag) => { const el = document.createElement(tag); el.innerHTML = html; out.append(el); return el; };
  const lines = md.split('\n');
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) add(para.map(inline).join('<br>'), 'p');
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[j])) code.push(lines[j++]);
      out.append(codeBlock(code.join('\n'), fence[2]));
      i = j; // the closing fence (or the end, while it streams)
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (heading) { flush(); add(inline(heading[2]), `h${Math.min(6, heading[1].length + 2)}`); }
    else if (item) {
      if (para.length) flush();
      const tag = item[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) list = add('', tag);
      const li = document.createElement('li');
      li.innerHTML = inline(item[2]);
      list.append(li);
    } else if (!line.trim()) flush();
    else { list = null; para.push(line); }
  }
  flush();
  return out;
}

/** The text of the first fenced code block, or the whole answer when there is none. */
export function firstCodeBlock(text) {
  const m = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\1[ \t]*(?:\n|$)|(?![\s\S]))/m.exec(text);
  return m ? m[2] : text.trim();
}
