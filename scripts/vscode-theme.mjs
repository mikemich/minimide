// Converts a VS Code color theme JSON(C) into a Minimide theme package.
// The conversion lives in src/renderer/core/vscode-theme.js (the app's "Import Settings from
// VS Code" uses it too); this is the command-line front end.
//
// Usage:
//   import { convertTheme, parseJsonc } from './scripts/vscode-theme.mjs';
//   node scripts/vscode-theme.mjs <theme.json> [--out packages]

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertTheme, parseJsonc } from '../src/renderer/core/vscode-theme.js';

export { convertTheme, parseJsonc };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => !a.startsWith('--'));
  if (!inputFile) {
    console.error('Usage: node scripts/vscode-theme.mjs <theme.json> [--out packages]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx !== -1 ? args[outIdx + 1] : 'packages';

  const text = await fs.readFile(inputFile, 'utf-8');
  const vsTheme = parseJsonc(text);
  const { slug: themeSlug, packageJson, themeCss } = convertTheme(vsTheme);
  const pkgDir = path.join(outDir, `theme-${themeSlug}`);
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  await fs.writeFile(path.join(pkgDir, 'theme.css'), themeCss + '\n', 'utf-8');
  console.log(`Written: ${pkgDir}/package.json and theme.css`);
  // VS Code themes often have faint secondary text; Minimide shows it in more places.
  const contrast = spawnSync(process.execPath, [fileURLToPath(new URL('./theme-contrast.mjs', import.meta.url)), '--fix', path.join(pkgDir, 'theme.css')], { encoding: 'utf-8' });
  if (contrast.stdout.trim()) console.log(`Made faint text readable:\n${contrast.stdout.trim()}`);
}
