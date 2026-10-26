// Checks that every theme's secondary text is readable: --fg-muted at 4.5:1 and --fg-subtle at 3:1
// against each panel background, and --accent-fg on --accent where a better choice exists.
//
//   node scripts/theme-contrast.mjs            report problems (exit 1 if any; CI runs this)
//   node scripts/theme-contrast.mjs --fix      fix them in place, by blending toward the theme's
//                                              own --fg-strong (so the hue stays) or flipping
//                                              --accent-fg between white and near-black
//   node scripts/theme-contrast.mjs --fix my-theme/theme.css   just one file
import fs from 'node:fs';
import path from 'node:path';
const write = process.argv.includes('--fix');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const hex = (s) => { const m = /^#([0-9a-f]{6})$/i.exec(s?.trim() || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const BGS = ['--bg', '--bg-sidebar', '--bg-tabbar', '--bg-statusbar', '--bg-elevated'];
const files = only.length ? only : fs.readdirSync('packages').filter((d) => d.startsWith('theme-')).map((d) => path.join('packages', d, 'theme.css'));
let problems = 0;
for (const file of files) {
  const dir = path.basename(path.dirname(file));
  let css = fs.readFileSync(file, 'utf8');
  const v = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1];
  const bgs = BGS.map((b) => hex(v(b))).filter(Boolean);
  const strong = hex(v('--fg-strong'));
  const changes = [];
  for (const [name, target] of [['--fg-muted', 4.5], ['--fg-subtle', 3]]) {
    const cur = hex(v(name));
    if (!cur || !strong) continue;
    const worst = (c) => Math.min(...bgs.map((b) => ratio(c, b)));
    if (worst(cur) >= target) continue;
    let t = 0, next = cur;
    // A little above the target, so rounding to a hex color can't land just under it.
    while (worst(next) < target + 0.05 && t < 1) { t += 0.01; next = mix(cur, strong, t); }
    changes.push(`${name} ${v(name)} -> ${toHex(next)} (${worst(cur).toFixed(2)} -> ${worst(next).toFixed(2)})`);
    css = css.replace(new RegExp(`(${name}:\\s*)#[0-9a-f]{6}`, 'i'), `$1${toHex(next)}`);
  }
  const accent = hex(v('--accent')), accentFg = hex(v('--accent-fg'));
  if (accent && accentFg) {
    const other = lum(accentFg) > 0.5 ? [16, 18, 22] : [255, 255, 255];
    if (ratio(accentFg, accent) < 4.5 && ratio(other, accent) >= 4.5) {
      changes.push(`--accent-fg ${v('--accent-fg')} -> ${toHex(other)} (${ratio(accentFg, accent).toFixed(2)} -> ${ratio(other, accent).toFixed(2)})`);
      css = css.replace(/(--accent-fg:\s*)#[0-9a-f]{6}/i, `$1${toHex(other)}`);
    }
  }
  problems += changes.length;
  if (changes.length) console.log(`${dir}${write ? ' (fixed)' : ''}\n  ${changes.join('\n  ')}`);
  if (write && changes.length) fs.writeFileSync(file, css);
}
if (!write) {
  console.log(problems ? `${problems} contrast problem(s). Run with --fix to repair them.` : `All ${files.length} themes pass.`);
  process.exitCode = problems ? 1 : 0;
}
