import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonc, convertTheme } from '../../scripts/vscode-theme.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ---------------------------------------------------------------------------
// parseJsonc
// ---------------------------------------------------------------------------

test('parseJsonc: strips line comments', () => {
  const result = parseJsonc('{ "a": 1 // comment\n, "b": 2 }');
  assert.deepEqual(result, { a: 1, b: 2 });
});

test('parseJsonc: strips block comments', () => {
  const result = parseJsonc('{ /* block */ "x": 42 }');
  assert.deepEqual(result, { x: 42 });
});

test('parseJsonc: strips trailing commas in object', () => {
  const result = parseJsonc('{ "a": 1, }');
  assert.deepEqual(result, { a: 1 });
});

test('parseJsonc: strips trailing commas in array', () => {
  const result = parseJsonc('[1, 2, 3,]');
  assert.deepEqual(result, [1, 2, 3]);
});

test('parseJsonc: does not mangle // inside a string', () => {
  const result = parseJsonc('{ "url": "https://example.com" }');
  assert.equal(result.url, 'https://example.com');
});

test('parseJsonc: parses the sample-dark.jsonc fixture', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const theme = parseJsonc(text);
  assert.equal(theme.name, 'Dark Night');
  assert.equal(theme.type, 'dark');
  assert.ok(theme.colors['editor.background']);
  assert.ok(Array.isArray(theme.tokenColors));
  assert.ok(theme.tokenColors.length > 0);
});

// ---------------------------------------------------------------------------
// convertTheme — dark full mapping
// ---------------------------------------------------------------------------

test('convertTheme: dark theme has color-scheme dark', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /color-scheme:\s*dark/);
});

test('convertTheme: dark theme maps editor.background to --bg', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--bg:\s*#282a36/);
});

test('convertTheme: dark theme maps editor.foreground to --fg', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--fg:\s*#f8f8f2/);
});

test('convertTheme: dark theme maps focusBorder to --accent', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--accent:\s*#6272a4/);
});

test('convertTheme: dark theme maps sideBar.background to --bg-sidebar', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--bg-sidebar:\s*#21222c/);
});

test('convertTheme: dark theme maps terminal ANSI colors', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--c-red:\s*#ff5555/);
  assert.match(themeCss, /--c-green:\s*#50fa7b/);
  assert.match(themeCss, /--c-magenta:\s*#bd93f9/);
});

test('convertTheme: dark theme maps comment tokenColor with italic', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /\.tok-comment \{[^}]*#6272a4[^}]*font-style: italic/);
});

test('convertTheme: dark theme maps keyword tokenColor', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /\.tok-keyword[^{]*\{[^}]*#ff79c6/);
});

test('convertTheme: dark theme defines all required CSS variables', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  const required = [
    '--bg', '--bg-sidebar', '--bg-tabbar', '--bg-statusbar', '--bg-elevated',
    '--bg-input', '--bg-hover', '--bg-selected', '--bg-selected-focus',
    '--fg', '--fg-strong', '--fg-muted', '--fg-subtle',
    '--border', '--border-strong', '--accent', '--accent-fg',
    '--selection', '--cursor', '--line-highlight',
    '--gutter-fg', '--gutter-fg-active',
    '--c-red', '--c-orange', '--c-yellow', '--c-green', '--c-cyan', '--c-blue', '--c-magenta',
  ];
  for (const v of required) {
    assert.match(themeCss, new RegExp(v + ':'), `missing variable: ${v}`);
  }
});

test('convertTheme: dark theme produces valid packageJson shape', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-dark.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { slug: themeSlug, packageJson } = convertTheme(vsTheme);
  assert.equal(themeSlug, 'dark-night');
  assert.equal(packageJson.name, 'dark-night');
  assert.equal(packageJson.displayName, 'Dark Night');
  assert.equal(packageJson.theme, 'ui');
  assert.equal(packageJson.main, false);
  assert.deepEqual(packageJson.styles, ['theme.css']);
  assert.ok(Array.isArray(packageJson.swatches));
  assert.ok(packageJson.swatches.length > 0);
  assert.match(packageJson.swatches[0], /^#[0-9a-f]{6}$/);
});

