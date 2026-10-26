// Small syntax highlighters for file types CodeMirror has no grammar for: Makefile, nftables,
// Terraform/HCL, Nix, GraphQL, Prisma, Zig, Gleam, ignore files, logs, CSV/TSV, batch files,
// Caddyfile, justfile, Vim script, subtitles, gettext and awk. They're tokenizers, not parsers:
// enough to color keywords, strings, comments, numbers and variables the way themes expect.
import { StreamLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Token names used below, mapped to the tags themes already color.
const TOKENS = {
  kw: t.keyword, atom: t.atom, num: t.number, str: t.string, str2: t.special(t.string), com: t.comment,
  op: t.operator, punct: t.punctuation, type: t.typeName, prop: t.propertyName, fn: t.function(t.variableName),
  var: t.special(t.variableName), meta: t.meta, tag: t.tagName, err: t.invalid, heading: t.heading,
};

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const NUMBER = /^-?(?:0x[\da-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)\b/i;

/**
 * A configurable tokenizer for C-, shell- and config-like languages.
 * def: { line: ['#', '//'], block: ['/*', '*\/'], strings: '"\'`', keywords, atoms, types, builtins,
 *        typeCase (Capitalized words are types), variable (regex), at (`@name` style), word (regex),
 *        fnCall (word followed by "(" is a function), hook(stream, state) -> token | undefined, ci }
 */
function simple(def) {
  const line = [].concat(def.line || []);
  const strings = def.strings ?? '"\'';
  const word = def.word || /^[A-Za-z_][\w-]*/;
  const ci = (w) => (def.ci ? w.toLowerCase() : w);
  // A named function (not a method): it calls itself, and CodeMirror doesn't call it with `this` set.
  function token(stream, state) {
    if (stream.sol()) state.col = 0;
    if (state.block) {
      if (stream.skipTo(def.block[1])) { stream.pos += def.block[1].length; state.block = false; } else stream.skipToEnd();
      return 'com';
    }
    if (state.str) {
      const q = state.str;
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === q && !escaped) { state.str = null; break; }
        escaped = !escaped && ch === '\\' && !def.rawStrings;
      }
      return 'str';
    }
    if (stream.eatSpace()) return null;
    const hooked = def.hook?.(stream, state);
    if (hooked !== undefined) { state.col++; return hooked; }
    for (const c of line) if (stream.match(c, false) && (c !== '#' || def.hashAnywhere !== false || stream.sol())) { stream.skipToEnd(); return 'com'; }
    if (def.block && stream.match(def.block[0])) { state.block = true; return token(stream, state) || 'com'; }
    const ch = stream.peek();
    if (strings.includes(ch)) { stream.next(); state.str = ch; return token(stream, state) || 'str'; }
    if (def.variable && stream.match(def.variable)) return 'var';
    if (def.at && stream.match(def.at)) return 'meta';
    if (stream.match(NUMBER)) return 'num';
    const m = stream.match(word);
    if (m) {
      const w = ci(m[0]);
      state.col++;
      if (def.keywords?.has(w)) return 'kw';
      if (def.atoms?.has(w)) return 'atom';
      if (def.types?.has(w) || (def.typeCase && /^[A-Z][a-z]/.test(m[0]))) return 'type';
      if (def.builtins?.has(w)) return 'fn';
      if (def.fnCall && stream.match(/^\s*\(/, false)) return 'fn';
      if (def.props && stream.match(/^\s*[:=](?!=)/, false)) return 'prop';
      return null;
    }
    if (stream.match(/^[=+\-*/%<>!&|^~?:]+/)) return 'op';
    stream.next();
    return /[{}()[\];,.]/.test(ch) ? 'punct' : null;
  }
  return StreamLanguage.define({
    name: def.name,
    startState: () => ({ str: null, block: false, col: 0 }),
    token,
    languageData: { commentTokens: { line: line[0], ...(def.block ? { block: { open: def.block[0], close: def.block[1] } } : {}) } },
    tokenTable: TOKENS,
  });
}

// --- Makefile and justfile --------------------------------------------------

const MAKE_DIRECTIVES = words('include -include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override undefine vpath private');
function makefile(just = false) {
  return simple({
    name: just ? 'justfile' : 'makefile', line: '#', strings: '"\'`',
    keywords: just ? words('set alias export import mod if else true false') : MAKE_DIRECTIVES,
    variable: just ? /^\{\{[^}]*\}\}/ : /^\$(?:\([^)]*\)|\{[^}]*\}|[@<^?*%+|$\w])/,
    hook(stream, state) {
      // Target / recipe name: `name:` (not `:=`) at the start of a line.
      if (stream.sol() && stream.match(just ? /^@?[\w-]+(?=[^:=\n]*:(?!=))/ : /^[^\s:#=][^:#=]*(?=:(?!=))/)) return 'fn';
      // Assignment: `NAME =`, `:=`, `?=`, `+=`.
      if (stream.sol() && stream.match(/^[\w.-]+(?=\s*(?:[:?+]?=))/)) return 'var';
      if (!just && stream.match(/^\.(PHONY|SUFFIXES|DEFAULT|PRECIOUS|INTERMEDIATE|SECONDARY|DELETE_ON_ERROR|ONESHELL|SILENT|NOTPARALLEL)\b/)) return 'kw';
      if (stream.sol() && stream.match(/^\t[@+-]*/)) return 'op'; // recipe line marker
      return undefined;
    },
  });
}

// --- nftables ---------------------------------------------------------------

const nftables = simple({
  name: 'nftables', line: '#',
  keywords: words(`table chain rule set map flowtable element elements add delete insert replace create flush list rename reset describe
    define redefine undefine include type hook priority policy device devices flags timeout size counter quota limit rate burst log prefix level
    accept drop reject return jump goto continue queue masquerade snat dnat redirect to tproxy notrack offload flow add update meta ct
    ip ip6 inet arp bridge netdev filter nat route ingress egress prerouting input forward output postrouting`),
  atoms: words(`established related new invalid untracked tcp udp udplite sctp dccp icmp icmpv6 igmp gre esp ah l4proto nfproto protocol
    saddr daddr sport dport iif oif iifname oifname mark state status length dscp ecn ttl hoplimit nexthdr fib hw offload interval constant`),
  variable: /^[$@][\w.-]+/,
  word: /^[A-Za-z_][\w-]*/,
  hook: (stream) => (stream.match(/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d+)?|^[\da-f]*:[\da-f:]*:[\da-f:]*(?:\/\d+)?/i) ? 'num' : undefined),
});

