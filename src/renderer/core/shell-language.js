// Shell scripts: CodeMirror's legacy shell mode, with richer token types.
//
// The legacy mode leaves command names unstyled and reports variables as "def" and flags as
// "attribute", which most themes render close to plain text. Here command names (the first word
// of a command) become functions, builtins too, variables become special variables and flags
// become attributes, so scripts get the same color variety as other languages.
import { StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { shell } from '@codemirror/legacy-modes/mode/shell';

// After these, the next word is a command again.
const COMMAND_START = /^(;|;;|&&|\|\||\||&|\(|\{|\$\(|`|!|then|do|else|elif|if|while|until|time|sudo|exec|xargs|env|nohup|command|builtin)$/;
const WORD = /^[\w.\/@+-][\w.\/@:+%-]*$/;

const parser = {
  name: 'shell',
  startState: () => ({ inner: shell.startState(), command: true }),
  copyState: (s) => ({ inner: { ...s.inner, tokens: [...s.inner.tokens] }, command: s.command }),
  token(stream, state) {
    if (stream.sol()) state.command = true;
    if (!state.inner.tokens.length && stream.eatSpace()) return null; // inside a string, spaces belong to it
    const style = shell.token(stream, state.inner);
    const text = stream.current();
    let out = style;
    if (style === 'def') out = 'shVar';
    else if (style === 'attribute') out = 'shFlag';
    else if (style === 'builtin') out = 'shCommand';
    else if (style == null && state.command && WORD.test(text) && !/^\d+$/.test(text)) out = 'shCommand';
    // `x=1 cmd` keeps the command position; anything else ends it, separators start a new one.
    if (COMMAND_START.test(text)) state.command = true;
    else if (!(style === 'def' && stream.peek() === '=') && text !== '=') state.command = false;
    return out;
  },
  languageData: shell.languageData,
  tokenTable: {
    shCommand: tags.function(tags.variableName),
    shVar: tags.special(tags.variableName),
    shFlag: tags.atom, // options read like constants; attributeName would inherit the theme's property color
  },
};

export const shellLanguage = StreamLanguage.define(parser);
