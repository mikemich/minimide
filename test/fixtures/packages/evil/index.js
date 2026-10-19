export async function activate(mide) {
  const r = {};
  const attempt = async (name, fn) => { try { const v = await fn(); r[name] = 'ALLOWED:' + JSON.stringify(v)?.slice(0, 60); } catch (e) { r[name] = 'blocked'; } };
  r.window = typeof window; r.document = typeof document; r.process = typeof process; r.require = typeof require;
  r.indexedDB = typeof self.indexedDB === 'undefined' || self.indexedDB === undefined ? 'undefined' : 'present';
  await attempt('fetchHttps', () => fetch('https://example.com').then((x) => x.status));
  await attempt('fetchMideApp', () => fetch('mide://app/index.html').then((x) => x.status));
  await attempt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onload = () => res(x.status); x.onerror = () => rej(new Error('x')); x.open('GET', 'https://example.com'); x.send(); }));
  await attempt('websocket', () => new Promise((res, rej) => { const w = new WebSocket('wss://example.com'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('ws')); }));
  await attempt('importRemote', () => import('https://esm.sh/lodash'));
  await attempt('eval', () => eval('1+1'));
  await attempt('fnCtor', () => new Function('return 1')());
  await attempt('readOutside', () => mide.fs.read('/etc/hosts'));
  await attempt('readProject', () => mide.fs.read('notes.txt'));
  await attempt('exec', () => mide.process.exec('ls'));
  await attempt('netFetch', () => mide.net.fetch('https://example.com'));
  await attempt('openExternal', () => mide.shell.openExternal('https://example.com/?leak=1'));
  await attempt('clipboardRead', () => mide.clipboard.readText());
  await attempt('runForeignCommand', () => mide.commands.run('settings:open'));
  await attempt('setForeignConfig', () => mide.config.set('core.theme', 'daylight'));
  await attempt('addForeignCommand', () => mide.commands.add('core:pwn', 'x', () => {}) && new Promise((res, rej) => setTimeout(() => res('added?'), 200)));
  await attempt('workspaceOpen', () => mide.workspace.open('notes.txt'));
  r.foreignConfigVisible = mide.config.get('core.restoreSession') === undefined ? 'hidden' : 'VISIBLE';
  r.themeVisible = mide.config.get('core.theme') ? 'visible' : 'hidden';
  await attempt('editorText', () => mide.editor.getText());
  await attempt('importUserInit', () => import('mide://user/init.js'));
  await attempt('importOtherPackage', () => import('mide://pkg/word-count/index.js'));
  r.broadcastChannel = typeof self.BroadcastChannel;
  r.storage = typeof navigator.storage;
  r.locks = typeof navigator.locks;
  r.nestedWorker = typeof self.Worker;
  try { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'storage'); r.storageViaPrototype = typeof (d?.get ? d.get.call(navigator) : d?.value); } catch { r.storageViaPrototype = 'blocked'; }
  // Flood: most of these should be refused rather than freezing the editor.
  const flood = await Promise.allSettled(Array.from({ length: 1500 }, () => mide.editor.getCursor()));
  r.floodRejected = flood.filter((x) => x.status === 'rejected').length;
  const spam = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => mide.notify.info('spam ' + i)));
  r.notifyRejected = spam.filter((x) => x.status === 'rejected').length;
  await new Promise((resolve) => setTimeout(resolve, 2500)); // let the rate limit refill before reporting
  await mide.config.set('evil.results', JSON.stringify(r));
}
