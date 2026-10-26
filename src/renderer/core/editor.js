// Text documents and CodeMirror-backed editor items.
// A Document is a file; an EditorItem is one view of it in a pane. Several views of
// the same Document stay in sync, which is what makes split panes work.
import { EditorState, Compartment, Annotation, Transaction, Text } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, scrollPastEnd, highlightWhitespace,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, indentUnit, LanguageDescription,
} from '@codemirror/language';
import { languages as builtinLanguages } from '@codemirror/language-data';
import { installExtraLanguages } from './extra-languages.js';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { classHighlighter, tagHighlighter, tags as t } from '@lezer/highlight';

// Extra token classes on top of classHighlighter so CSS-only themes can style more.
const richHighlighter = tagHighlighter([
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function tok-definition' },
  { tag: t.tagName, class: 'tok-tagName' },
  { tag: t.attributeName, class: 'tok-attributeName' },
  { tag: t.attributeValue, class: 'tok-attributeValue' },
  { tag: t.self, class: 'tok-self' },
  { tag: t.null, class: 'tok-null' },
  { tag: t.constant(t.variableName), class: 'tok-constant' },
  { tag: t.standard(t.variableName), class: 'tok-builtin' },
  { tag: t.controlKeyword, class: 'tok-controlKeyword' },
  { tag: [t.definitionKeyword, t.modifier], class: 'tok-modifier' },
  { tag: t.docComment, class: 'tok-docComment' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.escape, class: 'tok-escape' },
  { tag: t.regexp, class: 'tok-regexp' },
]);
import { Emitter } from './events.js';
import { h, basename } from './dom.js';

const syncAnnotation = Annotation.define();

export const languages = [...builtinLanguages];
// Shell gets richer token types than the stock legacy mode (see shell-language.js).
{
  const i = languages.findIndex((l) => l.name === 'Shell');
  if (i >= 0) {
    const stock = languages[i];
    languages[i] = LanguageDescription.of({
      name: stock.name, alias: stock.alias, extensions: stock.extensions, filename: stock.filename,
      load: () => import('./shell-language.js').then((m) => m.shellLanguage),
    });
  }
}
installExtraLanguages(languages);

export function registerLanguage(desc) {
  const d = desc instanceof LanguageDescription ? desc : LanguageDescription.of(desc);
  languages.unshift(d);
  return { dispose: () => { const i = languages.indexOf(d); if (i >= 0) languages.splice(i, 1); } };
}