// --- Terraform / HCL, Nix, GraphQL, Prisma, Zig, Gleam -----------------------

const hcl = simple({
  name: 'hcl', line: ['#', '//'], block: ['/*', '*/'], strings: '"',
  keywords: words('resource data variable output module provider locals terraform provisioner backend required_providers dynamic content moved import check for in if for_each count depends_on lifecycle'),
  atoms: words('true false null'), variable: /^\$\{[^}]*\}/, fnCall: true, props: true,
});

const nix = simple({
  name: 'nix', line: '#', block: ['/*', '*/'], strings: '"',
  keywords: words('let in with rec inherit if then else assert or import'), atoms: words('true false null'),
  builtins: words('builtins map toString fetchTarball fetchGit derivation abort throw'),
  variable: /^\$\{[^}]*\}/, props: true,
  hook: (stream) => (stream.match(/^(?:\.{0,2}\/[\w./-]+|<[\w./-]+>)/) ? 'str2' : stream.match(/^''[\s\S]*?''/) ? 'str' : undefined),
});

const graphql = simple({
  name: 'graphql', line: '#', strings: '"',
  keywords: words('query mutation subscription fragment on type interface union enum input scalar schema extend directive implements repeatable'),
  atoms: words('true false null'), types: words('ID String Int Float Boolean'), typeCase: true, variable: /^\$\w+/, at: /^@\w+/, props: true,
});

const prisma = simple({
  name: 'prisma', line: '//', strings: '"',
  keywords: words('model enum datasource generator type view'), atoms: words('true false null'),
  types: words('String Int Boolean DateTime Json Float Decimal BigInt Bytes Unsupported'), typeCase: true, at: /^@@?[\w.]+/, fnCall: true,
});

