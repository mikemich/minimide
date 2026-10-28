// Code Image: draws the selected code (or the file) as a PNG: a rounded window with the file name
// on a soft backdrop in the theme's accent, colored like the editor. Copy it, or save it.

const MAX_LINES = 200;
const MAX_COLS = 110;

export function activate(mide) {
  const { ensureSyntaxTree } = mide.cm.language;
  const { highlightTree } = mide.cm.highlight;
  const { notify } = mide;

  const activeEditor = () => mide.workspace.getActiveEditor();
  const cssVar = (name, fallback = '') => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  // --- what to draw ---------------------------------------------------------
  /** Lines of { text, cls } pieces for the selection (or the whole file), with the editor's token classes. */
  function collect(editor) {
    const { state } = editor.view;
    const sel = state.selection.main;
    let from = sel.empty ? 0 : sel.from;
    let to = sel.empty ? state.doc.length : sel.to;
    // Start at the line's beginning when only indentation comes before the selection.
    const first = state.doc.lineAt(from);
    if (!sel.empty && !state.sliceDoc(first.from, from).trim()) from = first.from;
    // Stop at the line limit, parsing only as far as needed.
    const lastLine = Math.min(state.doc.lineAt(to).number, state.doc.lineAt(from).number + MAX_LINES * 2);
    to = Math.min(to, state.doc.line(lastLine).to);
    const tree = ensureSyntaxTree(state, to, 500);

    const spans = [];
    let pos = from;
    if (tree) {
      highlightTree(tree, mide.editor.highlighters, (a, b, cls) => {
        if (a > pos) spans.push({ from: pos, to: a, cls: '' });
        spans.push({ from: a, to: b, cls });
        pos = b;
      }, from, to);
    }
    if (pos < to) spans.push({ from: pos, to, cls: '' });

    const tab = ' '.repeat(state.tabSize);
    let lines = [[]];
    for (const span of spans) {
      state.sliceDoc(span.from, span.to).split('\n').forEach((piece, i) => {
        if (i) lines.push([]);
        if (piece) lines.at(-1).push({ text: piece.replace(/\t/g, tab), cls: span.cls });
      });
    }
    const textOf = (line) => line.map((p) => p.text).join('');
    const startLine = state.doc.lineAt(from).number;
    // Blank lines at either end are noise.
    let skip = 0;
    while (lines.length > 1 && !textOf(lines[0]).trim()) { lines.shift(); skip++; }
    while (lines.length > 1 && !textOf(lines.at(-1)).trim()) lines.pop();
    let truncated = false;
    if (lines.length > MAX_LINES) { lines = lines.slice(0, MAX_LINES); truncated = true; }

    // Drop the indentation they all share, so a snippet from deep inside a function sits flush left.
    const indent = Math.min(...lines.map(textOf).filter((t) => t.trim()).map((t) => t.match(/^ */)[0].length), Infinity);
    if (indent > 0 && indent < Infinity) {
      for (let line of lines) {
        let drop = indent;
        while (drop > 0 && line.length) {
          const take = Math.min(drop, line[0].text.length);
          line[0] = { ...line[0], text: line[0].text.slice(take) };
          drop -= take;
          if (!line[0].text) line.shift();
        }
      }
    }
    // Very long lines are cut so the picture stays a sensible width.
    for (const line of lines) {
      let room = MAX_COLS;
      for (let i = 0; i < line.length; i++) {
        if (line[i].text.length >= room) {
          line[i] = { ...line[i], text: line[i].text.slice(0, Math.max(room - 1, 0)) + '…' };
          line.length = i + 1;
          break;
        }
        room -= line[i].text.length;
      }
    }
    return { lines, startLine: startLine + skip, truncated };
  }

  // --- colors ---------------------------------------------------------------
  /** How the editor's stylesheet colors a token's classes: asks the browser through a hidden .cm-editor. */
  function styleProbe() {
    const probe = mide.ui.h('div.cm-editor', { style: { position: 'fixed', left: '-9999px', top: '0', color: 'var(--fg)', font: 'inherit' } });
    document.body.append(probe);
    const cache = new Map();
    return {
      of(cls) {
        if (!cache.has(cls)) {
          const el = mide.ui.h('span', { class: cls }, 'x');
          probe.append(el);
          const cs = getComputedStyle(el);
          cache.set(cls, { color: cs.color, bold: Number(cs.fontWeight) >= 600, italic: cs.fontStyle === 'italic' });
        }
        return cache.get(cls);
      },
      done: () => probe.remove(),
    };
  }

  // --- drawing --------------------------------------------------------------
  async function render(editor = activeEditor()) {
    if (!editor) return null;
    const { lines, startLine, truncated } = collect(editor);
    const family = mide.config.get('editor.fontFamily');
    const size = mide.config.get('editor.fontSize') || 14;
    const lineHeight = Math.round(size * (mide.config.get('editor.lineHeight') || 1.5));
    const numbers = !!mide.config.get('code-image.lineNumbers');
    const uiFont = getComputedStyle(document.body).fontFamily;
    // The font may not have loaded yet (it is only fetched once something uses it).
    try { await Promise.all([document.fonts.load(`${size}px ${family}`), document.fonts.load(`600 13px ${uiFont}`)]); } catch {}
    await document.fonts.ready;

    const scale = 2;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${size}px ${family}`;
    const charW = measure.measureText('0').width;
    const cols = Math.max(24, ...lines.map((l) => l.reduce((n, p) => n + p.text.length, 0)));
    const gutterW = numbers ? Math.ceil((String(startLine + lines.length - 1).length * charW) + 18) : 0;
    const pad = 20; // inside the window
    const margin = 56; // around it
    const titleH = 44;
    const winW = Math.ceil(gutterW + cols * charW + pad * 2);
    const winH = titleH + 6 + lines.length * lineHeight + pad + 4;
    const W = winW + margin * 2;
    const H = winH + margin * 2;

    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // Backdrop: the accent fading into a second theme color, softened toward the editor background.
    const bg = cssVar('--bg', '#1e2128');
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, cssVar('--accent', '#6aa8ff'));
    grad.addColorStop(1, cssVar('--c-magenta', '#c792ea'));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    // The window.
    const x = margin, y = margin, radius = 12;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 22;
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(x, y, winW, winH, radius); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, winW, winH, radius); ctx.clip();
    ctx.fillStyle = cssVar('--bg-tabbar', bg);
    ctx.fillRect(x, y, winW, titleH);
    ctx.fillStyle = cssVar('--border', 'rgba(255,255,255,0.06)');
    ctx.fillRect(x, y + titleH - 1, winW, 1);
    ctx.restore();
    ctx.strokeStyle = cssVar('--border-strong', 'rgba(255,255,255,0.1)');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, winW - 1, winH - 1, radius); ctx.stroke();

    [cssVar('--c-red', '#ff5f57'), cssVar('--c-yellow', '#febc2e'), cssVar('--c-green', '#28c840')].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x + pad + 6 + i * 20, y + titleH / 2, 6, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = cssVar('--fg-muted', '#8991a2');
    ctx.font = `600 13px ${uiFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(editor.getTitle().replace(/ \(deleted\)$/, ''), x + winW / 2, y + titleH / 2 + 0.5);

    // The code.
    const styles = styleProbe();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const baseline = Math.round((lineHeight - size) / 2 + size * 0.82);
    lines.forEach((line, i) => {
      const top = y + titleH + 6 + i * lineHeight;
      if (numbers) {
        ctx.font = `${size}px ${family}`;
        ctx.fillStyle = cssVar('--gutter-fg', cssVar('--fg-subtle', '#6d7481'));
        ctx.textAlign = 'right';
        ctx.fillText(String(startLine + i), x + pad + gutterW - 18, top + baseline);
        ctx.textAlign = 'left';
      }
      let col = 0;
      for (const piece of line) {
        const s = styles.of(piece.cls);
        ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${size}px ${family}`;
        ctx.fillStyle = s.color;
        ctx.fillText(piece.text, x + pad + gutterW + col * charW, top + baseline);
        col += piece.text.length;
      }
    });
    styles.done();

    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, lines: lines.length, truncated };
  }

  const limitNote = (image) => (image.truncated ? `Only the first ${MAX_LINES} lines fit.` : undefined);

  mide.commands.add('code-image:copy', 'Copy as Image', async () => {
    const image = await render();
    const copied = await mide.clipboard.writeImage(image.dataUrl);
    notify.success('Copied image', limitNote(image));
    return { ...image, copied };
  }, { when: () => !!activeEditor() });

  mide.commands.add('code-image:save', 'Save as Image…', async () => {
    const editor = activeEditor();
    const base = editor.getTitle().replace(/\.[^.]*$/, '').replace(/ \(deleted\)$/, '') || 'code';
    const dir = editor.getPath() ? mide.path.dirname(editor.getPath()) : mide.workspace.project;
    let path = await window.native.dialog.saveAs(`${dir ? `${dir}/` : ''}${base}.png`);
    if (!path) return false;
    if (!/\.png$/i.test(path)) path += '.png';
    const image = await render(editor);
    await mide.fs.writeDataUrl(path, image.dataUrl);
    notify.success('Saved image', limitNote(image) || path, { actions: [{ label: 'Show in Folder', run: () => mide.shell.reveal(path) }] });
    return { ...image, path };
  }, { when: () => !!activeEditor() });

  mide.services.provide('code-image', { render });
}
