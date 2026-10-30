// Large files. A file over `editor.largeFileSize` MB, or with a line over 200 KB (minified code), opens
// read-write with its heavy features off: syntax highlighting, bracket matching, word completion and,
// in packages that check isLargeFile(), things like git markers, the minimap or the language server.
// "Turn features on anyway" brings them back for that file. A file over MAX_OPEN_SIZE isn't opened.
import { Facet } from '@codemirror/state';
import { h } from './dom.js';

/** The largest file the editor opens at all: a JavaScript string can't hold much more. */
export const MAX_OPEN_SIZE = 512 * 1024 * 1024;
/** A line longer than this makes a file large whatever its size. */
export const LONG_LINE = 200 * 1024;

/** True in the editors of a large file. Packages read it with isLargeFile() or `state.facet(largeFile)`. */
export const largeFile = Facet.define({ combine: (values) => values.some(Boolean) });

/** Whether an EditorItem, Document, EditorView or EditorState is a large file with its heavy features off. */
export function isLargeFile(target) {
  if (!target) return false;
  if (typeof target.large === 'boolean') return target.large; // Document
  if (target.document) return !!target.document.large; // EditorItem
  const state = target.state || target;
  return typeof state.facet === 'function' && state.facet(largeFile);
}

/** Whether a file of `size` bytes with this text opens as large. `limitMB` 0 turns large files off. */
export function isLargeText(text, size, limitMB) {
  return limitMB > 0 && (size > limitMB * 1024 * 1024 || hasLongLine(text));
}

/** Whether any line is over LONG_LINE characters. */
export function hasLongLine(text) {
  if (text.length <= LONG_LINE) return false;
  const nl = text.includes('\n') ? '\n' : '\r'; // old Mac files end lines with CR alone
  for (let start = 0; start < text.length;) {
    let end = text.indexOf(nl, start);
    if (end < 0) end = text.length;
    if (end - start > LONG_LINE) return true;
    start = end + 1;
  }
  return false;
}

export const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`);

/** The status bar item while the active editor shows a large file, and the notice when one opens. */
export function bindLargeFiles(app) {
  const ws = app.workspace;
  let item = null;
  const notices = new WeakMap(); // doc -> its notice, so there is one at a time
  const offer = (doc) => {
    notices.get(doc)?.close();
    notices.set(doc, app.ui.notify.info(`${doc.title} is a large file`,
      `${doc.size ? `It is ${formatSize(doc.size)}${doc.longLines ? ' with very long lines' : ''}. ` : ''}Syntax highlighting, bracket matching, git markers, the language server and other heavy features are off for it, so it stays fast.`,
      { timeout: 10000, actions: [{ label: 'Turn features on anyway', run: () => doc.enableAllFeatures() }] }));
  };
  const update = () => {
    const doc = ws.getActiveEditor()?.document;
    item?.dispose();
    item = doc?.large ? app.statusBar.addItem({
      id: 'large-file', element: h('span.large-file-item', 'Large file: some features are off'), align: 'left', priority: 2,
      tooltip: 'Heavy features are off for this file so it stays fast. Click to turn them on.',
      onClick: () => offer(doc),
    }) : null;
  };
  ws.on('active-item-changed', update);
  ws.on('large-file-changed', update);
  ws.on('document-opened', (doc) => { if (doc.large) offer(doc); });
  app.commands.add('editor:enable-all-features', 'Turn Features On for This Large File', () => ws.getActiveEditor()?.document.enableAllFeatures(),
    { when: () => !!ws.getActiveEditor()?.isLarge() });
  update();
}
