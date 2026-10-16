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

/* --------------- tables: the cell is prose, not a literal ---------------
   A table is the most common shape in a model reply, so a broken cell is a
   broken answer. Every cell goes through the inline pass. */

const richCell = renderMarkdown('| Name | Value |\n| --- | --- |\n| **bold** | `code` |');
check('inline markdown inside a table cell is rendered, not left raw',
  has(richCell, '<td><strong>bold</strong></td>') && has(richCell, '<td><code>code</code></td>'),
  richCell);

const cellLink = renderMarkdown('| a |\n| --- |\n| [x](https://example.com) |');
check('a link inside a table cell is rendered', has(cellLink, '<td><a href="https://example.com"'), cellLink);

// `\|` is a literal pipe. Splitting on it invented a column, and the backslash
// then appeared in the cell: `x \ | y | z`.
const escapedPipe = renderMarkdown('| a | b |\n| --- | --- |\n| x \\| y | z |');
check('an escaped pipe stays inside its cell', has(escapedPipe, '<td>x | y</td>') && has(escapedPipe, '<td>z</td>'),
  escapedPipe);
check('an escaped pipe does not invent a column',
  (escapedPipe.match(/<td>/g) || []).length === 2, escapedPipe);

const pipedCode = renderMarkdown('| a | b |\n| --- | --- |\n| `a\\|b` | z |');
check('an escaped pipe inside a code span survives',
  has(pipedCode, '<code>a|b</code>') && (pipedCode.match(/<td>/g) || []).length === 2, pipedCode);

const ragged = renderMarkdown('| a | b |\n| --- | --- |\n| only-one |');
check('a ragged row is padded rather than shifting the columns beside it',
  has(ragged, '<td>only-one</td><td></td>'), ragged);

const longRow = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |');
check('a row with extra cells is truncated to the header width',
  (longRow.match(/<td>/g) || []).length === 2, longRow);

const quotedTable = renderMarkdown('> | a | b |\n> | --- | --- |\n> | 1 | 2 |');
check('a table inside a blockquote renders as a table', has(quotedTable, '<blockquote><table>'), quotedTable);

/* --------------- ordered lists --------------- */

const parenOrdered = renderMarkdown('1) first\n2) second');
check('an ordered list with a `)` delimiter renders as an ordered list',
  has(parenOrdered, '<ol>') && has(parenOrdered, '<li>first</li>'), parenOrdered);

// Without `start`, `3.` renders as `1.` and the reply contradicts itself.
const startAtThree = renderMarkdown('3. three\n4. four');
check('an ordered list that starts above 1 keeps its number',
  has(startAtThree, '<ol start="3">'), startAtThree);
check('a list that starts at 1 stays a plain <ol>',
  !has(renderMarkdown('1. one\n2. two'), 'start='), renderMarkdown('1. one\n2. two'));
// Markers are labels, not ordering: a reply that numbers 2 then 1 is sorted, or
// the list counts 2, 3, 4 and the numbers disagree with the text.
check('an ordered list counts from its first marker, whatever order it was written in',
  has(renderMarkdown('2. second\n1. first'), '<li>first</li><li>second</li>'),
  renderMarkdown('2. second\n1. first'));
// The list is sorted, but it still starts where its lowest number says, so the
// rendered numbers agree with the text.
check('a reordered list starts at its lowest number',
  has(renderMarkdown('3. c\n1. a\n2. b'), '<li>a</li><li>b</li><li>c</li>'),
  renderMarkdown('3. c\n1. a\n2. b'));
check('a reordered list that starts above 1 keeps the lower start',
  has(renderMarkdown('4. d\n2. b\n3. c'), '<ol start="2"><li>b</li><li>c</li><li>d</li></ol>'),
  renderMarkdown('4. d\n2. b\n3. c'));

const nestedOrdered = renderMarkdown('1. top\n   3. child\n   4. next');
check('a nested ordered list keeps its own start number',
  has(nestedOrdered, '<ol start="3">'), nestedOrdered);
