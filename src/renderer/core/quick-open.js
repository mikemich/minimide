// One box for finding anything. ⌘P searches files; typing a prefix switches what it searches:
// ">" commands, "@" symbols in the file, "#" symbols in the project, ":" a line, "?" what's
// available. Packages add modes with mide.ui.addQuickOpenMode(); the keys that used to open
// separate lists (⇧⌘P, ⌘R…) now open this box on their prefix.
import { Disposable } from './events.js';
import { selectList, closeModal, isModalOpen } from './ui.js';

const ID = 'quick-open';

export class QuickOpen {
  constructor(app) {
    this.app = app;
    this.modes = [];
    this.list = null;
    this.addMode(lineMode(app));
    this.addMode(this.help = {
      prefix: '?', title: 'Help', order: 100,
      items: () => this.sortedModes().filter((m) => m.prefix !== '?').map((m) => ({ label: m.prefix ? `${m.prefix}  ${m.title}` : m.title, detail: m.description, prefix: m.prefix || '' })),
      onSelect: (item) => setTimeout(() => this.open(item.prefix), 0),
    });
  }

  /** addMode({ prefix, title, description?, order?, ...selectList options }) */
  addMode(mode) {
    this.modes.push(mode);
    return new Disposable(() => { this.modes = this.modes.filter((m) => m !== mode); });
  }

  sortedModes() { return [...this.modes].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)); }

  open(prefix = '') {
    if (isModalOpen(ID) && this.list) {
      // The same key again closes the box; another one switches it.
      if ((this.list.mode?.prefix || '') === prefix) closeModal();
      else this.list.setQuery(prefix);
      return;
    }
    const modes = this.sortedModes();
    if (!modes.some((m) => !m.prefix)) modes.push({ ...this.help, prefix: '', title: 'Search' }); // file search turned off
    const hints = modes.filter((m) => m.prefix && m.prefix !== '?').map((m) => `${m.prefix} ${m.short || m.title.toLowerCase()}`).join(', ');
    const base = modes.find((m) => !m.prefix);
    this.list = selectList({
      id: ID,
      modes,
      initialQuery: prefix,
      placeholder: `${(typeof base.placeholder === 'function' ? base.placeholder() : base.placeholder) || base.title}. Type ${hints}, ? for help`,
    });
  }
}

// ":42" or ":42:7" jumps to a line (and column) in the open file.
function lineMode(app) {
  return {
    prefix: ':', title: 'Go to line', short: 'line', order: 40,
    description: 'Type a line number, or line:column',
    onQuery: (q) => {
      const editor = app.workspace.getActiveEditor();
      if (!editor) return [{ label: 'Open a file first' }];
      const total = editor.view.state.doc.lines;
      const m = /^(\d+)(?:[:,](\d+))?$/.exec(q.trim());
      if (!m) return [{ label: `Type a line number between 1 and ${total}`, detail: `You're on line ${editor.getCursor().line}` }];
      const line = Math.min(+m[1], total);
      return [{ label: `Go to line ${line}${m[2] ? `, column ${m[2]}` : ''}`, line, col: m[2] ? +m[2] - 1 : 0 }];
    },
    onSelect: (item) => {
      const editor = app.workspace.getActiveEditor();
      if (editor && item.line) editor.goToLine(item.line, item.col);
    },
  };
}
