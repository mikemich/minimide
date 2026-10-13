// Bundles the renderer with esbuild and copies static assets.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'dist/renderer';

async function copyStatic() {
  await fs.mkdir(out, { recursive: true });
  await fs.copyFile('src/renderer/index.html', `${out}/index.html`);
  await fs.cp('src/renderer/styles', `${out}/styles`, { recursive: true });
  // Vendor libraries for built-in packages that run outside the bundle.
  const vendor = 'packages/markdown-preview/vendor';
  await fs.mkdir(vendor, { recursive: true });
  await fs.copyFile('node_modules/marked/lib/marked.esm.js', path.join(vendor, 'marked.esm.js'));
  await fs.copyFile('node_modules/dompurify/dist/purify.es.mjs', path.join(vendor, 'purify.es.mjs'));
  const term = 'packages/terminal/vendor';
  await fs.mkdir(term, { recursive: true });
  await fs.copyFile('node_modules/@xterm/xterm/lib/xterm.mjs', path.join(term, 'xterm.mjs'));
  await fs.copyFile('node_modules/@xterm/xterm/css/xterm.css', path.join(term, 'xterm.css'));
  await fs.copyFile('node_modules/@xterm/addon-fit/lib/addon-fit.mjs', path.join(term, 'addon-fit.mjs'));
  await fs.copyFile('node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs', path.join(term, 'addon-web-links.mjs'));
  // npm may skip node-pty's install script, which is what makes its helper executable.
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    await fs.chmod(`node_modules/node-pty/prebuilds/${arch}/spawn-helper`, 0o755).catch(() => {});
  }
}

const options = {
  entryPoints: ['src/renderer/app.js'],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: out,
  target: 'chrome130',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  chunkNames: 'chunks/[name]-[hash]',
};

await fs.rm(out, { recursive: true, force: true });
await copyStatic();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
}