// ---------------------------------------------------------------------------
// convertTheme — fallbacks for a sparse theme
// ---------------------------------------------------------------------------

test('convertTheme: derives --bg-sidebar from --bg when not provided', () => {
  const vsTheme = { name: 'Sparse', type: 'dark', colors: { 'editor.background': '#222233' }, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  // bg-sidebar should be darker than bg (#222233 → R=34,G=34,B=51 → shift -5 → R=29,G=29,B=46 → #1d1d2e)
  assert.match(themeCss, /--bg-sidebar:\s*#1d1d2e/);
});

test('convertTheme: derives --accent from defaults when not in VS Code colors', () => {
  const vsTheme = { name: 'Sparse', type: 'dark', colors: { 'editor.background': '#1a1a2e', 'editor.foreground': '#eaeaea' }, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  // Should use the default dark accent
  assert.match(themeCss, /--accent:\s*#6aa8ff/);
});

test('convertTheme: derives --c-orange from red+yellow mix when both ANSI colors present', () => {
  const vsTheme = {
    name: 'Orange Test',
    type: 'dark',
    colors: { 'terminal.ansiRed': '#ff0000', 'terminal.ansiYellow': '#ffff00' },
    tokenColors: [],
  };
  const { themeCss } = convertTheme(vsTheme);
  // mix(#ff0000, #ffff00, 0.5) = #ff8000
  assert.match(themeCss, /--c-orange:\s*#ff8000/);
});

test('convertTheme: sparse theme still defines all required variables', () => {
  const vsTheme = { name: 'Minimal', type: 'dark', colors: {}, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  const required = ['--bg', '--fg', '--accent', '--selection', '--cursor',
    '--c-red', '--c-green', '--c-blue', '--gutter-fg', '--line-highlight'];
  for (const v of required) {
    assert.match(themeCss, new RegExp(v + ':'), `missing variable: ${v}`);
  }
});

// ---------------------------------------------------------------------------
// convertTheme — light theme
// ---------------------------------------------------------------------------

test('convertTheme: light theme has color-scheme light', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-light.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /color-scheme:\s*light/);
});

test('convertTheme: light theme maps editor.background to --bg', async () => {
  const text = await fs.readFile(path.join(FIXTURES, 'sample-light.jsonc'), 'utf-8');
  const vsTheme = parseJsonc(text);
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /--bg:\s*#fafafa/);
});

test('convertTheme: light theme uses light-appropriate --bg-hover', () => {
  const vsTheme = { name: 'Light', type: 'light', colors: {}, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  // Light fallback: rgba(0, 0, 0, 0.04)
  assert.match(themeCss, /--bg-hover:\s*rgba\(0, 0, 0, 0\.04\)/);
});

test('convertTheme: light type string is case-insensitive', () => {
  const vsTheme = { name: 'L', type: 'Light', colors: {}, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /color-scheme:\s*light/);
});

test('convertTheme: missing type defaults to dark', () => {
  const vsTheme = { name: 'D', colors: {}, tokenColors: [] };
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /color-scheme:\s*dark/);
});

// ---------------------------------------------------------------------------
// convertTheme — tokenColor scope matching edge cases
// ---------------------------------------------------------------------------

test('convertTheme: matches comma-separated scope string', () => {
  const vsTheme = {
    name: 'T', type: 'dark', colors: {},
    tokenColors: [{
      scope: 'comment, punctuation.definition.comment',
      settings: { foreground: '#aabbcc', fontStyle: 'italic' },
    }],
  };
  const { themeCss } = convertTheme(vsTheme);
  assert.match(themeCss, /\.tok-comment \{[^}]*#aabbcc/);
});

test('convertTheme: slug handles spaces and special characters', () => {
  const vsTheme = { name: 'One Dark Pro!', type: 'dark', colors: {}, tokenColors: [] };
  const { slug: themeSlug } = convertTheme(vsTheme);
  assert.equal(themeSlug, 'one-dark-pro');
});
