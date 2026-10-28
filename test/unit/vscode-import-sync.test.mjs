import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { convertKey, mapSettings, mapKeybindings, appendKeymapBlock, builtinThemeFor } from '../../packages/vscode-import/convert.js';
import { lineDiff, collapse, summarize } from '../../packages/settings-sync/diff.js';
import { createSecrets, createGist } from '../../src/main/sync.js';
import { createVscodeReader } from '../../src/main/vscode.js';

// --- Import from VS Code ----------------------------------------------------

test('convertKey: ctrl and cmd map to Ctrl/Mod by platform', () => {
  assert.equal(convertKey('ctrl+shift+p', false), 'Mod-Shift-p');
  assert.equal(convertKey('cmd+k cmd+s', true), 'Mod-k Mod-s');
  assert.equal(convertKey('ctrl+shift+p', true), 'Ctrl-Shift-p');
  assert.equal(convertKey('ctrl+numpad_add', false), null);
});

test('mapSettings: converts known settings and lists the rest as skipped', () => {
  const r = mapSettings({ 'editor.fontSize': 15, 'editor.wordWrap': 'on', 'editor.lineHeight': 22, 'workbench.colorTheme': 'Nord', 'terminal.integrated.fontSize': 12, 'editor.tabSize': 'big' });
  assert.deepEqual(r.items.map((i) => [i.to, i.value]), [['editor.fontSize', 15], ['editor.softWrap', true]]);
  assert.deepEqual(r.skipped, ['editor.lineHeight', 'terminal.integrated.fontSize', 'editor.tabSize']);
  assert.equal(r.theme, 'Nord');
});

test('mapKeybindings: skips unknown commands and ones with arguments, removals only for real defaults', () => {
  const list = [
    { key: 'ctrl+alt+j', command: 'workbench.action.togglePanel' },
    { key: 'ctrl+s', command: '-workbench.action.files.save' },
    { key: 'ctrl+alt+q', command: 'ext.thing' },
    { key: 'ctrl+alt+w', command: 'workbench.action.togglePanel', args: {} },
  ];
  const r = mapKeybindings(list, { isMac: false, current: new Map([['Mod-s', 'file:save']]) });
  assert.deepEqual(r.bindings.map((b) => [b.binding, b.command]), [['Mod-Alt-j', 'panel:toggle']]);
  assert.deepEqual(r.removals.map((b) => b.binding), ['Mod-s']);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['no matching command', 'has arguments']);
});

test('appendKeymapBlock: keeps the existing file, comments included, and adds a marked block', () => {
  const text = '// mine\n{\n  // keep\n  "Mod-j": "panel:toggle"\n}\n';
  const out = appendKeymapBlock(text, { 'Alt-p': 'x:y', 'Mod-s': null }, 'VS Code');
  assert.ok(out.startsWith('// mine\n{\n  // keep\n  "Mod-j": "panel:toggle",'));
  assert.match(out, /--- Imported from VS Code ---[\s\S]*"Alt-p": "x:y",[\s\S]*"Mod-s": null,[\s\S]*--- end of import ---\n}\n$/);
  assert.equal(appendKeymapBlock('', { 'Alt-p': 'x:y' }, 'VS Code').startsWith('{\n  // --- Imported'), true);
  assert.equal(appendKeymapBlock('{}\n', { 'Alt-p': 'x:y' }, 'VS Code').includes('"Alt-p": "x:y"'), true);
});

test('builtinThemeFor: matches by name or by the known VS Code equivalents', () => {
  const themes = [{ name: 'nightfall', displayName: 'Nightfall' }, { name: 'fjord', displayName: 'Fjord' }];
  assert.equal(builtinThemeFor('Dark+', themes).name, 'nightfall');
  assert.equal(builtinThemeFor('Nord', themes).name, 'fjord');
  assert.equal(builtinThemeFor('Nightfall', themes).name, 'nightfall');
  assert.equal(builtinThemeFor('Unknown', themes), null);
});

