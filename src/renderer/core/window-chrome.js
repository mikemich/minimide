// The window's own parts follow the theme. Off macOS the window has no native title bar or menu bar
// (main.js): our title bar takes their place, with a button for the menu, and the minimize, maximize
// and close buttons the system draws in its corner get the title bar's colors. Everywhere, the
// window's background (what shows while it resizes) and native menus and dialogs match the theme.
import { h, icon, registerIcon } from './dom.js';

registerIcon('menu', '<path d="M4 7h16M4 12h16M4 17h16"/>');

export function bindWindowChrome(app) {
  // The browser demo keeps the page's own layout: no window to draw a title bar for.
  const native = !['darwin', 'web'].includes(app.userInfo.platform);
  const bar = document.getElementById('titlebar');
  if (native && bar && !bar.querySelector('.titlebar-menu')) {
    const btn = h('button.titlebar-menu', {
      type: 'button', title: 'Menu (Alt)', 'aria-label': 'Application menu', 'aria-haspopup': 'menu',
      onclick: () => { const r = btn.getBoundingClientRect(); window.native.window.showMenu(r.left, r.bottom); },
    }, icon('menu', 16));
    bar.prepend(btn);
    // Alt on its own opens the menu, as a native menu bar would.
    let alone = false;
    window.addEventListener('keydown', (e) => { alone = e.key === 'Alt' && !e.repeat ? true : alone && e.key === 'Alt'; }, true);
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && alone && !e.ctrlKey && !e.shiftKey && !e.metaKey) btn.click();
      alone = false;
    }, true);
    window.addEventListener('mousedown', () => { alone = false; }, true);
  }

  let timer = null;
  let last = '';
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const colors = { background: color('--bg'), bar: color('--bg-sidebar'), symbols: color('--fg-muted') };
      if (!colors.background || !colors.bar || !colors.symbols) return;
      colors.dark = luminance(colors.background) < 0.4;
      const key = JSON.stringify(colors);
      if (key !== last) { last = key; window.native.window.setChrome(colors); }
    }, 150);
  };
  // Theme stylesheets load asynchronously, so look again after any package change too.
  app.packages.on('changed', update);
  app.packages.on('activated', update);
  for (const key of ['core.theme', 'ui.accentColor']) app.config.onDidChange(key, update);
  update();
}

/** A theme variable as #rrggbb, whatever form the theme wrote it in; null when it isn't opaque. */
function color(name) {
  const probe = h('span', { style: { color: `var(${name})`, display: 'none' } });
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
  if (!m || (m[4] != null && Number(m[4]) < 1)) return null;
  return '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
