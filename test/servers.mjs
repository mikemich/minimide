// Things the end-to-end suites talk to instead of the real internet or the real VS Code folder.
// A suite's `server: (fixtures) => Promise<{ env, close }>` starts one before the app launches; the
// returned `env` is added to the app's environment (the dev-build overrides in src/main/main.js).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

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
