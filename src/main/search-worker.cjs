// Project search, run in a worker thread so a slow (catastrophically backtracking)
// regex can be stopped by terminating the worker instead of freezing the app.
// Results are posted in batches as they're found, so a search that is stopped for
// taking too long still returns everything it matched so far.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.exe', '.dylib', '.so', '.o', '.a', '.class', '.jar', '.wasm', '.lock']);
const FILE_LIMIT = 250000;
const PARALLEL_READS = 24;

async function walk(root, ignored) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < FILE_LIMIT) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (ignored.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && !BINARY_EXT.has(path.extname(e.name).toLowerCase())) files.push(full);
    }
  }
  return { files, limited: files.length >= FILE_LIMIT };
}

async function readText(file) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      if ((await handle.stat()).size > 2_000_000) return null;
      const text = await handle.readFile('utf8');
      return text.includes('\u0000') ? null : text;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function search({ root, query, regex = false, caseSensitive = false, ignored, maxResults = 2000 }) {
  if (!query) return { results: [], truncated: false };
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { error: err.message, results: [] };
  }
  const { files, limited } = await walk(root, new Set(ignored));
  let count = 0;
  let batch = [];
  let lastPost = Date.now();
  const flush = () => { if (batch.length) parentPort.postMessage({ partial: batch }); batch = []; lastPost = Date.now(); };

  // Read ahead in parallel (disk is the bottleneck on big repos), but match in file order.
  for (let i = 0; i < files.length && count < maxResults; i += PARALLEL_READS) {
    const chunk = files.slice(i, i + PARALLEL_READS);
    const texts = await Promise.all(chunk.map(readText));
    for (let f = 0; f < chunk.length && count < maxResults; f++) {
      const text = texts[f];
      if (text == null) continue;
      const matches = [];
      const lines = text.split('\n');
      for (let l = 0; l < lines.length; l++) {
        re.lastIndex = 0;
        const line = lines[l];
        const m = re.exec(line);
        if (m) {
          matches.push({ line: l + 1, col: m.index, length: m[0].length || 1, text: line.slice(0, 400) });
          if (++count >= maxResults) break;
        }
      }
      if (matches.length) batch.push({ file: chunk[f], matches });
    }
    if (Date.now() - lastPost > 150) flush();
  }
  flush();
  return { done: true, truncated: count >= maxResults, filesLimited: limited, searched: files.length };
}

search(workerData).then((r) => parentPort.postMessage(r.done ? r : { ...r, done: true }), (err) => parentPort.postMessage({ done: true, error: err.message, results: [] }));
