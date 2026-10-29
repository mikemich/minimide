// Symbols from CodeMirror's syntax tree, for files no language server covers: JavaScript and
// TypeScript, Python, Markdown headings, CSS rules and JSON keys. Best effort, and cheap: one walk
// over the tree, skipping strings and comments.
//
// A symbol is { name, detail, kind, from, to, selFrom, selTo, children } in editor offsets, the
// same shape the lsp service's documentSymbols() returns.

const MAX_SYMBOLS = 5000;
const SKIP = new Set(['String', 'TemplateString', 'LineComment', 'BlockComment', 'Comment', 'RegExp', 'FormatString', 'ContinuedString']);

const sym = (name, kind, node, nameNode) => ({
  name, detail: '', kind, from: node.from, to: node.to,
  selFrom: nameNode ? nameNode.from : node.from, selTo: nameNode ? nameNode.to : node.from, children: [],
});

// ---------------------------------------------------------------------------
// JavaScript / TypeScript

const FUNCTION_VALUES = new Set(['ArrowFunction', 'FunctionExpression']);

function jsSymbols(node, ctx) {
  const name = (n) => ctx.text(n.from, n.to);
  switch (node.name) {
    case 'ClassDeclaration': case 'ClassExpression': {
      const id = node.getChild('VariableDefinition') || node.getChild('TypeDefinition');
      return id ? [sym(name(id), 'class', node, id)] : null;
    }
    case 'FunctionDeclaration': {
      const id = node.getChild('VariableDefinition');
      return id ? [sym(name(id), 'function', node, id)] : null;
    }
    case 'MethodDeclaration': {
      const id = node.getChild('PropertyDefinition') || node.getChild('PrivatePropertyDefinition');
      if (!id) return null;
      const n = name(id);
      const accessor = node.getChild('get') || node.getChild('set');
      return [sym(n, n === 'constructor' ? 'constructor' : accessor ? 'property' : 'method', node, id)];
    }
    case 'PropertyDeclaration': {
      const id = node.getChild('PropertyDefinition') || node.getChild('PrivatePropertyDefinition');
      if (!id) return null;
      const value = id.nextSibling?.name === 'Equals' ? id.nextSibling.nextSibling : null;
      return [sym(name(id), value && FUNCTION_VALUES.has(value.name) ? 'method' : 'property', node, id)];
    }
    case 'InterfaceDeclaration': case 'TypeAliasDeclaration': case 'EnumDeclaration': {
      const id = node.getChild('TypeDefinition');
      const kind = node.name === 'InterfaceDeclaration' ? 'interface' : node.name === 'EnumDeclaration' ? 'enum' : 'type';
      return id ? [sym(name(id), kind, node, id)] : null;
    }
    case 'NamespaceDeclaration': case 'ModuleDeclaration': {
      const id = node.getChild('VariableDefinition') || node.getChild('String');
      return id ? [sym(name(id), 'namespace', node, id)] : null;
    }
    case 'PropertyType': case 'MethodType': {
      if (ctx.parentKind !== 'interface' && ctx.parentKind !== 'type') return null;
      const id = node.getChild('PropertyDefinition');
      return id ? [sym(name(id), node.name === 'MethodType' ? 'method' : 'property', node, id)] : null;
    }
    case 'EnumBody': {
      if (ctx.parentKind !== 'enum') return null;
      const out = [];
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'PropertyName') out.push(sym(name(c), 'enum member', c, c));
      return { leaves: out };
    }
    case 'Property': {
      // Object literal members, but only of objects that are a named thing's value (not arguments).
      const id = node.getChild('PropertyDefinition');
      if (!id || !ctx.namedObject(node.parent)) return null;
      const value = id.nextSibling;
      const fn = node.getChild('ParamList') || (value && FUNCTION_VALUES.has(value.name));
      return [sym(name(id), fn ? 'method' : 'property', node, id)];
    }
    case 'VariableDeclaration': {
      // `const a = 1, b = () => {}`: one symbol per name, each owning its value's subtree.
      const keyword = node.firstChild?.name;
      const topLevel = ctx.parentKind == null || ctx.parentKind === 'namespace' || ctx.parentKind === 'module';
      const out = [];
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name !== 'VariableDefinition') continue;
        let value = c.nextSibling;
        while (value && (value.name === 'TypeAnnotation' || value.name === 'Equals')) value = value.nextSibling;
        if (value && (value.name === ',' || value.name === ';' || value.name === 'VariableDefinition')) value = null;
        const isFn = value && FUNCTION_VALUES.has(value.name);
        const isClass = value?.name === 'ClassExpression';
        if (!topLevel && !isFn && !isClass) continue;
        const kind = isFn ? 'function' : isClass ? 'class' : keyword === 'const' ? 'constant' : 'variable';
        const s = { ...sym(ctx.text(c.from, c.to), kind, { from: c.from, to: value ? value.to : c.to }, c) };
        if (out.length === 0) s.from = node.from; // `const` belongs to the first name
        out.push(s);
        if (value) ctx.adopt(value, s);
      }
      return { leaves: out, keepParent: true };
    }
    default: return null;
  }
}