export function detectLanguage(path, firstLine = '') {
  if (!path) return null;
  const name = basename(path);
  let desc = LanguageDescription.matchFilename(languages, name);
  if (!desc && /^#!.*\b(node|deno|bun)\b/.test(firstLine)) desc = languages.find((l) => l.name === 'JavaScript');
  if (!desc && /^#!.*\b(ba|z)?sh\b/.test(firstLine)) desc = languages.find((l) => l.name === 'Shell');
  if (!desc && /^#!.*\bpython/.test(firstLine)) desc = languages.find((l) => l.name === 'Python');
  return desc || null;
}

let nextId = 1;

/** The file's dominant line ending, so one stray CRLF doesn't convert the whole file. */
function detectLineEnding(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export class Document extends Emitter {
  constructor(path, text = '') {
    super();
    this.id = nextId++;
    this.path = path;
    this.initialText = text;
    this.savedDoc = Text.of(text.split(/\r?\n/));
    this.lineEnding = detectLineEnding(text);
    this.dirty = false;
    this.views = new Set();
    this.language = detectLanguage(path, text.slice(0, 200).split('\n')[0]);
    this.conflict = false;
  }

  get title() { return (this.path ? basename(this.path) : 'untitled') + (this.deleted ? ' (deleted)' : ''); }

  /** The authoritative state: any attached view (they are all identical in content). */
  primaryView() { return this.views.values().next().value?.view; }
  getText() { return this.primaryView()?.state.doc.toString() ?? this.initialText; }

  updateDirty() {
    const doc = this.primaryView()?.state.doc;
    if (!doc) return;
    // A file deleted on disk counts as unsaved, so closing it asks first.
    const dirty = this.deleted || doc.length !== this.savedDoc.length || !doc.eq(this.savedDoc);
    if (dirty !== this.dirty) {
      this.dirty = dirty;
      this.emit('dirty', dirty);
    }
  }

  markSaved(text) {
    this.savedDoc = Text.of(text.split(/\r?\n/));
    this.conflict = false;
    this.deleted = false;
    const doc = this.primaryView()?.state.doc;
    this.dirty = doc ? doc.length !== this.savedDoc.length || !doc.eq(this.savedDoc) : false;
    this.emit('dirty', this.dirty);
  }

  /** Text as it should be written to disk (preserves CRLF files). */
  getTextForSave() {
    const doc = this.primaryView()?.state.doc;
    return doc ? doc.sliceString(0, doc.length, this.lineEnding) : this.initialText;
  }

  setPath(path) {
    this.path = path;
    this.language = detectLanguage(path, this.getText().slice(0, 200).split('\n')[0]);
    this.emit('path', path);
    for (const item of this.views) item.applyLanguage();
  }

  /** Replace content from disk without losing scroll/selection when possible. */
  reloadFrom(text) {
    const view = this.primaryView();
    if (!view) return;
    const next = text.replace(/\r\n?/g, '\n'); // the editor buffer always uses \n
    const current = view.state.doc.toString();
    if (current !== next) {
      // Replace only the changed middle so cursors, folds and scroll stay where they were.
      let start = 0;
      while (start < current.length && start < next.length && current[start] === next[start]) start++;
      let endA = current.length;
      let endB = next.length;
      while (endA > start && endB > start && current[endA - 1] === next[endB - 1]) { endA--; endB--; }
      view.dispatch({ changes: { from: start, to: endA, insert: next.slice(start, endB) }, annotations: Transaction.addToHistory.of(true) });
    }
    this.lineEnding = detectLineEnding(text);
    this.deleted = false;
    this.markSaved(text);
  }
}

/** Shared compartments so config changes apply to every editor at once. */
export const compartments = {
  language: () => new Compartment(),
  tabSize: new Compartment(),
  lineWrapping: new Compartment(),
  lineNumbers: new Compartment(),
  activeLine: new Compartment(),
  whitespace: new Compartment(),
  scrollPastEnd: new Compartment(),
  plugins: new Compartment(),
  readOnly: new Compartment(),
};

export class EditorItem extends Emitter {
  constructor(document, workspace, sourceView) {
    super();
    this.type = 'editor';
    this.id = `editor-${nextId++}`;
    this.document = document;
    this.workspace = workspace;
    this.langCompartment = compartments.language();
    this.element = h('div.editor-item');
    document.views.add(this);

    const ws = workspace;
    const self = this;
    const state = EditorState.create({
      doc: sourceView ? sourceView.state.doc : document.initialText,
      selection: sourceView ? sourceView.state.selection : undefined,
      extensions: [
        this.langCompartment.of([]),
        ...baseExtensions(ws),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) document.updateDirty();
          if (update.docChanged || update.selectionSet || update.focusChanged) ws.emit('editor-updated', self, update);
          if (update.focusChanged && update.view.hasFocus) ws.focusItem(self);
        }),
      ],
    });

    this.view = new EditorView({
      state,
      parent: this.element,
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        for (const tr of trs) {
          if (tr.changes.empty || tr.annotation(syncAnnotation)) continue;
          for (const other of document.views) {
            if (other === self || !other.view) continue;
            other.view.dispatch({
              changes: tr.changes,
              annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
            });
          }
        }
      },
    });

    this.disposeDirty = document.on('dirty', () => this.emit('title-changed'));
    this.disposePath = document.on('path', () => this.emit('title-changed'));
    this.applyLanguage();
  }

  async applyLanguage() {
    const desc = this.document.language;
    if (!desc) {
      this.view.dispatch({ effects: this.langCompartment.reconfigure([]) });
      this.workspace.emit('editor-updated', this, null);
      return;
    }
    try {
      const support = desc.support || await desc.load();
      if (!this.view) return;
      this.view.dispatch({ effects: this.langCompartment.reconfigure(support) });
      this.workspace.emit('editor-updated', this, null);
    } catch (err) {
      console.warn(`[editor] failed to load language ${desc.name}`, err);
    }
  }

  getTitle() { return this.document.title; }
  getPath() { return this.document.path; }
  getLanguageName() { return this.document.language?.name || 'Plain Text'; }
  isDirty() { return this.document.dirty; }
  getElement() { return this.element; }
  focus() { this.view?.focus(); }
  getText() { return this.view.state.doc.toString(); }

  getSelectedText() {
    const { state } = this.view;
    return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
  }

  insertText(text) {
    this.view.dispatch(this.view.state.replaceSelection(text));
  }

  goToLine(line, col = 0) {
    const { state } = this.view;
    const ln = state.doc.line(Math.max(1, Math.min(line, state.doc.lines)));
    const pos = Math.min(ln.from + col, ln.to);
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
  }

  selectRange(line, col, length) {
    const { state } = this.view;
    const ln = state.doc.line(Math.max(1, Math.min(line, state.doc.lines)));
    const from = Math.min(ln.from + col, ln.to);
    const to = Math.min(from + length, ln.to);
    this.view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    this.view.focus();
  }

  getCursor() {
    const { state } = this.view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1, selections: state.selection.ranges.length, selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0) };
  }

  serialize() {
    const sel = this.view.state.selection.main;
    return { type: 'editor', path: this.document.path, anchor: sel.anchor, head: sel.head, scrollTop: this.view.scrollDOM.scrollTop };
  }

  restore(s) {
    if (!s) return;
    const len = this.view.state.doc.length;
    try {
      this.view.dispatch({ selection: { anchor: Math.min(s.anchor ?? 0, len), head: Math.min(s.head ?? 0, len) } });
      requestAnimationFrame(() => { if (this.view) this.view.scrollDOM.scrollTop = s.scrollTop || 0; });
    } catch {}
  }

  destroy() {
    this.document.views.delete(this);
    this.disposeDirty.dispose();
    this.disposePath.dispose();
    this.view.destroy();
    this.view = null;
    this.emit('destroyed');
  }
}

