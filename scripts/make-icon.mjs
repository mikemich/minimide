// Renders build/icon.png (1024×1024) from HTML so the icon needs no design tools.
// Run with: npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';

const html = `<!doctype html><html><head><style>
  html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; overflow: hidden; }
  .tile {
    position: absolute; left: 100px; top: 100px; width: 824px; height: 824px; border-radius: 185px;
    background: linear-gradient(145deg, #7cb4ff 0%, #8d8cf5 48%, #c792ea 100%);
    box-shadow: 0 28px 48px rgba(10, 14, 30, 0.35), inset 0 2px 0 rgba(255,255,255,0.35), inset 0 -10px 30px rgba(40, 20, 90, 0.25);
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .glow { position: absolute; inset: -30% -10% 45% -10%; background: radial-gradient(closest-side, rgba(255,255,255,0.35), transparent); }
  .mark { position: relative; display: flex; align-items: flex-end; gap: 58px; transform: translate(10px, -14px); }
  .m { font: 800 540px/0.8 "SF Mono", Menlo, monospace; color: #141824; letter-spacing: -20px; }
  .cursor { width: 36px; height: 430px; border-radius: 18px; background: #ffffff; box-shadow: 0 0 40px rgba(255,255,255,0.6); margin-bottom: -18px; }
</style></head><body><div class="tile"><div class="glow"></div><div class="mark"><span class="m">m</span><span class="cursor"></span></div></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024, quality: 'best' });
  await fs.writeFile('build/icon.png', out.toPNG());
  console.log('wrote build/icon.png', out.getSize());
  app.quit();
});