/** Is this ObjectExpression the value of a declared variable, property or export default? */
function jsNamedObject(obj) {
  if (obj?.name !== 'ObjectExpression') return false;
  const p = obj.parent?.name;
  return p === 'VariableDeclaration' || p === 'Property' || p === 'ExportDeclaration' || p === 'PropertyDeclaration';
}

// ---------------------------------------------------------------------------
// Python

function pySymbols(node, ctx) {
  switch (node.name) {
    case 'ClassDefinition': case 'FunctionDefinition': {
      const id = node.getChild('VariableName');
      if (!id) return null;
      const n = ctx.text(id.from, id.to);
      const kind = node.name === 'ClassDefinition' ? 'class' : ctx.parentKind === 'class' ? (n === '__init__' ? 'constructor' : 'method') : 'function';
      return [sym(n, kind, node, id)];
    }
    case 'AssignStatement': {
      if (ctx.parentKind != null && ctx.parentKind !== 'class') return null;
      const id = node.firstChild;
      if (id?.name !== 'VariableName') return null;
      const n = ctx.text(id.from, id.to);
      const kind = ctx.parentKind === 'class' ? 'property' : /^[A-Z][A-Z0-9_]*$/.test(n) ? 'constant' : 'variable';
      return { leaves: [sym(n, kind, node, id)] };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// CSS (and its relatives, where their trees use the same names)

function cssSymbols(node, ctx) {
  const before = (block) => ctx.text(node.from, block ? block.from : node.to).replace(/\s+/g, ' ').trim();
  switch (node.name) {
    case 'RuleSet': {
      const block = node.getChild('Block');
      return [{ ...sym(before(block), 'selector', node), selTo: block ? block.from : node.to }];
    }
    case 'MediaStatement': case 'SupportsStatement': case 'KeyframesStatement': case 'AtRule': case 'ScopeStatement': case 'LayerStatement': {
      const block = node.getChild('Block') || node.getChild('KeyframeList');
      if (!block) return null;
      return [{ ...sym(before(block), 'namespace', node), selTo: block.from }];
    }
    case 'Declaration': return { skip: true };
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// JSON

const JSON_KINDS = { Object: 'object', Array: 'array', String: 'string', Number: 'number', True: 'boolean', False: 'boolean', Null: 'null' };

function jsonSymbols(node, ctx) {
  if (node.name !== 'Property') return null;
  const id = node.getChild('PropertyName');
  if (!id) return null;
  const raw = ctx.text(id.from, id.to);
  let name = raw;
  try { name = JSON.parse(raw); } catch { name = raw.replace(/^"|"$/g, ''); }
  const value = node.lastChild; // after the name and ":"
  return [sym(String(name), JSON_KINDS[value?.name] || 'key', node, id)];
}

// ---------------------------------------------------------------------------
// Markdown: headings, nested by level; each one spans until the next heading at its level or above.

function markdownSymbols(state, tree) {
  const headings = [];
  tree.iterate({
    enter(node) {
      const m = /^(ATXHeading|SetextHeading)(\d)$/.exec(node.name);
      if (m) {
        const line = state.doc.lineAt(node.from);
        const text = m[1] === 'ATXHeading' ? line.text.replace(/^\s*#+\s*/, '').replace(/\s+#+\s*$/, '') : line.text.trim();
        const start = line.from + Math.max(0, line.text.indexOf(text));
        headings.push({ name: text.trim() || '(empty heading)', detail: '', kind: 'heading', level: Number(m[2]), from: node.from, to: node.to, selFrom: start, selTo: start + text.length, children: [] });
        return false;
      }
      return /^(Document|Blockquote|BulletList|OrderedList|ListItem)$/.test(node.name);
    },
  });
  const roots = [];
  const stack = [];
  for (const h of headings) {
    while (stack.length && stack.at(-1).level >= h.level) stack.pop().to = h.from - 1;
    (stack.length ? stack.at(-1).children : roots).push(h);
    stack.push(h);
  }
  const end = state.doc.length;
  for (const h of stack) h.to = end;
  const clean = (list) => list.map(({ level, ...s }) => ({ ...s, to: Math.max(s.from, s.to), children: clean(s.children) }));
  return clean(roots);
}

// ---------------------------------------------------------------------------

const EXTRACTORS = {
  javascript: jsSymbols, typescript: jsSymbols, jsx: jsSymbols, tsx: jsSymbols,
  python: pySymbols,
  css: cssSymbols, scss: cssSymbols, less: cssSymbols, sass: cssSymbols,
  json: jsonSymbols,
};

/** Is there a syntax-tree extractor for this CodeMirror language name? */
export const supportsLanguage = (name) => !!name && (name === 'markdown' || name in EXTRACTORS);

/**
 * Symbols for `state` from its syntax tree. `lang` is the CodeMirror language module
 * (mide.cm.language). Returns { symbols, partial }: partial when the parser hadn't reached the end.
 */
export function syntaxSymbols(state, lang) {
  const language = state.facet(lang.language);
  const name = language?.name;
  if (!supportsLanguage(name)) return { symbols: [], partial: false };
  // Give the parser a moment to reach the end; what isn't parsed yet is picked up on the next pass.
  const tree = lang.ensureSyntaxTree(state, state.doc.length, 60) || lang.syntaxTree(state);
  const partial = tree.length < state.doc.length;
  if (name === 'markdown') return { symbols: markdownSymbols(state, tree), partial };
  const extract = EXTRACTORS[name];
  const roots = [];
  const stack = []; // { sym, from, to, type }
  const adopted = new Map(); // `${from}:${typeId}` -> symbol that owns this subtree (a variable's value)
  let count = 0;
  const ctx = {
    text: (from, to) => state.sliceDoc(from, to),
    parentKind: null,
    adopt: (node, s) => adopted.set(`${node.from}:${node.type.id}`, s),
    namedObject: jsNamedObject,
  };
  const add = (s) => { if (count++ < MAX_SYMBOLS) (stack.length ? stack.at(-1).sym.children : roots).push(s); };
  tree.iterate({
    enter(ref) {
      if (SKIP.has(ref.name)) return false;
      const owner = adopted.get(`${ref.from}:${ref.type.id}`);
      if (owner) { stack.push({ sym: owner, from: ref.from, to: ref.to, type: ref.type }); ctx.parentKind = owner.kind; }
      const found = extract(ref.node, ctx);
      if (!found) return;
      if (found.skip) return false;
      if (Array.isArray(found)) {
        // A container: what's inside belongs to it until we leave this node.
        for (const s of found) add(s);
        if (found.length === 1) { stack.push({ sym: found[0], from: ref.from, to: ref.to, type: ref.type }); ctx.parentKind = found[0].kind; }
        return;
      }
      for (const s of found.leaves) add(s);
      if (!found.keepParent) return false;
    },
    leave(ref) {
      while (stack.length) {
        const top = stack.at(-1);
        if (top.from !== ref.from || top.to !== ref.to || top.type !== ref.type) break;
        stack.pop();
      }
      ctx.parentKind = stack.at(-1)?.sym.kind ?? null;
    },
  });
  return { symbols: roots, partial };
}

/** The chain of symbols (outermost first) whose range contains `pos`. */
export function pathAt(symbols, pos) {
  const path = [];
  let list = symbols;
  while (list?.length) {
    let hit = null;
    for (const s of list) {
      if (s.from > pos) break;
      if (s.to >= pos) hit = s; // the last one that starts before pos: the innermost of overlapping siblings
    }
    if (!hit) break;
    path.push(hit);
    list = hit.children;
  }
  return path;
}

/** Every symbol, depth first, with its parent chain. */
export function flatten(symbols, out = [], parents = []) {
  for (const s of symbols) {
    out.push({ sym: s, parents });
    flatten(s.children, out, [...parents, s]);
  }
  return out;
}
