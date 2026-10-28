// Emmet: type div#app or ul>li*3 (HTML, JSX, Vue) or m10 (CSS) and press Tab. The expansion is
// done by @emmetio/codemirror6-plugin, loaded the first time such a file opens. We use only its
// commands, not its always-on abbreviation tracking, so Tab stays Tab everywhere else.

// Language names (as CodeMirror reports them) -> Emmet syntax.
const SYNTAXES = { html: 'html', xml: 'xml', jsx: 'jsx', tsx: 'tsx', vue: 'vue', css: 'css', scss: 'scss', less: 'less', sass: 'sass' };
const STYLESHEETS = new Set(['css', 'scss', 'less', 'sass']);

// A bare word like "hello" is a valid abbreviation (<hello></hello>), but in prose it's just a word.
// So a lone word expands only if it is a real tag, an Emmet alias, a Component or a custom-element.
const TAGS = new Set(`a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col
colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head
header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup
option output p param picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary
sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr
bq acr adr art sect hdr ftr fig figc ifr emb obj cap colg fst btn optg opt tarea leg dlg prog datag datal kg out det cmd doc`.split(/\s+/));

export function activate(mide) {
  const { StateField, StateEffect, Prec } = mide.cm.state;
  const { keymap, runScopeHandlers } = mide.cm.view;
  const { syntaxTree } = mide.cm.language;

  let emmet = null; // the plugin module, once loaded
  let loading = null;
  const load = () => loading ||= mide.cm.extras.emmet().then(install);

  const syntaxOf = (editor) => SYNTAXES[(editor?.getLanguageName?.() || '').toLowerCase()] || null;
  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view);
  const enabled = () => mide.config.get('emmet.enabled');

  // The plugin reads the syntax from a facet; we feed it from a field that follows the file's language.
  const setSyntax = StateEffect.define();
  const syntaxField = StateField.define({
    create: () => 'html',
    update: (value, tr) => { for (const e of tr.effects) if (e.is(setSyntax)) value = e.value; return value; },
  });
  const WRAP_KEY = 'F13'; // the plugin's wrap box is opened by a key; "Wrap with Abbreviation…" presses it for you

  function install(module) {
    emmet = module;
    mide.editor.addExtension([
      syntaxField,
      emmet.emmetConfig.compute([syntaxField], (state) => ({ syntax: state.field(syntaxField) })),
      emmet.wrapWithAbbreviation(WRAP_KEY),
      Prec.default(keymap.of([{ key: 'Tab', run: expandOnTab }])),
    ]);
    mide.services.provide('emmet', { ready: true });
  }

  /** Point the plugin at this file's syntax; returns it (null when Emmet doesn't apply). */
  function prepare(view) {
    const syntax = syntaxOf(editorFor(view));
    if (syntax && view.state.field(syntaxField, false) !== syntax) view.dispatch({ effects: setSyntax.of(syntax) });
    return syntax;
  }

  // Only where an abbreviation makes sense: text between tags, inside a CSS block (also in <style>),
  // not in tags, comments, strings or <script>. Returns 'markup' or 'stylesheet', or null.
  function kindAt(state, pos, syntax) {
    const names = [];
    for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) names.push(n.name);
    if (names.some((n) => /^(OpenTag|CloseTag|SelfClosingTag|MismatchedCloseTag|ScriptText|AttributeValue|(Line|Block)?Comment|StringLiteral|String)$/.test(n))) return null;
    if (STYLESHEETS.has(syntax) || names.includes('StyleSheet')) return names.includes('Block') ? 'stylesheet' : null;
    if (syntax === 'jsx' || syntax === 'tsx') { // only inside JSX elements, never in plain JavaScript
      const jsx = names.find((n) => n.startsWith('JSX'));
      return jsx === 'JSXText' || jsx === 'JSXElement' ? 'markup' : null;
    }
    return names.includes('Script') ? null : 'markup';
  }

  function expandOnTab(view) {
    if (!enabled() || !emmet) return false;
    const { main, ranges } = view.state.selection;
    if (!main.empty || ranges.length > 1) return false;
    const syntax = prepare(view);
    const kind = syntax && kindAt(view.state, main.head, syntax);
    if (!kind) return false;
    if (kind === 'markup') {
      const line = view.state.doc.lineAt(main.head);
      const word = /\S+$/.exec(line.text.slice(0, main.head - line.from))?.[0];
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(word || '') && !TAGS.has(word) && !/^[A-Z]/.test(word)) return false;
    }
    return emmet.expandAbbreviation(view);
  }

  // --- loading: the first time a file Emmet applies to is open ------------------
  let started = false;
  function maybeLoad() {
    if (started || !enabled()) return;
    if (!mide.workspace.getItems().some((i) => syntaxOf(i))) return;
    started = true;
    // Not on the startup path: wait until the app is idle.
    (window.requestIdleCallback || setTimeout)(() => load().catch((err) => { started = false; mide.notify.error('Emmet failed to load', err.message); }));
  }
  mide.workspace.onDidOpenItem(maybeLoad);
  mide.workspace.onDidUpdateEditor((editor, update) => { if (!update) maybeLoad(); }); // language finished loading / path changed
  mide.config.onDidChange('emmet.enabled', maybeLoad);
  maybeLoad();

  // --- commands ----------------------------------------------------------------
  const active = () => { const e = mide.workspace.getActiveEditor(); return e && syntaxOf(e) ? e : null; };
  const command = (title, run) => ({ title, when: () => enabled() && !!active(), run: async () => {
    const editor = active();
    if (!editor) return;
    await load();
    const { view } = editor;
    if (prepare(view)) run(view);
  } });

  mide.commands.add({
    'emmet:expand': command('Emmet: Expand Abbreviation', (view) => { view.focus(); if (!expandOnTab(view)) mide.notify.info('No Emmet abbreviation before the cursor.'); }),
    'emmet:wrap': command('Emmet: Wrap with Abbreviation…', (view) => {
      view.focus();
      requestAnimationFrame(() => runScopeHandlers(view, new KeyboardEvent('keydown', { key: WRAP_KEY }), 'editor'));
    }),
    'emmet:balance-outward': command('Emmet: Balance Outward', (view) => { view.focus(); emmet.balanceOutward(view); }),
    'emmet:balance-inward': command('Emmet: Balance Inward', (view) => { view.focus(); emmet.balanceInward(view); }),
  });

  // The wrap box ships with a white background; make it follow the theme.
  mide.styles.add(`
    .editor-item .cm-editor .emmet-wrap-with-abbreviation__content {
      background: var(--bg-elevated); border: 1px solid var(--border-strong); border-top: 0; box-shadow: var(--shadow);
    }
    .editor-item .cm-editor .emmet-wrap-with-abbreviation__content input {
      font: inherit; padding: 6px 8px; color: var(--fg); background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); outline: none;
    }
    .editor-item .cm-editor .emmet-wrap-with-abbreviation__content input:focus { border-color: var(--accent); }
  `);
}
