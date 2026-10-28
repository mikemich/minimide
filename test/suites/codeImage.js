// Copy / Save as Image, pasting an image into Markdown, and spell check in prose files,
// over the `cimproj` fixture. Evaluated in the renderer; returns a JSON-able results object.
(async () => { try {
  const app = window.minimide, ws = app.workspace, T = window.mideTest, native = window.native;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } return null; };
  while (!ws.project) await sleep(50);
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  const toasts = () => [...document.querySelectorAll('.notification-title')].map((n) => n.textContent);
  const clearToasts = () => document.querySelectorAll('.notification').forEach((n) => n.remove());
  const shape = (items) => items.map((i) => (i.type === 'separator' ? '|' : i.role || i.label));

  // Decode a PNG data URL into pixels.
  const pixels = async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
  };
  const at = (px, x, y) => { const i = (y * px.width + x) * 4; return `${px.data[i]},${px.data[i + 1]},${px.data[i + 2]}`; };
  // Colors in a grid over the image, rounded so antialiasing doesn't count as new colors.
  const palette = (px, x0, y0, x1, y1) => {
    const set = new Set();
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * px.width + x) * 4;
      set.add([px.data[i], px.data[i + 1], px.data[i + 2]].map((v) => v >> 5).join(','));
    }
    return set;
  };

  // --- copy as image -------------------------------------------------------------------------
  const main = await ws.open(`${ws.project}/main.js`);
  await sleep(1000); // the grammar loads
  const doc = main.view.state.doc;
  main.view.dispatch({ selection: { anchor: doc.line(4).from, head: doc.line(7).to } });
  clearToasts();
  const image = await app.commands.run('code-image:copy');
  out.copy = { lines: image.lines, truncated: image.truncated, onClipboard: image.copied?.width === image.width && image.copied?.height === image.height, toast: toasts().includes('Copied image') };
  const px = await pixels(image.dataUrl);
  out.copy.sizeOk = px.width === image.width && px.width > 600 && px.width < 3000 && px.height > 400 && px.height < 1500 && px.width % 2 === 0;
  // Backdrop in the corner, the window's own background in its middle, and several colors where the code is.
  out.copy.cornerIsBackdrop = at(px, 4, 4) !== at(px, px.width >> 1, px.height - 140);
  out.copy.codeColors = palette(px, 140, 190, px.width - 140, px.height - 140).size;
  out.copy.titleBarDots = palette(px, 140, 146, 260, 166).size > 2;
  out.copy.notBlank = palette(px, 0, 0, px.width, px.height).size >= 8;

  // A long file without a selection is cut at the limit; line numbers (off by default) widen the picture.
  const long = await ws.open(`${ws.project}/long.js`);
  await sleep(600);
  long.view.dispatch({ selection: { anchor: 0 } });
  clearToasts();
  const cut = await app.commands.run('code-image:copy');
  out.wholeFile = { lines: cut.lines, truncated: cut.truncated, note: !!document.querySelector('.notification-detail')?.textContent.includes('200') };
  const svc = app.packages.services.get('code-image');
  main.view.dispatch({ selection: { anchor: doc.line(4).from, head: doc.line(7).to } });
  await ws.open(`${ws.project}/main.js`);
  const plain = await svc.render(main);
  app.config.set('code-image.lineNumbers', true);
  const numbered = await svc.render(main);
  app.config.set('code-image.lineNumbers', false);
  out.lineNumbersWider = numbered.width > plain.width;

  // Save as Image…
  const target = `${ws.project}/out/shot.png`;
  await T.answers('saveAs', target);
  const saved = await app.commands.run('code-image:save');
  const onDisk = await native.fs.readDataUrl(target).catch(() => '');
  out.save = { path: saved.path === target, isPng: onDisk.startsWith('data:image/png;base64,'), notEmpty: onDisk.length > 1000 };
  await T.answers('saveAs', null);
  out.saveCancelled = (await app.commands.run('code-image:save')) === false;

  // The native writes refuse anything that is not a PNG.
  const attempt = (fn) => fn().then(() => 'accepted', (e) => 'refused');
  out.refuses = {
    html: await attempt(() => native.fs.writeDataUrl(`${ws.project}/out/x.png`, 'data:text/html;base64,PGI+aGk8L2I+')),
    notPng: await attempt(() => native.fs.writeDataUrl(`${ws.project}/out/x.png`, 'data:image/png;base64,AAAAAAAAAAAAAAAA')),
    relative: await attempt(() => native.fs.writeDataUrl('x.png', image.dataUrl)),
    clipboard: await attempt(() => native.clipboard.writeImage('data:image/png;base64,AAAAAAAAAAAAAAAA')),
  };
  out.refuses.nothingWritten = !(await native.fs.stat(`${ws.project}/out/x.png`));

  // --- the right-click menu ------------------------------------------------------------------
  const rightClick = async (ed, line, col = 2) => {
    const coords = ed.view.coordsAtPos(ed.view.state.doc.line(line).from + col);
    ed.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: coords.left + 1, clientY: (coords.top + coords.bottom) / 2 }));
    await sleep(300);
  };
  await ws.open(`${ws.project}/main.js`);
  await T.answers('menu', null);
  await rightClick(main, 5);
  const jsMenu = shape((await T.menus()).shown[0] || []);
  out.jsMenu = { copyAsImage: jsMenu.includes('Copy as Image'), afterToggleComment: jsMenu[jsMenu.indexOf('Toggle Comment') + 1] };
  await T.answers('menu', 'code-image:copy');
  clearToasts();
  await rightClick(main, 5);
  await until(() => toasts().includes('Copied image'));
  out.menuCopies = toasts().includes('Copied image');
  await T.menus(); // drain

  // --- pasting an image into Markdown --------------------------------------------------------
  const pngFile = async (color) => {
    const c = document.createElement('canvas');
    c.width = 6; c.height = 4;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 6, 4);
    return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'image.png', { type: 'image/png' });
  };
  const paste = (ed, items) => {
    const dt = new DataTransfer();
    for (const it of items) { if (typeof it === 'string') dt.setData('text/plain', it); else dt.items.add(it); }
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ed.view.contentDOM.dispatchEvent(ev);
    return ev;
  };
  const notes = await ws.open(`${ws.project}/notes.md`);
  await sleep(500);
  notes.view.dispatch({ selection: { anchor: notes.view.state.doc.length } });
  notes.view.focus();
  const ev = paste(notes, [await pngFile('#f00')]);
  const link = await until(() => notes.getText().match(/!\[\]\(images\/(notes-\d{8}-\d{6}(?:-\d+)?\.png)\)/));
  out.pasteImage = { prevented: ev.defaultPrevented, linked: !!link };
  if (link) {
    const file = `${ws.project}/images/${link[1]}`;
    out.pasteImage.written = (await native.fs.readDataUrl(file).catch(() => '')).startsWith('data:image/png;base64,');
    out.pasteImage.atCursor = notes.getText().endsWith(`${link[0]}`) || notes.getText().includes(`${link[0]}`);
  }
  // A second paste doesn't overwrite the first, and a name with spaces gives a link that works as Markdown.
  paste(notes, [await pngFile('#0f0')]);
  await until(() => (notes.getText().match(/!\[\]\(images\//g) || []).length === 2);
  const names = [...notes.getText().matchAll(/\]\((images\/[^)]+)\)/g)].map((m) => m[1]);
  out.pasteImage.twoDistinct = names.length === 2 && names[0] !== names[1];
  const spaced = await ws.open(`${ws.project}/my notes.md`);
  await sleep(400);
  spaced.view.dispatch({ selection: { anchor: spaced.view.state.doc.length } });
  paste(spaced, [await pngFile('#00f')]);
  out.pasteImage.spacedName = !!(await until(() => /!\[\]\(images\/my-notes-\d{8}-\d{6}\.png\)/.test(spaced.getText())));

  // Text still pastes as text, and wins when the clipboard has both.
  notes.view.dispatch({ selection: { anchor: 0 } });
  const before = (await native.fs.readdir(`${ws.project}/images`)).length;
  paste(notes, ['hello ']);
  paste(notes, ['both ', await pngFile('#888')]);
  await sleep(500);
  out.textPaste = { inserted: notes.getText().startsWith('hello both # Notes'), noNewImage: (await native.fs.readdir(`${ws.project}/images`)).length === before };

  // Other kinds of files ignore a pasted image (and keep the selection), and untitled files say to save first.
  const js = await ws.open(`${ws.project}/main.js`);
  const jsBefore = js.getText();
  js.view.dispatch({ selection: { anchor: 5, head: 15 } });
  const jsEv = paste(js, [await pngFile('#f00')]);
  await sleep(400);
  out.otherFiles = { jsIgnored: jsEv.defaultPrevented && js.getText() === jsBefore && js.view.state.selection.main.to === 15 };
  const txt = await ws.open(`${ws.project}/plain.txt`);
  const txtEv = paste(txt, [await pngFile('#f00')]);
  await sleep(300);
  out.otherFiles.txtIgnored = txtEv.defaultPrevented && txt.getText() === 'just some words\n';
  const untitled = await ws.newFile();
  await sleep(300);
  clearToasts();
  const untitledEv = paste(untitled, [await pngFile('#f00')]);
  await until(() => toasts().includes('Save the file first to paste images'));
  out.untitled = { prevented: untitledEv.defaultPrevented, toast: toasts().includes('Save the file first to paste images'), empty: untitled.getText() === '' };
  out.imagesFolder = (await native.fs.readdir(`${ws.project}/images`)).map((e) => e.name).filter((n) => /\.png$/.test(n)).length;

  // --- spell check ---------------------------------------------------------------------------
  const spell = (ed) => ({ spellcheck: ed.view.contentDOM.getAttribute('spellcheck'), autocorrect: ed.view.contentDOM.getAttribute('autocorrect') });
  out.spellcheck = { md: spell(notes).spellcheck, txt: spell(txt).spellcheck, js: spell(js).spellcheck, autocorrectMd: spell(notes).autocorrect, untitled: spell(untitled).spellcheck };
  app.config.set('editor.spellcheck', false);
  await sleep(100);
  out.spellcheck.offMd = spell(notes).spellcheck;
  out.spellcheck.offTxt = spell(txt).spellcheck;
  app.config.set('editor.spellcheck', true);
  await sleep(100);
  out.spellcheck.backOn = spell(notes).spellcheck;
  // Saving a plain file under a Markdown name switches it on, a code name switches it off.
  untitled.document.setPath(`${ws.project}/scratch.md`);
  await sleep(500);
  out.spellcheck.renamedToMd = spell(untitled).spellcheck;
  untitled.document.setPath(`${ws.project}/scratch.js`);
  await sleep(500);
  out.spellcheck.renamedToJs = spell(untitled).spellcheck;
  out.nativeSpell = typeof native.spell.check('hello').misspelled; // the real checker answers (what it flags depends on the OS dictionary)

  // Right-click on a misspelled word: suggestions first, then Add to Dictionary. (The checker itself
  // is Chromium's and depends on the OS dictionaries, so a fixed answer stands in for it here.)
  const looked = [];
  app.spellLookup = (word) => { looked.push(word); return word === 'teh' ? { misspelled: true, suggestions: ['the', 'tech', 'ten', 'tea', 'tee', 'tex'] } : { misspelled: false, suggestions: [] }; };
  await ws.open(`${ws.project}/notes.md`);
  await sleep(200);
  const nl = notes.view.state.doc.toString().split('\n').findIndex((l) => l.includes('teh')) + 1;
  await T.answers('menu', null);
  await rightClick(notes, nl, 1);
  const menu = shape((await T.menus()).shown[0] || []);
  out.spellMenu = { top: menu.slice(0, 7), hasDictionary: menu.includes('Add to Dictionary'), hasCopyImage: menu.includes('Copy as Image'), asked: looked[0] };
  await T.answers('menu', 'spell:1');
  await rightClick(notes, nl, 1);
  await until(() => notes.getText().includes('tech quick'));
  out.spellMenu.replaced = notes.view.state.doc.line(nl).text;
  await T.menus(); // drain
  looked.length = 0;
  await T.answers('menu', null);
  await ws.open(`${ws.project}/main.js`);
  await rightClick(main, 5);
  out.spellMenu.codeFilesNotChecked = looked.length === 0 && !(await T.menus()).shown[0]?.some((i) => i.label === 'Add to Dictionary');

  out.errors = errs;
  return out;
} catch (e) { return { errors: [String(e.stack).split("\n").filter((l) => !/chunk/.test(l)).join("|")] }; } })();
