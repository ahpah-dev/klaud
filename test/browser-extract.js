'use strict';

/**
 * In-page extractor test.
 *
 *   node test/browser-extract.js
 *
 * No browser, no network, no dependencies.
 *
 * The extractor's whole job happens inside somebody else's page, which is the
 * one place a unit test cannot go: there is no Chrome in CI here, and a test
 * that needs one would be skipped where it matters. So this suite runs the
 * *real* injected script — the same string `Runtime.evaluate` would send —
 * against a DOM shim a few hundred lines long.
 *
 * The shim implements only what the page code touches: `document`,
 * `location`, `getComputedStyle` (display, visibility, opacity), rects with a
 * crude layout, and a selector matcher that supports exactly the flat selectors
 * the extractor uses. It throws on anything else, so a new selector in the
 * extractor shows up as a failing test rather than as silently empty output.
 *
 * What this suite therefore CAN prove: the text formatting rules (headings,
 * lists, nesting, links, code, tables, chrome collapse, boilerplate collapse,
 * truncation), the never-throws contract, that nothing is mutated, and the
 * Node-side parsing of CDP replies.
 *
 * What it CANNOT prove: that the script survives contact with a real DOM, real
 * layout, shadow roots, iframes or a page that reflows mid-read. See the report
 * for that gap — it is the important one.
 */

const {
  extractionScript,
  parseExtraction,
  queryScript,
  parseQuery,
} = require('../src/lib/browser/extract');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const TICK = String.fromCharCode(96);
const DOLLAR = '$';
const count = (haystack, needle) => haystack.split(needle).length - 1;

const group = (title) => console.log(`\n  \x1b[1m${title}\x1b[0m`);

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

class ShimNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
}

class ShimText extends ShimNode {
  constructor(value) {
    super(3);
    this.nodeValue = value;
  }

  get textContent() {
    return this.nodeValue;
  }
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body.charAt(0) === '#') {
      const code = body.charAt(1).toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const mapped = named[body.toLowerCase()];
    return mapped === undefined ? whole : mapped;
  });
}

function parseAttributes(raw) {
  const attributes = {};
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[name] = decodeEntities(value);
  }
  return attributes;
}

/** Absolute URL resolution, the way the browser's `a.href` property does it. */
function resolveUrl(href, base) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const parts = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(base);
  const origin = parts ? parts[1] : 'https://example.test';
  const path = parts ? parts[2] || '/' : '/';
  if (href.startsWith('//')) return origin.split(':')[0] + ':' + href;
  if (href.startsWith('/')) return origin + href;
  if (href.startsWith('#')) return origin + path + href;
  if (href.startsWith('?')) return origin + path + href;
  const dir = path.replace(/[^/]*$/, '');
  return origin + dir + href;
}

function walkElements(root, visit) {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    visit(child);
    walkElements(child, visit);
  }
}

