// Things the end-to-end suites talk to instead of the real internet or the real VS Code folder.
// A suite's `server: (fixtures) => Promise<{ env, close }>` starts one before the app launches; the
// returned `env` is added to the app's environment (the dev-build overrides in src/main/main.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** The token every fake gist server accepts, and the one the fake `gh` prints. */
export const GIST_TOKEN = 'test-token-1234567890';
export const GH_TOKEN = 'gh-cli-token-abcdef123456';

/** Point the app at the fake VS Code user folder built by fixtures.mjs. */
export function vscodeEnv(fixtures) {
  return async () => ({ env: { MINIMIDE_VSCODE_DIR: path.join(fixtures, 'vsc') }, close: async () => {} });
}

/** A stand-in for the `gh` program: prints a token, or fails like a logged-out CLI. */
function writeGhStubs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const win = process.platform === 'win32';
  const make = (name, body, winBody) => {
    const file = path.join(dir, win ? `${name}.cmd` : name);
    fs.writeFileSync(file, win ? winBody : body, { mode: 0o755 });
    return file;
  };
  return {
    ok: make('gh-ok', `#!/bin/sh\necho ${GH_TOKEN}\n`, `@echo off\r\necho ${GH_TOKEN}\r\n`),
    fail: make('gh-fail', '#!/bin/sh\necho "not logged in" >&2\nexit 1\n', '@echo off\r\nexit /b 1\r\n'),
  };
}

/**
 * A fake api.github.com that only knows gists. Gists are kept in <fixtures>/gist-store.json, so a
 * later suite (another "computer") sees what an earlier one uploaded; every request is logged to
 * <fixtures>/gist-<name>-requests.json for the suite to inspect.
 *   gh:   'ok' | 'fail'  what the fake `gh auth token` does
 *   seed: (store) => void  changes the stored gists before the suite starts
 */
export function gistServer({ name, gh = 'fail', seed } = {}) {
  return async (fixtures) => {
    const storeFile = path.join(fixtures, 'gist-store.json');
    const logFile = path.join(fixtures, `gist-${name}-requests.json`);
    const load = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return { gists: {} }; } };
    const save = (store) => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
    if (seed) { const store = load(); seed(store); save(store); }
    const log = [];
    fs.writeFileSync(logFile, '[]');

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        let body = null;
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch {}
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const entry = {
          method: req.method, path: url.pathname, token,
          userAgent: req.headers['user-agent'] || '', apiVersion: req.headers['x-github-api-version'] || '',
          public: body?.public, description: body?.description,
          files: body?.files ? Object.keys(body.files).filter((n) => body.files[n]) : undefined,
          deleted: body?.files ? Object.keys(body.files).filter((n) => body.files[n] === null) : undefined,
        };
        log.push(entry);
        fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
        const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (token !== GIST_TOKEN && token !== GH_TOKEN) return send(401, { message: 'Bad credentials' });
        const store = load();
        const view = (id, full) => {
          const g = store.gists[id];
          return {
            id, description: g.description, public: g.public, html_url: `https://gist.example.test/${id}`, updated_at: g.updated_at,
            ...(full ? { files: Object.fromEntries(Object.entries(g.files).map(([n, content]) => [n, { filename: n, content, truncated: false }])) } : {}),
          };
        };
        const match = /^\/gists\/([0-9a-f]+)$/.exec(url.pathname);
        if (url.pathname === '/gists' && req.method === 'GET') return send(200, Object.keys(store.gists).map((id) => view(id, false)));
        if (url.pathname === '/gists' && req.method === 'POST' && body?.files) {
          const id = crypto.randomBytes(16).toString('hex');
          store.gists[id] = {
            description: body.description || '', public: !!body.public, updated_at: new Date().toISOString(),
            files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])),
          };
          save(store);
          return send(201, view(id, true));
        }
        if (match && store.gists[match[1]] && req.method === 'GET') return send(200, view(match[1], true));
        if (match && store.gists[match[1]] && req.method === 'PATCH' && body?.files) {
          const g = store.gists[match[1]];
          for (const [n, f] of Object.entries(body.files)) { if (f === null) delete g.files[n]; else g.files[n] = f.content; }
          g.updated_at = new Date().toISOString();
          save(store);
          return send(200, view(match[1], true));
        }
        send(404, { message: 'Not Found' });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const stubs = writeGhStubs(path.join(fixtures, 'bin'));
    return {
      env: {
        MINIMIDE_GIST_API: `http://127.0.0.1:${server.address().port}`,
        MINIMIDE_SECRETS_PLAIN: '1',
        MINIMIDE_GH_BIN: stubs[gh],
      },
      close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
  };
}

// ---------------------------------------------------------------------------
// A fake GitHub for the package browser: search, repositories, package.json, README, commits and the
// tarballs the installer downloads (served under /_codeload, which MINIMIDE_GITHUB_API makes the app
// use instead of codeload.github.com). Every request is logged to <fixtures>/github/requests.json.
// Which version of each repository is "pushed" is read from <fixtures>/github/head.json
// ({ "ada/goal-tracker": 2 }) on every request, so a suite can publish a new commit by writing it.
// Searching for "limited" is rate-limited, for "offline" the connection is dropped.

const README_GOAL = [
  '# Goal Tracker', '',
  'Set a **daily word goal** and watch the status bar fill up.', '',
  '## Install', '',
  'Open the details page and press `Install`.', '',
  '![Screenshot](docs/shot.png)', '',
  '![Badge](https://img.shields.io/badge/tests-passing-green.svg)', '',
  'See [CONTRIBUTING](CONTRIBUTING.md), the [home page](https://example.com/goal) or jump to [Install](#install).', '',
  '```js', 'mide.commands.run("goal:set");', '```', '',
  '<script>window.__readmeXss = 1</script>',
  '<img src="x.png" onerror="window.__readmeXss = 2">', '',
].join('\n');

