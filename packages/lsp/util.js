// Conversions between CodeMirror and LSP, plus small rendering helpers.

export const toUri = (path) => 'file://' + path.split('/').map(encodeURIComponent).join('/');
export const fromUri = (uri) => (uri.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname) : uri);

/** CodeMirror offset -> LSP position. Both count UTF-16 code units, so columns map 1:1. */
export function toPosition(doc, offset) {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  return { line: line.number - 1, character: offset - line.from };
}

/** LSP position -> CodeMirror offset, clamped to the document. */
export function fromPosition(doc, pos) {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(0, pos.line) + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

/** Offset for an LSP position in a plain string (for files that aren't open). */
export function offsetInText(text, pos) {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  const end = text.indexOf('\n', offset);
  return Math.min(offset + pos.character, end < 0 ? text.length : end);
}

export const COMPLETION_KINDS = {
  1: 'text', 2: 'method', 3: 'function', 4: 'class', 5: 'property', 6: 'variable', 7: 'class', 8: 'interface',
  9: 'namespace', 10: 'property', 11: 'constant', 12: 'constant', 13: 'enum', 14: 'keyword', 15: 'text',
  16: 'constant', 17: 'text', 18: 'variable', 19: 'text', 20: 'enum', 21: 'constant', 22: 'class', 23: 'variable',
  24: 'keyword', 25: 'type',
};

export const SYMBOL_KINDS = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum',
  'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
  'null', 'enum member', 'struct', 'event', 'operator', 'type parameter',
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Tiny, safe Markdown renderer for hover / completion docs (escapes all HTML). */
export function renderMarkdown(md) {
  const out = [];
  const parts = md.split(/```([\w+-]*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) continue;
    if (i % 3 === 2) { if (parts[i].trim()) out.push(`<pre class="lsp-code">${esc(parts[i].replace(/\n$/, ''))}</pre>`); continue; }
    const text = parts[i].trim();
    if (!text) continue;
    for (const para of text.split(/\n{2,}/)) {
      let html = esc(para)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
        .replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/\n/g, '<br>');
      out.push(`<p>${html}</p>`);
    }
  }
  return out.join('');
}

/** Normalize hover contents / documentation into Markdown text. */
export function markupToMarkdown(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(markupToMarkdown).filter(Boolean).join('\n\n');
  if (content.kind) return content.kind === 'markdown' ? content.value : content.value.replace(/[`*_]/g, '\\$&');
  if (content.language) return '```' + content.language + '\n' + content.value + '\n```';
  return content.value || '';
}
