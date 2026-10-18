export async function activate(mide) {
  const item = mide.statusBar.addItem({ text: 'words: …', tooltip: 'Word count', align: 'right' });
  const update = async () => { const t = (await mide.editor.getText()) || ''; item.setText(`words: ${t.split(/\s+/).filter(Boolean).length}`); };
  mide.workspace.onDidChangeActiveEditor(update);
  mide.editor.onDidChange(update);
  update();
  mide.commands.add('word-count:show', 'Show Word Count', async () => {
    const t = (await mide.editor.getText()) || '';
    mide.notify.info(`${t.split(/\s+/).filter(Boolean).length} words`);
    await mide.editor.insertText('[counted]');
  });
}
