// Smoke test of the test harness itself: scripted answers for native dialogs reach the renderer.
// Evaluated in the renderer; returns a JSON-able results object.
(async () => {
  await window.mideTest.answers('confirm', 2);
  const scripted = await window.native.dialog.confirm({ message: 'x' });
  await window.mideTest.answers('saveAs', '/tmp/scripted.txt');
  const savePath = await window.native.dialog.saveAs?.({});
  return { scripted, savePath };
})()
