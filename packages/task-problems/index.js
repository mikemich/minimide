// Task Problems: the errors and warnings a task prints (compilers, linters, test runners) land in
// the Problems view next to the language servers' and, underlined, in open files. It reads the
// output of the runner's task tabs ("task:<name>" terminals) through the terminal service, parses it
// with matchers.js and keeps each task's problems until that task runs again.
import { ProblemParser, compileMatchers, stripAnsi } from './matchers.js';

const SEVERITY = { error: 1, warning: 2, info: 3 };
const MAX_PROBLEMS = 1000; // per run; a build that prints more has bigger problems

/** Collapse `.` and `..` in an absolute path. */
export function normalize(path) {
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** A parsed problem as an LSP-shaped diagnostic. Without a column, the whole line. */
export function toDiagnostic(p, source) {
  const line = p.line - 1;
  const start = { line, character: p.column ? p.column - 1 : 0 };
  const end = p.column ? start : { line, character: Number.MAX_SAFE_INTEGER };
  return { range: { start, end }, severity: SEVERITY[p.severity] || 1, message: p.message, source, ...(p.code ? { code: p.code } : {}) };
}

export function activate(mide) {
  const service = mide.services.get('diagnostics');
  const problems = service.create('task-problems', { inEditor: mide.config.get('task-problems.showInEditor') !== false, expandPoints: true });
  mide.subscriptions.add(problems);
  const tasks = new Map(); // terminal key -> { label, cwd, run, parser, partial, found: [{ path, p }], seen, stat }
  let runs = 0;
  let custom = [];
  let timer = null;
  const shown = new Map(); // path -> what was last set for it, to leave unchanged files alone

  // --- reading output -------------------------------------------------------------------------
  function begin({ key, title, cwd }) {
    const task = {
      key, label: String(title || key.slice(5)).replace(/^Task: /, ''), cwd, run: ++runs,
      parser: new ProblemParser({ matchers: custom }), partial: '', found: [], seen: new Set(), stat: new Map(),
    };
    tasks.set(key, task);
    return task;
  }

  function onStart(info) {
    if (!info.key.startsWith('task:')) return;
    begin(info);
    sync(); // the last run's problems go now, not when the first new one shows up
  }

  function onOutput(info) {
    if (!info.key.startsWith('task:')) return;
    const task = tasks.get(info.key) || begin(info); // started before this package was
    const lines = (task.partial + info.data).split('\n');
    task.partial = lines.pop();
    if (task.partial.length > 100000) task.partial = task.partial.slice(-100000);
    for (const line of lines) read(task, line);
  }

  function onExit(info) {
    const task = tasks.get(info.key);
    if (!task) return;
    if (task.partial) read(task, task.partial);
    task.partial = '';
    task.parser.end();
    schedule();
  }

  function read(task, raw) {
    const text = stripAnsi(raw.replace(/\r$/, ''));
    for (const p of task.parser.line(text.slice(text.lastIndexOf('\r') + 1))) {
      if (task.seen.size >= MAX_PROBLEMS) return;
      const id = `${p.file}:${p.line}:${p.column || 0}:${p.message}`;
      if (task.seen.has(id)) continue;
      task.seen.add(id);
      locate(task, p).then((path) => {
        if (!path || tasks.get(task.key) !== task) return; // run again since
        task.found.push({ path, p });
        schedule();
      });
    }
  }

  // --- where a problem is ------------------------------------------------------------------------
  const isFile = (task, path) => {
    if (!task.stat.has(path)) task.stat.set(path, mide.fs.stat(path).then((s) => !!s?.isFile, () => false));
    return task.stat.get(path);
  };
  const inWorkspace = (path) => !!mide.workspace.folderFor(path);

  /** A file named in output: relative to the task's folder or any project folder. Outside the project only if it exists. */
  async function resolve(task, file) {
    let f = file.replace(/^file:\/\//, '');
    if (f.startsWith('~/')) f = mide.user.home + f.slice(1);
    if (!f.startsWith('/') && /^[^/]*:/.test(f)) return null; // `<string>`, `node:internal`, a URL
    const bases = f.startsWith('/') ? [''] : [task.cwd, ...mide.workspace.folders].filter(Boolean);
    const candidates = [...new Set(bases.map((b) => normalize(`${b}/${f}`)))];
    for (const c of candidates) if (await isFile(task, c)) return { path: c, inside: inWorkspace(c) };
    const inside = candidates.find(inWorkspace);
    return inside ? { path: inside, inside: true, missing: true } : null;
  }

  /** The best place for a problem: its own file, or for a traceback the innermost frame in the project. */
  async function locate(task, p) {
    const place = ([path, loc]) => { if (loc !== p) { p.line = loc.line; delete p.column; } return path; };
    let fallback = null;
    for (const loc of [p, ...(p.alternatives || [])]) {
      const r = !/^<.*>$/.test(loc.file) && await resolve(task, loc.file);
      if (!r) continue;
      if (r.inside && !r.missing) return place([r.path, loc]);
      fallback ||= [r.path, loc];
    }
    return fallback ? place(fallback) : null;
  }

  // --- showing them -----------------------------------------------------------------------------
  function schedule() { clearTimeout(timer); timer = setTimeout(sync, 150); }

  function sync() {
    clearTimeout(timer);
    timer = null;
    const byPath = new Map();
    for (const task of tasks.values()) {
      for (const { path, p } of task.found) {
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(toDiagnostic(p, task.label));
      }
    }
    for (const path of problems.paths()) if (!byPath.has(path)) { problems.delete(path); shown.delete(path); }
    for (const [path, list] of byPath) {
      const json = JSON.stringify(list);
      if (shown.get(path) === json) continue;
      shown.set(path, json);
      problems.set(path, list);
    }
  }

  function clear() {
    tasks.clear();
    sync();
  }

  const all = () => [...tasks.values()].flatMap((t) => t.found.map((f) => ({ ...f, label: t.label })));

  function list() {
    const items = all()
      .sort((a, b) => SEVERITY[a.p.severity] - SEVERITY[b.p.severity] || a.path.localeCompare(b.path) || a.p.line - b.p.line)
      .map((f) => ({
        label: f.p.message.split('\n')[0],
        detail: `${mide.workspace.relativePath(f.path)}:${f.p.line}${f.p.column ? `:${f.p.column}` : ''} · ${f.label}`,
        hint: f.p.severity, f,
      }));
    mide.ui.selectList({
      id: 'task-problems', placeholder: 'Go to a problem from task output', items,
      emptyMessage: 'No problems in task output. Run a task with ⌘⇧B or a file with F5.',
      onSelect: ({ f }) => mide.workspace.open(f.path, { line: f.p.line, col: f.p.column ? f.p.column - 1 : 0 }),
    });
  }

  // --- wiring ---------------------------------------------------------------------------------------
  let listening = [];
  const stopListening = () => { for (const d of listening) d.dispose(); listening = []; };
  mide.services.consume('terminal', (terminal) => {
    stopListening();
    if (!terminal.onDidStart) return;
    listening = [terminal.onDidStart(onStart), terminal.onDidOutput(onOutput), terminal.onDidExit(onExit)];
  });
  mide.subscriptions.add({ dispose: () => { stopListening(); clearTimeout(timer); } });

  mide.config.observe('task-problems.showInEditor', (on) => problems.setInEditor(on !== false));
  mide.config.observe('task-problems.matchers', (value) => {
    const { matchers, errors } = compileMatchers(value);
    custom = matchers;
    if (errors.length) {
      mide.notify.error(`${errors.length === 1 ? 'A problem matcher' : `${errors.length} problem matchers`} in config.json can't be used`, errors.join('\n'), {
        actions: [{ label: 'Open config.json', run: () => mide.commands.run('settings:open-config-file') }],
      });
    }
  });

  mide.commands.add({
    'task-problems:clear': { title: 'Clear Task Problems', when: () => all().length > 0, run: clear },
    'task-problems:list': { title: 'Go to Task Problem…', run: list },
  });
}
