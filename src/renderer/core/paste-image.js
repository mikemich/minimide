// Pasting an image into a Markdown file saves it next to the file (images/<name>-<time>.png)
// and inserts the link. Text pastes are left alone; an image pasted into any other file does nothing.
import { EditorView } from '@codemirror/view';
import { basename, dirname } from './dom.js';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

async function pngDataUrl(file) {
  if (file.type !== 'image/png') {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function pasteImage(app) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const data = e.clipboardData;
      // Real text (a copied cell, a Word paragraph) wins over the picture that comes with it.
      const file = data && !data.getData('text/plain') && [...data.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
      if (!file) return false;
      const item = app.workspace.allItems().find((i) => i.type === 'editor' && i.view === view);
      // An untitled file might become Markdown, so it gets the "save first" hint.
      e.preventDefault(); // elsewhere nothing happens, rather than the empty paste replacing the selection
      if (item && (item.document.language?.name === 'Markdown' || (!item.document.path && !item.document.language))) save(app, item, file);
      return true;
    },
  });
}

async function save(app, item, file) {
  const { notify } = app.ui;
  const path = item.document.path;
  if (!path) return notify.info('Save the file first to paste images');
  try {
    const dir = `${dirname(path)}/images`;
    const base = basename(path).replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-');
    let name = `${base}-${stamp()}`;
    for (let n = 2; await window.native.fs.stat(`${dir}/${name}.png`); n++) name = `${base}-${stamp()}-${n}`;
    await window.native.fs.writeDataUrl(`${dir}/${name}.png`, await pngDataUrl(file));
    if (!item.view) return; // closed while saving
    item.view.dispatch({ ...item.view.state.replaceSelection(`![](images/${name}.png)`), userEvent: 'input.paste', scrollIntoView: true });
  } catch (err) {
    notify.error('Could not paste the image', err.message);
  }
}
