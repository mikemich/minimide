// Symbols for every editor, behind the `symbols` service (breadcrumbs, the Outline view…). They come
// from the language server when one is attached (through the lsp service) and otherwise from the
// syntax tree (syntax-symbols.js). Nothing is computed until a package asks for an editor's symbols or
// watches editors; then they're computed once typing pauses and reused, with positions moved through
// edits, until the text changes again.
import { ViewPlugin, EditorView } from '@codemirror/view';
import * as lang from '@codemirror/language';
import { Disposable } from './events.js';
import { icon, registerIcon } from './dom.js';
import { syntaxSymbols, pathAt } from './syntax-symbols.js';
import { largeFile } from './large-files.js';

const DELAY = 300; // ms after the last edit before symbols are computed again

/** Returns { extension, service }: the extension goes on every editor, the service is `symbols`. */
export function symbolTracker(app) {
  const editorFor = (view) => app.workspace.allItems().find((i) => i.view === view) || null;
  const lsp = () => app.packages?.services.get('lsp');
  const trackers = new Set();
  const watchers = new Set(); // fn(editor) -> true while it shows that editor's symbols
  const changeListeners = new Set();

  class Tracker {
    constructor(view) {
      this.view = view;
      this.snapshot = null; // { symbols, source, doc, partial?, language? }
      this.mapping = null; // edits since the symbols' positions were last moved (see sync())
      this.dirty = true;
      this.seq = 0;
      this.timer = null;
      this.pending = null;
      this.reqChanges = undefined; // edits made while a computation runs
      trackers.add(this);
      this.schedule(20);
    }

    update(u) {
      if (u.docChanged) {
        if (this.snapshot) this.mapping = this.mapping ? this.mapping.compose(u.changes) : u.changes;
        if (this.reqChanges !== undefined) this.reqChanges = this.reqChanges ? this.reqChanges.compose(u.changes) : u.changes;
        this.dirty = true;
        this.schedule(DELAY);
      } else if (this.snapshot?.source === 'syntax' && (this.snapshot.partial || u.state.facet(lang.language) !== this.snapshot.language)
        && lang.syntaxTree(u.startState) !== lang.syntaxTree(u.state)) {
        // The language just loaded, or the parser got further than last time.
        this.dirty = true;
        this.schedule(DELAY);
      } else if (u.startState.facet(largeFile) !== u.state.facet(largeFile)) { // a large file's features were turned on
        this.dirty = true;
        this.schedule(0);
      } else if (this.dirty && (u.geometryChanged || u.viewportChanged)) this.schedule(100); // shown again
    }

    wanted() {
      const { view } = this;
      if (!watchers.size || !view.dom.isConnected || !view.dom.getClientRects().length) return false;
      const editor = editorFor(view);
      return !!editor && [...watchers].some((fn) => { try { return fn(editor); } catch { return false; } });
    }

    schedule(delay) {
      clearTimeout(this.timer);
      if (watchers.size) this.timer = setTimeout(() => { if (this.dirty && this.wanted()) this.compute(); }, delay);
    }

    /** Recompute now if the text changed since last time and someone shows the result. */
    refresh() { if (this.dirty && this.wanted()) this.compute(); }

    compute() {
      clearTimeout(this.timer);
      const seq = ++this.seq;
      const { view } = this;
      const doc = view.state.doc;
      this.dirty = false;
      this.reqChanges = null;
      this.pending = (async () => {
        // A large file has none: it isn't parsed and no server opens it.
        if (view.state.facet(largeFile)) { this.reqChanges = undefined; this.snapshot = { symbols: [], source: 'syntax', doc }; this.mapping = null; emitChange(this); return; }
        const server = lsp();
        const editor = editorFor(view);
        let fromServer = null;
        if (server?.documentSymbols && editor) {
          try { fromServer = await server.documentSymbols(editor); } catch {}
        }
        if (seq !== this.seq || !trackers.has(this)) return;
        let snap = fromServer?.symbols.length ? { symbols: fromServer.symbols, source: 'lsp', doc: fromServer.doc } : null;
        if (!snap) {
          const { symbols, partial } = syntaxSymbols(view.state, lang);
          snap = symbols.length || !fromServer
            ? { symbols, source: 'syntax', doc: view.state.doc, partial, language: view.state.facet(lang.language) }
            : { symbols: [], source: 'lsp', doc: fromServer.doc };
        }
        let mapping = null;
        if (snap.doc !== view.state.doc) {
          // Typed while the server answered: move its positions through what was typed since.
          if (snap.doc !== doc || !this.reqChanges) { this.dirty = true; this.schedule(DELAY); return; }
          mapping = this.reqChanges;
        }
        this.reqChanges = undefined;
        this.snapshot = snap;
        this.mapping = mapping;
        emitChange(this);
      })();
      return this.pending;
    }

    async ensure() {
      if (this.dirty || !this.snapshot) await this.compute();
      else if (this.pending) await this.pending;
      return this.current();
    }

    /**
     * The symbols with positions in the current text. They're moved in place, once per batch of edits
     * and only when asked for, so the same objects last until the symbols are computed again. Typing
     * at either edge of a symbol stays inside it.
     */
    current() {
      const snap = this.snapshot;
      if (snap && this.mapping) {
        const m = this.mapping;
        const move = (list) => { for (const s of list) { s.from = m.mapPos(s.from, -1); s.to = m.mapPos(s.to, 1); s.selFrom = m.mapPos(s.selFrom, -1); s.selTo = m.mapPos(s.selTo, 1); move(s.children); } };
        move(snap.symbols);
        this.mapping = null;
      }
      return snap;
    }

    destroy() { trackers.delete(this); clearTimeout(this.timer); this.seq++; }
  }

  const extension = ViewPlugin.fromClass(Tracker);
  const trackerFor = (editor) => (editor?.view ? editor.view.plugin(extension) : null);

  function emitChange(tracker) {
    const editor = editorFor(tracker.view);
    if (editor) for (const fn of [...changeListeners]) { try { fn(editor); } catch (err) { console.error('[symbols]', err); } }
  }

  // A server that just opened this document has better symbols than the syntax tree.
  app.packages.services.consume('lsp', (server) => {
    server.onDidAttach?.((doc) => {
      for (const t of trackers) {
        if (editorFor(t.view)?.document !== doc) continue;
        t.dirty = true;
        t.schedule(0);
      }
    });
  });

  const service = {
    /** { symbols, source: 'lsp' | 'syntax' } for an editor, computed now if needed; null for other items. */
    async getSymbols(editor) {
      const snap = await trackerFor(editor)?.ensure();
      return snap ? { symbols: snap.symbols, source: snap.source } : null;
    },
    /** The last computed symbols, without computing anything: { symbols, source } or null. */
    peek(editor) {
      const snap = trackerFor(editor)?.current();
      return snap ? { symbols: snap.symbols, source: snap.source } : null;
    },
    /** The symbols around `pos` (default: the cursor), outermost first, from the last computed symbols. */
    symbolPathAt(editor, pos) {
      const tracker = trackerFor(editor);
      const snap = tracker?.current();
      return snap ? pathAt(snap.symbols, pos ?? tracker.view.state.selection.main.head) : [];
    },
    /**
     * Keep symbols up to date (computed again once typing pauses) for the editors where `fn(editor)`
     * is true: the ones a package shows symbols for. Returns a Disposable.
     */
    watch(fn) {
      watchers.add(fn);
      setTimeout(() => { for (const t of trackers) t.refresh(); }, 0);
      return new Disposable(() => watchers.delete(fn));
    },
    /** Compute an editor's symbols now if its text changed and a watcher shows them. */
    refresh(editor) { trackerFor(editor)?.refresh(); },
    /** `fn(editor)` whenever an editor's symbols were computed again. */
    onDidChange(fn) { changeListeners.add(fn); return new Disposable(() => changeListeners.delete(fn)); },
    /** Select a symbol's name in its editor, scrolled to the middle, and focus it. */
    reveal(editor, sym) {
      trackerFor(editor)?.current(); // positions moved through what was typed since
      const { view } = editor;
      const pos = Math.min(sym.selFrom, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select.symbol' });
      view.focus();
    },
  };
  return { extension, service };
}

// Kind -> [icon, color]. Icons are drawn here so they follow the theme's colors.
registerIcon('sym-class', '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>');
registerIcon('sym-function', '<path d="M14 4h-1a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H6"/><path d="M7 11h8"/>');
registerIcon('sym-property', '<path d="M5 19l7-7"/><circle cx="15.5" cy="8.5" r="4"/>');
registerIcon('sym-variable', '<path d="M7 5L4 12l3 7M17 5l3 7-3 7"/><path d="M9.5 9l5 6M14.5 9l-5 6"/>');
registerIcon('sym-constant', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h8"/>');
registerIcon('sym-interface', '<circle cx="7" cy="12" r="3.5"/><path d="M10.5 12H21"/>');
registerIcon('sym-enum', '<rect x="3" y="4" width="8" height="8" rx="1.5"/><path d="M14 6h7M14 10h7M6 16h15M6 20h15"/>');
registerIcon('sym-module', '<path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1"/>');
registerIcon('sym-key', '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>');
registerIcon('sym-heading', '<path d="M6 4v16M18 4v16M6 12h12"/>');
registerIcon('sym-selector', '<path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2"/><circle cx="12" cy="12" r="1.5"/>');
registerIcon('sym-symbol', '<circle cx="12" cy="12" r="3.5"/>');

const KINDS = {
  class: ['sym-class', 'orange'], struct: ['sym-class', 'orange'], object: ['sym-module', 'orange'],
  method: ['sym-function', 'magenta'], function: ['sym-function', 'magenta'], constructor: ['sym-function', 'orange'], operator: ['sym-function', 'magenta'], event: ['sym-function', 'yellow'],
  property: ['sym-property', 'blue'], field: ['sym-property', 'blue'],
  variable: ['sym-variable', 'blue'], 'type parameter': ['sym-variable', 'cyan'],
  constant: ['sym-constant', 'blue'], string: ['sym-key', 'green'], number: ['sym-key', 'orange'], boolean: ['sym-key', 'cyan'], null: ['sym-key', 'muted'], array: ['sym-module', 'cyan'],
  interface: ['sym-interface', 'cyan'], type: ['sym-interface', 'cyan'],
  enum: ['sym-enum', 'yellow'], 'enum member': ['sym-enum', 'yellow'],
  module: ['sym-module', 'muted'], namespace: ['sym-module', 'muted'], package: ['sym-module', 'muted'], file: ['sym-module', 'muted'],
  key: ['sym-key', 'yellow'], heading: ['sym-heading', 'blue'], selector: ['sym-selector', 'green'],
};

/** A colored icon for a symbol kind ('class', 'method', 'heading'…), titled with the kind. */
export function symbolIcon(kind, size = 14) {
  const [name, color] = KINDS[kind] || ['sym-symbol', 'muted'];
  const el = icon(name, size);
  el.dataset.color = color;
  el.title = kind;
  return el;
}
