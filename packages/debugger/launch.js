// How to debug a file: which debug adapter to start and what to ask it to launch.
// Python goes through debugpy's adapter; JavaScript through our own small adapter
// (node-adapter.mjs), which needs nothing but Node.

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function kindFor(path) {
  const ext = path?.includes('.') ? path.split('.').pop().toLowerCase() : '';
  if (ext === 'py') return 'python';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'node';
  return null;
}

/** Run a command line the way the adapter will be started (a login shell, so PATH matches). */
function sh(mide, argv) {
  if (mide.user.platform === 'win32') return mide.process.exec(argv[0], argv.slice(1));
  return mide.process.exec(mide.user.shell || '/bin/sh', ['-lc', argv.map(quote).join(' ')]);
}

/** { kind, argv, cwd, args } for debugging `path`, or null after telling the user what's missing. */
export async function configFor(mide, path) {
  const kind = kindFor(path);
  const dir = mide.path.dirname(path);
  const root = mide.workspace.project;
  const cwd = mide.config.get('runner.cwd') === 'project' && root && path.startsWith(root + '/') ? root : dir;
  const install = (title, detail, command) => mide.notify.info(title, detail, {
    timeout: 15000,
    actions: [{ label: 'Copy install command', run: () => mide.clipboard.write(command) }],
  });

  if (kind === 'python') {
    const python = mide.config.get('debugger.python') || 'python3';
    const r = await sh(mide, [python, '-c', 'import debugpy']);
    if (r.code !== 0) {
      if (/No module named/.test(r.stderr)) {
        install('Python debugging needs debugpy', `Install it, then start debugging again:\n${python} -m pip install debugpy`, `${python} -m pip install debugpy`);
      } else {
        mide.notify.error(`Couldn't run ${python}`, (r.stderr || '').trim().split('\n').pop() || 'Is Python installed? You can choose the interpreter in Settings → Debugger.');
      }
      return null;
    }
    return {
      kind, cwd,
      argv: [python, '-m', 'debugpy.adapter'],
      args: { name: mide.path.basename(path), type: 'python', request: 'launch', program: path, cwd, console: 'internalConsole', justMyCode: true, redirectOutput: true },
    };
  }

  if (kind === 'node') {
    const node = mide.config.get('debugger.node') || 'node';
    const r = await sh(mide, [node, '--version']);
    const major = Number(/^v(\d+)/.exec(r.stdout.trim())?.[1]);
    if (r.code !== 0 || !major) {
      mide.notify.error(`Couldn't run ${node}`, 'Is Node.js installed? You can choose the program in Settings → Debugger.');
      return null;
    }
    if (major < 22) {
      mide.notify.info('Debugging JavaScript needs Node.js 22 or newer', `${node} is ${r.stdout.trim()}. Update it from nodejs.org or your package manager.`, {
        actions: [{ label: 'Open nodejs.org', run: () => mide.shell.openExternal('https://nodejs.org') }],
      });
      return null;
    }
    // The packaged app keeps its files in an archive Node can't read: run a copy.
    const adapter = `${mide.user.runDir}/minimide-node-debug.mjs`;
    await mide.fs.write(adapter, await mide.fs.read(`${mide.package.dir}/node-adapter.mjs`));
    return {
      kind, cwd,
      argv: [node, adapter],
      args: { name: mide.path.basename(path), type: 'node', request: 'launch', program: path, cwd },
    };
  }
  return null;
}
