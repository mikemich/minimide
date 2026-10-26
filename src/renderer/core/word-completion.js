// Word completion: suggests words already in the file you're editing, for every language.
// It stands aside where a language server provides completions, and ranks below snippets.
import { completeAnyWord } from '@codemirror/autocomplete';

export function wordCompletion(app) {
  return (ctx) => {
    if (app.config.get('editor.wordCompletion') === false) return null;
    // Two letters typed (or completion asked for explicitly) before suggesting anything.
    if (!ctx.explicit && !ctx.matchBefore(/[\p{L}\p{N}_]{2,}$/u)) return null;
    if (app.packages.services.get('lsp')?.handles(ctx.view)) return null;
    const result = completeAnyWord(ctx);
    if (!result?.options.length) return null;
    const typed = ctx.state.sliceDoc(result.from, ctx.pos);
    const options = result.options.filter((o) => o.label !== typed).map((o) => ({ ...o, detail: 'word', boost: -3 }));
    return options.length ? { ...result, options } : null;
  };
}
