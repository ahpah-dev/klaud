/**
 * Markdown renderer checks — runs the real client module in Node.
 *
 *   node test/markdown.js
 */

import { renderMarkdown, escapeHtml } from '../public/markdown.mjs';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const has = (html, needle) => html.includes(needle);

console.log('\n\x1b[38;5;209m* Klaud markdown checks\x1b[0m\n');

const sample = `# Heading

A paragraph with **bold**, *italic*, \`inline code\` and a [link](https://example.com).

- first item
- second item
  - nested item

1. ordered one
2. ordered two

- [x] done task
- [ ] open task

> a quoted line

\`\`\`js
const x = 1;
\`\`\`

| Name | Value |
| --- | --- |
| a | 1 |

---

Done.`;

const html = renderMarkdown(sample);

check('renders headings', has(html, '<h1>Heading</h1>'));
check('renders paragraphs', has(html, '<p>A paragraph with'));
check('renders bold', has(html, '<strong>bold</strong>'));
check('renders italic', has(html, '<em>italic</em>'));
check('renders inline code', has(html, '<code>inline code</code>'));
check('renders links with rel=noopener',
  has(html, 'href="https://example.com"') && has(html, 'rel="noopener noreferrer"'));
check('renders unordered lists', has(html, '<ul>') && has(html, '<li>first item</li>'));
check('renders nested lists', has(html, '<li>second item<ul><li>nested item</li></ul></li>'));
check('renders ordered lists', has(html, '<ol>') && has(html, '<li>ordered one</li>'));
check('renders task lists as checkboxes',
  has(html, 'class="todo"') && has(html, '☑') && has(html, '☐'));
check('renders blockquotes', has(html, '<blockquote>'));
check('renders fenced code with a language tag', has(html, '<pre data-lang="js">') && has(html, 'const x = 1;'));
check('renders tables', has(html, '<table>') && has(html, '<th>Name</th>') && has(html, '<td>a</td>'));
check('renders horizontal rules', has(html, '<hr>'));

/* --------------- escaping --------------- */

const marker = 'ZZZEVENTMARKERZZZ';
const nasty = renderMarkdown(`<script>alert(1)</script>\n\n<img src=x on${marker}=alert(1)>`);
// Every real tag in the output must be one this renderer produced; the marker
// must survive only as inert text, never as an attribute.
const realTags = nasty.match(/<[^>]*>/g) || [];
check('escapes raw HTML tags', !has(nasty, '<script>') && has(nasty, '&lt;script&gt;'));
check(
  'never emits an event handler from raw HTML',
  !realTags.some((tag) => tag.includes(marker)) && has(nasty, marker),
  `tags: ${realTags.join(' ')}`
);

check('escapeHtml covers the five dangerous characters',
  escapeHtml(`<>&"'`) === '&lt;&gt;&amp;&quot;&#39;');

const inCode = renderMarkdown('```\n<b>not bold</b>\n```');
check('escapes HTML inside code fences', has(inCode, '&lt;b&gt;not bold&lt;/b&gt;'));

const codeSpan = renderMarkdown('use `<div>` here');
check('escapes HTML inside code spans', has(codeSpan, '<code>&lt;div&gt;</code>'));

const quoteAttr = renderMarkdown('[click](https://example.com/?a=1&b=2)');
check('escapes ampersands in link targets', has(quoteAttr, 'a=1&amp;b=2'));

/* --------------- streaming behaviour --------------- */

const partialFence = renderMarkdown('Here is the file:\n\n```python\nprint(1)\nprint(2)');
check('an unterminated fence still renders during streaming', has(partialFence, '<pre') && has(partialFence, 'print(2)'));

const partialBold = renderMarkdown('this is **unfinished');
check('an unterminated bold marker degrades to text', has(partialBold, 'unfinished'));

const partialTable = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
check('a table renders without a trailing blank line', has(partialTable, '<table>'));

const empty = renderMarkdown('');
check('empty input produces no markup', empty === '');

const plain = renderMarkdown('just a sentence');
check('plain text becomes a single paragraph', plain === '<p>just a sentence</p>');

const multiline = renderMarkdown('line one\nline two');
check('soft newlines become <br>', multiline === '<p>line one<br>line two</p>');

/* --------------- diff blocks --------------- */

const diff = renderMarkdown('```diff\n-removed\n+added\n same\n```');
check('diff fences keep their markers for the decorator',
  has(diff, 'data-lang="diff"') && has(diff, '+added') && has(diff, '-removed'));

/* --------------- realism --------------- */

const realistic = renderMarkdown(`I updated \`src/app.js\`:

\`\`\`js
export function greet(name) {
  return \`hello \${name}\`;
}
\`\`\`

Then I ran it:

\`\`\`
$ node src/app.js
hello world
exit: 0
\`\`\`

**Result:** works.`);

check('renders a realistic agent reply',
  has(realistic, '<code>src/app.js</code>') &&
  has(realistic, 'export function greet') &&
  has(realistic, 'exit: 0') &&
  has(realistic, '<strong>Result:</strong>'));

const templateLiteralLeak = realistic.includes('${name}') && !realistic.includes('\\${');
check('template literals inside fenced code survive intact', templateLiteralLeak);

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} markdown checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} markdown checks passed\x1b[0m\n`);