check('a nested ordered list is nested, not flattened',
  has(nestedOrdered, '<li>top<ol start="3">'), nestedOrdered);

// A bullet list under an ordered one is a different list, not a sibling item.
const mixedLists = renderMarkdown('1. top\n   - a\n   - b\n2. second');
check('a bullet list nested in an ordered list stays inside the item',
  has(mixedLists, '<li>top<ul><li>a</li><li>b</li></ul></li><li>second</li>'), mixedLists);

/* --------------- lists with a paragraph inside the item --------------- */

// The nested list used to lose its parent: indenting past a continuation line
// pushed a new list at the same depth, closing the item it belonged to.
const listParaThenList = renderMarkdown('- item one\n\n  more text\n\n  - nested');
check('a nested list after a paragraph in the item is still nested',
  has(listParaThenList, '<li>item one\nmore text<ul><li>nested</li></ul></li>'), listParaThenList);

const deepList = renderMarkdown('- one\n  - two\n    - three');
check('lists nest to three levels',
  has(deepList, '<li>two<ul><li>three</li></ul></li>'), deepList);

const threeSpaceIndent = renderMarkdown('- one\n   - two');
check('a three-space indent opens a nested list (not only two spaces)',
  has(threeSpaceIndent, '<li>one<ul><li>two</li></ul></li>'), threeSpaceIndent);

const continuation = renderMarkdown('- item\n  wrapped onto a second line');
check('an indented continuation line joins its list item',
  has(continuation, '<li>item\nwrapped onto a second line</li>'), continuation);

/* --------------- fences --------------- */

const noLang = renderMarkdown('```\nplain\n```');
check('a fence with no language renders an empty data-lang', has(noLang, '<pre data-lang=""><code>plain</code></pre>'),
  noLang);

const tildeFence = renderMarkdown('~~~js\nconst x = 1;\n~~~');
check('a tilde fence renders as code', has(tildeFence, 'data-lang="js"') && has(tildeFence, 'const x = 1;'),
  tildeFence);

const fenceAsterisks = renderMarkdown('```\n**not bold**\n```');
check('emphasis markers inside a fence survive literally',
  has(fenceAsterisks, '**not bold**') && !has(fenceAsterisks, '<strong>'), fenceAsterisks);

const fenceHtml = renderMarkdown('```html\n<script>alert("x")</script>\n```');
check('HTML inside a fence is escaped, not emitted',
  has(fenceHtml, '&lt;script&gt;') && !has(fenceHtml, '<script>'), fenceHtml);

// ```js {1,3} used to render as a paragraph followed by an empty code block:
// the info string was matched by a `[\w+#.-]*` that stopped at the space.
const fenceAttrs = renderMarkdown('```js {1,3}\nconst x = 1;\n```');
check('a fence whose info string has attributes still opens a fence',
  has(fenceAttrs, 'data-lang="js {1,3}"') && has(fenceAttrs, 'const x = 1;'), fenceAttrs);

/* --------------- unterminated fences --------------- */

// Mid-stream this is the normal state, so it renders as code — but it is
// marked, because a fence that never closes otherwise swallows the rest of the
// document without a word.
const unclosed = renderMarkdown('text\n\n```\nnever closed\nmore text');
check('an unterminated fence is flagged rather than passed off as closed',
  has(unclosed, 'data-unclosed="1"'), unclosed);
check('an unterminated fence still renders its content', has(unclosed, 'more text'), unclosed);
check('a terminated fence is not flagged', !has(noLang, 'data-unclosed'), noLang);

/* --------------- links and images --------------- */

// A URL with brackets is one target. The old pattern stopped at the first `)`
// and the remainder leaked into the sentence as text.
const parenLink = renderMarkdown('[x](https://en.wikipedia.org/wiki/Foo_(bar))');
check('a link target may contain balanced parentheses',
  has(parenLink, 'href="https://en.wikipedia.org/wiki/Foo_(bar)"'), parenLink);
check('a link target with brackets leaves nothing behind',
  parenLink === '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">x</a></p>',
  parenLink);

