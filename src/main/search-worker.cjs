// Project search, run in a worker thread so a slow (catastrophically backtracking)
// regex can be stopped by terminating the worker instead of freezing the app.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.exe', '.dylib', '.so', '.o', '.a', '.class', '.jar', '.wasm', '.lock']);

async function walk(root, ignored, limit = 50000) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (ignored.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
  }
  return files;
}

async function search({ root, query, regex = false, caseSensitive = false, ignored, maxResults = 2000 }) {
  if (!query) return { results: [], truncated: false };
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { error: err.message, results: [] };
  }
  const files = await walk(root, new Set(ignored));
  const results = [];
  let count = 0;
  for (const file of files) {
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2_000_000) continue;
      text = await fs.readFile(file, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const matches = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const line = lines[i];
      const m = re.exec(line);
      if (m) {
        matches.push({ line: i + 1, col: m.index, length: m[0].length || 1, text: line.slice(0, 400) });
        if (++count >= maxResults) break;
      }
    }
    if (matches.length) results.push({ file, matches });
    if (count >= maxResults) return { results, truncated: true };
  }
  return { results, truncated: false };
}

search(workerData).then((r) => parentPort.postMessage(r), (err) => parentPort.postMessage({ error: err.message, results: [] }));
