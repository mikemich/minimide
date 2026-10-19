// Updates from GitHub releases.
//
// macOS builds aren't signed with an Apple Developer ID, which the standard Electron updater
// (Squirrel) requires, so this does it directly: download the release zip, check it against
// the SHA-256 digest GitHub publishes, unpack it, and swap the app bundle once Minimide has
// quit. Linux AppImages are replaced in place; Windows runs the new installer silently.
import path from 'node:path';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { app, net } from 'electron';

const REPO = 'mikemich/minimide';

const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export function isNewer(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p > q;
    return typeof p === 'number'; // 1.0.0 is newer than 1.0.0-beta
  }
  return false;
}

export function createUpdater({ devBuild }) {
  // Dev builds can pretend to be older and install into a scratch copy, for testing.
  const currentVersion = () => (devBuild && process.env.MINIMIDE_FAKE_VERSION) || app.getVersion();
  const devTarget = devBuild ? process.env.MINIMIDE_UPDATE_TARGET : null;
  let staged = null; // { version, kind, file, appPath }

  function pickAsset(assets, version) {
    const byName = (n) => assets.find((a) => a.name === n);
    if (process.platform === 'darwin') return byName(process.arch === 'arm64' ? `Minimide-${version}-arm64-mac.zip` : `Minimide-${version}-mac.zip`);
    if (process.platform === 'win32') {
      return byName(`Minimide-Setup-${version}-${process.arch}.exe`)
        || assets.find((a) => /^Minimide[ .-]Setup[ .-]/i.test(a.name) && a.name.endsWith('.exe'));
    }
    if (process.platform === 'linux' && (process.env.APPIMAGE || devTarget)) return byName(`Minimide-${version}.AppImage`);
    return null;
  }

  async function check() {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Minimide/${app.getVersion()}` },
    });
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is rate-limiting update checks. Try again later.' : `GitHub returned ${res.status}`);
    const release = await res.json();
    const version = release.tag_name.replace(/^v/, '');
    const current = currentVersion();
    const asset = pickAsset(release.assets || [], version);
    return {
      current, version, available: isNewer(version, current),
      notes: release.body || '', url: release.html_url,
      // Without an asset for this platform (e.g. a Linux tarball install) we can only link to the page.
      canInstall: !!asset && (app.isPackaged || !!devTarget),
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null,
    };
  }

  async function download(asset, dest, onProgress) {
    const res = await net.fetch(asset.url, { headers: { 'user-agent': `Minimide/${app.getVersion()}` } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fss.createWriteStream(dest);
    let got = 0;
    let lastReport = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastReport > 250) { lastReport = Date.now(); onProgress?.(asset.size ? got / asset.size : 0); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (asset.size && got !== asset.size) throw new Error('The download was incomplete. Try again.');
    const digest = hash.digest('hex');
    // GitHub publishes a SHA-256 for every release file; never install one without it.
    if (!asset.digest) throw new Error('This release has no published checksum, so it can\'t be verified. Download it from the releases page instead.');
    if (asset.digest.replace(/^sha256:/, '') !== digest) throw new Error('The download is corrupted (checksum mismatch). Try again.');
    return digest;
  }

  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

  /** Downloads and prepares the update; it is applied by finish() when the app quits. */
  async function prepare(info, onProgress) {
    if (!info?.asset) throw new Error('There is no download for this platform. Get the new version from the releases page.');
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'minimide-update-'));
    const file = path.join(work, info.asset.name);
    await download(info.asset, file, onProgress);

    if (process.platform === 'darwin') {
      const appPath = devTarget || path.resolve(process.execPath, '../../..');
      if (!appPath.endsWith('.app')) throw new Error(`Can't update Minimide in ${appPath}.`);
      await fs.access(path.dirname(appPath), fss.constants.W_OK).catch(() => { throw new Error(`Minimide can't write to ${path.dirname(appPath)}. Move it to your Applications folder, or update with the install script.`); });
      const unpacked = path.join(work, 'unpacked');
      await run('ditto', ['-x', '-k', file, unpacked]);
      const newApp = path.join(unpacked, 'Minimide.app');
      const plist = await fs.readFile(path.join(newApp, 'Contents/Info.plist'), 'utf8').catch(() => '');
      const v = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (v !== info.version) throw new Error(`The download contains version ${v || 'unknown'}, expected ${info.version}.`);
      await run('codesign', ['--verify', '--deep', newApp]).catch(() => { throw new Error('The downloaded app failed its code signature check.'); });
      staged = { kind: 'mac', version: info.version, newApp, appPath, work };
    } else if (process.platform === 'linux') {
      const target = devTarget || process.env.APPIMAGE;
      await fs.chmod(file, 0o755);
      staged = { kind: 'appimage', version: info.version, file, target, work };
    } else if (process.platform === 'win32') {
      staged = { kind: 'nsis', version: info.version, file, work };
    }
    return { version: info.version };
  }

  /** Called while quitting. Starts the swap (in a detached helper) and relaunches if asked. */
  function finish({ relaunch = true } = {}) {
    if (!staged) return false;
    const s = staged;
    staged = null;
    if (s.kind === 'mac') {
      // Wait for this process to exit, swap the bundles (rolling back if the move fails), relaunch.
      const script = `
        while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
        rm -rf "$APP.old"
        if mv "$APP" "$APP.old"; then
          if mv "$NEW" "$APP"; then rm -rf "$APP.old"; else mv "$APP.old" "$APP"; fi
        fi
        xattr -dr com.apple.quarantine "$APP" 2>/dev/null
        rm -rf "$WORK"
        [ "$RELAUNCH" = 1 ] && open "$APP"
      `;
      spawn('/bin/sh', ['-c', script], {
        detached: true, stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PID: String(process.pid), APP: s.appPath, NEW: s.newApp, WORK: s.work, RELAUNCH: relaunch && !devTarget ? '1' : '0' },
      }).unref();
    } else if (s.kind === 'appimage') {
      // Renaming over a running AppImage is fine on Linux; the old inode lives until we exit.
      fss.copyFileSync(s.file, `${s.target}.new`);
      fss.chmodSync(`${s.target}.new`, 0o755);
      fss.renameSync(`${s.target}.new`, s.target);
      if (relaunch && !devTarget) app.relaunch({ execPath: s.target });
    } else if (s.kind === 'nsis') {
      // /S = silent install over the current one; --force-run starts Minimide when it's done.
      spawn(s.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  }

  return { check, prepare, finish, hasStaged: () => !!staged, stagedVersion: () => staged?.version || null, currentVersion };
}
