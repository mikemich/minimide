// Built-in server definitions. Override or add servers with the "lsp.servers" setting.
// `command` may be a list of alternatives; the first one found on PATH wins.

const LANGSERVERS_EXTRACTED = 'npm i -g vscode-langservers-extracted';

export const DEFAULT_SERVERS = {
  typescript: { displayName: 'TypeScript',
    command: [['typescript-language-server', '--stdio']],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
    install: 'npm i -g typescript@5 typescript-language-server',
  },
  python: { displayName: 'Python',
    command: [['pyright-langserver', '--stdio'], ['basedpyright-langserver', '--stdio'], ['pylsp']],
    extensions: ['py', 'pyi'],
    install: 'npm i -g pyright   (or: pip install python-lsp-server)',
  },
  rust: { displayName: 'Rust', command: [['rust-analyzer']], extensions: ['rs'], install: 'rustup component add rust-analyzer' },
  go: { displayName: 'Go', command: [['gopls']], extensions: ['go'], install: 'go install golang.org/x/tools/gopls@latest' },
  c: { displayName: 'C/C++',
    command: [['clangd']],
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm'],
    install: 'xcode-select --install   (or: brew install llvm / apt install clangd)',
  },
  css: { displayName: 'CSS', command: [['vscode-css-language-server', '--stdio']], extensions: ['css', 'scss', 'less'], install: LANGSERVERS_EXTRACTED },
  html: { displayName: 'HTML', command: [['vscode-html-language-server', '--stdio']], extensions: ['html', 'htm'], install: LANGSERVERS_EXTRACTED },
  json: { displayName: 'JSON', command: [['vscode-json-language-server', '--stdio']], extensions: ['json', 'jsonc'], install: LANGSERVERS_EXTRACTED },
  bash: { displayName: 'Bash', command: [['bash-language-server', 'start']], extensions: ['sh', 'bash', 'zsh'], install: 'npm i -g bash-language-server' },
  yaml: { displayName: 'YAML', command: [['yaml-language-server', '--stdio']], extensions: ['yaml', 'yml'], install: 'npm i -g yaml-language-server' },
  lua: { displayName: 'Lua', command: [['lua-language-server']], extensions: ['lua'], install: 'brew install lua-language-server' },
  ruby: { displayName: 'Ruby', command: [['ruby-lsp'], ['solargraph', 'stdio']], extensions: ['rb'], install: 'gem install ruby-lsp' },
  php: { displayName: 'PHP', command: [['intelephense', '--stdio']], extensions: ['php'], install: 'npm i -g intelephense' },
  zig: { displayName: 'Zig', command: [['zls']], extensions: ['zig'], install: 'brew install zls' },
  svelte: { displayName: 'Svelte', command: [['svelteserver', '--stdio']], extensions: ['svelte'], install: 'npm i -g svelte-language-server' },
};

const LANGUAGE_IDS = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', m: 'objective-c', mm: 'objective-cpp',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', json: 'json', jsonc: 'jsonc',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yaml: 'yaml', yml: 'yaml',
  lua: 'lua', rb: 'ruby', php: 'php', zig: 'zig', svelte: 'svelte',
};

export function languageIdFor(path, server) {
  const ext = path.split('.').pop().toLowerCase();
  return server?.languageIds?.[ext] || LANGUAGE_IDS[ext] || ext;
}

/** Merge built-ins with the user's "lsp.servers" setting. */
export function resolveServers(user = {}) {
  const out = {};
  for (const name of Object.keys({ ...DEFAULT_SERVERS, ...user })) {
    const merged = { ...DEFAULT_SERVERS[name], ...user[name] };
    if (merged.disabled || !merged.command || !merged.extensions) continue;
    // Accept "cmd --flag", ["cmd", "--flag"] or [["cmd", "--flag"], ["alt"]].
    let cmd = merged.command;
    if (typeof cmd === 'string') cmd = [cmd.split(/\s+/)];
    else if (!Array.isArray(cmd[0])) cmd = [cmd];
    out[name] = { ...merged, name, command: cmd, extensions: merged.extensions.map((e) => e.replace(/^\./, '').toLowerCase()) };
  }
  return out;
}

export function serverForPath(servers, path) {
  const name = path.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return Object.values(servers).find((s) => s.extensions.includes(ext) || s.filenames?.includes(name)) || null;
}