const FAKE_REPOS = {
  'ada/goal-tracker': {
    stars: 42, pushed: '2026-09-01T10:00:00Z', description: 'Set a daily word goal and watch it fill up.', readme: README_GOAL,
    versions: [{ version: '1.0.0', permissions: ['project-files', 'network'] }, { version: '1.1.0', permissions: ['project-files', 'network'] }],
  },
  'bob/quick-notes': {
    stars: 7, pushed: '2026-10-10T08:00:00Z', description: 'Jot notes in a scratch file.', readme: '# Quick Notes\n\nScratch notes, one keystroke away.\n',
    versions: [{ version: '1.0.0', permissions: [] }, { version: '2.0.0', permissions: ['clipboard'] }],
  },
  'cy/power-tools': {
    stars: 3, pushed: '2026-06-01T12:00:00Z', description: 'Everything, with full access.', readme: '# Power Tools\n\nNeeds the keys to the house.\n',
    versions: [{ version: '0.3.0', access: 'full', permissions: [] }],
  },
  'dee/not-a-package': {
    stars: 1, pushed: '2026-01-05T12:00:00Z', description: 'A repository with the topic but no package.json.', readme: null, versions: [{ version: null }],
  },
};

export function githubServer({ name = 'packageBrowser' } = {}) {
  return async (fixtures) => {
    const root = path.join(fixtures, 'github');
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    const headFile = path.join(root, 'head.json');
    const logFile = path.join(root, 'requests.json');
    fs.writeFileSync(headFile, '{}');
    const log = [];
    fs.writeFileSync(logFile, '[]');
    const sha = (full, v) => crypto.createHash('sha1').update(`${name}:${full}:${v}`).digest('hex');
    const head = (full) => { try { return JSON.parse(fs.readFileSync(headFile, 'utf8'))[full] || 1; } catch { return 1; } };
    const files = (full, v) => {
      const ver = FAKE_REPOS[full].versions[v - 1];
      if (!ver.version) return null;
      const short = full.split('/')[1];
      const manifest = {
        name: short, displayName: short.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), version: ver.version,
        description: FAKE_REPOS[full].description, main: 'index.js', access: ver.access || 'sandboxed', permissions: ver.permissions,
      };
      return {
        'package.json': JSON.stringify(manifest, null, 2) + '\n',
        'index.js': `export function activate(mide) {\n  mide.statusBar.addItem({ text: '${short} v${ver.version}', tooltip: '${short}', align: 'right' });\n}\n`,
      };
    };
    const tarball = (full, hash) => {
      const out = path.join(work, `${hash}.tgz`);
      if (!fs.existsSync(out)) {
        const v = FAKE_REPOS[full].versions.findIndex((_, i) => sha(full, i + 1) === hash) + 1;
        const dir = path.join(work, `${full.replace('/', '-')}-${hash.slice(0, 7)}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const [file, content] of Object.entries(files(full, v))) fs.writeFileSync(path.join(dir, file), content);
        execFileSync('tar', ['-czf', out, '-C', work, path.basename(dir)]);
      }
      return fs.readFileSync(out);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q') || '';
      const term = q.replace(/^topic:\S+\s*/, '').trim().toLowerCase();
      log.push({ path: url.pathname, ...(url.pathname === '/search/repositories' ? { term, sort: url.searchParams.get('sort') } : {}), accept: req.headers.accept || '' });
      fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
      const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      const text = (body) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); };
      const view = (full) => {
        const r = FAKE_REPOS[full];
        const [owner, repo] = full.split('/');
        return { full_name: full, name: repo, owner: { login: owner }, description: r.description, stargazers_count: r.stars, html_url: `https://github.com/${full}`, pushed_at: r.pushed, default_branch: 'main', license: { spdx_id: 'MIT' } };
      };
      if (url.pathname === '/search/repositories') {
        if (term === 'offline') return req.socket.destroy();
        if (term === 'limited') return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 170) });
        const hits = Object.keys(FAKE_REPOS).filter((f) => !term || `${f} ${FAKE_REPOS[f].description}`.toLowerCase().includes(term));
        hits.sort((a, b) => (url.searchParams.get('sort') === 'updated' ? FAKE_REPOS[b].pushed.localeCompare(FAKE_REPOS[a].pushed) : FAKE_REPOS[b].stars - FAKE_REPOS[a].stars));
        return send(200, { total_count: hits.length, items: hits.map(view) });
      }
      let m = /^\/repos\/([\w.-]+\/[\w.-]+)(\/.*)?$/.exec(url.pathname);
      if (m && FAKE_REPOS[m[1]]) {
        const full = m[1];
        const v = head(full);
        if (!m[2]) return send(200, view(full));
        if (m[2].startsWith('/commits/')) return send(200, { sha: sha(full, v) });
        if (m[2] === '/contents/package.json') { const f = files(full, v); return f ? text(f['package.json']) : send(404, { message: 'Not Found' }); }
        if (m[2] === '/readme') return FAKE_REPOS[full].readme == null ? send(404, { message: 'Not Found' }) : text(FAKE_REPOS[full].readme);
      }
      m = /^\/_codeload\/([\w.-]+\/[\w.-]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(url.pathname);
      if (m && FAKE_REPOS[m[1]]) { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(tarball(m[1], m[2])); }
      send(404, { message: 'Not Found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      env: { MINIMIDE_GITHUB_API: `http://127.0.0.1:${server.address().port}` },
      close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    };
  };
}
