// File types beyond language-data, snippets in autocomplete, word completion and snippet expansion.
(async () => {
  const app = window.minimide, ws = app.workspace;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(60); } return null; };
  while (!ws.project) await sleep(50);
  const out = { langs: {} };
  for (const f of ['Makefile', 'rules.nft', 'app.log', 'data.csv', '.zshrc', '.gitignore', 'main.tf', '.env', 'test.sh']) {
    const ed = await ws.open(`${ws.project}/${f}`); await sleep(250);
    out.langs[f] = `${ed.getLanguageName()} (${new Set([...ed.view.contentDOM.querySelectorAll('span[class*=tok-]')].map((s) => s.className)).size} token kinds)`;
  }
  const ed = await ws.open(`${ws.project}/test.sh`); await sleep(300);
  const view = ed.view;
  const type = async (text) => { const end = view.state.doc.length; view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: 'input.type' }); };
  const labels = () => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.querySelector('.cm-completionLabel')?.textContent + '|' + (li.querySelector('.cm-completionDetail')?.textContent || ''));
  await type('fo');
  out.afterFo = (await until(() => labels().length && labels())) || [];
  view.dispatch({ changes: { from: view.state.doc.length - 2, to: view.state.doc.length } });
  app.ui.closeModal?.();
  await sleep(200);
  await type('ns');
  out.afterNs = (await until(() => labels().some((l) => l.startsWith('nsr1')) && labels())) || labels();
  view.dispatch({ changes: { from: view.state.doc.length - 2, to: view.state.doc.length } });
  await sleep(200);
  await type('$ns');
  out.afterDollarNs = (await until(() => labels().some((l) => l.startsWith('$nsr1')) && labels())) || labels();
  view.dispatch({ changes: { from: view.state.doc.length - 3, to: view.state.doc.length } });
  await sleep(200);
  // Accept the "for" snippet from the list.
  await type('for');
  await until(() => labels().some((l) => l.startsWith('for|')));
  const items = [...document.querySelectorAll('.cm-tooltip-autocomplete li')];
  const idx = items.findIndex((li) => li.querySelector('.cm-completionDetail')?.textContent === 'for … in');
  items[idx]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await sleep(300);
  out.expanded = JSON.stringify(view.state.doc.toString().split('\n').slice(3).join('\n'));
  return out;
})()
