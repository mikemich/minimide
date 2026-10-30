import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixThemeContrast } from '../../src/renderer/core/theme-contrast.js';

const theme = (accent, extra = '') => `:root {
  --bg: #1e1e24; --bg-sidebar: #1e1e24; --bg-tabbar: #1e1e24; --bg-statusbar: #1e1e24; --bg-elevated: #26262e;
  --fg-strong: #ffffff; --fg-muted: #b0b0b8; --fg-subtle: #8a8a94;
  --accent: ${accent}; --accent-fg: #ffffff;
  ${extra}
}`;

test('a readable accent needs no separate focus ring', () => {
  const { changes } = fixThemeContrast(theme('#6aa8ff'));
  assert.deepEqual(changes.filter((c) => c.startsWith('--focus-ring')), []);
});

test('an accent too dark to see on the panels gets a lighter --focus-ring, keeping the accent', () => {
  const { css, changes } = fixThemeContrast(theme('#2a2a60'));
  assert.equal(changes.filter((c) => c.startsWith('--focus-ring')).length, 1);
  assert.match(css, /--accent: #2a2a60;\n\s+--focus-ring: #[0-9a-f]{6};/);
});

test('an existing --focus-ring is checked instead of the accent', () => {
  assert.deepEqual(fixThemeContrast(theme('#2a2a60', '--focus-ring: #ffd60a;')).changes.filter((c) => c.startsWith('--focus-ring')), []);
});
