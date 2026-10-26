// File types beyond @codemirror/language-data: more names for languages it already has
// (.zshrc is shell, .jsonc is JSON…) and the small grammars in simple-modes.js.
// Everything here goes to the front of the list, so it wins over a looser match elsewhere
// (for example .cfg, which language-data gives to an obscure test-config language).
import { LanguageDescription } from '@codemirror/language';

const simpleMode = (key) => () => import('./simple-modes.js').then((m) => m.languages[key]);
const exact = (names) => new RegExp(`^(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

// More file names and extensions for languages language-data already knows.
const EXTEND = {
  Shell: {
    extensions: ['zsh', 'fish', 'command', 'bats', 'ebuild', 'tool'],
    filenames: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.zshrc', '.zprofile', '.zshenv',
      '.zlogin', '.zlogout', '.envrc', '.xinitrc', '.xprofile', 'APKBUILD', 'configure'],
  },
  'Properties files': {
    extensions: ['conf', 'cfg', 'env', 'service', 'socket', 'timer', 'mount', 'target', 'path', 'desktop', 'ics', 'inf', 'reg', 'url', 'npmrc'],
    filenames: ['.env', '.editorconfig', '.npmrc', '.yarnrc', '.gitconfig', '.gitmodules', '.flake8', '.pylintrc', '.coveragerc', 'setup.cfg', 'tox.ini', '.htaccess'],
    patterns: [/^\.env\..+$/],
  },
  JSON: {
    extensions: ['jsonc', 'json5', 'ipynb', 'code-workspace', 'webmanifest', 'har', 'geojson', 'babelrc'],
    filenames: ['.prettierrc', '.eslintrc', '.babelrc', '.swcrc', '.jshintrc', '.watchmanconfig', 'composer.lock', '.firebaserc'],
  },
  YAML: { filenames: ['yarn.lock', '.clang-format', '.clang-tidy', '.yamllint', 'pnpm-lock.yaml', '.gitlab-ci.yml'] },
  TOML: { filenames: ['Cargo.lock', 'Pipfile', 'poetry.lock', 'uv.lock', 'Gopkg.lock'] },
  Ruby: {
    extensions: ['rbi', 'rake', 'gemspec', 'podspec', 'ru'],
    filenames: ['Podfile', 'Brewfile', 'Vagrantfile', 'Fastfile', 'Appfile', 'Dangerfile', 'Guardfile', 'Capfile', 'Gemfile', 'Rakefile'],
  },
  Dockerfile: { extensions: ['dockerfile', 'containerfile'], patterns: [/^(?:Dockerfile|Containerfile)(?:\..+)?$/] },
  XML: { extensions: ['plist', 'xib', 'storyboard', 'csproj', 'fsproj', 'vbproj', 'props', 'targets', 'xaml', 'resx', 'nuspec', 'gpx', 'kml', 'rss', 'atom', 'xliff'] },
  Markdown: { extensions: ['mdx', 'mdown', 'markdn'] },
  HTML: { extensions: ['ejs', 'erb', 'svelte', 'astro', 'njk', 'mustache'] },
  Python: { extensions: ['star', 'gyp', 'pyi', 'rpy'], filenames: ['WORKSPACE', 'WORKSPACE.bazel', 'BUILD.bazel', 'Tiltfile', 'SConstruct', 'SConscript'] },
  Gas: { extensions: ['asm', 'S'] },
};

// Languages that borrow a close relative's grammar.
const BORROW = [
  { name: 'Elixir', from: 'Ruby', extensions: ['ex', 'exs'], filenames: ['mix.lock'] },
  { name: 'Nim', from: 'Python', extensions: ['nim', 'nims', 'nimble'] },
];

// New grammars from simple-modes.js.
const SIMPLE = [
  { name: 'Makefile', key: 'makefile', extensions: ['mk', 'mak', 'make'], filenames: ['Makefile', 'makefile', 'GNUmakefile', 'BSDmakefile'] },
  { name: 'Justfile', key: 'justfile', extensions: ['just'], filenames: ['justfile', 'Justfile', '.justfile'] },
  { name: 'nftables', key: 'nftables', extensions: ['nft'], filenames: ['nftables.conf'] },
  { name: 'Terraform', key: 'hcl', alias: ['hcl', 'tf'], extensions: ['tf', 'tfvars', 'hcl', 'nomad'], filenames: ['.terraform.lock.hcl'] },
  { name: 'Nix', key: 'nix', extensions: ['nix'] },
  { name: 'GraphQL', key: 'graphql', alias: ['gql'], extensions: ['graphql', 'gql', 'graphqls'] },
  { name: 'Prisma', key: 'prisma', extensions: ['prisma'] },
  { name: 'Zig', key: 'zig', extensions: ['zig', 'zon'] },
  { name: 'Gleam', key: 'gleam', extensions: ['gleam'] },
  { name: 'Ignore', key: 'ignore', extensions: ['gitignore', 'dockerignore'],
    filenames: ['.gitignore', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore', '.gcloudignore', '.vercelignore', '.helmignore', '.slugignore', '.stylelintignore', 'CODEOWNERS', '.gitattributes'] },
  { name: 'Log', key: 'log', extensions: ['log'] },
  { name: 'CSV', key: 'csv', extensions: ['csv'] },
  { name: 'TSV', key: 'tsv', extensions: ['tsv', 'tab'] },
  { name: 'Batch', key: 'batch', alias: ['bat', 'cmd'], extensions: ['bat', 'cmd'] },
  { name: 'Caddyfile', key: 'caddyfile', filenames: ['Caddyfile'], extensions: ['caddyfile'] },
  { name: 'Vim Script', key: 'vimscript', alias: ['vim', 'viml'], extensions: ['vim'], filenames: ['.vimrc', '.gvimrc', '.ideavimrc', '_vimrc', '.exrc'] },
  { name: 'Subtitles', key: 'subtitles', extensions: ['srt', 'vtt'] },
  { name: 'Gettext', key: 'gettext', alias: ['po'], extensions: ['po', 'pot'] },
  { name: 'Awk', key: 'awk', extensions: ['awk'] },
];

function filenameRegex(filenames = [], patterns = []) {
  const parts = [...(filenames.length ? [exact(filenames)] : []), ...patterns];
  return parts.length ? new RegExp(parts.map((r) => r.source).join('|')) : undefined;
}

/** Extends `languages` (an array of LanguageDescription) in place. */
export function installExtraLanguages(languages) {
  const front = [];
  for (const [name, more] of Object.entries(EXTEND)) {
    const i = languages.findIndex((l) => l.name === name);
    if (i < 0) continue;
    const base = languages[i];
    const own = filenameRegex(more.filenames, more.patterns);
    const filename = base.filename && own ? new RegExp(`${base.filename.source}|${own.source}`) : base.filename || own;
    languages.splice(i, 1);
    front.push(LanguageDescription.of({
      name: base.name, alias: base.alias, extensions: [...new Set([...base.extensions, ...(more.extensions || [])])], filename,
      load: () => base.load(), support: base.support,
    }));
  }
  for (const b of BORROW) {
    const base = languages.find((l) => l.name === b.from) || front.find((l) => l.name === b.from);
    if (base) front.push(LanguageDescription.of({ name: b.name, extensions: b.extensions, filename: filenameRegex(b.filenames), load: () => base.load() }));
  }
  for (const s of SIMPLE) {
    front.push(LanguageDescription.of({ name: s.name, alias: s.alias, extensions: s.extensions || [], filename: filenameRegex(s.filenames), load: simpleMode(s.key) }));
  }
  languages.unshift(...front);
}
