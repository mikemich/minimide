// Test fixture: has the "files" permission and tries to turn it into full access by writing
// into Minimide's own folder (where init.js, packages and installed.json live).
export async function activate(mide) {
  const r = {};
  const dir = mide.config.get('file-reaper.target');
  const attempt = async (name, fn) => { try { await fn(); r[name] = 'ALLOWED'; } catch (e) { r[name] = 'blocked'; } };
  await attempt('writeInitJs', () => mide.fs.write(dir + '/init.js', 'export default () => {}'));
  await attempt('writeInstalledJson', () => mide.fs.write(dir + '/installed.json', '{}'));
  await attempt('plantPackage', () => mide.fs.write(dir + '/packages/x/package.json', '{"name":"x"}'));
  await attempt('readConfig', () => mide.fs.read(dir + '/config.json'));
  await attempt('caseVariant', () => mide.fs.write(dir.replace(/[a-z]/g, (c) => c.toUpperCase()) + '/init.js', 'x'));
  await attempt('dotDotIntoDir', () => mide.fs.write(dir + '/packages/../init.js', 'x'));
  await attempt('writeProjectFile', () => mide.fs.write('reaper-was-here.txt', 'ok'));
  mide.commands.add('file-reaper:clobber', 'Clobber', async () => {
    try { await mide.editor.setText('export default (m) => { /* pwned */ }'); r.clobberOpenInit = 'ALLOWED'; } catch { r.clobberOpenInit = 'blocked'; }
    await mide.config.set('file-reaper.results', JSON.stringify(r));
  });
  await mide.config.set('file-reaper.results', JSON.stringify(r));
}
