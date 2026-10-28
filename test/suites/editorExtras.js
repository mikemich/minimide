// Bracket pair colors (depth classes, strings and comments skipped, a viewport that starts mid-file,
// the command) and the word count in the status bar, over the `extras` fixture.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(60); } return null; };
  while (!ws.project) await sleep(50);
  const out = {};
  const wordsText = () => document.querySelector('[data-id="word-count"]')?.textContent ?? null;
  // The depth-colored brackets currently drawn, e.g. "(|d0".
  const spans = (ed) => [...ed.view.contentDOM.querySelectorAll('[class*="cm-bracket-d"]')]
    .map((el) => `${el.textContent}|${el.className.match(/cm-bracket-(d\d)/)[1]}`);

  // --- word count ---------------------------------------------------------------
  const md = await ws.open(`${ws.project}/notes.md`);
  await until(wordsText);
  out.md = wordsText();

  // Select the first 120 words: the status bar shows the selected count.
  const text = md.view.state.doc.toString();
  let n = 0, end = 0;
  for (const m of text.matchAll(/\S+/g)) { if (++n === 120) { end = m.index + m[0].length; break; } }
  md.view.dispatch({ selection: { anchor: 0, head: end } });
  await until(() => wordsText() === '120 of 1,234 words');
  out.selected = wordsText();

  // Typing recounts once the typing pauses.
  const len = md.view.state.doc.length;
  md.view.dispatch({ selection: { anchor: len } });
  md.view.dispatch({ changes: { from: len, insert: ' alpha beta' }, selection: { anchor: len + 11 } });
  await until(() => wordsText() === '1,236 words · 6 min read');
  out.typed = wordsText();

  await ws.open(`${ws.project}/plain.txt`);
  await until(() => wordsText() === '3 words · 1 min read');
  out.txt = wordsText();

  const js = await ws.open(`${ws.project}/code.js`);
  await sleep(300);
  out.jsHidden = !document.querySelector('[data-id="word-count"]');

  // --- bracket pair colors --------------------------------------------------------
  out.offByDefault = spans(js).length;
  await app.commands.run('editor:toggle-bracket-pair-colors');
  await until(() => spans(js).length >= 9);
  await sleep(100);
  // The file's first screen: the nested example, then "({[" on line 5. Nothing in the string or comments.
  out.top = spans(js);

  // Scroll to the bottom: "]})" closes brackets opened above the viewport, so it needs the depth from the top.
  const close = js.view.state.doc.toString().lastIndexOf(']');
  js.view.dispatch({ selection: { anchor: close }, scrollIntoView: true });
  await until(() => spans(js).includes(']|d2'));
  await sleep(100);
  out.bottom = spans(js);

  await app.commands.run('editor:toggle-bracket-pair-colors');
  await sleep(200);
  out.commandOff = { config: app.config.get('editor.bracketPairColors'), spans: spans(js).length };
  return out;
})()
