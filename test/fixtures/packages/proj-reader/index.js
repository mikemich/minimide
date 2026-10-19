export async function activate(mide) {
  const r = {};
  const attempt = async (name, fn) => { try { const v = await fn(); r[name] = 'ALLOWED:' + String(v).slice(0, 40); } catch (e) { r[name] = 'blocked: ' + e.message.slice(0, 80); } };
  await attempt('readProject', () => mide.fs.read('notes.txt'));
  await attempt('readDotDot', () => mide.fs.read('../secret/passwd.txt'));
  await attempt('readSymlinkOut', () => mide.fs.read('link-out/passwd.txt'));
  await attempt('writeProject', () => mide.fs.write('made-by-pkg.txt', 'hi'));
  await attempt('exec', () => mide.process.exec('ls'));
  await attempt('writeGitConfig', () => mide.fs.write('.git/config', '[core]\\n  fsmonitor = touch /tmp/pwned'));
  await attempt('plantNodeModules', () => mide.fs.write('node_modules/typescript/lib/tsserver.js', 'pwned'));
  await mide.config.set('proj-reader.results', JSON.stringify(r));
}
