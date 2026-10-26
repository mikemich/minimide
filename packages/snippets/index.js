// Snippets: built-ins + ~/.minimide/snippets.json + ~/.minimide/snippets/*.json (VS Code format).
import BUILTINS from './builtins.js';

// Language names (as CodeMirror reports them) -> VS Code language ids, most specific first.
const LANGUAGE_IDS = {
  javascript: ['javascript'], jsx: ['javascriptreact', 'typescriptreact', 'javascript'],
  typescript: ['typescript', 'javascript'], tsx: ['typescriptreact', 'typescript', 'javascript'],
  python: ['python'], go: ['go'], rust: ['rust'], c: ['c'], 'c++': ['cpp', 'c'], 'objective-c': ['objective-c', 'c'],
  html: ['html'], css: ['css'], scss: ['scss', 'css'], less: ['less', 'css'], sass: ['sass', 'css'],
  markdown: ['markdown'], shell: ['shellscript'], json: ['json'], yaml: ['yaml'], sql: ['sql'], java: ['java'],
  ruby: ['ruby'], php: ['php'], swift: ['swift'], kotlin: ['kotlin'], lua: ['lua'], vue: ['vue', 'html'], svelte: ['svelte', 'html'],
  'c#': ['csharp'], dockerfile: ['dockerfile'], makefile: ['makefile'], terraform: ['terraform'], java: ['java'], 'properties files': ['properties'],
};

