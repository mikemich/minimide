// Builds the in-browser demo into docs/try/ (served by GitHub Pages at /minimide/try/).
// The app is the same renderer the desktop version runs; src/web/native.js stands in for the
// Electron bridge. Run: node scripts/build-web.mjs
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = 'docs/try';
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
// Need a desktop (see LEFT_OUT in src/web/native.js); not shipped to the browser at all.
const LEFT_OUT = new Set(['lsp', 'terminal', 'runner', 'git', 'git-blame', 'source-control', 'debugger', 'ai', 'settings-sync', 'vscode-import', 'remote-ssh', 'local-history']);

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

await esbuild.build({
  entryPoints: ['src/web/main.js'],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: out,
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});

await fs.cp('src/renderer/styles', `${out}/styles`, { recursive: true });

// Built-in packages, with the vendor files the desktop build copies in from node_modules.
const manifests = [];
for (const entry of (await fs.readdir('packages', { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  const name = entry.name;
  if (!entry.isDirectory() || LEFT_OUT.has(name)) continue;
  const dir = path.join('packages', name);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  await fs.cp(dir, path.join(out, 'pkg', name), { recursive: true, filter: (src) => !src.endsWith('.DS_Store') });
  manifests.push({ name: manifest.name || name, folder: name, manifest });
}
const vendor = `${out}/pkg/markdown-preview/vendor`;
await fs.mkdir(vendor, { recursive: true });
await fs.copyFile('node_modules/marked/lib/marked.esm.js', `${vendor}/marked.esm.js`);
await fs.copyFile('node_modules/dompurify/dist/purify.es.mjs', `${vendor}/purify.es.mjs`);
await fs.writeFile(`${out}/packages.json`, JSON.stringify(manifests));

// The desktop page, with a web CSP and the HTML context menu's styles.
let html = await fs.readFile('src/renderer/index.html', 'utf8');
html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Try Minimide, a small hackable code editor, right in your browser.">
  <link rel="icon" href="../icon.png">`)
  .replace('<title>Minimide</title>', `<title>Minimide in your browser</title>
  <style>
    html, body { background: #1b1d23; }
    .web-menu { position: fixed; z-index: 4000; min-width: 220px; padding: 5px; border-radius: 9px; background: var(--bg-elevated); border: 1px solid var(--border-strong); box-shadow: var(--shadow); font: inherit; }
    .web-menu button { display: flex; justify-content: space-between; gap: 24px; width: 100%; padding: 5px 10px; border: 0; border-radius: 5px; background: none; color: var(--fg); text-align: left; }
    .web-menu button:hover:not(:disabled) { background: var(--bg-selected-focus); color: var(--fg-strong); }
    .web-menu button:disabled { opacity: .45; }
    .web-menu kbd { background: none; border: 0; padding: 0; color: var(--fg-subtle); }
    .web-menu hr { border: 0; border-top: 1px solid var(--border); margin: 4px 2px; }
    .web-dialog-backdrop { position: fixed; inset: 0; z-index: 4000; display: grid; place-items: center; background: rgba(0, 0, 0, .35); }
    .web-dialog { width: min(420px, 90vw); padding: 18px 20px 14px; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--border-strong); box-shadow: var(--shadow); color: var(--fg); }
    .web-dialog-message { color: var(--fg-strong); font-weight: 600; margin-bottom: 6px; }
    .web-dialog-detail { color: var(--fg-muted); white-space: pre-wrap; margin-bottom: 14px; }
    .web-dialog-buttons { display: flex; justify-content: flex-end; gap: 8px; }
    .web-dialog-buttons button { padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--bg-hover); color: var(--fg); }
    .web-dialog-buttons button.primary { background: var(--accent); border-color: transparent; color: var(--accent-fg); }
  </style>`);
await fs.writeFile(`${out}/index.html`, html);

const size = async (dir) => {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) total += (await fs.stat(path.join(e.parentPath, e.name))).size;
  return total;
};
console.log(`Built ${out} (${(await size(out) / 1e6).toFixed(1)} MB, ${manifests.length} packages)`);
