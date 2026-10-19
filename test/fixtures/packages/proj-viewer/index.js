// Test fixture: "project-files" is read-only.
export async function activate(mide) {
  const r = {};
  try { await mide.fs.read('notes.txt'); r.read = 'ALLOWED'; } catch { r.read = 'blocked'; }
  try { await mide.fs.write('viewer-was-here.txt', 'x'); r.write = 'ALLOWED'; } catch { r.write = 'blocked'; }
  await mide.config.set('proj-viewer.results', JSON.stringify(r));
}
