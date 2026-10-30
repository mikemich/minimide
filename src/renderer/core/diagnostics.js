// Problems from every source in one place: language servers, task output, your own packages. Each
// source owns a collection of LSP-shaped diagnostics per file ({ range, severity 1-4, message,
// source, code }); the core draws them, merged, in every editor showing the file (underlines and the
// lint gutter), the Problems view lists them and F8 / Shift-F8 walk through them across files.
// Provided as the `diagnostics` service.
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { Disposable } from './events.js';

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/** LSP position -> offset in a CodeMirror doc, clamped to it. */
function offsetOf(doc, pos) {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(0, pos.line) + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

/** Problems order: by file, then position. */
const byPosition = (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;

/** Returns { service, commands }: the `diagnostics` service and the next / previous problem commands. */
export function diagnosticsTracker(app) {
  const ws = app.workspace;
  const collections = new Set();
  const listeners = new Set();
  const dirty = new Set(); // paths whose editors and listeners haven't heard of a change yet
  let queued = false;
  let gutter = null; // the lint gutter, on editors while a collection shows problems there

  function updateGutter() {
    const want = [...collections].some((c) => c.inEditor);
    if (want && !gutter) gutter = ws.addEditorExtension(lintGutter());
    else if (!want && gutter) { gutter.dispose(); gutter = null; }
  }

  function changed(paths) {
    for (const p of paths) dirty.add(p);
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const list = [...dirty];
      dirty.clear();
      for (const p of list) apply(ws.documents.get(p));
      for (const fn of [...listeners]) { try { fn(list); } catch (err) { console.error('[diagnostics]', err); } }
    });
  }

  /** Every collection's problems for `path`, merged (only those shown in editors with `inEditor`). */
  function get(path, inEditor = false) {
    const out = [];
    for (const c of collections) if (!inEditor || c.inEditor) out.push(...(c.files.get(path) || []));
    return out;
  }

  function toCodeMirror(state, d, expand) {
    let from = offsetOf(state.doc, d.range.start);
    let to = Math.max(from, offsetOf(state.doc, d.range.end));
    const word = expand && to === from && state.wordAt(from); // a column alone: underline the word there
    if (word) ({ from, to } = word);
    return {
      from, to,
      severity: SEVERITY[d.severity || 1],
      message: d.message,
      source: [d.source, d.code?.value ?? d.code].filter((x) => x != null && x !== '').join(' ') || undefined,
    };
  }

  function applyView(view, path) {
    const list = [];
    for (const c of collections) {
      if (!c.inEditor) continue;
      for (const d of c.files.get(path) || []) list.push(toCodeMirror(view.state, d, c.expandPoints));
    }
    view.dispatch(setDiagnostics(view.state, list));
  }

  function apply(doc) {
    if (!doc?.path) return;
    for (const item of doc.views) if (item.view) applyView(item.view, doc.path);
  }

  // A new editor (a file opened, or a second view of it) gets what is known about its file.
  ws.on('item-added', (item) => {
    if (item.type !== 'editor') return;
    setTimeout(() => { const path = item.getPath(); if (item.view && path && get(path, true).length) applyView(item.view, path); }, 0);
  });

  const service = {
    /**
     * A collection of problems owned by `name`. `inEditor: false` keeps them out of editors (the
     * Problems view still lists them); `expandPoints` underlines the word at a problem that has only
     * a column. Dispose it when the package stops.
     */
    create(name, { inEditor = true, expandPoints = false } = {}) {
      const files = new Map(); // path -> diagnostics
      const c = {
        name, files, inEditor, expandPoints,
        set(path, list) {
          if (!list?.length) return c.delete(path);
          files.set(path, list);
          changed([path]);
        },
        delete(path) { if (files.delete(path)) changed([path]); },
        clear() { const paths = [...files.keys()]; files.clear(); changed(paths); },
        get: (path) => files.get(path) || [],
        paths: () => [...files.keys()],
        setInEditor(on) {
          if (c.inEditor === !!on) return;
          c.inEditor = !!on;
          updateGutter();
          changed(files.keys());
        },
        dispose() {
          if (!collections.delete(c)) return;
          updateGutter();
          changed(files.keys());
        },
      };
      collections.add(c);
      updateGutter();
      return c;
    },
    get: (path) => get(path),
    /** [{ path, list }] for every file with problems, sorted by path; each list sorted by position. */
    all() {
      const paths = new Set();
      for (const c of collections) for (const [p, list] of c.files) if (list.length) paths.add(p);
      return [...paths].sort((a, b) => a.localeCompare(b)).map((path) => ({ path, list: get(path).sort(byPosition) }));
    },
    counts() {
      let errors = 0, warnings = 0;
      for (const c of collections) for (const list of c.files.values()) for (const d of list) { if ((d.severity || 1) === 1) errors++; else if (d.severity === 2) warnings++; }
      return { errors, warnings };
    },
    /** fn(paths) after problems changed (batched). */
    onDidChange(fn) { listeners.add(fn); return new Disposable(() => listeners.delete(fn)); },
  };

  // --- next / previous problem, across files ---------------------------------------------------
  const any = () => [...collections].some((c) => [...c.files.values()].some((l) => l.length));

  async function step(dir) {
    const flat = service.all().flatMap(({ path, list }) => list.map((d) => ({ path, d })));
    if (!flat.length) return;
    const editor = ws.getActiveEditor();
    const here = editor?.getPath() && editor.view;
    let target;
    if (!here) target = dir > 0 ? flat[0] : flat.at(-1);
    else {
      const { state } = editor.view;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      const cursor = { path: editor.getPath(), d: { range: { start: { line: line.number - 1, character: head - line.from } } } };
      const cmp = (a, b) => a.path.localeCompare(b.path) || byPosition(a.d, b.d);
      target = dir > 0 ? flat.find((e) => cmp(e, cursor) > 0) || flat[0] : flat.findLast((e) => cmp(e, cursor) < 0) || flat.at(-1);
    }
    const item = await ws.open(target.path);
    const view = item?.view;
    if (!view) return;
    const { from } = toCodeMirror(view.state, target.d);
    const severity = SEVERITY[target.d.severity || 1];
    view.dispatch({
      selection: { anchor: from },
      effects: [EditorView.scrollIntoView(from, { y: 'center' }), EditorView.announce.of(`${severity}: ${target.d.message.split('\n')[0]}`)],
    });
    view.focus();
  }

  const commands = {
    'editor:next-problem': { title: 'Go to Next Problem', when: any, run: () => step(1) },
    'editor:previous-problem': { title: 'Go to Previous Problem', when: any, run: () => step(-1) },
  };
  return { service, commands };
}
