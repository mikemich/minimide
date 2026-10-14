// Built-in snippets, VS Code format: { language: { name: { prefix, body, description } } }.
// "javascript" snippets also apply to TypeScript, JSX and TSX; "*" applies everywhere.

export default {
  '*': {
    'Date': { prefix: 'date', body: '$CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE', description: "Today's date" },
  },
  javascript: {
    'Console log': { prefix: 'log', body: 'console.log($1);', description: 'console.log()' },
    'Console log variable': { prefix: 'logv', body: "console.log('${1:value}:', ${1:value});", description: 'Log a labelled value' },
    'Function': { prefix: 'fn', body: ['function ${1:name}(${2:params}) {', '\t$0', '}'], description: 'Function declaration' },
    'Arrow function': { prefix: 'af', body: 'const ${1:name} = (${2:params}) => {\n\t$0\n};', description: 'Arrow function' },
    'Async function': { prefix: 'afn', body: ['async function ${1:name}(${2:params}) {', '\t$0', '}'], description: 'Async function' },
    'Import': { prefix: 'imp', body: "import { $2 } from '${1:module}';", description: 'Named import' },
    'For of': { prefix: 'forof', body: ['for (const ${1:item} of ${2:items}) {', '\t$0', '}'], description: 'for…of loop' },
    'For index': { prefix: 'fori', body: ['for (let ${1:i} = 0; ${1:i} < ${2:items}.length; ${1:i}++) {', '\t$0', '}'], description: 'Indexed for loop' },
    'Try catch': { prefix: 'try', body: ['try {', '\t$1', '} catch (${2:err}) {', '\t$0', '}'], description: 'try…catch' },
    'Class': { prefix: 'cls', body: ['class ${1:Name} {', '\tconstructor(${2}) {', '\t\t$0', '\t}', '}'], description: 'Class' },
    'Export default function': { prefix: 'edf', body: ['export default function ${1:${TM_FILENAME_BASE}}(${2}) {', '\t$0', '}'], description: 'Export default function' },
    'Fetch JSON': { prefix: 'fetchj', body: ["const ${1:res} = await fetch(${2:url});", "const ${3:data} = await ${1:res}.json();$0"], description: 'fetch + .json()' },
    'Set timeout': { prefix: 'sto', body: ['setTimeout(() => {', '\t$0', '}, ${1:1000});'], description: 'setTimeout' },
  },
  typescriptreact: {
    'React component': { prefix: 'rfc', body: ['export function ${1:${TM_FILENAME_BASE}}(${2:props}) {', '\treturn (', '\t\t<div>$0</div>', '\t);', '}'], description: 'React function component' },
    'useState': { prefix: 'us', body: 'const [${1:value}, ${2:setValue}] = useState(${3:initial});', description: 'useState hook' },
    'useEffect': { prefix: 'ue', body: ['useEffect(() => {', '\t$0', '}, [${1}]);'], description: 'useEffect hook' },
  },
  typescript: {
    'Interface': { prefix: 'intf', body: ['interface ${1:Name} {', '\t${2:key}: ${3:string};$0', '}'], description: 'Interface' },
    'Type alias': { prefix: 'type', body: 'type ${1:Name} = ${0};', description: 'Type alias' },
  },
  python: {
    'Function': { prefix: 'def', body: ['def ${1:name}(${2}):', '\t${0:pass}'], description: 'Function' },
    'Main guard': { prefix: 'main', body: ['def main():', '\t${0:pass}', '', '', 'if __name__ == "__main__":', '\tmain()'], description: 'if __name__ == "__main__"' },
    'Class': { prefix: 'cls', body: ['class ${1:Name}:', '\tdef __init__(self${2}):', '\t\t${0:pass}'], description: 'Class' },
    'Dataclass': { prefix: 'dc', body: ['from dataclasses import dataclass', '', '', '@dataclass', 'class ${1:Name}:', '\t${2:field}: ${3:str}$0'], description: 'Dataclass' },
    'For': { prefix: 'for', body: ['for ${1:item} in ${2:items}:', '\t${0:pass}'], description: 'for loop' },
    'With open': { prefix: 'with', body: ['with open(${1:"file.txt"}) as ${2:f}:', '\t${0:data = f.read()}'], description: 'Open a file' },
    'Try except': { prefix: 'try', body: ['try:', '\t${1:pass}', 'except ${2:Exception} as ${3:e}:', '\t${0:raise}'], description: 'try…except' },
    'Print f-string': { prefix: 'pf', body: 'print(f"${1}")', description: 'print(f"…")' },
  },
  go: {
    'Main': { prefix: 'main', body: ['package main', '', 'import "fmt"', '', 'func main() {', '\t${0:fmt.Println("hello")}', '}'], description: 'main package' },
    'If err': { prefix: 'iferr', body: ['if err != nil {', '\treturn ${1:err}', '}'], description: 'if err != nil' },
    'Function': { prefix: 'fn', body: ['func ${1:name}(${2}) ${3:error} {', '\t$0', '}'], description: 'Function' },
    'Test': { prefix: 'test', body: ['func Test${1:Name}(t *testing.T) {', '\t$0', '}'], description: 'Test function' },
  },
  rust: {
    'Main': { prefix: 'main', body: ['fn main() {', '\t${0:println!("hello");}', '}'], description: 'main function' },
    'Function': { prefix: 'fn', body: ['fn ${1:name}(${2}) -> ${3:()} {', '\t$0', '}'], description: 'Function' },
    'Test module': { prefix: 'tmod', body: ['#[cfg(test)]', 'mod tests {', '\tuse super::*;', '', '\t#[test]', '\tfn ${1:it_works}() {', '\t\t$0', '\t}', '}'], description: 'Test module' },
    'Derive': { prefix: 'der', body: '#[derive(${1:Debug, Clone})]', description: '#[derive]' },
  },
  c: {
    'Main': { prefix: 'main', body: ['#include <stdio.h>', '', 'int main(void) {', '\t${0:printf("hello\\n");}', '\treturn 0;', '}'], description: 'main()' },
    'Printf': { prefix: 'pf', body: 'printf("${1:%d}\\n", ${2});', description: 'printf' },
    'For': { prefix: 'for', body: ['for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {', '\t$0', '}'], description: 'for loop' },
  },
  html: {
    'HTML document': { prefix: 'html5', body: ['<!doctype html>', '<html lang="${1:en}">', '<head>', '\t<meta charset="utf-8">', '\t<meta name="viewport" content="width=device-width, initial-scale=1">', '\t<title>${2:Document}</title>', '</head>', '<body>', '\t$0', '</body>', '</html>'], description: 'HTML5 boilerplate' },
    'Link CSS': { prefix: 'linkcss', body: '<link rel="stylesheet" href="${1:style.css}">', description: 'Stylesheet link' },
    'Script': { prefix: 'script', body: '<script type="module" src="${1:main.js}"></script>', description: 'Module script' },
  },
  css: {
    'Flex center': { prefix: 'flexc', body: ['display: flex;', 'align-items: center;', 'justify-content: center;'], description: 'Center with flexbox' },
    'Grid': { prefix: 'grid', body: ['display: grid;', 'grid-template-columns: ${1:repeat(3, 1fr)};', 'gap: ${2:1rem};'], description: 'Grid layout' },
    'Media query': { prefix: 'media', body: ['@media (max-width: ${1:768px}) {', '\t$0', '}'], description: 'Media query' },
  },
  markdown: {
    'Code block': { prefix: 'code', body: ['```${1:js}', '$0', '```'], description: 'Fenced code block' },
    'Table': { prefix: 'table', body: ['| ${1:Column} | ${2:Column} |', '| --- | --- |', '| $3 | $4 |'], description: 'Table' },
    'Link': { prefix: 'link', body: '[${1:text}](${2:https://})', description: 'Link' },
    'Task': { prefix: 'task', body: '- [ ] ${1:task}', description: 'Checklist item' },
  },
  shellscript: {
    'Shebang': { prefix: 'bash', body: ['#!/usr/bin/env bash', 'set -euo pipefail', '', '$0'], description: 'Bash script header' },
    'If file': { prefix: 'iff', body: ['if [[ -f "${1:file}" ]]; then', '\t$0', 'fi'], description: 'If file exists' },
  },
};
