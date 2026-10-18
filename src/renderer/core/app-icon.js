// Draws the app icon in the active theme's colors and hands it to the Dock (macOS) or the
// window/taskbar (Windows, Linux). Same design as build/icon.png: a rounded tile with an "m"
// and a cursor, but the gradient comes from the theme's accent and the letter from your font.

const SIZE = 512;

const luminance = (color) => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = color;
  const s = ctx.fillStyle;
  const [r, g, b] = s.startsWith('#') ? s.slice(1).match(/../g).map((x) => parseInt(x, 16)) : s.match(/[\d.]+/g).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Returns a PNG data URL of the icon for the current theme. */
export async function renderAppIcon() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const accent = v('--accent', '#7cb4ff');
  // Accent → magenta, like the logo in the app; fall back to blue when they're the same color.
  let second = v('--c-magenta', '#c792ea');
  if (second.toLowerCase() === accent.toLowerCase()) second = v('--c-blue', '#8d8cf5');
  const light = (luminance(accent) + luminance(second)) / 2 > 128;
  const font = (v('--editor-font', 'monospace').split(',')[0] || 'monospace').trim();
  await document.fonts.load(`700 200px ${font}`).catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const k = SIZE / 1024; // drawn on macOS's 1024 icon grid
  const x = 100 * k, y = 100 * k, w = 824 * k, r = 185 * k;
  const tile = new Path2D();
  tile.roundRect(x, y, w, w, r);

  ctx.save();
  ctx.shadowColor = 'rgba(10, 14, 30, 0.35)';
  ctx.shadowBlur = 48 * k;
  ctx.shadowOffsetY = 28 * k;
  const grad = ctx.createLinearGradient(x, y, x + w, y + w);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, second);
  ctx.fillStyle = grad;
  ctx.fill(tile);
  ctx.restore();

  ctx.save();
  ctx.clip(tile);
  const glow = ctx.createRadialGradient(x + w / 2, y - w * 0.05, 0, x + w / 2, y - w * 0.05, w * 0.75);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x, y, w, w);
  ctx.restore();

  // The "m" and a blinking-cursor bar, centered as a pair.
  // A dark letter uses the theme's own background when that's dark (it ties the icon to the theme).
  const bg = v('--bg', '#141824');
  const ink = light ? (luminance(bg) < 60 ? bg : '#141824') : '#ffffff';
  ctx.font = `800 ${540 * k}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  const mWidth = ctx.measureText('m').width;
  const gap = 58 * k, barW = 36 * k, barH = 430 * k;
  const left = x + (w - (mWidth + gap + barW)) / 2 + 10 * k;
  const baseline = y + w / 2 + 150 * k;
  ctx.fillStyle = ink;
  ctx.fillText('m', left, baseline);
  ctx.save();
  ctx.shadowColor = light ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.45)';
  ctx.shadowBlur = 40 * k;
  ctx.fillStyle = light ? '#ffffff' : 'rgba(255, 255, 255, 0.92)';
  ctx.beginPath();
  ctx.roundRect(left + mWidth + gap, baseline + 18 * k - barH, barW, barH, barW / 2);
  ctx.fill();
  ctx.restore();

  return canvas.toDataURL('image/png');
}

/** Keeps the app icon in sync with the theme, accent and editor font (debounced). */
export function bindThemedAppIcon(app) {
  let timer = null;
  let lastUrl = null;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (app.config.get('ui.themedAppIcon') === false) {
        if (lastUrl !== null) { lastUrl = null; window.native.window.setAppIcon(null); }
        return;
      }
      const url = await renderAppIcon();
      if (url !== lastUrl) { lastUrl = url; window.native.window.setAppIcon(url); }
    }, 150);
  };
  // Theme stylesheets load asynchronously, so redraw after any package change too.
  app.packages.on('changed', update);
  app.packages.on('activated', update);
  for (const key of ['core.theme', 'ui.accentColor', 'editor.fontFamily', 'ui.themedAppIcon']) app.config.onDidChange(key, update);
  update();
}
