import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

// Keys shared on purpose: the debugger takes F5 only while a session runs, and Ctrl-` toggles
// the panel until the terminal package takes it over.
const SHARED = { F5: ['debugger', 'runner'], 'Shift-F5': ['debugger', 'runner'], 'Ctrl-`': ['core', 'terminal'] };

function bindings() {
  const owners = {};
  const add = (key, owner) => (owners[key] ??= []).push(owner);
  // CORE_KEYMAP is read as text: core-commands.js imports CodeMirror and renderer modules.
  const core = readFileSync(new URL('src/renderer/core/core-commands.js', root), 'utf8');
  const block = core.slice(core.indexOf('export const CORE_KEYMAP'), core.indexOf('};', core.indexOf('export const CORE_KEYMAP')));
  for (const [, key] of block.matchAll(/'((?:[^'\\]|\\.)+)':\s*'/g)) add(key.replace(/\\\\/g, '\\'), 'core');
  for (const dir of readdirSync(new URL('packages/', root))) {
    const file = new URL(`packages/${dir}/package.json`, root);
    if (!existsSync(file)) continue;
    for (const key of Object.keys(JSON.parse(readFileSync(file, 'utf8')).keymap ?? {})) add(key, dir);
  }
  return owners;
}

test('no two packages, or a package and the core, bind the same key', () => {
  const owners = bindings();
  assert.ok(Object.keys(owners).length > 50, 'read the core and package keymaps');
  const clashes = Object.entries(owners)
    .filter(([key, who]) => who.length > 1 && String(who.sort()) !== String(SHARED[key]))
    .map(([key, who]) => `${key}: ${who.join(', ')}`);
  assert.deepEqual(clashes, []);
});
