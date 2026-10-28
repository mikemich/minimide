// Checks that every theme's secondary text is readable: --fg-muted at 4.5:1 and --fg-subtle at 3:1
// against each panel background, and --accent-fg on --accent where a better choice exists.
// The checks live in src/renderer/core/theme-contrast.js (the app uses them for imported themes too).
//
//   node scripts/theme-contrast.mjs            report problems (exit 1 if any; CI runs this)
//   node scripts/theme-contrast.mjs --fix      fix them in place, by blending toward the theme's
//                                              own --fg-strong (so the hue stays) or flipping
//                                              --accent-fg between white and near-black
//   node scripts/theme-contrast.mjs --fix my-theme/theme.css   just one file
import fs from 'node:fs';
import path from 'node:path';
import { fixThemeContrast } from '../src/renderer/core/theme-contrast.js';
const write = process.argv.includes('--fix');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = only.length ? only : fs.readdirSync('packages').filter((d) => d.startsWith('theme-')).map((d) => path.join('packages', d, 'theme.css'));
let problems = 0;
for (const file of files) {
  const dir = path.basename(path.dirname(file));
  const { css, changes } = fixThemeContrast(fs.readFileSync(file, 'utf8'));
  problems += changes.length;
  if (changes.length) console.log(`${dir}${write ? ' (fixed)' : ''}\n  ${changes.join('\n  ')}`);
  if (write && changes.length) fs.writeFileSync(file, css);
}
if (!write) {
  console.log(problems ? `${problems} contrast problem(s). Run with --fix to repair them.` : `All ${files.length} themes pass.`);
  process.exitCode = problems ? 1 : 0;
}