export function activate(mide) {
  const { snippet } = mide.cm.autocomplete;
  const { keymap } = mide.cm.view;
  const { Prec } = mide.cm.state;
  const userFile = `${mide.user.dir}/snippets.json`;
  const userDir = `${mide.user.dir}/snippets`;
  let user = {}; // { langId: { name: def } }

  // --- loading -------------------------------------------------------------
  const parse = (text) => JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '').replace(/,(\s*[}\]])/g, '$1'));

  async function load() {
    const next = {};
    const merge = (lang, defs) => { for (const id of lang.split(',').map((l) => l.trim()).filter(Boolean)) next[id] = { ...next[id], ...defs }; };
    if (await mide.fs.stat(userFile)) try {
      const data = parse(await mide.fs.read(userFile));
      for (const [lang, defs] of Object.entries(data)) if (defs && typeof defs === 'object') merge(lang === 'global' ? '*' : lang, defs);
    } catch (err) {
      if (!/ENOENT/.test(err.message)) mide.notify.error('Could not read snippets.json', err.message);
    }
    if (await mide.fs.stat(userDir)) {
      for (const entry of await mide.fs.readdir(userDir)) {
        if (entry.isDir) continue;
        try {
          const data = parse(await mide.fs.read(entry.path));
          if (entry.name.endsWith('.code-snippets')) {
            // Global VS Code snippets: optional "scope": "javascript,typescript".
            for (const [name, def] of Object.entries(data)) merge(def.scope || '*', { [name]: def });
          } else if (entry.name.endsWith('.json')) {
            merge(entry.name.replace(/\.json$/, ''), data);
          }
        } catch (err) {
          mide.notify.error(`Could not read snippets/${entry.name}`, err.message);
        }
      }
    }
    user = next;
  }

  // --- lookup --------------------------------------------------------------
  function idsFor(editor) {
    const name = (editor?.getLanguageName() || '').toLowerCase();
    return [...(LANGUAGE_IDS[name] || [name.replace(/\s+/g, '')]), '*'];
  }

  function snippetsFor(editor) {
    const ids = idsFor(editor);
    const out = new Map(); // prefix -> entry; earlier (more specific, user) wins
    const add = (source, origin) => {
      for (const id of ids) {
        for (const [name, def] of Object.entries(source[id] || {})) {
          const prefixes = Array.isArray(def.prefix) ? def.prefix : [def.prefix];
          for (const prefix of prefixes) {
            if (prefix && def.body != null && !out.has(prefix)) out.set(prefix, { name, prefix, body: Array.isArray(def.body) ? def.body.join('\n') : String(def.body), description: def.description, origin });
          }
        }
      }
    };
    add(user, 'user');
    if (mide.config.get('snippets.builtins')) add(BUILTINS, 'built-in');
    return [...out.values()];
  }

  // --- expansion -----------------------------------------------------------
  function variables(editor, selected) {
    const path = editor?.getPath() || '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      TM_FILENAME: mide.path.basename(path) || 'untitled',
      TM_FILENAME_BASE: (mide.path.basename(path) || 'untitled').replace(/\.[^.]+$/, ''),
      TM_FILEPATH: path, TM_DIRECTORY: path ? mide.path.dirname(path) : '',
      RELATIVE_FILEPATH: mide.workspace.relativePath(path),
      WORKSPACE_NAME: mide.workspace.project ? mide.path.basename(mide.workspace.project) : '',
      TM_SELECTED_TEXT: selected, SELECTION: selected,
      CURRENT_YEAR: String(now.getFullYear()), CURRENT_YEAR_SHORT: String(now.getFullYear()).slice(2),
      CURRENT_MONTH: pad(now.getMonth() + 1), CURRENT_DATE: pad(now.getDate()),
      CURRENT_HOUR: pad(now.getHours()), CURRENT_MINUTE: pad(now.getMinutes()), CURRENT_SECOND: pad(now.getSeconds()),
      CURRENT_MONTH_NAME: now.toLocaleString('en', { month: 'long' }), CURRENT_DAY_NAME: now.toLocaleString('en', { weekday: 'long' }),
      UUID: crypto.randomUUID(), RANDOM: String(Math.random()).slice(2, 8),
    };
  }

  function expand(view, editor, entry, from, to, completion = null) {
    const selected = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    const vars = variables(editor, selected);
    // The shared converter escapes variable values, so selected code containing `${x}`, `$1`
    // or `#{y}` is inserted literally rather than turned into tab stops.
    // CodeMirror re-indents continuation lines and turns leading tabs into the indent unit.
    snippet(mide.editor.convertSnippet(entry.body, (name) => vars[name]))(view, completion, from, to);
  }


  const editorFor = (view) => mide.workspace.getItems().find((i) => i.view === view);

  // Completion source (runs alongside language servers via the shared registry).
  mide.editor.addCompletionSource((ctx) => {
    const word = ctx.matchBefore(/[\w$@!.-]+$/);
    if (!word && !ctx.explicit) return null;
    const editor = editorFor(ctx.view);
    const entries = snippetsFor(editor);
    if (!entries.length) return null;
    return {
      from: word ? word.from : ctx.pos,
      options: entries.map((e) => ({
        label: e.prefix,
        detail: e.description || e.name,
        type: 'snippet',
        boost: -1,
        info: () => { const pre = document.createElement('pre'); pre.className = 'snippet-preview'; pre.textContent = e.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{?\d+\}?/g, ''); return pre; },
        apply: (view, completion, from, to) => expand(view, editor, e, from, to, completion),
      })),
      validFor: /^[\w$@!.-]*$/,
    };
  });

  // Tab right after a prefix expands it (snippet field navigation keeps priority).
  mide.editor.addExtension(Prec.high(keymap.of([{
    key: 'Tab',
    run: (view) => {
      if (!mide.config.get('snippets.tabExpands')) return false;
      const sel = view.state.selection.main;
      if (!sel.empty || view.state.selection.ranges.length > 1) return false;
      const line = view.state.doc.lineAt(sel.head);
      const m = /[\w$@!.-]+$/.exec(line.text.slice(0, sel.head - line.from));
      if (!m) return false;
      const editor = editorFor(view);
      const entry = snippetsFor(editor).find((e) => e.prefix === m[0]);
      if (!entry) return false;
      expand(view, editor, entry, sel.head - m[0].length, sel.head);
      return true;
    },
  }])));

  // --- commands ------------------------------------------------------------
  mide.commands.add({
    'snippets:insert': {
      title: 'Insert Snippet…',
      when: () => !!mide.workspace.getActiveEditor(),
      run: () => {
        const editor = mide.workspace.getActiveEditor();
        mide.ui.selectList({
          id: 'snippets',
          placeholder: `Insert a ${editor.getLanguageName()} snippet`,
          items: snippetsFor(editor).map((e) => ({ label: e.name, detail: `${e.prefix} · ${e.description || ''}`, hint: e.origin, entry: e })),
          filterKey: (i) => `${i.entry.prefix} ${i.label}`,
          emptyMessage: 'No snippets for this language yet. Add some with "Snippets: Open Your Snippets".',
          onSelect: ({ entry }) => {
            const view = editor.view;
            const { from, to } = view.state.selection.main;
            requestAnimationFrame(() => { view.focus(); expand(view, editor, entry, from, to); });
          },
        });
      },
    },
    'snippets:open-user-snippets': {
      title: 'Open Your Snippets',
      run: async () => {
        if (!(await mide.fs.stat(userFile))) {
          await mide.fs.write(userFile, `// Your snippets, in VS Code's format. Saved changes apply immediately.
// Keys are language ids (javascript, typescript, python, go, rust, html, css, markdown, …) or "*" for all.
// You can also drop VS Code snippet files (python.json, *.code-snippets) into ~/.minimide/snippets/.
{
  "javascript": {
    "Log with label": {
      "prefix": "logl",
      "body": ["console.log('$1', $1);"],
      "description": "console.log with a label"
    }
  },
  "*": {
    "Signature": {
      "prefix": "sig",
      "body": "— $CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE"
    }
  }
}
`);
        }
        mide.workspace.open(userFile);
      },
    },
  });

  mide.workspace.onDidSave((editor) => {
    const p = editor.getPath() || '';
    if (p === userFile || p.startsWith(userDir + '/')) load().then(() => mide.notify.info('Snippets reloaded'));
  });
  const onFocus = () => load();
  window.addEventListener('focus', onFocus);
  mide.subscriptions.add({ dispose: () => window.removeEventListener('focus', onFocus) });
  load();

  mide.styles.add(`
    .cm-completionIcon-snippet::after { content: '⧉' !important; font-size: 12px; }
    .cm-completionIcon-snippet { color: var(--c-green); background: color-mix(in srgb, var(--c-green) 16%, transparent); }
    .snippet-preview { margin: 0; font-family: var(--editor-font); font-size: calc(var(--editor-font-size) - 2px); white-space: pre; color: var(--fg); }
  `);
}
