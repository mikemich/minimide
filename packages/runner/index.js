// Code Runner: F5 runs the current file, ⌘⇧B runs a project task. Output goes to
// the integrated terminal (via the "terminal" service), so programs can read input.

// {file} etc. are replaced with shell-quoted paths. {out} is a temp path for compiled binaries.
const DEFAULT_COMMANDS = {
  py: 'python3 -u {file}',
  js: 'node {file}', mjs: 'node {file}', cjs: 'node {file}',
  ts: 'npx --yes tsx {file}', mts: 'npx --yes tsx {file}', tsx: 'npx --yes tsx {file}',
  go: 'go run {file}',
  rs: 'rustc {file} -o {out} && {out}',
  c: 'cc -Wall -O1 {file} -o {out} && {out}',
  cpp: 'c++ -std=c++20 -Wall -O1 {file} -o {out} && {out}', cc: 'c++ -std=c++20 -Wall -O1 {file} -o {out} && {out}', cxx: 'c++ -std=c++20 -Wall -O1 {file} -o {out} && {out}',
  java: 'java {file}',
  kt: 'kotlinc {file} -include-runtime -d {out}.jar && java -jar {out}.jar',
  swift: 'swift {file}',
  rb: 'ruby {file}', php: 'php {file}', pl: 'perl {file}', lua: 'lua {file}',
  r: 'Rscript {file}', jl: 'julia {file}', dart: 'dart run {file}', ex: 'elixir {file}', exs: 'elixir {file}',
  hs: 'runghc {file}', zig: 'zig run {file}', nim: 'nim r {file}',
  sh: 'bash {file}', bash: 'bash {file}', zsh: 'zsh {file}', fish: 'fish {file}',
  ps1: 'pwsh {file}',
};

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function activate(mide) {
  let last = null; // { command, cwd, title }

  const terminal = () => {
    const svc = mide.services.get('terminal');
    if (!svc) mide.notify.error('The Terminal package is disabled', 'Enable it in Settings → Packages to run code.');
    return svc;
  };

  async function findUp(start, names, stopAt) {
    let dir = start;
    while (dir && dir.length > 1) {
      for (const n of names) if (await mide.fs.stat(`${dir}/${n}`)) return { dir, name: n };
      if (dir === stopAt) break;
      dir = mide.path.dirname(dir);
    }
    return null;
  }

  /** Work out how to run `path`. Returns { command, cwd, title } or null. */
  async function commandFor(path, text) {
    const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
    const base = mide.path.basename(path);
    const dir = mide.path.dirname(path);
    const root = mide.workspace.project || dir;
    const cwd = mide.config.get('runner.cwd') === 'project' && path.startsWith(root + '/') ? root : dir;
    const user = mide.config.get('runner.commands') || {};
    let template = user[ext] || user[base];

    // Project-aware defaults for Rust.
    if (!template && ext === 'rs') {
      const cargo = await findUp(dir, ['Cargo.toml'], root);
      if (cargo) return { command: 'cargo run', cwd: cargo.dir, title: 'cargo run' };
    }
    // Scripts with a shebang run with their declared interpreter.
    if (!template && text.startsWith('#!')) {
      const interp = text.slice(2, text.indexOf('\n') >>> 0).trim();
      if (interp) template = `${interp} {file}`;
    }
    template ||= DEFAULT_COMMANDS[ext];
    if (!template) return null;
    const name = base.replace(/\.[^.]+$/, '');
    const vars = {
      file: quote(path), dir: quote(dir), base: quote(base), name: quote(name), root: quote(root),
      out: quote(`${mide.user.platform === 'win32' ? '%TEMP%' : '/tmp'}/minimide-run-${name}`),
    };
    const command = template.replace(/\{(file|dir|base|name|root|out)\}/g, (_, k) => vars[k]);
    return { command, cwd, title: base };
  }

  async function runFile() {
    const editor = mide.workspace.getActiveEditor();
    if (!editor) return mide.notify.info('Open a file to run it.');
    if (editor.getLanguageName() === 'Markdown') return mide.commands.run('markdown-preview:toggle');
    if (!editor.getPath() || (editor.isDirty() && mide.config.get('runner.saveBeforeRun'))) {
      if (!await mide.workspace.save(editor)) return;
    }
    const path = editor.getPath();
    const ext = path.split('.').pop().toLowerCase();
    if (['html', 'htm', 'svg'].includes(ext)) return mide.shell.openPath(path);
    const spec = await commandFor(path, editor.getText());
    if (!spec) {
      return mide.notify.info(`Don't know how to run .${ext} files yet`, `Add one in config.json: "runner": { "commands": { "${ext}": "mytool {file}" } }`, {
        actions: [{ label: 'Open config.json', run: () => mide.commands.run('settings:open-config-file') }],
      });
    }
    run(spec);
  }

  function run(spec) {
    const t = terminal();
    if (!t) return;
    last = spec;
    t.run(spec.command, { cwd: spec.cwd, title: spec.title, key: 'run', onExit: () => mide.workspace.refreshPaneActions?.() });
    refreshButtons();
  }

  // --- tasks ---------------------------------------------------------------
  async function readJson(p) { try { return JSON.parse(await mide.fs.read(p)); } catch { return null; } }

  async function discoverTasks() {
    const root = mide.workspace.project;
    const tasks = [];
    for (const [name, command] of Object.entries(mide.config.get('runner.tasks') || {})) tasks.push({ label: name, detail: command, command, source: 'custom' });
    if (!root) return tasks;
    const has = async (f) => !!(await mide.fs.stat(`${root}/${f}`));

    const pkg = (await has('package.json')) ? await readJson(`${root}/package.json`) : null;
    if (pkg?.scripts) {
      const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) || (await has('bun.lock')) ? 'bun' : 'npm';
      for (const [name, script] of Object.entries(pkg.scripts)) {
        tasks.push({ label: `${pm} run ${name}`, detail: script, command: `${pm} run ${name}`, source: 'package.json' });
      }
    }
    for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
      if (!(await has(mk))) continue;
      let text;
      try { text = await mide.fs.read(`${root}/${mk}`); } catch { continue; }
      const targets = new Set();
      for (const m of text.matchAll(/^([A-Za-z0-9][\w.\-/]*)\s*:(?!=)/gm)) if (!m[1].startsWith('.')) targets.add(m[1]);
      for (const t of targets) tasks.push({ label: `make ${t}`, detail: mk, command: `make ${t}`, source: 'make' });
      break;
    }
    if (await has('Cargo.toml')) {
      for (const c of ['run', 'build', 'test', 'check', 'clippy']) tasks.push({ label: `cargo ${c}`, detail: 'Cargo.toml', command: `cargo ${c}`, source: 'cargo' });
    }
    if (await has('go.mod')) {
      for (const c of ['go run .', 'go build ./...', 'go test ./...', 'go vet ./...']) tasks.push({ label: c, detail: 'go.mod', command: c, source: 'go' });
    }
    if ((await has('pyproject.toml')) || (await has('pytest.ini'))) {
      tasks.push({ label: 'python3 -m pytest', detail: 'pytest', command: 'python3 -m pytest', source: 'python' });
    }
    return tasks;
  }

  async function runTask() {
    if (!mide.workspace.project && !Object.keys(mide.config.get('runner.tasks') || {}).length) {
      return mide.notify.info('Open a folder to see its tasks.');
    }
    mide.ui.selectList({
      id: 'runner-tasks',
      placeholder: 'Run a task (type any command and press Enter to run it)',
      items: discoverTasks,
      filterKey: (t) => t.label,
      emptyMessage: 'No tasks found (package.json scripts, Makefile, Cargo, Go). Type a command to run it.',
      onEnterWithoutMatch: (command) => run({ command, cwd: mide.workspace.project, title: command }),
      onSelect: (task) => run({ command: task.command, cwd: mide.workspace.project, title: task.label }),
      render: (t, indices) => {
        const { h, highlightMatches } = mide.ui;
        return h('div.select-row', h('div.select-text', h('div.select-label', highlightMatches(t.label, indices)), h('div.select-detail', t.detail)), h('kbd.select-hint', t.source));
      },
    });
  }

  // --- run button ----------------------------------------------------------
  const runnable = (item) => {
    const p = item?.type === 'editor' ? item.getPath() : null;
    if (!p) return false;
    const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : '';
    const user = mide.config.get('runner.commands') || {};
    return !!(user[ext] || DEFAULT_COMMANDS[ext] || ['html', 'htm', 'md', 'markdown'].includes(ext) || item.document?.initialText?.startsWith('#!'));
  };
  const isRunning = () => {
    return !!mide.services.get('terminal')?.isRunning('run');
  };
  function refreshButtons() { setTimeout(() => mide.workspace.refreshPaneActions?.(), 30); }

  mide.workspace.addPaneAction({
    id: 'runner.run',
    icon: () => (isRunning() ? 'stop' : 'play'),
    title: () => (isRunning() ? 'Stop (Shift-F5)' : 'Run File (F5)'),
    className: 'runner-action',
    when: (item) => runnable(item),
    run: () => (isRunning() ? stop() : runFile()),
  });

  function stop() {
    const stopped = !!mide.services.get('terminal')?.stop('run');
    if (!stopped) mide.notify.info('Nothing is running.');
    refreshButtons();
  }

  mide.commands.add({
    'runner:run-file': { title: 'Run File', run: runFile },
    'runner:stop': { title: 'Stop Running', run: stop },
    'runner:rerun': { title: 'Run Last Again', run: () => (last ? run(last) : runFile()) },
    'runner:run-task': { title: 'Run Task…', run: runTask },
    'runner:configure': { title: 'Configure Run Commands', run: () => mide.commands.run('settings:open-config-file') },
  });
  mide.keymap.allowInPassthrough('runner:run-file', 'runner:stop', 'runner:rerun', 'runner:run-task');

  mide.styles.add(`
    .tab-actions .runner-action { color: var(--success); }
    .tab-actions .runner-action:hover { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
    .tab-actions .runner-action .icon-stop { color: var(--error); }
  `);
}