test('VS Code reader only reads the user folder it is pointed at', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-vsc-'));
  try {
    fs.mkdirSync(path.join(root, 'User/snippets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'User/settings.json'), '{ // c\n "editor.fontSize": 12, }');
    fs.writeFileSync(path.join(root, 'User/snippets/a.json'), '{}');
    fs.writeFileSync(path.join(root, 'User/snippets/notes.txt'), 'x');
    const reader = createVscodeReader({ home: root, platform: 'linux', override: root });
    assert.deepEqual((await reader.scan()).map((i) => i.id), ['code']);
    const data = await reader.read('code');
    assert.match(data.settings, /fontSize/);
    assert.equal(data.keybindings, null);
    assert.deepEqual(data.snippets.map((s) => s.name), ['a.json']);
    await assert.rejects(reader.read('../../etc'), /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Settings sync -----------------------------------------------------------

test('lineDiff and collapse: changes with context, long unchanged runs folded', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 10', 'LINE TEN');
  const diff = lineDiff(before, after);
  assert.deepEqual(summarize(diff), { added: 1, removed: 1 });
  const short = collapse(diff, 1);
  assert.deepEqual(short.map((l) => l.type), ['gap', 'same', 'del', 'add', 'same', 'gap']);
  assert.deepEqual(lineDiff('', 'a\nb').map((l) => l.type), ['add', 'add']);
  assert.deepEqual(summarize(lineDiff('a\nb', '')), { added: 0, removed: 2 });
});

function fakeGitHub() {
  const calls = [];
  const gists = {};
  const fetch = async (url, opts) => {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, auth: opts.headers.authorization, redirect: opts.redirect, body: opts.body && JSON.parse(opts.body) });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (u.hostname !== 'api.github.com') return json(500, {});
    const id = /^\/gists\/(\w+)$/.exec(u.pathname)?.[1];
    if (u.pathname === '/gists' && opts.method === 'GET') return json(200, Object.entries(gists).map(([i, g]) => ({ id: i, description: g.description, html_url: 'u', updated_at: 't' })));
    if (u.pathname === '/gists' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      gists['abcdef0123456789'] = { description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, { content: f.content }])) };
      return json(201, { id: 'abcdef0123456789', html_url: 'u', updated_at: 't' });
    }
    if (id && gists[id] && opts.method === 'GET') return json(200, { id, html_url: 'u', updated_at: 't', files: gists[id].files });
    if (id && gists[id] && opts.method === 'PATCH') {
      for (const [n, f] of Object.entries(JSON.parse(opts.body).files)) { if (f === null) delete gists[id].files[n]; else gists[id].files[n] = { content: f.content }; }
      return json(200, { id, html_url: 'u', updated_at: 't' });
    }
    return json(404, {});
  };
  return { fetch, calls, gists };
}

test('secrets: only the allowed name, never readable through the public methods', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-sec-'));
  try {
    const secrets = createSecrets({ file: path.join(dir, 'secrets.json'), plain: true });
    await assert.rejects(secrets.set('other', 'abcdefgh1234'), /Unknown secret/);
    await assert.rejects(secrets.set('github-gist-token', 'no'), /token/);
    assert.equal(await secrets.has('github-gist-token'), false);
    await secrets.set('github-gist-token', ' ghp_abcdefgh1234 ');
    assert.equal(await secrets.has('github-gist-token'), true);
    assert.equal(await secrets.get('github-gist-token'), 'ghp_abcdefgh1234');
    assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('ghp_abcdefgh1234'));
    await secrets.delete('github-gist-token');
    assert.equal(await secrets.has('github-gist-token'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gist client: creates a private gist, then updates it and removes deleted files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-gist-'));
  try {
    const secrets = createSecrets({ file: path.join(dir, 'secrets.json'), plain: true });
    await secrets.set('github-gist-token', 'ghp_abcdefgh1234');
    const gh = fakeGitHub();
    let id = null;
    const gist = createGist({ secrets, fetch: gh.fetch, version: '1.0.0', gh: async () => '', getId: async () => id, setId: async (v) => { id = v; } });
    await assert.rejects(gist.upload({ '../evil': 'x' }), /Can't sync a file called/);
    await assert.rejects(gist.upload({ 'minimide-sync.json': 'x' }), /Can't sync/);
    await gist.upload({ 'config.json': '{}', 'a.txt': '' });
    assert.equal(id, 'abcdef0123456789');
    const post = gh.calls.find((c) => c.method === 'POST');
    assert.equal(post.body.public, false);
    assert.equal(post.body.files['a.txt'].content, '\n'); // GitHub refuses empty files
    assert.ok(gh.calls.every((c) => c.auth === 'Bearer ghp_abcdefgh1234' && c.redirect === 'manual'));
    await gist.upload({ 'config.json': '{"a":1}' });
    assert.deepEqual(Object.keys(gh.gists[id].files).sort(), ['config.json', 'minimide-sync.json']);
    const down = await gist.download();
    assert.deepEqual(down.files, { 'config.json': '{"a":1}' });
    await gist.forget();
    assert.equal(id, null);
    assert.equal(await secrets.has('github-gist-token'), false);
    await assert.rejects(gist.download(), /isn't set up/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gist client: the GitHub CLI token goes straight into the store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mide-gh-'));
  try {
    const secrets = createSecrets({ file: path.join(dir, 'secrets.json'), plain: true });
    const mk = (out) => createGist({ secrets, fetch: async () => { throw new Error('no network'); }, version: '1', gh: async () => { if (out instanceof Error) throw out; return out; }, getId: async () => null, setId: async () => {} });
    assert.equal(await mk(new Error('missing')).cliAvailable(), false);
    assert.deepEqual(await mk('garbage with spaces').cliLogin(), { ok: false, error: 'The GitHub CLI didn\'t return a token.' });
    const ok = mk('gho_abcdefgh12345\n');
    assert.equal(await ok.cliAvailable(), true);
    assert.deepEqual(await ok.cliLogin(), { ok: true });
    assert.equal(await secrets.get('github-gist-token'), 'gho_abcdefgh12345');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