function baseExtensions(ws) {
  const cfg = ws.config;
  return [
    compartments.lineNumbers.of(cfg.get('editor.showLineNumbers') ? [lineNumbers(), highlightActiveLineGutter()] : []),
    compartments.activeLine.of(cfg.get('editor.highlightActiveLine') ? highlightActiveLine() : []),
    compartments.tabSize.of(tabExtensions(cfg)),
    compartments.lineWrapping.of(cfg.get('editor.softWrap') ? EditorView.lineWrapping : []),
    compartments.whitespace.of(cfg.get('editor.showInvisibles') ? highlightWhitespace() : []),
    compartments.scrollPastEnd.of(cfg.get('editor.scrollPastEnd') ? scrollPastEnd() : []),
    compartments.readOnly.of([]),
    highlightSpecialChars(),
    history(),
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement('span');
        el.className = `cm-fold-marker ${open ? 'open' : 'closed'}`;
        el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
        return el;
      },
    }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(classHighlighter),
    syntaxHighlighting(richHighlighter),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    compartments.plugins.of(ws.editorExtensions()),
    EditorState.languageData.of(() => [{ autocomplete: ws.extraCompletionSource }]),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
  ];
}

export function tabExtensions(cfg) {
  const size = cfg.get('editor.tabSize');
  return [EditorState.tabSize.of(size), indentUnit.of(cfg.get('editor.softTabs') ? ' '.repeat(size) : '\t')];
}

/** Reconfigure every live editor when a related config value changes. */
export function bindEditorConfig(ws) {
  const cfg = ws.config;
  const all = (effectFn) => {
    for (const item of ws.allItems()) if (item.type === 'editor' && item.view) item.view.dispatch({ effects: effectFn() });
  };
  const subs = [
    cfg.onDidChange('editor.tabSize', () => all(() => compartments.tabSize.reconfigure(tabExtensions(cfg)))),
    cfg.onDidChange('editor.softTabs', () => all(() => compartments.tabSize.reconfigure(tabExtensions(cfg)))),
    cfg.onDidChange('editor.softWrap', (v) => all(() => compartments.lineWrapping.reconfigure(v ? EditorView.lineWrapping : []))),
    cfg.onDidChange('editor.showLineNumbers', (v) => all(() => compartments.lineNumbers.reconfigure(v ? [lineNumbers(), highlightActiveLineGutter()] : []))),
    cfg.onDidChange('editor.highlightActiveLine', (v) => all(() => compartments.activeLine.reconfigure(v ? highlightActiveLine() : []))),
    cfg.onDidChange('editor.showInvisibles', (v) => all(() => compartments.whitespace.reconfigure(v ? highlightWhitespace() : []))),
    cfg.onDidChange('editor.scrollPastEnd', (v) => all(() => compartments.scrollPastEnd.reconfigure(v ? scrollPastEnd() : []))),
  ];
  ws.on('editor-extensions-changed', () => all(() => compartments.plugins.reconfigure(ws.editorExtensions())));
  return subs;
}

/** A read-only placeholder for files we will not open as text. */
// Opening a program would run it, so ask first.
const EXECUTABLE = /\.(exe|com|bat|cmd|ps1|msi|scr|app|command|pkg|dmg|sh|jar|appimage|run|bin|vbs|lnk)$/i;
async function openWithDefaultApp(path) {
  if (EXECUTABLE.test(path) || !/\.[^/]+$/.test(path)) {
    const choice = await window.native.dialog.confirm({
      type: 'warning', message: `Open ${basename(path)}?`,
      detail: 'This looks like a program or installer. Opening it will run it. Only continue if you trust where it came from.',
      buttons: ['Open', 'Cancel'],
    });
    if (choice !== 0) return;
  }
  window.native.shell.openPath(path);
}

export class BinaryItem extends Emitter {
  constructor(path) {
    super();
    this.type = 'binary';
    this.id = `binary-${nextId++}`;
    this.path = path;
    this.element = h('div.placeholder-item',
      h('div.placeholder-title', basename(path)),
      h('p', 'This file is binary or too large to edit here.'),
      h('button.btn', { onclick: () => openWithDefaultApp(path) }, 'Open with default app'));
  }
  getTitle() { return basename(this.path); }
  getPath() { return this.path; }
  getElement() { return this.element; }
  focus() {}
  serialize() { return null; }
  destroy() {}
}