const zig = simple({
  name: 'zig', line: '//', strings: '"\'',
  keywords: words(`const var fn pub return if else while for switch break continue defer errdefer try catch orelse struct enum union error
    comptime inline noinline extern export test usingnamespace and or unreachable async await suspend resume nosuspend noalias packed align threadlocal volatile allowzero linksection callconv opaque anyframe`),
  atoms: words('true false null undefined'),
  types: words('u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f16 f32 f64 f80 f128 bool void type anyerror anytype noreturn comptime_int comptime_float c_int c_uint c_long c_char anyopaque'),
  at: /^@\w+/, typeCase: true, fnCall: true,
});

const gleam = simple({
  name: 'gleam', line: '//', strings: '"',
  keywords: words('pub fn let assert case use import type opaque const external todo panic as if echo'), atoms: words('True False Nil'),
  typeCase: true, fnCall: true, at: /^@\w+/,
});

// --- Ignore files, logs, CSV/TSV ------------------------------------------------

const ignore = StreamLanguage.define({
  name: 'ignore',
  token(stream) {
    if (stream.sol() && stream.match(/^#.*/)) return 'com';
    if (stream.sol() && stream.eat('!')) return 'op';
    if (stream.match(/^\*\*|^[*?]|^\[[^\]]*\]/)) return 'op';
    if (stream.eat('/')) return 'punct';
    stream.match(/^[^*?[/]+/) || stream.next();
    return 'str';
  },
  languageData: { commentTokens: { line: '#' } },
  tokenTable: TOKENS,
});

const log = StreamLanguage.define({
  name: 'log',
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/) || stream.match(/^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/)
      || stream.match(/^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}/)) return 'com';
    if (stream.match(/^\b(?:FATAL|CRITICAL|CRIT|ERROR|ERR|SEVERE|PANIC|EMERG|ALERT|Exception|Traceback)\b:?/)) return 'err';
    if (stream.match(/^\b(?:WARNING|WARN|WRN)\b:?/i)) return 'atom';
    if (stream.match(/^\b(?:INFO|NOTICE|INF)\b:?/i)) return 'fn';
    if (stream.match(/^\b(?:DEBUG|DBG|TRACE|VERBOSE)\b:?/i)) return 'com';
    if (stream.match(/^https?:\/\/\S+/)) return 'str2';
    if (stream.match(/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/)) return 'str';
    if (stream.match(/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/) || stream.match(NUMBER)) return 'num';
    if (stream.match(/^\[[^\]\s]{1,40}\]/)) return 'meta';
    stream.match(/^[\w.-]+/) || stream.next();
    return null;
  },
  tokenTable: TOKENS,
});

// One color per column, cycling, so wide rows stay readable. Quoted fields may contain the separator.
const COLUMN_TOKENS = ['kw', 'str', 'num', 'fn', 'type', 'var'];
function delimited(sep) {
  return StreamLanguage.define({
    name: sep === '\t' ? 'tsv' : 'csv',
    startState: () => ({ col: 0, quoted: false }),
    token(stream, state) {
      if (stream.sol()) { state.col = 0; }
      if (!state.quoted && stream.eat(sep)) { state.col++; return 'punct'; }
      const style = COLUMN_TOKENS[state.col % COLUMN_TOKENS.length];
      if (state.quoted || stream.peek() === '"') {
        if (!state.quoted) { stream.next(); state.quoted = true; }
        while (!stream.eol()) {
          if (stream.next() === '"') { if (stream.peek() === '"') stream.next(); else { state.quoted = false; break; } }
        }
        return style;
      }
      while (!stream.eol() && stream.peek() !== sep) stream.next();
      return style;
    },
    tokenTable: TOKENS,
  });
}

// --- Batch, Caddyfile, Vim script, subtitles, gettext, awk ------------------

