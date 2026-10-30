// Merge Conflicts: finds conflict blocks (<<<<<<< / ||||||| / ======= / >>>>>>>) in any open file,
// tints the sections, and puts Accept Current / Incoming / Both / Compare above each block.
// It only looks at the text, so it works in any file, with or without git.

const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const MID = /^={7}\s*$/;
const END = /^>{7}(?: |$)/;

export function activate(mide) {
  const { h } = mide.ui;
  const { EditorView, Decoration, WidgetType } = mide.cm.view;
  const { StateField, Text } = mide.cm.state;
  const { isolateHistory } = mide.cm.commands;

  // --- parsing ---------------------------------------------------------------
  // Markers must start in column 0. A new "<<<<<<<" before the block is closed starts over (an
  // unterminated block is not a conflict); an "=======" inside the incoming side is just text.
  // Offsets: `ours`, `base` and `theirs` are the content between markers, `empty` when it has no
  // lines at all (as opposed to one blank line).
  function scan(doc) {
    const conflicts = [];
    let cur = null;
    let pos = 0;
    for (const text of doc.iterLines()) {
      const from = pos;
      const to = pos + text.length;
      pos = to + 1;
      const c = text.charCodeAt(0);
      if (c !== 60 && c !== 124 && c !== 61 && c !== 62) continue; // < | = >
      if (c === 60 && START.test(text)) cur = { start: { from, to, label: text.slice(8).trim() }, base: null, mid: null, stage: 'ours' };
      else if (!cur) continue;
      else if (c === 124 && cur.stage === 'ours' && BASE.test(text)) { cur.base = { from, to, label: text.slice(8).trim() }; cur.stage = 'base'; }
      else if (c === 61 && cur.stage !== 'theirs' && MID.test(text)) { cur.mid = { from, to }; cur.stage = 'theirs'; }
      else if (c === 62 && cur.stage === 'theirs' && END.test(text)) {
        const end = { from, to, label: text.slice(8).trim() };
        const section = (open, close) => ({ from: open.to + 1, to: close.from - 1, empty: close.from === open.to + 1 });
        const afterOurs = cur.base || cur.mid;
        conflicts.push({
          from: cur.start.from, to: end.to,
          start: cur.start, base: cur.base, mid: cur.mid, end,
          ours: section(cur.start, afterOurs), theirs: section(cur.mid, end),
          baseSection: cur.base ? section(cur.base, cur.mid) : null,
          oursLabel: cur.start.label, theirsLabel: end.label, baseLabel: cur.base?.label || '',
        });
        cur = null;
      }
    }
    return conflicts;
  }

  function decorate(doc, conflicts) {
    const ranges = [];
    const lineDeco = (cls) => Decoration.line({ class: cls });
    const decos = {
      marker: (kind) => lineDeco(`cm-mc-marker cm-mc-marker-${kind}`),
      ours: lineDeco('cm-mc-ours'), base: lineDeco('cm-mc-base'), theirs: lineDeco('cm-mc-theirs'),
    };
    const markers = { ours: decos.marker('ours'), base: decos.marker('base'), mid: decos.marker('mid'), theirs: decos.marker('theirs') };
    const fill = (section, deco) => {
      if (!section || section.empty) return;
      for (let p = section.from; p <= section.to;) {
        const line = doc.lineAt(p);
        ranges.push(deco.range(line.from));
        p = line.to + 1;
      }
    };
    conflicts.forEach((c, index) => {
      ranges.push(Decoration.widget({ widget: new ActionsWidget(index, c), block: true, side: -1 }).range(c.from));
      ranges.push(markers.ours.range(c.start.from));
      fill(c.ours, decos.ours);
      if (c.base) { ranges.push(markers.base.range(c.base.from)); fill(c.baseSection, decos.base); }
      ranges.push(markers.mid.range(c.mid.from));
      fill(c.theirs, decos.theirs);
      ranges.push(markers.theirs.range(c.end.from));
    });
    return Decoration.set(ranges, true);
  }

  const build = (doc) => {
    const conflicts = scan(doc);
    return { conflicts, deco: conflicts.length ? decorate(doc, conflicts) : Decoration.none };
  };

  // With no conflicts in the document, typing never rescans unless an edit touches a line that
  // looks like a marker; with conflicts it rescans (one cheap pass over the lines) on each change.
  const isMarker = (text) => START.test(text) || BASE.test(text) || MID.test(text) || END.test(text);
  function startsBlock(tr) {
    const doc = tr.state.doc;
    let hit = false;
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      for (let n = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; n <= last && !hit; n++) if (isMarker(doc.line(n).text)) hit = true;
    });
    return hit;
  }

  const field = StateField.define({
    create: (state) => build(state.doc),
    update(value, tr) {
      if (!tr.docChanged) return value;
      if (!value.conflicts.length && !startsBlock(tr)) return value;
      return build(tr.state.doc);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  const conflictsOf = (view) => view?.state.field(field, false)?.conflicts || [];

  // --- editing ---------------------------------------------------------------
  const BREAK = Text.of(['', '']);

  /** The replacement for one block: the chosen sides, each ending in a line break. */
  function resolution(doc, c, side) {
    const parts = side === 'current' ? [c.ours] : side === 'incoming' ? [c.theirs] : [c.ours, c.theirs];
    let text = Text.empty;
    for (const p of parts) if (!p.empty) text = text.append(doc.slice(p.from, p.to)).append(BREAK);
    const atEnd = c.to >= doc.length; // a block that ends the file has no line break after it
    if (atEnd && text.length) text = text.slice(0, text.length - 1);
    return { from: c.from, to: atEnd ? c.to : c.to + 1, insert: text };
  }

  function apply(view, list, side) {
    if (!list.length) return false;
    view.dispatch({
      changes: list.map((c) => resolution(view.state.doc, c, side)),
      annotations: isolateHistory.of('full'),
      userEvent: 'input.merge-conflict',
      scrollIntoView: true,
    });
    return true;
  }

  const atCursor = (view) => {
    const head = view.state.selection.main.head;
    return conflictsOf(view).find((c) => head >= c.from && head <= c.to) || null;
  };

  function goTo(view, c) {
    view.dispatch({ selection: { anchor: c.from }, effects: EditorView.scrollIntoView(c.from, { y: 'center' }), userEvent: 'select' });
    view.focus();
  }

  function step(view, dir) {
    const list = conflictsOf(view);
    if (!list.length) return false;
    const head = view.state.selection.main.head;
    let target;
    if (dir > 0) target = list.find((c) => c.from > head) || list[0];
    else target = [...list].reverse().find((c) => c.to < head) || list[list.length - 1];
    goTo(view, target);
    return true;
  }

  // --- the action row above each block --------------------------------------
  class ActionsWidget extends WidgetType {
    constructor(index, c) { super(); this.index = index; this.oursLabel = c.oursLabel; this.theirsLabel = c.theirsLabel; this.hasBase = !!c.base; }
    eq(o) { return o.index === this.index && o.oursLabel === this.oursLabel && o.theirsLabel === this.theirsLabel && o.hasBase === this.hasBase; }
    get estimatedHeight() { return 25; }
    toDOM(view) {
      const act = (name, label, run, title) => h('button', {
        type: 'button', dataset: { action: name }, title, 'aria-label': `${label}, conflict ${this.index + 1}`,
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.preventDefault(); const c = conflictsOf(view)[this.index]; if (c) run(c); view.focus(); },
      }, label);
      const sep = () => h('span.cm-mc-sep', { 'aria-hidden': 'true' }, '|');
      const labels = [this.oursLabel && `Current: ${this.oursLabel}`, this.theirsLabel && `Incoming: ${this.theirsLabel}`].filter(Boolean).join('  ·  ');
      return h('div.cm-mc-actions', { role: 'group', 'aria-label': `Merge conflict ${this.index + 1}` },
        act('current', 'Accept Current', (c) => apply(view, [c], 'current'), 'Keep the current side (above the =======), drop the incoming one'),
        sep(),
        act('incoming', 'Accept Incoming', (c) => apply(view, [c], 'incoming'), 'Keep the incoming side (below the =======), drop the current one'),
        sep(),
        act('both', 'Accept Both', (c) => apply(view, [c], 'both'), 'Keep both sides, current first'),
        sep(),
        act('compare', 'Compare', (c) => openCompare(view, c), 'Compare the two sides side by side'),
        labels ? h('span.cm-mc-labels', { title: labels }, labels) : null);
    }
    ignoreEvent() { return true; }
  }

  mide.editor.addExtension(field);

  // --- compare ------------------------------------------------------------------
  class CompareItem {
    constructor(editor, c) {
      this.type = 'merge-conflict-compare';
      this.iconName = 'split';
      this.editor = editor;
      const doc = editor.view.state.doc;
      this.a = c.ours.empty ? '' : doc.sliceString(c.ours.from, c.ours.to);
      this.b = c.theirs.empty ? '' : doc.sliceString(c.theirs.from, c.theirs.to);
      this.id = `merge-compare-${editor.getPath() || 'untitled'}-${c.from}`;
      this.title = `${mide.path.basename(editor.getPath() || 'untitled')} (conflict)`;
      const btn = (label, side) => h('button.btn.small', { onclick: () => this.accept(side) }, label);
      this.host = h('div.mc-compare-host');
      this.element = h('div.mc-compare', { tabIndex: -1 },
        h('div.mc-compare-toolbar',
          h('span.mc-compare-path', mide.path.basename(editor.getPath() || 'untitled')),
          h('span.mc-compare-side', { dataset: { side: 'current' } }, `Current${c.oursLabel ? `: ${c.oursLabel}` : ''}`),
          h('span.mc-compare-arrow', '↔'),
          h('span.mc-compare-side', { dataset: { side: 'incoming' } }, `Incoming${c.theirsLabel ? `: ${c.theirsLabel}` : ''}`),
          h('div.mc-compare-actions', btn('Accept Current', 'current'), btn('Accept Incoming', 'incoming'), btn('Accept Both', 'both'))),
        this.host);
      this.show();
    }
    getTitle() { return this.title; }
    getElement() { return this.element; }
    focus() { this.element.focus({ preventScroll: true }); }
    serialize() { return null; }
    destroy() { this.destroyed = true; this.view?.destroy(); }
    on() { return { dispose() {} }; }

    /** The same conflict as when this view opened, found again by its text (the file may have been edited since). */
    locate() {
      const view = this.editor.view;
      if (!view) return null;
      const doc = view.state.doc;
      const same = (s, text) => (s.empty ? '' : doc.sliceString(s.from, s.to)) === text;
      return conflictsOf(view).find((c) => same(c.ours, this.a) && same(c.theirs, this.b)) || null;
    }
    accept(side) {
      const c = this.locate();
      if (!c) return mide.notify.info('This conflict has changed', 'Open Compare again from the conflict.');
      apply(this.editor.view, [c], side);
      mide.workspace.closeItem(this);
      mide.workspace.openItem(this.editor);
    }
    async show() {
      const { MergeView } = await mide.cm.extras.merge();
      const { EditorView: View, lineNumbers } = mide.cm.view;
      const { EditorState } = mide.cm.state;
      const { syntaxHighlighting } = mide.cm.language;
      const { classHighlighter } = mide.cm.highlight;
      const lang = this.editor.getPath() ? await mide.editor.languageFor(this.editor.getPath()) : null;
      if (this.destroyed) return;
      const extensions = [lineNumbers(), syntaxHighlighting(classHighlighter), View.editable.of(false), EditorState.readOnly.of(true), lang || []];
      this.view = new MergeView({ parent: this.host, a: { doc: this.a, extensions }, b: { doc: this.b, extensions }, gutter: true, highlightChanges: true });
    }
  }

  function openCompare(view, c) {
    const editor = mide.workspace.getItems().find((i) => i.type === 'editor' && i.view === view);
    if (!editor) return;
    const item = new CompareItem(editor, c);
    const existing = mide.workspace.getItems().find((i) => i.id === item.id);
    if (existing) { item.destroy(); return mide.workspace.openItem(existing); }
    mide.workspace.openItem(item);
  }
  // Turning the package off closes its compare tabs.
  mide.subscriptions.add({ dispose: () => { for (const i of mide.workspace.getItems().filter((x) => x.type === 'merge-conflict-compare')) mide.workspace.closeItem(i); } });

  // --- commands --------------------------------------------------------------
  const activeView = () => mide.workspace.getActiveEditor()?.view || null;
  const hasConflicts = () => conflictsOf(activeView()).length > 0;

  function atCursorOrTell(action) {
    const view = activeView();
    const c = view && atCursor(view);
    if (!c) { mide.notify.info('Put the cursor inside a merge conflict first.', 'F7 jumps to the next one.'); return; }
    action(view, c);
  }

  mide.commands.add({
    'merge-conflicts:next': { title: 'Next Merge Conflict', when: hasConflicts, run: () => step(activeView(), 1) },
    'merge-conflicts:previous': { title: 'Previous Merge Conflict', when: hasConflicts, run: () => step(activeView(), -1) },
    'merge-conflicts:accept-current': { title: 'Accept Current Change', when: hasConflicts, run: () => atCursorOrTell((v, c) => apply(v, [c], 'current')) },
    'merge-conflicts:accept-incoming': { title: 'Accept Incoming Change', when: hasConflicts, run: () => atCursorOrTell((v, c) => apply(v, [c], 'incoming')) },
    'merge-conflicts:accept-both': { title: 'Accept Both Changes', when: hasConflicts, run: () => atCursorOrTell((v, c) => apply(v, [c], 'both')) },
    'merge-conflicts:compare': { title: 'Compare Merge Conflict Sides', when: hasConflicts, run: () => atCursorOrTell((v, c) => openCompare(v, c)) },
    'merge-conflicts:accept-all-current': { title: 'Accept All Current Changes', when: hasConflicts, run: () => apply(activeView(), conflictsOf(activeView()), 'current') },
    'merge-conflicts:accept-all-incoming': { title: 'Accept All Incoming Changes', when: hasConflicts, run: () => apply(activeView(), conflictsOf(activeView()), 'incoming') },
  });

  // --- status bar ------------------------------------------------------------
  const status = h('span.mc-status');
  mide.statusBar.addItem({
    id: 'merge-conflicts', element: status, align: 'left', priority: 25, tooltip: 'Merge conflicts in this file: click to jump to the next one',
    command: 'merge-conflicts:next', onClick: () => mide.commands.run('merge-conflicts:next'),
  });
  function updateStatus() {
    const n = conflictsOf(activeView()).length;
    status.textContent = n ? `${n} conflict${n === 1 ? '' : 's'}` : '';
  }
  mide.workspace.onDidChangeActiveItem(updateStatus);
  mide.workspace.onDidUpdateEditor((editor, update) => { if (update?.docChanged && editor === mide.workspace.getActiveEditor()) updateStatus(); });
  mide.workspace.onDidOpenItem(() => queueMicrotask(updateStatus));
  updateStatus();

  // Other packages (source control) can open a file at its first conflict.
  mide.services.provide('merge-conflicts', {
    count: (editor) => conflictsOf(editor?.view).length,
    hasMarkers: (text) => /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text),
    revealFirst(editor) {
      const view = editor?.view;
      const first = conflictsOf(view)[0];
      if (!first) return false;
      goTo(view, first);
      return true;
    },
  });
}
