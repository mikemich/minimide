// Read-only access to a VS Code user folder, for "Import Settings from VS Code".
//
// The renderer never names a path: it asks for an install by id ("code", "cursor", …) and gets
// back file contents. Only settings.json, keybindings.json, snippets/ and the color themes that
// installed extensions declare can be read, and every file must stay inside its folder.
import path from 'node:path';
import fs from 'node:fs/promises';

const MAX_FILE = 5 * 1024 * 1024;
const MAX_SNIPPET_FILES = 300;

// Editors that keep their settings in the VS Code layout: id, label, config folder, extensions folder.
const FAMILY = [
  { id: 'code', label: 'VS Code', folder: 'Code', extensions: '.vscode' },
  { id: 'insiders', label: 'VS Code Insiders', folder: 'Code - Insiders', extensions: '.vscode-insiders' },
  { id: 'cursor', label: 'Cursor', folder: 'Cursor', extensions: '.cursor' },
  { id: 'vscodium', label: 'VSCodium', folder: 'VSCodium', extensions: '.vscode-oss' },
];

/** Comments and trailing commas are allowed in VS Code's JSON files. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1'));
}

const isDir = (p) => fs.stat(p).then((s) => s.isDirectory(), () => false);

async function readText(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > MAX_FILE) throw new Error(`${path.basename(file)} is larger than 5 MB.`);
  return fs.readFile(file, 'utf8');
}

/**
 * `override` (tests): a folder holding User/ and extensions/, used instead of the real locations.
 */
export function createVscodeReader({ home, platform, appData, override }) {
  function locations() {
    if (override) return [{ ...FAMILY[0], user: path.join(override, 'User'), extensionsDir: path.join(override, 'extensions') }];
    const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32' ? appData || path.join(home, 'AppData', 'Roaming')
        : path.join(home, '.config');
    return FAMILY.map((f) => ({ ...f, user: path.join(base, f.folder, 'User'), extensionsDir: path.join(home, f.extensions, 'extensions') }));
  }

  async function find(id) {
    const loc = locations().find((l) => l.id === id);
    if (!loc || !await isDir(loc.user)) throw new Error('That editor\'s settings folder was not found.');
    return loc;
  }

  /** The installs that have a user folder. */
  async function scan() {
    const out = [];
    for (const l of locations()) if (await isDir(l.user)) out.push({ id: l.id, label: l.label, dir: l.user });
    return out;
  }

  /** Everything importable from one install, as text. */
  async function read(id) {
    const loc = await find(id);
    const snippets = [];
    const dir = path.join(loc.user, 'snippets');
    for (const e of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).slice(0, MAX_SNIPPET_FILES)) {
      if (!e.isFile() || !/^[^/\\]+\.(json|code-snippets)$/.test(e.name)) continue;
      const text = await readText(path.join(dir, e.name)).catch(() => null);
      if (text != null) snippets.push({ name: e.name, text });
    }
    return {
      settings: await readText(path.join(loc.user, 'settings.json')),
      keybindings: await readText(path.join(loc.user, 'keybindings.json')),
      snippets,
    };
  }

  /** Color themes declared by installed extensions: { label, id, uiTheme, extension, file }. */
  async function extensionThemes(loc) {
    const out = [];
    for (const e of await fs.readdir(loc.extensionsDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const extDir = path.join(loc.extensionsDir, e.name);
      let manifest;
      try { manifest = JSON.parse(await readText(path.join(extDir, 'package.json'))); } catch { continue; }
      for (const t of Array.isArray(manifest.contributes?.themes) ? manifest.contributes.themes : []) {
        if (typeof t?.path !== 'string' || !(t.label || t.id)) continue;
        out.push({ label: String(t.label || t.id), id: t.id ? String(t.id) : null, uiTheme: t.uiTheme, extension: e.name, root: extDir, file: path.resolve(extDir, t.path) });
      }
    }
    return out;
  }

  /** A theme file inside its extension, with "include"d base themes merged in (the theme's own rules win). */
  async function loadThemeFile(root, file, depth = 0) {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    if (!realFile.startsWith(realRoot + path.sep)) throw new Error('Theme file is outside its extension.');
    const theme = parseJsonc(await readText(realFile));
    if (!theme || typeof theme !== 'object') throw new Error('Not a theme.');
    let base = {};
    if (typeof theme.include === 'string' && depth < 4) base = await loadThemeFile(root, path.resolve(path.dirname(realFile), theme.include), depth + 1).catch(() => ({}));
    const rules = (t) => (Array.isArray(t.tokenColors) ? t.tokenColors : []);
    return {
      name: theme.name || base.name, type: theme.type || base.type,
      colors: { ...base.colors, ...theme.colors },
      tokenColors: [...rules(theme), ...rules(base)],
    };
  }

  /** The theme called `name` (its label or id) from an installed extension, or null. */
  async function theme(id, name) {
    const loc = await find(id);
    const hit = (await extensionThemes(loc)).find((t) => t.label === name || t.id === name);
    if (!hit) return null;
    try {
      const data = await loadThemeFile(hit.root, hit.file);
      if (!data.type) data.type = hit.uiTheme === 'vs' || hit.uiTheme === 'hc-light' ? 'light' : 'dark';
      return { ...data, name: hit.label };
    } catch { return null; }
  }

  return { scan, read, theme };
}
