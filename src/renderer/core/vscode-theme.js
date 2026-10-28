// Converts a VS Code color theme (JSON with comments) into a Minimide theme package.
// Pure functions with no Node APIs, so the app (Import from VS Code) and scripts/vscode-theme.mjs
// share them.
import { fixThemeContrast } from './theme-contrast.js';

// ---------------------------------------------------------------------------
// JSONC parser — strips // line comments, /* */ block comments, and trailing
// commas, then delegates to JSON.parse.
// ---------------------------------------------------------------------------

export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    // String: consume verbatim including escape sequences.
    if (text[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    // Line comment.
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // Block comment.
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += text[i++];
  }

  // Strip trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// Color utilities — all internal; no dependencies.
// ---------------------------------------------------------------------------

function parseColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw.startsWith('#')) return null;
  let h = raw.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 6) {
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

function clamp(v) { return Math.round(Math.max(0, Math.min(255, v))); }

function toHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

function colorToCss(c) {
  if (!c) return null;
  if (c.a >= 0.999) return toHex(c.r, c.g, c.b);
  const alpha = parseFloat(c.a.toFixed(3));
  return `rgba(${clamp(c.r)}, ${clamp(c.g)}, ${clamp(c.b)}, ${alpha})`;
}

function colorToHex(c) {
  if (!c) return null;
  return toHex(c.r, c.g, c.b);
}

function shift(c, n) {
  return { r: c.r + n, g: c.g + n, b: c.b + n, a: c.a };
}

function mix(c1, c2, t) {
  return {
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
    a: 1,
  };
}

function withAlpha(c, a) { return { ...c, a }; }

// Return the first key in `colors` that parses as a valid color.
function pick(colors, ...keys) {
  for (const k of keys) {
    const c = parseColor(colors[k]);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token color lookup — finds the first tokenColors entry whose scope covers
// any of the requested target scopes (substring match).
// ---------------------------------------------------------------------------

function normalizeScopes(entry) {
  if (!entry.scope) return [];
  if (Array.isArray(entry.scope)) return entry.scope.map(s => s.trim());
  return entry.scope.split(',').map(s => s.trim()).filter(Boolean);
}

function findToken(tokenColors, ...targets) {
  for (const target of targets) {
    for (const entry of tokenColors) {
      const settings = entry.settings || {};
      if (!settings.foreground) continue;
      const scopes = normalizeScopes(entry);
      for (const sc of scopes) {
        if (sc === target || sc.startsWith(target + '.') || target.startsWith(sc + '.')) {
          return settings;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

// { readable: true } also lifts faint secondary text to a readable contrast (see theme-contrast.js).
export function convertTheme(vsTheme, { readable = false } = {}) {
  const colors = vsTheme.colors || {};
  const tokenColors = vsTheme.tokenColors || [];
  const isDark = (vsTheme.type || 'dark').toLowerCase() !== 'light';
  const name = String(vsTheme.name || 'Converted Theme').replace(/\*\//g, '* /'); // it goes into a CSS comment
  const themeSlug = slug(name);

  // --- UI colors ---
  const bg = pick(colors, 'editor.background')
    ?? (isDark ? parseColor('#1e2128') : parseColor('#fbfbfa'));
  const fg = pick(colors, 'editor.foreground')
    ?? (isDark ? parseColor('#c5cad3') : parseColor('#383a42'));

  const bgSidebar = pick(colors, 'sideBar.background')
    ?? shift(bg, isDark ? -5 : -8);
  const bgTabbar = pick(colors, 'editorGroupHeader.tabsBackground')
    ?? bgSidebar;
  const bgStatusbar = pick(colors, 'statusBar.background')
    ?? shift(bgSidebar, isDark ? -3 : -4);
  const bgElevated = pick(colors, 'editorWidget.background', 'dropdown.background')
    ?? (isDark ? shift(bg, 8) : parseColor('#ffffff'));
  const bgInput = pick(colors, 'input.background')
    ?? (isDark ? shift(bg, -6) : parseColor('#ffffff'));

  const bgHover = pick(colors, 'list.hoverBackground')
    ?? withAlpha(parseColor(isDark ? '#ffffff' : '#000000'), isDark ? 0.045 : 0.04);
  const bgSelected = pick(colors, 'list.inactiveSelectionBackground')
    ?? withAlpha(parseColor(isDark ? '#ffffff' : '#000000'), isDark ? 0.075 : 0.065);

  const accent = pick(colors, 'focusBorder', 'button.background', 'activityBar.activeBorder')
    ?? (isDark ? parseColor('#6aa8ff') : parseColor('#2f6fed'));

  const bgSelectedFocus = pick(colors, 'list.activeSelectionBackground')
    ?? withAlpha(accent, 0.17);

  const fgStrong = pick(colors, 'terminal.foreground', 'foreground')
    ?? shift(fg, isDark ? 40 : -40);
  const fgMuted = pick(colors, 'editorLineNumber.foreground', 'tab.inactiveForeground')
    ?? mix(fg, bg, 0.4);
  const fgSubtle = mix(fgMuted, bg, 0.5);

  const border = pick(colors, 'editorGroup.border', 'sideBar.border', 'panel.border')
    ?? withAlpha(parseColor(isDark ? '#ffffff' : '#000000'), isDark ? 0.055 : 0.07);
  const borderStrong = pick(colors, 'contrastBorder')
    ?? withAlpha(parseColor(isDark ? '#ffffff' : '#000000'), isDark ? 0.095 : 0.12);

  const accentFg = pick(colors, 'button.foreground')
    ?? (isDark ? shift(bg, -10) : parseColor('#ffffff'));

  const selection = pick(colors, 'editor.selectionBackground')
    ?? withAlpha(accent, 0.22);
  const cursor = pick(colors, 'editorCursor.foreground')
    ?? accent;

  const lineHighlight = pick(colors, 'editor.lineHighlightBackground')
    ?? withAlpha(parseColor(isDark ? '#ffffff' : '#000000'), isDark ? 0.028 : 0.028);

  const gutterFg = pick(colors, 'editorLineNumber.foreground')
    ?? mix(bg, fg, 0.25);
  const gutterFgActive = pick(colors, 'editorLineNumber.activeForeground')
    ?? mix(bg, fg, 0.75);

  // Terminal ANSI — VS Code has no orange, derive from red+yellow mix.
  const ansiRed = pick(colors, 'terminal.ansiRed', 'terminal.ansiBrightRed');
  const ansiYellow = pick(colors, 'terminal.ansiYellow', 'terminal.ansiBrightYellow');

  const cRed = ansiRed ?? (isDark ? parseColor('#f07178') : parseColor('#d1495b'));
  const cOrange = (ansiRed && ansiYellow)
    ? mix(ansiRed, ansiYellow, 0.5)
    : (isDark ? parseColor('#f5a66b') : parseColor('#b4690e'));
  const cYellow = ansiYellow ?? (isDark ? parseColor('#f0c674') : parseColor('#a37800'));
  const cGreen = pick(colors, 'terminal.ansiGreen', 'terminal.ansiBrightGreen')
    ?? (isDark ? parseColor('#a3d385') : parseColor('#3c8a2e'));
  const cCyan = pick(colors, 'terminal.ansiCyan', 'terminal.ansiBrightCyan')
    ?? (isDark ? parseColor('#7fd6d0') : parseColor('#0f8c94'));
  const cBlue = pick(colors, 'terminal.ansiBlue', 'terminal.ansiBrightBlue')
    ?? accent;
  const cMagenta = pick(colors, 'terminal.ansiMagenta', 'terminal.ansiBrightMagenta')
    ?? (isDark ? parseColor('#c792ea') : parseColor('#a33ea1'));

  // --- Token color rules ---
  // Each entry: [CSS selector, [VS Code scopes in priority order], default font styles]
  const SCOPE_RULES = [
    ['.tok-comment',
      ['comment', 'punctuation.definition.comment'],
      { italic: true }],
    ['.tok-string, .tok-attributeValue',
      ['string', 'string.quoted', 'string.template', 'string.interpolated'],
      {}],
    ['.tok-keyword, .tok-controlKeyword, .tok-modifier',
      ['keyword.control', 'keyword', 'storage.type', 'storage'],
      {}],
    ['.tok-function',
      ['entity.name.function', 'support.function', 'meta.function-call.generic'],
      {}],
    ['.tok-number, .tok-bool, .tok-atom, .tok-null, .tok-constant',
      ['constant.numeric', 'constant.language', 'constant.character', 'variable.other.constant', 'constant'],
      {}],
    ['.tok-tagName',
      ['entity.name.tag', 'meta.tag.sgml'],
      {}],
    ['.tok-typeName, .tok-className',
      ['entity.name.type', 'entity.name.class', 'support.class', 'support.type'],
      {}],
    ['.tok-propertyName',
      ['support.type.property-name', 'variable.other.property', 'entity.other.attribute-name', 'variable.other.object.property'],
      {}],
    ['.tok-propertyName.tok-definition',
      ['variable.other.constant.property', 'entity.name.function.member'],
      {}],
    ['.tok-variableName.tok-definition',
      ['variable.other.readwrite.definition', 'entity.name.variable', 'variable.declaration'],
      {}],
    ['.tok-punctuation',
      ['punctuation.separator', 'punctuation.definition', 'punctuation'],
      {}],
    ['.tok-operator',
      ['keyword.operator', 'punctuation.accessor'],
      {}],
    ['.tok-heading',
      ['markup.heading', 'entity.name.section.markdown'],
      {}],
    ['.tok-self, .tok-builtin',
      ['variable.language', 'support.variable.property.this', 'support.function.builtin'],
      { italic: true }],
    ['.tok-attributeName',
      ['entity.other.attribute-name', 'meta.attribute'],
      {}],
  ];

  const tokRules = [];
  for (const [selector, scopes, defaults] of SCOPE_RULES) {
    const settings = findToken(tokenColors, ...scopes);
    if (!settings) continue;
    const c = parseColor(settings.foreground);
    if (!c) continue;
    const fontStyle = settings.fontStyle || '';
    const italic = fontStyle.includes('italic') || (defaults.italic && !fontStyle);
    let rule = `${selector} { color: ${colorToCss(c)};`;
    if (italic) rule += ' font-style: italic;';
    rule += ' }';
    tokRules.push(rule);
  }

  // --- Assemble CSS ---
  const colorScheme = isDark ? 'dark' : 'light';
  const css = [
    `/* ${name} — converted from VS Code. */`,
    ':root {',
    `  color-scheme: ${colorScheme};`,
    `  --bg: ${colorToCss(bg)};`,
    `  --bg-sidebar: ${colorToCss(bgSidebar)};`,
    `  --bg-tabbar: ${colorToCss(bgTabbar)};`,
    `  --bg-statusbar: ${colorToCss(bgStatusbar)};`,
    `  --bg-elevated: ${colorToCss(bgElevated)};`,
    `  --bg-input: ${colorToCss(bgInput)};`,
    `  --bg-hover: ${colorToCss(bgHover)};`,
    `  --bg-selected: ${colorToCss(bgSelected)};`,
    `  --bg-selected-focus: ${colorToCss(bgSelectedFocus)};`,
    `  --fg: ${colorToCss(fg)};`,
    `  --fg-strong: ${colorToCss(fgStrong)};`,
    `  --fg-muted: ${colorToCss(fgMuted)};`,
    `  --fg-subtle: ${colorToCss(fgSubtle)};`,
    `  --border: ${colorToCss(border)};`,
    `  --border-strong: ${colorToCss(borderStrong)};`,
    `  --accent: ${colorToCss(accent)};`,
    `  --accent-fg: ${colorToCss(accentFg)};`,
    `  --selection: ${colorToCss(selection)};`,
    `  --cursor: ${colorToCss(cursor)};`,
    `  --line-highlight: ${colorToCss(lineHighlight)};`,
    `  --gutter-fg: ${colorToCss(gutterFg)};`,
    `  --gutter-fg-active: ${colorToCss(gutterFgActive)};`,
    `  --c-red: ${colorToCss(cRed)};`,
    `  --c-orange: ${colorToCss(cOrange)};`,
    `  --c-yellow: ${colorToCss(cYellow)};`,
    `  --c-green: ${colorToCss(cGreen)};`,
    `  --c-cyan: ${colorToCss(cCyan)};`,
    `  --c-blue: ${colorToCss(cBlue)};`,
    `  --c-magenta: ${colorToCss(cMagenta)};`,
    '}',
    ...tokRules,
  ].join('\n');

  // --- Package JSON ---
  const swatches = [
    colorToHex(bg),
    colorToHex(accent),
    colorToHex(cMagenta),
    colorToHex(cGreen),
    colorToHex(cOrange),
  ].filter(Boolean);

  const packageJson = {
    name: themeSlug,
    displayName: name,
    description: `${name} theme, converted from VS Code.`,
    version: '0.1.0',
    theme: 'ui',
    main: false,
    styles: ['theme.css'],
    swatches,
  };

  if (!readable) return { slug: themeSlug, packageJson, themeCss: css };
  const fixed = fixThemeContrast(css);
  return { slug: themeSlug, packageJson, themeCss: fixed.css, contrastChanges: fixed.changes };
}