const SIMPLE_SELECTOR = /^(\*|[a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/;
const TOKEN = /([#.])([\w-]+)|\[([\w:.-]+)(?:\s*=\s*["']?([^"'\]]*)["']?)?\]/g;

function matchesSimple(el, selector) {
  const parsed = SIMPLE_SELECTOR.exec(selector);
  if (!parsed) throw new Error(`shim: unsupported selector "${selector}"`);
  const tag = parsed[1];
  if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;

  const tail = parsed[2] || '';
  TOKEN.lastIndex = 0;
  let token;
  while ((token = TOKEN.exec(tail))) {
    if (token[1] === '#') {
      if (el.id !== token[2]) return false;
    } else if (token[1] === '.') {
      if (!el.classNames().includes(token[2])) return false;
    } else {
      const value = el.getAttribute(token[3]);
      if (value === null) return false;
      if (token[4] !== undefined && value !== token[4]) return false;
    }
  }
  if (tail.replace(TOKEN, '') !== '') throw new Error(`shim: unsupported selector "${selector}"`);
  return true;
}

function queryAll(root, selector) {
  const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
  // Parse every part up front: an unsupported selector must fail even when the
  // tree happens to be empty, exactly as a real SyntaxError would.
  for (const part of parts) {
    if (!SIMPLE_SELECTOR.test(part)) throw new Error(`shim: unsupported selector "${selector}"`);
  }
  const found = [];
  walkElements(root, (el) => {
    if (parts.some((part) => matchesSimple(el, part))) found.push(el);
  });
  return found;
}

class ShimElement extends ShimNode {
  constructor(tag, attributes, doc) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.attributes = attributes || {};
    this._doc = doc || null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get id() {
    const value = this.getAttribute('id');
    return value === null ? '' : value;
  }

  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }

  get hidden() {
    return this.getAttribute('hidden') !== null;
  }

  get href() {
    const raw = this.getAttribute('href');
    return raw === null ? '' : resolveUrl(raw, this._doc ? this._doc.URL : 'https://example.test/');
  }

  get value() {
    if (this.tagName === 'TEXTAREA') return this.textContent;
    const value = this.getAttribute('value');
    return value === null ? '' : value;
  }

  get isContentEditable() {
    let node = this;
    while (node && node.nodeType === 1) {
      const flag = node.getAttribute('contenteditable');
      if (flag !== null) return flag !== 'false';
      node = node.parentNode;
    }
    return false;
  }

  get labels() {
    if (!this._doc || !this.id) return [];
    return this._doc.querySelectorAll(`label[for="${this.id}"]`);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
  }

  classNames() {
    const raw = this.getAttribute('class');
    return raw === null ? [] : raw.split(/\s+/).filter(Boolean);
  }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  styleMap() {
    const raw = this.getAttribute('style');
    const out = {};
    if (!raw) return out;
    for (const piece of raw.split(';')) {
      const [key, value] = piece.split(':');
      if (!key || !value) continue;
      out[key.trim().toLowerCase()] = value.trim();
    }
    return out;
  }

  /**
   * A crude layout: everything that is rendered gets a box, everything hidden by
   * style gets a zero box, and an explicit width/height in the style attribute is
   * honoured so the zero-size rule can be exercised. Form controls and images have
   * an intrinsic size, so they get a box even when they hold no text — an empty
   * textarea is on screen in a real browser.
   */
  getBoundingClientRect() {
    const style = this.styleMap();
    const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    if (hidden) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const intrinsic = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IMG'].includes(this.tagName);
    const width = style.width === undefined ? 800 : parseFloat(style.width) || 0;
    const height = style.height === undefined
      ? (intrinsic || this.textContent.trim() ? 20 : 0)
      : parseFloat(style.height) || 0;
    return { left: 4, top: 8, width, height, right: 4 + width, bottom: 8 + height };
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class ShimDocument extends ShimNode {
  constructor(url) {
    super(9);
    this.tagName = '#document';
    this.URL = url;
    this.location = { href: url };
    this.documentElement = null;
    this.body = null;
  }

  get title() {
    const found = this.querySelectorAll('title');
    return found.length ? found[0].textContent : '';
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/** The only three computed properties the extractor reads. */
function computedStyle(el) {
  const style = el.styleMap ? el.styleMap() : {};
  return {
    display: style.display === undefined ? 'block' : style.display,
    visibility: style.visibility === undefined ? 'visible' : style.visibility,
    opacity: style.opacity === undefined ? '1' : style.opacity,
  };
}

function parseHTML(html, options = {}) {
  const doc = new ShimDocument(options.url || 'https://example.test/docs/page');
  const stack = [doc];
  const append = (node) => {
    const parent = stack[stack.length - 1];
    node.parentNode = parent;
    parent.childNodes.push(node);
  };
  const addText = (raw) => {
    if (!raw) return;
    append(new ShimText(decodeEntities(raw)));
  };
  const closeTag = (name) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tagName === name.toUpperCase()) {
        stack.length = i;
        return;
      }
    }
  };

  // Comments, doctype, CDATA, end tags and start tags with attributes.
  const TOKEN_RE =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!\s*[a-zA-Z][^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

  let last = 0;
  let match;
  while ((match = TOKEN_RE.exec(html))) {
    if (match.index > last) addText(html.slice(last, match.index));
    last = TOKEN_RE.lastIndex;
    if (match[1]) {
      closeTag(match[1]);
      continue;
    }
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    const attributeText = match[3] || '';
    const selfClosing = /\/\s*$/.test(attributeText);
    const el = new ShimElement(name, parseAttributes(attributeText.replace(/\/\s*$/, '')), doc);
    append(el);
    if (!VOID_TAGS.has(name) && !selfClosing) stack.push(el);
  }
  if (last < html.length) addText(html.slice(last));

  let root = doc.childNodes.find((node) => node.nodeType === 1 && node.tagName === 'HTML');
  if (!root) {
    root = new ShimElement('html', {}, doc);
    const moved = doc.childNodes.splice(0);
    root.parentNode = doc;
    for (const child of moved) root.appendChild(child);
    doc.childNodes.push(root);
  }
  doc.documentElement = root;

  let body = root.querySelector('body');
  if (!body) {
    body = new ShimElement('body', {}, doc);
    const kept = [];
    const moved = root.childNodes.splice(0);
    for (const child of moved) {
      if (child.nodeType === 1 && child.tagName === 'HEAD') kept.push(child);
      else body.appendChild(child);
    }
    root.childNodes.push(...kept);
    root.appendChild(body);
  }
  doc.body = body;
  return doc;
}

const GLOBAL_KEYS = ['document', 'window', 'location', 'getComputedStyle'];

function makeDom(html, options) {
  const document = parseHTML(html, options);
  return { document, location: document.location, getComputedStyle: computedStyle };
}

/**
 * Install the shim as globals, run the script, restore. `new Function` evaluates
 * in global scope, so this is what makes the shim visible to the injected code.
 */
function evaluateInPage(script, dom) {
  const saved = {};
  for (const key of GLOBAL_KEYS) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  globalThis.document = dom.document;
  globalThis.window = globalThis;
  globalThis.location = dom.location;
  globalThis.getComputedStyle = dom.getComputedStyle;
  try {
    return new Function(`return (${script});`)();
  } finally {
    for (const key of GLOBAL_KEYS) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
}

function extract(html, options = {}, domOptions = {}) {
  const dom = makeDom(html, domOptions);
  const value = evaluateInPage(extractionScript(options), dom);
  return { page: value, dom, text: value && typeof value.text === 'string' ? value.text : '' };
}

function query(html, spec, domOptions = {}) {
  const dom = makeDom(html, domOptions);
  const value = evaluateInPage(queryScript(spec), dom);
  return { value, dom };
}

/** A stable textual fingerprint of the tree, for the no-mutation checks. */
function serialize(node) {
  if (node.nodeType === 3) return JSON.stringify(node.nodeValue);
  const names = Object.keys(node.attributes || {}).sort();
  const attrs = names.map((name) => `${name}=${JSON.stringify(node.attributes[name])}`).join(' ');
  const children = node.childNodes.map(serialize).join('');
  return `<${node.tagName}${attrs ? ` ${attrs}` : ''}>${children}</${node.tagName}>`;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ARTICLE = `<!doctype html>
<html><head>
  <title>  Getting started  </title>
  <style>.note { color: red }</style>
</head><body>
  <nav>
    <a href="/">Home</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
  </nav>
  <main>
    <h1>Getting started</h1>
    <p>Install the package and run <code>klaud</code>.</p>
    <h2>Install</h2>
    <p>Run <a href="/install">the installer</a> or <a href="https://elsewhere.test/guide">read the guide</a>.</p>
    <p>Then <a href="/download">click here</a> to fetch it.</p>
    <h2>Read <a href="/guide">the guide</a></h2>
    <ul>
      <li>One</li>
      <li>Two
        <ul><li>Two A</li></ul>
      </li>
    </ul>
    <pre>
  indented line
line two</pre>
    <table>
      <tr><th>Name</th><th>Value</th></tr>
      <tr><td>alpha</td><td>1</td></tr>
      <tr><td>beta</td><td>2</td></tr>
    </table>
    <blockquote><p>Quoted words.</p></blockquote>
    <script>var secret = 'do not read me';</script>
    <noscript>enable javascript</noscript>
    <svg><text>vector text</text></svg>
    <div style="display:none">Hidden by CSS</div>
    <div aria-hidden="true">Hidden by aria</div>
    <p hidden>Hidden by attribute</p>
    <p style="width:0;height:0">Hidden by zero size</p>
    <div style="width:0;height:0"><p>Hidden inside a zero-size wrapper</p></div>
    <p>${'<span>'.repeat(20)}Deeply nested words${'</span>'.repeat(20)}</p>
  </main>
  <footer>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
  </footer>
</body></html>`;

/** No main/article/#content/.content, so the region has to be the body. */
const CHROME_PAGE = `<html><head><title>Story</title></head><body>
  <nav>
    ${['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa']
      .map((name) => `<a href="/${name.toLowerCase()}">${name}</a>`)
      .join('\n    ')}
  </nav>
  <header><h2>Quarterly report</h2><p>by Ana</p></header>
  <div id="article-body">
    <p>${'Real content that belongs to the article. '.repeat(6)}</p>
    <p>${'A second paragraph of the same article body. '.repeat(6)}</p>
  </div>
  <footer><a href="/terms">Terms</a> copyright 2024</footer>
</body></html>`;

/* ------------------------------------------------------------------ *
 * 1. The injected script itself
 * ------------------------------------------------------------------ */

console.log('\n\x1b[38;5;209m* Browser page extraction\x1b[0m');

group('the injected script is safe to embed');

const script = extractionScript();
check('extractionScript() returns a string', typeof script === 'string' && script.length > 500,
  `length ${typeof script === 'string' ? script.length : typeof script}`);
check('the script contains no raw backtick (it is built with fromCharCode)',
  !script.includes(TICK), `${count(script, TICK)} backticks`);
check('the script contains no ${} interpolation', !script.includes(`${DOLLAR}{`));
check('the script is a single expression that parses',
  (() => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (${script});`);
      return true;
    } catch (err) {
      return err.message;
    }
  })() === true);
check('the script is ASCII only, so the debug pipe cannot mangle it',
  !/[^\x09\x0a\x20-\x7e]/.test(script));

const hostileQuery = queryScript({ text: `a${TICK}b${DOLLAR}{c`, selector: '#x' });
check('a hostile spec cannot inject a backtick into the query script',
  !hostileQuery.includes(TICK), `found ${count(hostileQuery, TICK)}`);
check('a hostile spec cannot inject ${} into the query script', !hostileQuery.includes(`${DOLLAR}{`));
check('the hostile spec survives as an escaped string',
  hostileQuery.includes('\\u0060') && hostileQuery.includes('\\u0024{'), hostileQuery.slice(-160));

check('options are coerced to numbers, not pasted in',
  extractionScript({ maxChars: 'abc' }).includes('"maxChars":40000') &&
    extractionScript({ maxChars: 120 }).includes('"maxChars":120'));

/* ------------------------------------------------------------------ *
 * 2. Text formatting
 * ------------------------------------------------------------------ */

const article = extract(ARTICLE);

group('title, url and shape');

check('the title is trimmed', article.page.title === 'Getting started', JSON.stringify(article.page.title));
check('the url comes from location.href', article.page.url === 'https://example.test/docs/page',
  article.page.url);
check('charCount is the length of the text returned',
  article.page.charCount === article.text.length, `${article.page.charCount} vs ${article.text.length}`);
check('truncated is false for a short page', article.page.truncated === false);

group('headings');

check('h1 becomes a top-level heading', article.text.includes('# Getting started'), article.text.slice(0, 200));
check('h2 becomes a second-level heading', article.text.includes('## Install'));
check('the headings list carries level and text',
  article.page.headings[0].level === 1 && article.page.headings[0].text === 'Getting started' &&
    article.page.headings[1].level === 2 && article.page.headings[1].text === 'Install',
  JSON.stringify(article.page.headings));
check('a link inside a heading is reported as plain text in the heading list',
  article.page.headings.some((h) => h.text === 'Read the guide' && h.level === 2),
  JSON.stringify(article.page.headings));
check('a heading never carries markdown link syntax', !/^#{1,6} .*\]\(/m.test(article.text));

const levels = extract('<body><h1>One</h1><p>a</p><h3>Three</h3><p>b</p><h6>Six</h6><p>c</p></body>');
check('h3 becomes a third-level heading', levels.text.includes('### Three'), levels.text);
check('h6 is capped at six hashes', levels.text.includes('###### Six') && !levels.text.includes('####### '),
  levels.text);
check('every heading level is reported with its level',
  JSON.stringify(levels.page.headings.map((heading) => heading.level)) === '[1,3,6]',
  JSON.stringify(levels.page.headings));

const noTitle = extract('<body><h1>First heading</h1><p>Some text here.</p></body>');
check('with no document title the first heading stands in',
  noTitle.page.title === 'First heading', JSON.stringify(noTitle.page.title));

group('paragraphs and whitespace');

check('paragraph text is present', article.text.includes('Install the package and run'));
check('a heading is followed by exactly one blank line',
  article.text.includes('# Getting started\n\nInstall the package'), JSON.stringify(article.text.slice(0, 80)));
check('every block is separated by exactly one blank line',
  article.text.includes('## Install\n\nRun ') && article.text.includes('.\n\nThen click here to fetch it.'),
  JSON.stringify(article.text.slice(0, 220)));
check('inline code is wrapped in backticks',
  article.text.includes(`run ${TICK}klaud${TICK}.`), article.text.slice(0, 400));
check('no three consecutive newlines survive', !article.text.includes('\n\n\n'));
check('no line has trailing whitespace', !/[ \t]\n/.test(article.text));
check('no tab characters survive', !article.text.includes('\t'));

const brPage = extract('<body><p>Line one<br>Line two</p></body>');
check('a <br> becomes a single line break inside its paragraph',
  brPage.text === 'Line one\nLine two', JSON.stringify(brPage.text));

const quote = extract('<body><blockquote><p>First quoted.</p><p>Second quoted.</p></blockquote></body>');
check('a multi-paragraph quote keeps its paragraphs on separate quoted lines',
  quote.text === '> First quoted.\n> Second quoted.', JSON.stringify(quote.text));

group('links inline');

check('a meaningful link becomes markdown',
  article.text.includes('[the installer](https://example.test/install)'), article.text.slice(0, 600));
check('an external link is kept as markdown too',
  article.text.includes('[read the guide](https://elsewhere.test/guide)'));
check('"click here" is not turned into a link',
  !article.text.includes('[click here](') && article.text.includes('click here'),
  article.text.slice(0, 800));

group('lists');

check('a list item becomes a bullet', article.text.includes('- One') && article.text.includes('- Two'),
  article.text);
check('a nested list item is indented by two spaces', article.text.includes('\n  - Two A'),
  JSON.stringify(article.text.slice(article.text.indexOf('- One'), article.text.indexOf('- One') + 60)));
check('a list does not put a blank line between items', !/- One\n\n- Two/.test(article.text));

const deepList = extract(`<body><ul><li>L0<ul><li>L1<ul><li>L2<ul><li>L3<ul><li>L4<ul><li>L5</li></ul></li></ul></li></ul></li></ul></li></ul></li></ul></body>`);
check('nesting past four levels is capped at eight spaces of indent',
  deepList.text.includes('\n        - L5') && !deepList.text.includes('\n          - '),
  JSON.stringify(deepList.text));

const listWithBranches = extract('<body><ul><li>Alpha<ul><li>Nested</li></ul>Beta</li></ul></body>');
check('text after a nested list is not glued to the text before it',
  listWithBranches.text.includes('- Alpha Beta') && listWithBranches.text.includes('\n  - Nested'),
  JSON.stringify(listWithBranches.text));

group('code blocks');

check('pre content is fenced', article.text.includes(`${TICK}${TICK}${TICK}\n  indented line\nline two\n${TICK}${TICK}${TICK}`),
  JSON.stringify(article.text.slice(article.text.indexOf(TICK + TICK + TICK), article.text.indexOf(TICK + TICK + TICK) + 60)));
check('pre content keeps its own indentation', article.text.includes('  indented line'));

const fenced = extract(`<body><pre>${TICK}${TICK}${TICK} inside</pre></body>`);
check('content that already contains a fence gets a longer one',
  fenced.text.includes(`${TICK}${TICK}${TICK}${TICK}\n${TICK}${TICK}${TICK} inside\n${TICK}${TICK}${TICK}${TICK}`),
  JSON.stringify(fenced.text));

group('tables');

check('a table renders as pipe rows', article.text.includes('| Name | Value |'), article.text);
check('a header row is followed by a separator', article.text.includes('| --- | --- |'));
check('table data rows are present', article.text.includes('| alpha | 1 |') && article.text.includes('| beta | 2 |'));

const bigTable = (() => {
  const header = `<tr>${Array.from({ length: 10 }, (_, i) => `<th>h${i}</th>`).join('')}</tr>`;
  const rows = Array.from({ length: 39 }, (_, r) =>
    `<tr>${Array.from({ length: 10 }, (_, c) => `<td>r${r}c${c}</td>`).join('')}</tr>`).join('');
  return `<body><table>${header}${rows}</table></body>`;
})();
const tablePage = extract(bigTable);
check('a table is capped at 30 rows and says so', tablePage.text.includes('(30 of 40 rows shown)'),
  tablePage.text.split('\n').slice(-3).join(' | '));
check('a table is capped at 8 columns and says so', tablePage.text.includes('(8 of 10 columns shown)'));
check('the capped table has exactly 30 pipe rows plus the separator',
  (tablePage.text.match(/^\| h/gm) || []).length === 1 &&
    (tablePage.text.match(/^\| r/gm) || []).length === 29,
  `${(tablePage.text.match(/^\| /gm) || []).length} pipe rows`);

group('chrome and link farms');

check('the nav outside the chosen region contributes no summary line',
  !article.text.includes('Navigation:'), article.text.slice(0, 300));
check('the nav labels are absent from the article text',
  !article.text.includes('Pricing') && !article.text.includes('Home'), article.text.slice(0, 300));
check('the footer is absent from the article text', !article.text.includes('Privacy'));

const chromePage = extract(CHROME_PAGE);
check('with no main region the body is read instead',
  chromePage.text.includes('Real content that belongs to the article'), chromePage.text.slice(0, 200));
check('a nav link farm becomes one summary line',
  chromePage.text.includes('Navigation: Alpha / Beta / Gamma / Delta / Epsilon / Zeta'), chromePage.text.slice(0, 300));
check('the summary line stops at six links', !chromePage.text.includes('Kappa'), chromePage.text);
check('the nav summary appears exactly once', count(chromePage.text, 'Navigation:') === 1);
check('a header holding the title is content, not chrome',
  chromePage.text.includes('## Quarterly report') && chromePage.text.includes('by Ana') &&
    !chromePage.text.includes('Header links'),
  chromePage.text.slice(0, 300));
check('a footer with a single link is dropped rather than summarised',
  !chromePage.text.includes('Footer links') && !chromePage.text.includes('copyright 2024'),
  chromePage.text.slice(-200));

group('hidden content');

for (const marker of ['do not read me', 'enable javascript', 'vector text', 'Hidden by CSS',
  'Hidden by aria', 'Hidden by attribute', 'Hidden by zero size', 'Hidden inside a zero-size wrapper',
  'color: red']) {
  check(`"${marker}" never reaches the text`, !article.text.includes(marker));
}

check('text inside twenty nested spans is still read',
  article.text.includes('Deeply nested words'), article.text.slice(-400));

group('boilerplate collapse');

const repeats = extract(`<body>
  <p>Subscribe to our newsletter</p>
  <p>First real paragraph.</p>
  <p>Subscribe to our newsletter</p>
  <p>Second real paragraph.</p>
  <p>Subscribe to our newsletter</p>
  <p>Subscribe to our newsletter</p>
  <p>Subscribe to our newsletter</p>
</body>`);
check('a short block repeated five times is kept twice',
  count(repeats.text, 'Subscribe to our newsletter') === 2, repeats.text);
check('the content around the repeated block survives',
  repeats.text.includes('First real paragraph.') && repeats.text.includes('Second real paragraph.'));

/* ------------------------------------------------------------------ *
 * 3. Region selection
 * ------------------------------------------------------------------ */

group('choosing the region');

const tinyMain = extract(`<body>
  <main><p>Loading</p></main>
  <div id="outside"><p>${'The article body lives outside main. '.repeat(20)}</p></div>
</body>`);
check('a placeholder main falls back to the body',
  tinyMain.text.includes('Loading') && tinyMain.text.includes('The article body lives outside main'),
  tinyMain.text.slice(0, 200));

const ratioPage = extract(`<body>
  <main><p>${'Short content. '.repeat(10)}</p></main>
  <div>${'Chromeless junk outside main. '.repeat(40)}</div>
</body>`);
check('a main holding a fifth of the page is not trusted',
  ratioPage.text.includes('Chromeless junk outside main'), ratioPage.text.slice(0, 200));

const articleTag = extract(`<body><div class="content"><h1>Content id</h1>
  <p>${'The class content element is the region. '.repeat(12)}</p></div>
  <div>${'Smaller sibling. '.repeat(3)}</div></body>`);
check('.content is used as the region when it dominates',
  articleTag.text.includes('# Content id') &&
    articleTag.text.includes('The class content element is the region'), articleTag.text.slice(0, 200));

const roleMain = extract(`<body><div role="main"><h1>Role main</h1>
  <p>${'Content found through the main role. '.repeat(12)}</p></div></body>`);
check('[role=main] is used as the region', roleMain.text.includes('# Role main') &&
  roleMain.text.includes('Content found through the main role'), roleMain.text.slice(0, 200));

const articleRegion = extract(`<body><article><h1>Article</h1>
  <p>${'Article body content. '.repeat(12)}</p></article>
  <div>${'Sibling. '.repeat(3)}</div></body>`);
check('an article element is used as the region', articleRegion.text.includes('# Article') &&
  articleRegion.text.includes('Article body content'), articleRegion.text.slice(0, 200));
check('a sibling outside the article is not read', !articleRegion.text.includes('Sibling.'), articleRegion.text);

/* ------------------------------------------------------------------ *
 * 4. Truncation
 * ------------------------------------------------------------------ */

group('truncation');

const words = Array.from({ length: 1200 }, (_, i) => `w${i}`);
const longHtml = `<body>${words.map((word) => `<p>${word}</p>`).join('')}</body>`;
const longPage = extract(longHtml, { maxChars: 500 });
const marker = '[Content truncated at 500 characters]';
check('a long page is truncated', longPage.page.truncated === true);
check('truncated text is within the cap plus its marker',
  longPage.text.length <= 500, `${longPage.text.length} chars`);
check('the cut is announced in the text', longPage.text.includes(marker), longPage.text.slice(-120));
check('the cut lands on a block boundary, not mid-word', (() => {
  const body = longPage.text.slice(0, longPage.text.indexOf('\n\n' + marker));
  const lastLine = body.slice(body.lastIndexOf('\n') + 1);
  return /^w\d+$/.test(lastLine) && words.includes(lastLine);
})(), JSON.stringify(longPage.text.slice(-160)));
check('charCount matches the truncated text', longPage.page.charCount === longPage.text.length,
  `${longPage.page.charCount} vs ${longPage.text.length}`);

const capped = extract(longHtml, { maxChars: 2000 });
check('a smaller cap produces a shorter text', capped.text.length <= 2000 && capped.text.length > 500,
  `${capped.text.length} chars`);

// The session layer asks for a 200-character summary when it only wants a hint of
// the page, so a small cap has to return something rather than nothing.
const tinyCap = extract(longHtml, { maxChars: 200 });
check('a small cap still returns content within the cap',
  tinyCap.text.length > 0 && tinyCap.text.length <= 200 && tinyCap.page.truncated === true,
  `${tinyCap.text.length} chars: ${JSON.stringify(tinyCap.text.slice(0, 60))}`);

const oneParagraph = extract(`<body><p>${'word '.repeat(120)}</p></body>`, { maxChars: 200 });
check('a page that is one long paragraph is not returned empty at a small cap',
  oneParagraph.text.length > 0 && oneParagraph.text.length <= 200 && oneParagraph.page.truncated === true,
  JSON.stringify(oneParagraph.text.slice(0, 60)));

const tinyCap2 = extract(longHtml, { maxChars: 50 });
check('a very small cap still respects the cap',
  tinyCap2.text.length <= 50 && tinyCap2.page.truncated === true,
  `${tinyCap2.text.length} chars: ${JSON.stringify(tinyCap2.text)}`);

const noticeCap = extract(longHtml, { maxChars: 100 });
check('a tight cap is not mostly a truncation notice',
  noticeCap.text.length <= 100 && !noticeCap.text.includes('[Content truncated at 100'),
  JSON.stringify(noticeCap.text.slice(-40)));

/* ------------------------------------------------------------------ *
 * 5. links[] and inputs[]
 * ------------------------------------------------------------------ */

group('links');

const linkPage = extract(`<body><main>
  <h1>Links</h1>
  <p>${'Enough content for the region to be chosen. '.repeat(10)}</p>
  <a href="/docs">Documentation</a>
  <a href="/docs">Documentation again</a>
  <a href="https://other.test/x">Elsewhere</a>
  <a href="#anchor">Jump</a>
  <a href="javascript:void(0)">Script</a>
  <a href="/empty"></a>
</main></body>`);
const hrefs = linkPage.page.links.map((link) => link.href);
check('links are collected from the whole document', hrefs.includes('https://example.test/docs'),
  JSON.stringify(hrefs));
check('links are deduped by href', hrefs.filter((href) => href === 'https://example.test/docs').length === 1,
  JSON.stringify(hrefs));
check('the same-origin link is marked internal',
  linkPage.page.links.find((link) => link.href === 'https://example.test/docs').internal === true);
check('a different origin is marked external',
  linkPage.page.links.find((link) => link.href === 'https://other.test/x').internal === false,
  JSON.stringify(linkPage.page.links));
check('in-page anchors are not reported as destinations', !hrefs.some((href) => href.includes('#anchor')));
check('javascript: links are dropped', !hrefs.some((href) => href.startsWith('javascript:')));
check('a link with no text is dropped', !hrefs.some((href) => href.endsWith('/empty')));
check('link text is the visible label',
  linkPage.page.links.find((link) => link.href === 'https://example.test/docs').text === 'Documentation');

const manyLinks = extract(`<body><p>${'Text. '.repeat(40)}</p>${Array.from({ length: 60 },
  (_, i) => `<a href="/p${i}">Page ${i}</a>`).join('')}</body>`);
check('links are capped at 40', manyLinks.page.links.length === 40, `${manyLinks.page.links.length} links`);

group('inputs');

const formPage = extract(`<body><main>
  <h1>Sign in</h1>
  <p>${'Please fill in the form below to continue. '.repeat(8)}</p>
  <form>
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.test" value="a@b.test" />
    <label>Wrapped label <input name="nickname" /></label>
    <input name="token" type="hidden" value="secret-token" />
    <input name="pw" type="password" value="hunter2" />
    <input name="photo" type="file" />
    <input name="go" type="submit" value="Sign in" />
    <textarea name="notes" aria-label="Notes"></textarea>
    <select name="plan"><option>Free</option><option>Pro</option></select>
    <input name="off" type="text" style="display:none" />
  </form>
</main></body>`);

const kinds = formPage.page.inputs.map((input) => `${input.kind}:${input.name}`);
check('fillable controls are reported with their kind and name',
  kinds.includes('email:email') && kinds.includes('text:nickname') && kinds.includes('textarea:notes') &&
    kinds.includes('select:plan'), JSON.stringify(kinds));
check('a hidden input is not offered for filling', !kinds.some((kind) => kind.includes('token')));
check('a submit button is not offered for filling', !kinds.some((kind) => kind.includes('go')));
check('a file input is not offered', !kinds.some((kind) => kind.includes('photo')));
check('a display:none input is not offered', !kinds.some((kind) => kind.includes('off')));
check('the label is resolved through the for attribute',
  formPage.page.inputs.find((input) => input.name === 'email').label === 'Email address',
  JSON.stringify(formPage.page.inputs));
check('the placeholder is reported',
  formPage.page.inputs.find((input) => input.name === 'email').placeholder === 'you@example.test');
check('an existing value is reported when it is safe to',
  formPage.page.inputs.find((input) => input.name === 'email').value === 'a@b.test');
check('a password value is never reported',
  formPage.page.inputs.find((input) => input.name === 'pw') &&
    formPage.page.inputs.find((input) => input.name === 'pw').value === undefined,
  JSON.stringify(formPage.page.inputs.find((input) => input.name === 'pw')));
check('an aria-label is used when there is no label element',
  formPage.page.inputs.find((input) => input.name === 'notes').label === 'Notes');
check('a wrapping label is found', formPage.page.inputs.find((input) => input.name === 'nickname').label
  .startsWith('Wrapped label'));
check('the heading above the form is still read', formPage.text.includes('# Sign in'), formPage.text.slice(0, 120));
check('the options of a select never become page text',
  !formPage.text.includes('Free') && !formPage.text.includes('Pro'), formPage.text.slice(0, 300));

/* ------------------------------------------------------------------ *
 * 6. The never-throws contract and side-effect freedom
 * ------------------------------------------------------------------ */

group('it never throws, and never writes');

// Re-run against the *same* document: idempotent means the second read of an
// unchanged page must be identical.
const dom = makeDom(ARTICLE);
const firstRun = evaluateInPage(extractionScript(), dom);
const secondRun = evaluateInPage(extractionScript(), dom);
check('running twice on the same document gives the same result',
  JSON.stringify(firstRun) === JSON.stringify(secondRun), 'results differ');
check('the document is byte-identical after extracting',
  serialize(dom.document) === serialize(makeDom(ARTICLE).document), 'the DOM changed');

const throwingTag = makeDom('<body><p>hello</p></body>');
Object.defineProperty(throwingTag.document.body.childNodes.find((node) => node.nodeType === 1), 'tagName', {
  get() { throw new Error('boom'); },
});
const hostile = evaluateInPage(extractionScript(), throwingTag);
check('a hostile element yields __klaudError rather than an exception',
  typeof hostile === 'object' && typeof hostile.__klaudError === 'string', JSON.stringify(hostile).slice(0, 160));
check('the error names the failure', /boom/.test(hostile.__klaudError), hostile.__klaudError);
const hostileParsed = parseExtraction({ result: { type: 'object', value: hostile } });
check('parseExtraction turns __klaudError into ok:false',
  hostileParsed.ok === false && /boom/.test(hostileParsed.error), JSON.stringify(hostileParsed));

const noQueries = makeDom(ARTICLE);
noQueries.document.querySelectorAll = () => {
  throw new Error('selector engine on fire');
};
const survived = evaluateInPage(extractionScript(), noQueries);
check('a broken querySelectorAll still yields the page text',
  survived && typeof survived.text === 'string' && survived.text.includes('Getting started'),
  JSON.stringify(survived).slice(0, 200));
check('a broken querySelectorAll costs only the links and inputs',
  Array.isArray(survived.links) && survived.links.length === 0 && survived.inputs.length === 0);

const noRoot = makeDom('<body><p>x</p></body>');
noRoot.document.body = null;
noRoot.document.documentElement = null;
const empty = evaluateInPage(extractionScript(), noRoot);
check('a document with no root returns an empty page instead of throwing',
  empty && empty.text === '' && empty.charCount === 0 && empty.truncated === false &&
    Array.isArray(empty.headings) && Array.isArray(empty.links),
  JSON.stringify(empty).slice(0, 200));

const blank = extract('<body></body>');
check('an empty body is a valid, empty page',
  blank.page.text === '' && blank.page.charCount === 0 && blank.page.title === '');

/* ------------------------------------------------------------------ *
 * 7. parseExtraction
 * ------------------------------------------------------------------ */

group('parseExtraction');

const fromShim = parseExtraction({ result: { type: 'object', value: article.page } });
check('a valid CDP result parses to a page',
  fromShim.ok === true && fromShim.page.title === 'Getting started' && fromShim.page.text.length > 100,
  JSON.stringify(fromShim).slice(0, 120));
check('the parsed page keeps every field',
  ['title', 'url', 'text', 'headings', 'links', 'inputs', 'truncated', 'charCount'].every(
    (key) => key in fromShim.page),
  JSON.stringify(Object.keys(fromShim.page)));

const errorPayload = parseExtraction({ result: { type: 'object', value: { __klaudError: 'the page exploded' } } });
check('a __klaudError payload becomes ok:false',
  errorPayload.ok === false && errorPayload.error === 'the page exploded', JSON.stringify(errorPayload));

const exception = parseExtraction({
  result: { type: 'object' },
  exceptionDetails: { text: 'Uncaught', lineNumber: 3, exception: { description: 'TypeError: x is not a function' } },
});
check('a CDP exception result becomes ok:false',
  exception.ok === false && /TypeError: x is not a function/.test(exception.error), JSON.stringify(exception));
check('the CDP exception result names the line', /line 3/.test(exception.error), exception.error);

const noResult = parseExtraction(undefined);
check('undefined becomes ok:false', noResult.ok === false && /no result/i.test(noResult.error),
  JSON.stringify(noResult));

const notJson = parseExtraction({ result: { type: 'string', value: 'this is not json' } });
check('a non-JSON string becomes ok:false',
  notJson.ok === false && /not JSON/i.test(notJson.error), JSON.stringify(notJson));

const unserialisable = parseExtraction({ result: { type: 'object' } });
check('an unserialisable object becomes ok:false',
  unserialisable.ok === false && /serialis/i.test(unserialisable.error), JSON.stringify(unserialisable));

const wrongShape = parseExtraction({ result: { type: 'object', value: { hello: 'world' } } });
check('an object that is not a page becomes ok:false',
  wrongShape.ok === false && /not page content/i.test(wrongShape.error), JSON.stringify(wrongShape));

const jsonString = parseExtraction({ result: { type: 'string', value: JSON.stringify({ title: 'T', url: 'u', text: 'x' }) } });
check('a JSON string result is parsed, not rejected',
  jsonString.ok === true && jsonString.page.title === 'T', JSON.stringify(jsonString));

const junkFields = parseExtraction({
  result: {
    type: 'object',
    value: {
      title: 42,
      url: null,
      text: 'body',
      headings: [{ level: 9, text: 'deep' }, null, { level: 2, text: '' }],
      links: [{ text: 'a', href: '/x', internal: 1 }, { text: 'b' }],
      inputs: [{ kind: 'text', name: 'q' }, 'nope'],
      truncated: 'yes',
      charCount: 'not a number',
    },
  },
});
check('every field is coerced and junk entries are dropped',
  junkFields.ok === true &&
    junkFields.page.title === '42' &&
    junkFields.page.url === '' &&
    junkFields.page.truncated === false &&
    junkFields.page.headings.length === 1 &&
    junkFields.page.headings[0].level === 6 &&
    junkFields.page.links.length === 1 &&
    junkFields.page.links[0].internal === false &&
    junkFields.page.inputs.length === 1 &&
    junkFields.page.charCount === 4,
  JSON.stringify(junkFields.page));

check('a null reply becomes ok:false', parseExtraction(null).ok === false);
check('a string reply becomes ok:false', parseExtraction('nope').ok === false);
// The shape session.readPage actually builds: it has already turned the CDP
// reply into the value, and passes no `type`. It has to work as-is.
const readPageShape = parseExtraction({ result: { value: article.page } });
check('the value-only result shape used by the session layer parses',
  readPageShape.ok === true && readPageShape.page.text === article.page.text);
check('a value-only result that is undefined is refused',
  parseExtraction({ result: { value: undefined } }).ok === false &&
    /no value/.test(parseExtraction({ result: { value: undefined } }).error),
  JSON.stringify(parseExtraction({ result: { value: undefined } })));
check('parseExtraction never throws on a cycle',
  (() => {
    const cyclic = { result: { type: 'object', value: {} } };
    cyclic.result.value.self = cyclic;
    try {
      return parseExtraction(cyclic).ok === false;
    } catch {
      return false;
    }
  })());

/* ------------------------------------------------------------------ *
 * 8. queryScript and parseQuery
 * ------------------------------------------------------------------ */

group('queryScript');

const QUERY_PAGE = `<body>
  <h1>Inbox</h1>
  <button id="save" class="primary wide">Save</button>
  <button id="cancel" class="ghost">Cancel</button>
  <div class="row"><span>Save</span></div>
  <a href="/help">Help</a>
  <input id="q" name="query" placeholder="Search mail" />
  <textarea name="body" aria-label="Message body"></textarea>
  <div id="ce" contenteditable="true">Type here</div>
  <button style="display:none">Ghost button</button>
  <div id="hidden-div" aria-hidden="true">Save</div>
  <p style="width:0;height:0">Zero size</p>
</body>`;

const queryScriptSource = queryScript({ text: 'Save' });
check('queryScript returns a string', typeof queryScriptSource === 'string' && queryScriptSource.length > 500);
check('the query script contains no raw backtick', !queryScriptSource.includes(TICK));
check('the query script contains no ${}', !queryScriptSource.includes(`${DOLLAR}{`));
check('the query script is ASCII only',
  !/[^\x09\x0a\x20-\x7e]/.test(queryScriptSource),
  JSON.stringify((queryScriptSource.match(/[^\x09\x0a\x20-\x7e]/g) || []).slice(0, 5)));
check('the query script is a single expression', (() => {
  try {
    new Function(`return (${queryScriptSource});`);
    return true;
  } catch {
    return false;
  }
})());

const bySelector = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: '#save' }).value } });
check('a selector query finds one element',
  bySelector.ok === true && bySelector.matches.length === 1 && bySelector.matches[0].tag === 'button',
  JSON.stringify(bySelector));
check('the match reports its id and classes',
  bySelector.matches[0].id === 'save' && bySelector.matches[0].classes.join(' ') === 'primary wide',
  JSON.stringify(bySelector.matches[0]));
check('the match reports a usable rect',
  bySelector.matches[0].rect.width > 0 && bySelector.matches[0].rect.height > 0,
  JSON.stringify(bySelector.matches[0].rect));
check('a button is not editable', bySelector.matches[0].editable === false);
check('the match carries an index', bySelector.matches[0].index === 0);

const byText = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { text: 'save' }).value } });
check('a text query is case-insensitive and finds the most specific elements',
  byText.ok === true && byText.matches.length === 2 &&
    byText.matches.every((match) => ['button', 'span'].includes(match.tag)),
  JSON.stringify(byText.matches && byText.matches.map((match) => match.tag)));
check('a text query never returns the body or a wrapping div',
  byText.matches.every((match) => !['body', 'div'].includes(match.tag)),
  JSON.stringify(byText.matches && byText.matches.map((match) => match.tag)));
check('indices count up from zero',
  byText.matches[0].index === 0 && byText.matches[1].index === 1);

const trimmed = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { text: '  SAVE  ' }).value } });
check('the query text is trimmed', trimmed.ok === true && trimmed.matches.length === 2);

const limited = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: 'button', limit: 1 }).value } });
check('limit caps the number of matches', limited.ok === true && limited.matches.length === 1,
  JSON.stringify(limited));

const allButtons = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: 'button' }).value } });
check('hidden elements are excluded from the matches',
  allButtons.matches.length === 2 && !allButtons.matches.some((match) => match.text === 'Ghost button'),
  JSON.stringify(allButtons.matches.map((match) => match.text)));

const placeholder = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { text: 'search mail' }).value } });
check('a field can be found by its placeholder when no text matches',
  placeholder.ok === true && placeholder.matches.length === 1 && placeholder.matches[0].tag === 'input',
  JSON.stringify(placeholder));

const ariaQuery = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { text: 'message body' }).value } });
check('a field can be found by its aria-label',
  ariaQuery.ok === true && ariaQuery.matches.some((match) => match.tag === 'textarea'),
  JSON.stringify(ariaQuery));

const editableQuery = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: 'textarea' }).value } });
check('a textarea is editable', editableQuery.matches[0].editable === true);
const ceQuery = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: '#ce' }).value } });
check('a contenteditable element is editable', ceQuery.matches[0].editable === true);

const splitText = parseQuery({
  result: {
    type: 'object',
    value: query('<body><button id="b">Sav<span>e</span></button></body>', { text: 'save' }).value,
  },
});
check('text split across inline children still matches the wrapper',
  splitText.ok === true && splitText.matches.length === 1 && splitText.matches[0].tag === 'button',
  JSON.stringify(splitText));

const selectorAndText = parseQuery({
  result: { type: 'object', value: query(QUERY_PAGE, { selector: 'button', text: 'cancel' }).value },
});
check('selector and text together narrow the result',
  selectorAndText.ok === true && selectorAndText.matches.length === 1 &&
    selectorAndText.matches[0].id === 'cancel', JSON.stringify(selectorAndText));

const zeroBox = parseQuery({ result: { type: 'object', value: query(QUERY_PAGE, { selector: 'p' }).value } });
check('a zero-size element is not offered as a click target', zeroBox.matches.length === 0,
  JSON.stringify(zeroBox));

const noMatch = query(QUERY_PAGE, { selector: '.does-not-exist' });
const noMatchParsed = parseQuery({ result: { type: 'object', value: noMatch.value } });
check('an empty match list is a valid answer, not an error',
  noMatchParsed.ok === true && Array.isArray(noMatchParsed.matches) && noMatchParsed.matches.length === 0,
  JSON.stringify(noMatchParsed));

const badSelector = query(QUERY_PAGE, { selector: '[[[not a selector' });
check('an invalid selector comes back as __klaudError',
  typeof badSelector.value.__klaudError === 'string' && /Invalid CSS selector/.test(badSelector.value.__klaudError),
  JSON.stringify(badSelector.value).slice(0, 200));
check('parseQuery turns that into ok:false',
  parseQuery({ result: { type: 'object', value: badSelector.value } }).ok === false);

const emptySpec = query(QUERY_PAGE, {});
check('a spec with neither text nor selector is refused with an explanation',
  /selector or some visible text/.test(emptySpec.value.__klaudError || ''), JSON.stringify(emptySpec.value));

const queryDomBefore = serialize(makeDom(QUERY_PAGE).document);
const queryDom = makeDom(QUERY_PAGE);
evaluateInPage(queryScript({ text: 'Save' }), queryDom);
evaluateInPage(queryScript({ selector: 'button' }), queryDom);
check('querying does not write to the DOM', serialize(queryDom.document) === queryDomBefore, 'the DOM changed');
check('nothing is tagged with a klaud attribute',
  !serialize(queryDom.document).includes('data-klaud-idx'));

/* ------------------------------------------------------------------ *
 * 9. parseQuery edge cases
 * ------------------------------------------------------------------ */

group('parseQuery');

check('an empty reply becomes ok:false', parseQuery(undefined).ok === false);
check('a reply with no match list becomes ok:false',
  parseQuery({ result: { type: 'object', value: { nope: 1 } } }).ok === false);
check('a bare array of matches is accepted',
  (() => {
    const parsed = parseQuery({ result: { type: 'object', value: [{ tag: 'BUTTON', text: 'Go' }] } });
    return parsed.ok === true && parsed.matches.length === 1 && parsed.matches[0].tag === 'button';
  })());
check('a match with junk fields is normalised',
  (() => {
    const parsed = parseQuery({
      result: { type: 'object', value: { matches: [{ tag: 7, text: null, classes: 'nope', rect: 'bad', visible: 'yes' }] } },
    });
    return parsed.ok === true && parsed.matches[0].tag === '7' && parsed.matches[0].text === '' &&
      Array.isArray(parsed.matches[0].classes) && parsed.matches[0].classes.length === 0 &&
      parsed.matches[0].rect.width === 0 && parsed.matches[0].visible === false;
  })());
check('a match list returned directly from the page is accepted',
  parseQuery({ result: { type: 'object', value: { matches: [] } } }).ok === true);

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} extraction checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} extraction checks passed\x1b[0m\n`);