const parenImage = renderMarkdown('![alt](https://example.com/i_(1).png)');
check('an image target may contain balanced parentheses',
  has(parenImage, 'src="https://example.com/i_(1).png"'), parenImage);

const bareUrl = renderMarkdown('see https://example.com/x for more');
check('a bare URL becomes a link', has(bareUrl, '<a href="https://example.com/x"'), bareUrl);
check('a bare URL does not absorb the words after it',
  has(bareUrl, '</a> for more'), bareUrl);

const urlPunctuation = renderMarkdown('see https://example.com/x. Done');
check('a full stop hugging a URL is left outside the link',
  has(urlPunctuation, '</a>. Done'), urlPunctuation);

const urlBracket = renderMarkdown('see (https://example.com/x) now');
check('a URL inside prose brackets links only the URL', has(urlBracket, '<a href="https://example.com/x"'), urlBracket);

const urlQuery = renderMarkdown('see https://example.com/?a=1&b=2 now');
check('an ampersand query string links whole',
  has(urlQuery, 'href="https://example.com/?a=1&amp;b=2"'), urlQuery);
check('an ampersand is escaped exactly once in an href',
  !has(urlQuery, '&amp;amp;'), urlQuery);

/* --------------- blockquotes --------------- */

const quoteMarkdown = renderMarkdown('> **bold** and `code`');
check('markdown inside a blockquote is rendered',
  has(quoteMarkdown, '<blockquote><p><strong>bold</strong> and <code>code</code></p></blockquote>'), quoteMarkdown);

const nestedQuote = renderMarkdown('> outer\n> > inner');
check('a nested blockquote nests', has(nestedQuote, '<blockquote><p>inner</p></blockquote>'), nestedQuote);

const quoteList = renderMarkdown('> - a\n> - b');
check('a list inside a blockquote renders as a list', has(quoteList, '<blockquote><ul>'), quoteList);

/* --------------- whitespace and line breaks --------------- */

// A single newline inside a paragraph is a soft break and is rendered as <br>,
// because model output wraps for its own reasons and joining the lines runs
// two thoughts together. See the existing `soft newlines become <br>` check.
const hardBreak = renderMarkdown('line one  \nline two');
check('two trailing spaces are a hard break', has(hardBreak, '<br>'), hardBreak);

const quoteBreak = renderMarkdown('> line one  \n> line two');
check('a hard break inside a blockquote is kept', has(quoteBreak, '<br>'), quoteBreak);

check('a line break is not a paragraph break',
  renderMarkdown('one\ntwo') === '<p>one<br>two</p>', renderMarkdown('one\ntwo'));

// Intentional: `- - one` is an item whose text begins with a marker. The inner
// marker is deeper, so it opens a nested list rather than being flattened into
// the text — which is what a nested bullet looks like when it is not indented.
const lazyContinuation = [
  '- - one',
  '  - two',
  '',
  '- an item followed by',
  '  a plain indented line',
].join('\n');
check('a marker nested in a bullet opens a nested list',
  has(renderMarkdown('- - one\n  - two'), '<li>- one<ul><li>two</li></ul></li>'),
  renderMarkdown('- - one\n  - two'));
// Intentional: a continuation line is joined with a newline, and a newline in a
// paragraph is a <br>, so a wrapped bullet keeps its wrap.
check('an indented continuation of a bullet stays in that bullet',
  has(renderMarkdown('- an item followed by\n  a plain indented line'),
    '<li>an item followed by\na plain indented line</li>'),
  renderMarkdown('- an item followed by\n  a plain indented line'));

/* --------------- emphasis edges --------------- */

// The classic bug: `get_user_name` must not become `get<em>user</em>name`.
check('an underscore inside an identifier is not emphasis',
  renderMarkdown('call get_user_name(id)') === '<p>call get_user_name(id)</p>', renderMarkdown('call get_user_name(id)'));
check('a trailing digit does not close the identifier early',
  renderMarkdown('the do_thing_1 call') === '<p>the do_thing_1 call</p>', renderMarkdown('the do_thing_1 call'));
