// Image Viewer: an opener for image files that shows them in a zoomable tab.

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];

export function activate(mide) {
  const { h, icon } = mide.ui;
  const items = new Set();

  class ImageItem {
    constructor(path) {
      this.type = 'image';
      this.id = `image-${Math.random().toString(36).slice(2)}`;
      this.path = path;
      this.zoom = null; // null = fit to window
      this.listeners = new Map();
      this.img = h('img.iv-img', { draggable: false, alt: mide.path.basename(path) });
      this.stage = h('div.iv-stage', this.img);
      this.info = h('span.iv-info');
      this.zoomLabel = h('button.iv-zoom-label', { title: 'Toggle fit / actual size', onclick: () => this.setZoom(this.zoom == null ? 1 : null) });
      this.element = h('div.iv-view', { tabIndex: 0, dataset: { bg: mide.config.get('image-viewer.background') } },
        h('div.iv-toolbar',
          this.info,
          h('div.iv-tools',
            h('button.icon-btn', { title: 'Zoom out (⌘-)', onclick: () => this.step(-1) }, '−'),
            this.zoomLabel,
            h('button.icon-btn', { title: 'Zoom in (⌘=)', onclick: () => this.step(1) }, '+'),
            h('button.btn.small', { onclick: () => this.setZoom(null) }, 'Fit'),
            h('button.icon-btn', { title: 'Reveal in Finder', onclick: () => mide.shell.reveal(this.path) }, icon('folder', 14)))),
        this.stage);
      this.element.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return; // pinch-zoom arrives as ctrl+wheel
        e.preventDefault();
        this.setZoom(Math.min(16, Math.max(0.05, this.current() * Math.exp(-e.deltaY / 200))));
      }, { passive: false });
      // Re-fit on the next frame; laying out inside the observer callback causes a resize loop.
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.fitFrame);
        this.fitFrame = requestAnimationFrame(() => { if (this.zoom == null) this.layout(); });
      });
      this.resizeObserver.observe(this.stage);
      this.img.addEventListener('load', () => { this.layout(); this.updateInfo(); });
      this.load();
    }
    on(ev, fn) { this.listeners.set(ev, fn); return { dispose: () => this.listeners.delete(ev) }; }
    getTitle() { return mide.path.basename(this.path); }
    getPath() { return this.path; }
    getElement() { return this.element; }
    focus() { this.element.focus({ preventScroll: true }); }
    serialize() { return { type: 'image', path: this.path }; }
    destroy() { this.resizeObserver.disconnect(); cancelAnimationFrame(this.fitFrame); items.delete(this); }

    async load() {
      try {
        const [url, stat] = await Promise.all([mide.fs.readDataUrl(this.path), mide.fs.stat(this.path)]);
        this.size = stat?.size;
        if (!this.img.isConnected) this.stage.replaceChildren(this.img); // recover after an earlier error
        this.img.src = url;
      } catch (err) {
        this.stage.replaceChildren(h('div.iv-error', `Couldn't open this image: ${err.message}`));
      }
    }

    fitScale() {
      const { naturalWidth: w, naturalHeight: hgt } = this.img;
      if (!w || !hgt) return 1;
      const pad = 48;
      return Math.min(1, (this.stage.clientWidth - pad) / w, (this.stage.clientHeight - pad) / hgt);
    }
    current() { return this.zoom ?? this.fitScale(); }
    step(dir) {
      const cur = this.current();
      const next = dir > 0 ? ZOOMS.find((z) => z > cur + 1e-3) : [...ZOOMS].reverse().find((z) => z < cur - 1e-3);
      if (next) this.setZoom(next);
    }
    setZoom(z) { this.zoom = z; this.layout(); }
    layout() {
      const scale = this.current();
      const w = this.img.naturalWidth;
      const hgt = this.img.naturalHeight;
      if (w && hgt) {
        this.img.style.width = `${Math.max(1, Math.round(w * scale))}px`;
        this.img.style.height = `${Math.max(1, Math.round(hgt * scale))}px`;
      }
      this.img.classList.toggle('pixelated', scale >= 2);
      this.zoomLabel.textContent = this.zoom == null ? `Fit · ${Math.round(scale * 100)}%` : `${Math.round(scale * 100)}%`;
    }
    updateInfo() {
      const kb = this.size != null ? (this.size > 1048576 ? `${(this.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(this.size / 1024))} KB`) : '';
      const ext = this.path.split('.').pop().toUpperCase();
      this.info.textContent = [`${this.img.naturalWidth} × ${this.img.naturalHeight}`, kb, ext].filter(Boolean).join('  ·  ');
    }
  }

  mide.workspace.addOpener((path, opts = {}) => {
    const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
    // Jumping to a line (e.g. a search hit inside an .svg) or "Open as Text" means the source.
    if (!IMAGE_EXT.has(ext) || opts.asText || opts.line != null) return null;
    const item = new ImageItem(path);
    items.add(item);
    return item;
  });

  // Reload open images when they change on disk.
  mide.workspace.onDidChangeFiles((paths) => {
    for (const item of items) if (paths.includes(item.path)) item.load();
  });
  // Zoom keys only apply while an image is active; otherwise they fall through to font size.
  const active = () => { const i = mide.workspace.getActiveItem(); return i?.type === 'image' ? i : null; };
  mide.commands.add({
    'image-viewer:zoom-in': { title: 'Zoom In', when: () => !!active(), run: () => active().step(1) },
    'image-viewer:zoom-out': { title: 'Zoom Out', when: () => !!active(), run: () => active().step(-1) },
    'image-viewer:fit': { title: 'Fit to Window', when: () => !!active(), run: () => active().setZoom(null) },
    'image-viewer:actual-size': { title: 'Actual Size', when: () => !!active(), run: () => active().setZoom(1) },
  });
  mide.keymap.add({ 'Mod-=': 'image-viewer:zoom-in', 'Mod-Shift-=': 'image-viewer:zoom-in', 'Mod--': 'image-viewer:zoom-out', 'Mod-0': 'image-viewer:fit' });

  mide.commands.add('image-viewer:open-as-text', 'Open Image as Text', async () => {
    const item = active();
    if (!item) return;
    const path = item.path;
    await mide.workspace.closeItem(item);
    mide.workspace.open(path, { asText: true });
  }, { when: () => !!active() && active().path.toLowerCase().endsWith('.svg') });
  mide.subscriptions.add({ dispose: () => { for (const item of [...items]) mide.workspace.closeItem(item); } });

  mide.config.onDidChange('image-viewer.background', (bg) => { for (const item of items) item.element.dataset.bg = bg; });

  mide.styles.add(`
    .iv-view { display: flex; flex-direction: column; outline: none; background: var(--bg); }
    .iv-toolbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 36px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--border); background: var(--bg-sidebar); }
    .iv-info { color: var(--fg-muted); font-size: 0.9em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .iv-tools { display: flex; align-items: center; gap: 4px; }
    .iv-tools .icon-btn { font-size: 16px; }
    .iv-zoom-label { min-width: 84px; border: 0; background: transparent; color: var(--fg); font-variant-numeric: tabular-nums; border-radius: var(--radius); padding: 3px 6px; }
    .iv-zoom-label:hover { background: var(--bg-hover); }
    .iv-stage { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 24px; }
    .iv-img { display: block; max-width: none; box-shadow: 0 4px 24px rgba(0,0,0,0.25); }
    .iv-img.pixelated { image-rendering: pixelated; }
    .iv-view[data-bg="checkerboard"] .iv-img { background: repeating-conic-gradient(color-mix(in srgb, var(--fg) 12%, transparent) 0 25%, transparent 0 50%) 50% / 16px 16px; }
    .iv-view[data-bg="dark"] .iv-stage { background: #111; }
    .iv-view[data-bg="light"] .iv-stage { background: #f4f4f4; }
    .iv-error { color: var(--error); }
  `);
}