const batch = simple({
  name: 'batch', line: [], strings: '"', ci: true,
  keywords: words('if else goto call exit for in do not exist defined errorlevel equ neq lss leq gtr geq setlocal endlocal enabledelayedexpansion shift pause cls start choice'),
  builtins: words('echo set cd copy del dir md mkdir move ren rmdir type xcopy robocopy find findstr where'),
  variable: /^%[\w~:.,=-]*%|^%%?~?\w|^![\w]+!/,
  hook(stream) {
    if (stream.sol() && stream.match(/^\s*(?:rem\b|::).*/i)) return 'com';
    if (stream.sol() && stream.match(/^:\w+/)) return 'fn';
    if (stream.eat('@')) return 'op';
    return undefined;
  },
});

const caddyfile = simple({
  name: 'caddyfile', line: '#', strings: '"`',
  keywords: words(`reverse_proxy file_server root encode tls log header redir respond route handle handle_path handle_errors rewrite uri
    php_fastcgi basicauth basic_auth import request_body try_files templates bind abort error metrics push skip_log vars map method invoke`),
  variable: /^\{[\w.$>-]+\}/, at: /^@[\w-]+/,
  hook: (stream) => (stream.sol() && stream.match(/^[^\s{#][^\s{]*(?=\s*\{|\s*$)/) ? 'fn' : undefined),
});

const vimscript = simple({
  name: 'vim', line: [], strings: '\'',
  keywords: words(`let unlet set setlocal if elseif else endif for endfor while endwhile function endfunction function! return call execute exe
    try catch finally endtry autocmd augroup command map nmap vmap imap noremap nnoremap vnoremap inoremap xnoremap tnoremap source runtime
    syntax highlight hi colorscheme filetype plugin indent on off silent normal echo echom echoerr lua`),
  variable: /^[gslabwtv]:\w+|^&[\w:]+|^\$\w+/,
  hook(stream) {
    if (stream.match(/^\s*".*/) && stream.string.slice(0, stream.start).trim() === '') return 'com';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'str';
    if (stream.match(/^<[\w-]+>/)) return 'meta';
    return undefined;
  },
});

const subtitles = StreamLanguage.define({
  name: 'subtitles',
  token(stream) {
    if (stream.sol() && stream.match(/^WEBVTT\b.*|^(?:NOTE|STYLE|REGION)\b.*/)) return 'kw';
    if (stream.match(/^(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}/)) return 'num';
    if (stream.match(/^-->/)) return 'op';
    if (stream.sol() && stream.match(/^\d+\s*$/)) return 'com';
    if (stream.match(/^<\/?[\w.]+[^>]*>|^\{\\[^}]*\}/)) return 'tag';
    stream.next();
    return null;
  },
  tokenTable: TOKENS,
});

const gettext = simple({
  name: 'po', line: [], strings: '"',
  keywords: words('msgid msgid_plural msgstr msgctxt'),
  hook(stream) {
    if (stream.sol() && stream.match(/^#[,.:|]?.*/)) return 'com';
    if (stream.match(/^\[\d+\]/)) return 'num';
    return undefined;
  },
});

const awk = simple({
  name: 'awk', line: '#', strings: '"', block: null,
  keywords: words('BEGIN END BEGINFILE ENDFILE function func if else while for do break continue next nextfile exit return delete in getline print printf'),
  builtins: words('length substr index split sub gsub gensub match sprintf tolower toupper system close fflush rand srand int sqrt exp log sin cos atan2 strftime systime'),
  variable: /^\$(?:\d+|NF|\w+)/, atoms: words('NR NF FS OFS RS ORS FILENAME FNR SUBSEP RSTART RLENGTH ENVIRON ARGC ARGV CONVFMT OFMT'),
  hook: (stream) => (stream.match(/^\/(?:[^/\\\n]|\\.)+\/(?=\s*[{,;)~]|\s*$)/) ? 'str2' : undefined),
});

export const languages = {
  makefile: makefile(false), justfile: makefile(true), nftables, hcl, nix, graphql, prisma, zig, gleam, ignore, log,
  csv: delimited(','), tsv: delimited('\t'), batch, caddyfile, vimscript, subtitles, gettext, awk,
};