check('an underscore that really is emphasis still works',
  has(renderMarkdown('an _italic_ word'), '<em>italic</em>'), renderMarkdown('an _italic_ word'));

check('bold at the start of a line is bold',
  has(renderMarkdown('**Bold at start** of the line'), '<strong>Bold at start</strong>'),
  renderMarkdown('**Bold at start** of the line'));
check('three asterisks are bold and italic together',
  has(renderMarkdown('***both***'), '<strong><em>both</em></strong>'), renderMarkdown('***both***'));
check('two neighbouring bold spans are two spans, not one',
  renderMarkdown('**a** and **b**') === '<p><strong>a</strong> and <strong>b</strong></p>',
  renderMarkdown('**a** and **b**'));
check('two neighbouring italic spans are two spans, not one',
  renderMarkdown('*a* and *b*') === '<p><em>a</em> and <em>b</em></p>', renderMarkdown('*a* and *b*'));
check('strikethrough renders', has(renderMarkdown('~~gone~~'), '<del>gone</del>'), renderMarkdown('~~gone~~'));

// An asterisk used for arithmetic is not emphasis, and a mark with a space
// inside it is not emphasis either — `2 ** 3 ** 4` used to match across the
// space and render as 2 <strong>3</strong> 4.
check('multiplication is left as arithmetic',
  renderMarkdown('2 * 3 * 4 = 24') === '<p>2 * 3 * 4 = 24</p>', renderMarkdown('2 * 3 * 4 = 24'));
check('a bold mark spanning a space is left literal',
  renderMarkdown('2 ** 3 ** 4') === '<p>2 ** 3 ** 4</p>', renderMarkdown('2 ** 3 ** 4'));
check('a bold span containing a space still renders',
  has(renderMarkdown('a **b c** d'), '<strong>b c</strong>'), renderMarkdown('a **b c** d'));

// Bold wrapped around a code span: the placeholder used to be visible to the
// span patterns, which stopped at its `>` and left literal asterisks.
check('bold may wrap a code span',
  has(renderMarkdown('a **`npm test`** b'), '<strong><code>npm test</code></strong>'),
  renderMarkdown('a **`npm test`** b'));
check('bold may wrap a link',
  has(renderMarkdown('a **[x](https://example.com)** b'), '<strong><a href="https://example.com"'),
  renderMarkdown('a **[x](https://example.com)** b'));
check('a slash-delimited URL is not emphasis and is not split',
  has(renderMarkdown('see https://example.com/a_b_c'), 'href="https://example.com/a_b_c"'),
  renderMarkdown('see https://example.com/a_b_c'));

/* --------------- block-level edges and deliberate behaviour --------------- */

check('a spaced horizontal rule renders as a rule, not a list item',
  renderMarkdown('* * *') === '<hr>', renderMarkdown('* * *'));
check('letters alone do not make an ordered list',
  renderMarkdown('a) text') === '<p>a) text</p>', renderMarkdown('a) text'));
// Seven hashes is not a heading in any markdown dialect; it is a line of text.
check('seven hashes are not a heading',
  !has(renderMarkdown('####### seven'), '<h'), renderMarkdown('####### seven'));
check('a six-hash heading renders at level six',
  has(renderMarkdown('###### six'), '<h6>six</h6>'), renderMarkdown('###### six'));
check('an indented 4-space block is paragraph text, not code',
  renderMarkdown('    const x = 1;') === '<p>    const x = 1;</p>', renderMarkdown('    const x = 1;'));

// Intentional: an indented line after a blank line belongs to the item above
// it, so a bullet can hold two paragraphs. Only a line that is *less* indented
// than the item ends the list.
const indentedTail = renderMarkdown('- item\n\n    second paragraph');
check('an indented paragraph after a blank line is the item\'s second paragraph',
  has(indentedTail, '<li>item\nsecond paragraph</li>'), indentedTail);
check('a paragraph at the list\'s own indent ends the list',
  has(renderMarkdown('- item\n\ntext'), '</ul>\n<p>text</p>'), renderMarkdown('- item\n\ntext'));

