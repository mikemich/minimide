// Test fixture: has "network" and tries to reach the user's own machine and cloud metadata.
export async function activate(mide) {
  const r = {};
  for (const [name, url] of [['localhost', 'http://localhost:9/'], ['loopback', 'http://127.0.0.1:9/'], ['metadata', 'http://169.254.169.254/latest/meta-data/'], ['ipv6', 'http://[::1]:9/'], ['private', 'http://192.168.1.1/'], ['file', 'file:///etc/hosts']]) {
    try { await mide.net.fetch(url); r[name] = 'ALLOWED'; } catch (e) { r[name] = /local or private|Only http/.test(e.message) ? 'refused' : 'error: ' + e.message.slice(0, 60); }
  }
  await mide.config.set('net-probe.results', JSON.stringify(r));
}
