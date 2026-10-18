// LSP / VS Code snippet syntax -> CodeMirror snippet template.
//
// Handles $1, ${1}, ${1:placeholder} (nested placeholders are flattened), ${1|a,b|} (first choice),
// $VAR / ${VAR:default} variables (resolved by the caller), and escapes (\$ \} \\).
// Literal braces are escaped as \{ \} so text like `${name}` (JS templates) or `#{x}` (Ruby/Sass)
// inside the snippet, or inside a variable's value, is never mistaken for a CodeMirror field.

const escapeLiteral = (text) => text.replace(/[{}]/g, (c) => `\\${c}`);

export function convertSnippet(source, resolveVariable = () => '') {
  let i = 0;

  // Parse until `stop` (a closing brace for nested placeholders). Returns CodeMirror template text,
  // or with `plain` the raw text of the region (used for flattened nested placeholder defaults).
  function parse(stopAtBrace, plain) {
    let out = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\' && i + 1 < source.length && '$}\\'.includes(source[i + 1])) {
        out += plain ? source[i + 1] : escapeLiteral(source[i + 1]);
        i += 2;
        continue;
      }
      if (stopAtBrace && c === '}') return out;
      if (c === '$') {
        const rest = source.slice(i + 1);
        let m;
        if ((m = /^(\d+)/.exec(rest))) { // $1
          i += 1 + m[1].length;
          out += plain ? '' : `\${${m[1]}}`;
          continue;
        }
        if ((m = /^\{(\d+)\}/.exec(rest))) { // ${1}
          i += 1 + m[0].length;
          out += plain ? '' : `\${${m[1]}}`;
          continue;
        }
        if ((m = /^\{(\d+)\|([^|]*)\|\}/.exec(rest))) { // ${1|a,b|}
          i += 1 + m[0].length;
          const first = m[2].split(',')[0].replace(/\\(.)/g, '$1');
          out += plain ? first : `\${${m[1]}:${stripBraces(first)}}`;
          continue;
        }
        if ((m = /^\{(\d+):/.exec(rest))) { // ${1:placeholder…}
          i += 1 + m[0].length;
          const inner = parse(true, true);
          i++; // closing }
          out += plain ? inner : `\${${m[1]}:${stripBraces(inner)}}`;
          continue;
        }
        if ((m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) { // $VAR
          i += 1 + m[1].length;
          const value = resolveVariable(m[1]) ?? '';
          out += plain ? value : escapeLiteral(value);
          continue;
        }
        if ((m = /^\{([A-Za-z_][A-Za-z0-9_]*)(:|\/|\})/.exec(rest))) { // ${VAR}, ${VAR:default}, ${VAR/…/}
          i += 2 + m[1].length;
          let fallback = '';
          if (m[2] === ':') { i++; fallback = parse(true, true); }
          else if (m[2] === '/') { while (i < source.length && source[i] !== '}') i++; } // transforms: ignored
          i++; // closing }
          const value = resolveVariable(m[1]) || fallback;
          out += plain ? value : escapeLiteral(value);
          continue;
        }
      }
      out += plain ? c : escapeLiteral(c);
      i++;
    }
    return out;
  }

  return parse(false, false);
}

// Field placeholders can't contain braces in CodeMirror's syntax.
function stripBraces(text) { return text.replace(/[{}]/g, ''); }