// Intentional: there is no setext heading. `=====` under a line is text, not a
// <h1> — a wrapped line of equals signs is far more likely than a setext title.
check('a setext underline is left as text',
  renderMarkdown('Title\n=====') === '<p>Title<br>=====</p>', renderMarkdown('Title\n====='));

// Intentional: a blocked quote is one row of blockquote, each row rendered as a
// whole. Nothing outside it is swallowed, and no continuation is invented.
check('a blockquote closes at the first line without a marker',
  has(renderMarkdown('> q\nnot quoted'), '<p>not quoted</p>'), renderMarkdown('> q\nnot quoted'));

/* --------------- streaming shapes --------------- */

// What a half-sent reply looks like: every marker is unclosed at some point.
check('an unclosed bold marker does not throw',
  typeof renderMarkdown('a **b') === 'string', 'threw');
check('an unclosed table delimiter row is not a table',
  !has(renderMarkdown('| a | b |'), '<table>'), renderMarkdown('| a | b |'));
check('an unclosed inline code span is not a code span',
  !has(renderMarkdown('a `b'), '<code>'), renderMarkdown('a `b'));
// Intentional: the bare URL inside a half-written link is still linkified. The
// lead-in text of the unfinished link is left as text; guessing that a URL is
// part of an unfinished construct would mean holding back a URL that is real.
const truncatedLink = renderMarkdown('a [x](https://exa');
check('an unclosed link leaves the label as text', has(truncatedLink, '[x]('), truncatedLink);
check('truncated markdown never throws',
  ['#', '|', '>', '-', '1.', '*', '```', '![', '[', '_', '~~', '\u0000', '\u0002S0\u0002']
    .every((line) => typeof renderMarkdown(line) === 'string'));

/* --------------- escaping, again: no route to raw markup --------------- */

const holeMarker = 'ZZZHOLEZZZ';
const holes = [
  renderMarkdown(`| ${holeMarker} | b |\n| --- | --- |\n| <img src=x onerror=${holeMarker}> | 2 |`),
  renderMarkdown(`> <svg onload=${holeMarker}>`),
  renderMarkdown(`- [ ] <iframe src=javascript:${holeMarker}>`),
  renderMarkdown(`***<b on${holeMarker}=1>***`),
  renderMarkdown(`[<${holeMarker}>](https://example.com/?q=<${holeMarker}>)`),
  renderMarkdown(`![<${holeMarker}>](https://example.com/i.png)`),
  renderMarkdown(`\`\`\`\n<b on${holeMarker}=1>\n\`\`\``),
  renderMarkdown(`~~~\n<b on${holeMarker}=1>\n~~~`),
  renderMarkdown(`https://example.com/<script>${holeMarker}</script>`),
  renderMarkdown(`**<${holeMarker}>** and __<${holeMarker}>__ and ~~<${holeMarker}>~~`),
];
const leakedTag = holes
  .flatMap((h) => h.match(/<[^>]*>/g) || [])
  .find((tag) => tag.includes(holeMarker) && !/^<(a|img|code|pre|p|strong|em|del|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|h[1-6]|hr|span|br)(\s|>)/.test(tag));
check('no construct can smuggle an event-handler attribute into the output',
  leakedTag === undefined, String(leakedTag));
check('raw HTML never survives as a real tag in any of those inputs',
  holes.every((h) => !h.includes('<script') && !h.includes('<iframe') && !h.includes('<svg') && !h.includes('<b on')),
  holes.find((h) => h.includes('<b on')) || '');

// Placeholders are internal, and must never reach the document either as a
// control character or as the `<S0>` text a model could try to forge.
const controlLeak = holes.concat([richCell, parenLink, fenceHtml]).some((h) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(h));
check('no placeholder control character survives into the output', controlLeak === false);
check('a forged placeholder is inert text, not markup',
  has(renderMarkdown('<S0>'), '&lt;S0&gt;') && !has(renderMarkdown('<S0>'), '<S0>'),
  renderMarkdown('<S0>'));

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} markdown checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} markdown checks passed\x1b[0m\n`);
