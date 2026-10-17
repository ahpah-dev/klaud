'use strict';

/**
 * Page to text, for a model to read.
 *
 * The browser tool can already drive a page (see `cdp.js`). What it could not do
 * is *read* one: raw HTML is mostly markup, and `document.body.innerText` on a
 * real site is a wall of run-together navigation links with the article buried
 * somewhere inside it. A model given that answers the wrong question.
 *
 * So the work happens in two places, and this module owns both halves of the
 * boundary:
 *
 *   - the script that runs **inside the page** and turns the DOM into markdown-ish
 *     text, headings, links and form fields;
 *   - the **Node-side** parsing of the CDP reply into a plain object, plus the
 *     element-locating script the clicking and typing tools use.
 *
 * Nothing here knows how a CDP command is sent. `session.js` owns that: it sends
 * `extractionScript()` through `Runtime.evaluate` with `returnByValue: true` and
 * hands the reply to `parseExtraction()`. Keeping the transport out of this file
 * is what makes every function in it testable without a browser.
 *
 * ## Why the in-page code is a real function that gets serialised
 *
 * The script has to be a string, and the obvious way to get one is to write it as
 * a string literal — which means the page-side code is never syntax-checked by
 * Node, never linted, and has to escape its own quotes. Instead the page code is
 * an ordinary function in this module, and the script is
 * `'(' + pageExtract.toString() + ')(' + JSON.stringify(options) + ')'`. Node
 * parses it, `node --check` validates it, and the test suite can run it against a
 * DOM shim.
 *
 * Two constraints follow from that choice, and both are enforced by the test
 * suite:
 *
 *   - **No template literals and no `${` anywhere inside the page functions.** A
 *     caller may embed the returned script in a template literal, and a literal
 *     backtick or `${` would break it there. Backticks that the extractor itself
 *     needs to *emit* (code fences, inline code) are built with
 *     `String.fromCharCode(96)` instead of being typed.
 *   - **Self-contained.** The serialised function cannot see this module, so
 *     every helper lives inside it. The two page functions therefore duplicate a
 *     handful of small predicates, deliberately.
 *
 * This relies on `Function.prototype.toString()` returning source, which the ES
 * spec guarantees for functions defined in source text. There is no bundler or
 * transpiler in Klaud, so there is nothing to rewrite them.
 */

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_LINKS = 40;
const DEFAULT_MAX_INPUTS = 40;
const DEFAULT_MAX_HEADINGS = 100;
const DEFAULT_TABLE_ROWS = 30;
const DEFAULT_TABLE_COLS = 8;
const DEFAULT_QUERY_LIMIT = 10;
const MAX_QUERY_LIMIT = 50;

/* ------------------------------------------------------------------ *
 * Injected script: the page as text
 * ------------------------------------------------------------------ */

/**
 * Runs inside the page. Called as `(function pageExtract(options) { ... })({...})`
 * and must evaluate to a JSON-able object.
 *
 * Deliberately ES5 in style (`var`, `function`, string concatenation): this code
 * is executed in whatever page the agent happens to be on, so it is written to be
 * obviously portable rather than to match the rest of the codebase. It reads the
 * DOM and nothing else — no attributes are written, no globals are touched, no
 * nodes are added or removed. That is what makes it safe to run on every
 * navigation, and the test suite asserts the document is byte-identical
 * afterwards.
 *
 * The whole body is wrapped in a try/catch. A partially broken page must not fail
 * the tool call with a CDP exception the caller cannot read, so any failure comes
 * back as `{ __klaudError: message }` and `parseExtraction` turns that into a
 * normal `{ ok: false, error }`.
 */
function pageExtract(options) {
  var opts = options || {};

  var MAX_CHARS = num(opts.maxChars, 40000);
  var MAX_LINKS = num(opts.maxLinks, 40);
  var MAX_INPUTS = num(opts.maxInputs, 40);
  var MAX_HEADINGS = num(opts.maxHeadings, 100);
  var TABLE_ROWS = num(opts.tableRows, 30);
  var TABLE_COLS = num(opts.tableCols, 8);
  var MAX_CODE = 4000;
  var MAX_BLOCK = 20000;
  var MAX_LIST_DEPTH = 4;
  // Stop walking once we have twice what we can return: a 5MB page should cost a
  // cut walk, not a 5MB string. MAX_BLOCK is added on top so that the *first*
  // block always fits even when maxChars is tiny: refusing it would return an
  // empty page for a caller that asked for a small summary of a page whose first
  // paragraph is long.
  var HARD_STOP = MAX_CHARS * 2 + MAX_BLOCK;

  // A backtick, built rather than typed. The whole function is serialised and may
  // be embedded in a template literal by the caller, so this source must not
  // contain one literally.
  var TICK = String.fromCharCode(96);

  // Subtrees that are never readable text, or whose contents are already covered
  // by another field: form controls are reported in the inputs list, with values.
  var STRIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    OBJECT: 1, EMBED: 1, APPLET: 1, VIDEO: 1, AUDIO: 1, TRACK: 1, MAP: 1,
    HEAD: 1, META: 1, LINK: 1, BASE: 1, TITLE: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1
  };

  var BLOCK = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, DD: 1, DETAILS: 1,
    DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1,
    FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1,
    HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1,
    TABLE: 1, UL: 1
  };

  // Link text that carries no destination information. Wrapping these in the
  // [text](href) form adds noise without telling the model anything, so they stay
  // as plain text.
  var BAD_LINK_TEXT =
    /^(click here|click|here|read more|read on|more|learn more|this link|link|details|continue|continue reading|see more|see all|more info|view|view all|view more|next|previous|prev|back|top|skip to content|skip to main content|skip navigation|expand|show more|show less|\d+)$/i;

  var blocks = [];
  var headings = [];
  var emitted = 0;
  var overBudget = false;

  // Measurement in chars rather than in pretty-printed text: this runs on every
  // candidate region, and a fixpoint of "short enough" is all the ratio needs.

  function num(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  function tagOf(el) {
    return String(el.tagName || '').toUpperCase();
  }

  function attr(el, name) {
    try {
      var v = el.getAttribute(name);
      return v === null || v === undefined ? null : String(v);
    } catch (e) {
      return null;
    }
  }

  function attrOr(el, name) {
    var v = attr(el, name);
    return v === null ? '' : v;
  }

  function collapse(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function spaces(count) {
    return new Array(count + 1).join(' ');
  }

  function hashes(level) {
    return new Array(level + 1).join('#');
  }

  function pageUrl() {
    try {
      if (typeof location !== 'undefined' && location && location.href) return String(location.href);
    } catch (e) {
      /* about:srcdoc and sandboxed frames can throw on href */
    }
    try {
      if (document.URL) return String(document.URL);
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  /** 'https://example.com' from a full URL, or '' when there is no origin. */
  function originOf(url) {
    var m = /^([a-z][a-z0-9+.\-]*:)\/\/([^\/?#]+)/i.exec(String(url));
    if (!m) return '';
    return (m[1] + '//' + m[2]).toLowerCase();
  }

  var PAGE_ORIGIN = originOf(pageUrl());

  function isInternal(href) {
    var lower = String(href).toLowerCase();
    if (!PAGE_ORIGIN) return lower.charAt(0) === '/';
    if (lower.indexOf(PAGE_ORIGIN) !== 0) return false;
    // 'https://example.com' is the origin; 'https://example.com.evil.test' is not.
    var next = lower.charAt(PAGE_ORIGIN.length);
    return next === '' || next === '/' || next === '?' || next === '#';
  }

  function computed(el) {
    try {
      if (typeof getComputedStyle === 'function') return getComputedStyle(el) || null;
    } catch (e) {
      /* a detached node or a shim without style support */
    }
    return null;
  }

  /**
   * Cheap attribute checks first: this runs once per element, and
   * getComputedStyle forces style resolution.
   */
  function isHidden(el) {
    if (!el) return true;
    if (el.hidden === true) return true;
    var aria = attr(el, 'aria-hidden');
    if (aria !== null && collapse(aria).toLowerCase() === 'true') return true;
    if (attr(el, 'hidden') !== null) return true;
    var cs = computed(el);
    if (!cs) return false;
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    var opacity = cs.opacity;
    if (opacity !== undefined && opacity !== null && opacity !== '' && Number(opacity) === 0) return true;
    return false;
  }

  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return null;
      var x = Number(r.left);
      var y = Number(r.top);
      var w = Number(r.width);
      var h = Number(r.height);
      if (!isFinite(x)) x = 0;
      if (!isFinite(y)) y = 0;
      if (!isFinite(w)) w = 0;
      if (!isFinite(h)) h = 0;
      return { x: x, y: y, width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  /**
   * A collapsed element (max-height:0, a zero-sized wrapper) holds no visible
   * content. display:contents is the exception: those legitimately have no box of
   * their own while their children are on screen.
   */
  function hasNoBox(el) {
    var r = rectOf(el);
    if (!r || r.width !== 0 || r.height !== 0) return false;
    var cs = computed(el);
    return !(cs && cs.display === 'contents');
  }

  function elementChildren(el) {
    var kids = el.children;
    if (kids && typeof kids.length === 'number') return kids;
    var out = [];
    var nodes = el.childNodes || [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 1) out.push(nodes[i]);
    }
    return out;
  }

  function hasBlockChild(el) {
    var kids = elementChildren(el);
    for (var i = 0; i < kids.length; i++) {
      if (BLOCK[tagOf(kids[i])]) return true;
    }
    return false;
  }

  function describeError(err) {
    var message = '';
    try {
      message = err && err.message ? String(err.message) : String(err);
    } catch (e) {
      message = 'unknown error';
    }
    if (!message) message = 'unknown error';
    return 'Page extraction failed: ' + message;
  }

  /* ---------------- inline text ---------------- */

  function meaningfulLinkText(text) {
    if (!text || text.length < 2) return false;
    // A link wrapping a whole paragraph is a card, not a destination.
    if (text.length > 200) return false;
    return !BAD_LINK_TEXT.test(text);
  }

  /**
   * The resolved destination of an anchor, or '' when it is not somewhere the
   * agent can go. The href property is already absolute in a browser; the raw
   * attribute is checked first for in-page anchors, which resolve to a full URL
   * with a hash.
   */
  function linkHref(anchor) {
    var raw = collapse(attrOr(anchor, 'href'));
    if (!raw) return '';
    if (raw.charAt(0) === '#') return '';
    if (/^(javascript|data|vbscript|mailto|tel|sms):/i.test(raw)) return '';
    var resolved = '';
    try {
      if (anchor.href) resolved = String(anchor.href);
    } catch (e) {
      resolved = '';
    }
    if (!resolved) resolved = raw;
    if (resolved.length > 500) resolved = resolved.slice(0, 500);
    return resolved;
  }

  function inlineText(node, depth, plain) {
    // A guard against a pathological tree, not a practical limit: each level of
    // markup costs two of these, so 80 leaves room for 40 nested spans, which is
    // more than generated markup produces. (A DOM tree cannot cycle, so this can
    // only be reached by a genuinely absurd page.)
    if (!node || depth > 80) return '';
    if (node.nodeType === 3) {
      var raw = node.nodeValue;
      if (!raw) return '';
      // Text nodes carry the source indentation; fold it to single spaces here so
      // the line breaks that survive later are only the ones <br> put there.
      return String(raw).replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    var tag = tagOf(node);
    if (STRIP[tag]) return '';
    if (tag === 'BR') return '\n';
    if (isHidden(node)) return '';

    if (tag === 'A') {
      var label = collapse(inlineChildrenText(node, depth + 1, plain));
      if (!label) return '';
      var href = linkHref(node);
      if (!plain && href && meaningfulLinkText(label)) return '[' + label + '](' + href + ')';
      return label;
    }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      var code = collapse(inlineChildrenText(node, depth + 1, plain));
      if (!code) return '';
      if (plain || code.indexOf(TICK) !== -1) return code;
      return TICK + code + TICK;
    }
    // Images carry no text worth a line of their own; alt text without the image
    // is usually a caption fragment, and it showed up as noise in practice.
    if (tag === 'IMG') return '';
    return inlineChildrenText(node, depth + 1, plain);
  }

  function inlineChildrenText(el, depth, plain) {
    var out = '';
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      var piece = inlineText(child, depth + 1, plain);
      if (!piece) continue;
      // Block children flattened into a single line would run words together
      // ('a' from one paragraph directly into 'b' from the next).
      if (child.nodeType === 1 && BLOCK[tagOf(child)] && out && out.charAt(out.length - 1) !== '\n') {
        out += '\n';
      }
      out += piece;
    }
    return out;
  }

  /* ---------------- block output ---------------- */

  /**
   * One block == one paragraph. Blocks are joined with exactly one blank line,
   * which is how 'never emit more than one blank line in a row' is guaranteed
   * structurally rather than by a cleanup pass.
   */
  function cleanBlock(text) {
    if (text === null || text === undefined) return '';
    var t = String(text).replace(/\r\n?/g, '\n');
    t = t.replace(/[ \t\f\v]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\n+/g, '\n');
    t = t.replace(/^[ \n]+|[ \n]+$/g, '');
    return t;
  }

  function blockLength(block) {
    if (block.kind === 'list') return block.lines.join('\n').length;
    return block.text.length;
  }

  function push(block) {
    if (overBudget) return;
    var length = blockLength(block);
    if (emitted + length > HARD_STOP) {
      overBudget = true;
      return;
    }
    emitted += length;
    blocks.push(block);
  }

  function emitText(text) {
    var t = cleanBlock(text);
    if (!t) return;
    if (t.length > MAX_BLOCK) t = t.slice(0, MAX_BLOCK) + ' [...]';
    push({ kind: 'text', text: t });
  }

  function emitListItem(text, depth) {
    var d = depth < 0 ? 0 : depth > MAX_LIST_DEPTH ? MAX_LIST_DEPTH : depth;
    var line = spaces(d * 2) + '- ' + text;
    var last = blocks.length ? blocks[blocks.length - 1] : null;
    // Consecutive items belong to one block so a list does not get a blank line
    // between every bullet.
    if (last && last.kind === 'list' && !overBudget) {
      if (emitted + line.length > HARD_STOP) {
        overBudget = true;
        return;
      }
      last.lines.push(line);
      emitted += line.length;
      return;
    }
    push({ kind: 'list', lines: [line] });
  }

  function emitHeading(level, el) {
    var text = cleanBlock(inlineText(el, 0, true));
    if (!text) return;
    if (text.length > 300) text = text.slice(0, 300);
    if (headings.length < MAX_HEADINGS) headings.push({ level: level, text: text });
    push({ kind: 'text', text: hashes(level) + ' ' + text });
  }

  function rawText(el) {
    var t = '';
    try {
      t = el.textContent === null || el.textContent === undefined ? '' : String(el.textContent);
    } catch (e) {
      t = '';
    }
    return t.replace(/\r\n?/g, '\n').replace(/^[ \t]*\n+/, '').replace(/\n+[ \t]*$/, '');
  }

  function emitCode(text) {
    var code = text;
    if (!code) return;
    if (code.length > MAX_CODE) code = code.slice(0, MAX_CODE) + '\n[... code truncated]';
    var fence = TICK + TICK + TICK;
    if (code.indexOf(fence) !== -1) fence = TICK + TICK + TICK + TICK;
    push({ kind: 'raw', text: fence + '\n' + code + '\n' + fence });
  }

  function emitQuote(el) {
    var text = cleanBlock(inlineText(el, 0, false));
    if (!text) return;
    var lines = text.split('\n');
    var quoted = [];
    for (var i = 0; i < lines.length; i++) quoted.push('> ' + lines[i]);
    emitText(quoted.join('\n'));
  }

  function cellText(cell) {
    var t = collapse(inlineText(cell, 0, false)).replace(/\|/g, '\\|');
    if (t.length > 200) t = t.slice(0, 200) + '...';
    return t;
  }

  /**
   * Pipe-delimited rows. A markdown table is the one table shape a model reads
   * well, and the caps keep a 400-row price list from eating the whole budget.
   */
  function emitTable(table) {
    var rows = [];
    try {
      rows = table.querySelectorAll ? table.querySelectorAll('tr') : [];
    } catch (e) {
      rows = [];
    }
    if (!rows.length) return;

    var lines = [];
    var shown = 0;
    var maxCols = 0;
    var columnsCut = false;
    for (var i = 0; i < rows.length && shown < TABLE_ROWS; i++) {
      var cells = elementChildren(rows[i]);
      var values = [];
      var allValues = [];
      var headerRow = shown === 0;
      var hasHeaderCell = false;
      for (var c = 0; c < cells.length; c++) {
        var ctag = tagOf(cells[c]);
        if (ctag !== 'TD' && ctag !== 'TH') continue;
        if (ctag === 'TH') hasHeaderCell = true;
        allValues.push(ctag);
        if (values.length < TABLE_COLS) values.push(cellText(cells[c]));
      }
      if (!values.length) continue;
      if (allValues.length > maxCols) maxCols = allValues.length;
      if (allValues.length > values.length) columnsCut = true;
      lines.push('| ' + values.join(' | ') + ' |');
      if (headerRow && hasHeaderCell) {
        var seps = [];
        for (var s = 0; s < values.length; s++) seps.push('---');
        lines.push('| ' + seps.join(' | ') + ' |');
      }
      shown++;
    }
    if (!lines.length) return;

    if (columnsCut) lines.push('(' + TABLE_COLS + ' of ' + maxCols + ' columns shown)');
    if (rows.length > shown) lines.push('(' + shown + ' of ' + rows.length + ' rows shown)');
    emitText(lines.join('\n'));
  }

  function countHeadings(el) {
    var n = 0;
    try {
      if (el.querySelectorAll) n = el.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
    } catch (e) {
      n = 0;
    }
    return n;
  }

  /**
   * A nav, header or footer is chrome, not content. Summarising it as one line
   * keeps the site's destinations visible while stopping the twelve-link link
   * farm from becoming the page.
   */
  function emitChromeSummary(el, label) {
    var anchors = [];
    try {
      anchors = el.querySelectorAll ? el.querySelectorAll('a') : [];
    } catch (e) {
      anchors = [];
    }
    var names = [];
    for (var i = 0; i < anchors.length && names.length < 6; i++) {
      var text = collapse(anchors[i].textContent);
      if (!text || text.length > 40) continue;
      if (names.indexOf(text) !== -1) continue;
      names.push(text);
    }
    // One link is not a link farm, and a footer holding only a copyright line has
    // nothing the model needs.
    if (names.length < 2) return;
    var line = label + ': ' + names.join(' / ');
    if (anchors.length > names.length) line += ' ...';
    if (line.length > 200) line = line.slice(0, 200) + '...';
    emitText(line);
  }

  /* ---------------- the walk ---------------- */

  function flushInline(text) {
    var t = cleanBlock(text);
    if (t) emitText(t);
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== 1 || overBudget) return;
    var tag = tagOf(el);
    if (STRIP[tag]) return;
    if (isHidden(el)) return;

    var role = collapse(attrOr(el, 'role')).toLowerCase();

    if (tag === 'H1') return emitHeading(1, el);
    if (tag === 'H2') return emitHeading(2, el);
    if (tag === 'H3') return emitHeading(3, el);
    if (tag === 'H4') return emitHeading(4, el);
    if (tag === 'H5') return emitHeading(5, el);
    if (tag === 'H6') return emitHeading(6, el);

    if (tag === 'PRE') {
      if (hasNoBox(el)) return;
      return emitCode(rawText(el));
    }
    if (tag === 'TABLE') return emitTable(el);
    if (tag === 'BLOCKQUOTE') return emitQuote(el);

    if (tag === 'UL' || tag === 'OL' || tag === 'DL') return walkChildren(el, depth);
    if (tag === 'LI') return emitListItemBlock(el, depth);

    if (tag === 'P' || tag === 'DD' || tag === 'DT' || tag === 'SUMMARY' ||
        tag === 'FIGCAPTION' || tag === 'CAPTION' || tag === 'ADDRESS') {
      if (hasNoBox(el)) return;
      return flushInline(inlineText(el, 0, false));
    }

    if (tag === 'NAV' || role === 'navigation') return emitChromeSummary(el, 'Navigation');
    if (tag === 'FOOTER' || role === 'contentinfo') return emitChromeSummary(el, 'Footer links');
    if (tag === 'HEADER' || role === 'banner') {
      // A header wrapping the article title is content, not chrome.
      if (countHeadings(el) === 0) return emitChromeSummary(el, 'Header links');
    }

    if (tag === 'HR') return;
    // A container with no box of its own (a collapsed wrapper) has nothing on
    // screen, and walking it would invent content the user cannot see.
    if (hasNoBox(el)) return;
    return walkChildren(el, depth);
  }

  function emitListItemBlock(el, depth) {
    if (isHidden(el)) return;
    var own = '';
    var rest = [];
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 1) {
        var ctag = tagOf(child);
        if (STRIP[ctag]) continue;
        if (ctag === 'UL' || ctag === 'OL' || BLOCK[ctag] || hasBlockChild(child)) {
          rest.push(child);
          // Whatever text follows this block still belongs to the item, but it
          // must not be glued onto the text before it ('Two' + 'Tail').
          own += ' ';
          continue;
        }
      }
      own += inlineText(child, 0, false);
    }
    var text = cleanBlock(own);
    if (text) emitListItem(text, depth);
    // Nested lists and paragraphs inside the item are walked at the next depth so
    // their bullets come out indented under this one.
    for (var j = 0; j < rest.length; j++) walk(rest[j], depth + 1);
  }

  function walkChildren(el, depth) {
    var kids = el.childNodes || [];
    var inline = '';
    for (var i = 0; i < kids.length; i++) {
      if (overBudget) break;
      var child = kids[i];
      if (child.nodeType === 3) {
        inline += inlineText(child, 0, false);
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = tagOf(child);
      if (STRIP[tag] || isHidden(child)) continue;
      if (BLOCK[tag] || hasBlockChild(child)) {
        flushInline(inline);
        inline = '';
        walk(child, depth);
        continue;
      }
      inline += inlineText(child, 0, false);
    }
    flushInline(inline);
  }

  /* ---------------- links and inputs ---------------- */

  function collectLinks() {
    var anchors = [];
    try {
      anchors = document.querySelectorAll ? document.querySelectorAll('a[href]') : [];
    } catch (e) {
      anchors = [];
    }
    var out = [];
    var seen = {};
    for (var i = 0; i < anchors.length && out.length < MAX_LINKS; i++) {
      var anchor = anchors[i];
      if (isHidden(anchor)) continue;
      var href = linkHref(anchor);
      if (!href) continue;
      if (seen[href]) continue;
      var label = collapse(inlineText(anchor, 0, true));
      if (!label) label = collapse(attrOr(anchor, 'title')) || collapse(attrOr(anchor, 'aria-label'));
      if (!label) continue;
      if (label.length > 200) label = label.slice(0, 200);
      seen[href] = 1;
      out.push({ text: label, href: href, internal: isInternal(href) });
    }
    return out;
  }

  function labelOf(el) {
    var aria = collapse(attrOr(el, 'aria-label'));
    if (aria) return aria.slice(0, 120);
    try {
      var labels = el.labels;
      if (labels && labels.length) {
        var fromLabel = collapse(labels[0].textContent);
        if (fromLabel) return fromLabel.slice(0, 120);
      }
    } catch (e) {
      /* older DOM or a shim */
    }
    var parent = el.parentNode;
    var hops = 0;
    while (parent && hops < 4) {
      if (tagOf(parent) === 'LABEL') {
        var wrapped = collapse(parent.textContent);
        if (wrapped) return wrapped.slice(0, 120);
        break;
      }
      parent = parent.parentNode;
      hops++;
    }
    return collapse(attrOr(el, 'title')).slice(0, 120);
  }

  function collectInputs() {
    var nodes = [];
    try {
      nodes = document.querySelectorAll ? document.querySelectorAll('input, textarea, select') : [];
    } catch (e) {
      nodes = [];
    }
    var out = [];
    for (var i = 0; i < nodes.length && out.length < MAX_INPUTS; i++) {
      var el = nodes[i];
      var tag = tagOf(el);
      var kind = tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : collapse(attrOr(el, 'type')).toLowerCase();
      if (!kind) kind = 'text';
      if (tag === 'INPUT') {
        // Not fillable: hidden fields, buttons, and file inputs (which cannot be
        // driven by typing or by a value).
        if (kind === 'hidden' || kind === 'submit' || kind === 'button' || kind === 'reset' ||
            kind === 'image' || kind === 'file') continue;
      }
      if (isHidden(el)) continue;
      var item = {
        kind: kind,
        name: attrOr(el, 'name') || attrOr(el, 'id'),
        placeholder: attrOr(el, 'placeholder'),
        label: labelOf(el)
      };
      // A password or file field's value is never reported, even if it is there.
      if (kind !== 'password' && kind !== 'file') {
        var value = '';
        try {
          value = el.value === null || el.value === undefined ? '' : String(el.value);
        } catch (e) {
          value = '';
        }
        value = collapse(value);
        if (value && value.length <= 200) item.value = value;
      }
      out.push(item);
    }
    return out;
  }

  /* ---------------- choosing what to read ---------------- */

  function cheapHidden(el) {
    if (attr(el, 'hidden') !== null) return true;
    var aria = attr(el, 'aria-hidden');
    return aria !== null && collapse(aria).toLowerCase() === 'true';
  }

  /**
   * Character count of the readable text under an element, with a node budget so
   * a pathological page cannot stall the tool call. Hidden *styling* is not
   * resolved here (too expensive for a comparison); hidden attributes are.
   */
  function measureText(root) {
    var total = 0;
    var budget = { nodes: 20000, chars: 400000 };
    function visit(el, depth) {
      if (!el || depth > 400 || total >= budget.chars || budget.nodes <= 0) return;
      var nodes = el.childNodes || [];
      for (var i = 0; i < nodes.length; i++) {
        if (total >= budget.chars || budget.nodes <= 0) return;
        budget.nodes--;
        var node = nodes[i];
        if (node.nodeType === 3) {
          if (node.nodeValue) total += String(node.nodeValue).length;
          continue;
        }
        if (node.nodeType !== 1) continue;
        if (STRIP[tagOf(node)] || cheapHidden(node)) continue;
        visit(node, depth + 1);
      }
    }
    visit(root, 0);
    return total;
  }

  /**
   * Prefer the main content region, but only when it really is most of the page.
   * A main element holding a two-word "loading..." placeholder while the rest of
   * the document holds the article is worse than reading the body.
   */
  function chooseRegion(body) {
    var bodyLength = measureText(body);
    var candidates = [];
    try {
      candidates = document.querySelectorAll
        ? document.querySelectorAll('main, [role="main"], article, #content, .content')
        : [];
    } catch (e) {
      candidates = [];
    }
    var best = null;
    var bestLength = 0;
    var count = candidates.length < 12 ? candidates.length : 12;
    for (var i = 0; i < count; i++) {
      var length = measureText(candidates[i]);
      if (length > bestLength) {
        bestLength = length;
        best = candidates[i];
      }
    }
    if (!best) return body;
    if (bestLength < 200) return body;
    if (bodyLength > 0 && bestLength < bodyLength * 0.2) return body;
    return best;
  }

  /* ---------------- assembly ---------------- */

  /**
   * A short block repeated four or more times is chrome ('Read more', a newsletter
   * prompt, a price), not content. The first two are kept so a repeated heading in
   * a real list still reads correctly.
   */
  function dropRepeats(list) {
    var counts = {};
    var i;
    for (i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.kind !== 'text') continue;
      if (b.text.length > 160 || b.text.indexOf('\n') !== -1) continue;
      counts[b.text] = (counts[b.text] || 0) + 1;
    }
    var kept = {};
    var out = [];
    for (i = 0; i < list.length; i++) {
      var block = list[i];
      if (block.kind === 'text' && counts[block.text] >= 4) {
        kept[block.text] = (kept[block.text] || 0) + 1;
        if (kept[block.text] > 2) continue;
      }
      out.push(block);
    }
    return out;
  }

  function joinBlocks(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var block = list[i];
      var text = block.kind === 'list' ? block.lines.join('\n') : block.text;
      // Only prose is re-cleaned here. A list line's leading spaces are the
      // indentation that says which list the bullet belongs to, and a code block
      // is verbatim by definition.
      if (block.kind === 'text') text = cleanBlock(text);
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  /**
   * Cut at a block boundary when one is close to the cap, then a line, then a
   * word. The marker is inside the budget, so the returned text never exceeds
   * maxChars.
   *
   * The cut happens on an already-decoded JavaScript string, so it can never
   * split a UTF-8 sequence: a surrogate pair could only be split by slicing
   * between its two code units, and that is a display artefact, not the
   * mojibake a byte-level cut produces. Nothing here touches bytes.
   */
  function cutText(text, max) {
    var marker = '\n\n[Content truncated at ' + max + ' characters]';
    // A notice must not eat the budget it is describing: at a 100-character cap
    // the long marker would be more than a third of the answer.
    if (marker.length > max / 4) marker = ' [...]';
    var room = max - marker.length;
    if (room < 8) return text.slice(0, max);
    var head = text.slice(0, room);
    var boundary = head.lastIndexOf('\n\n');
    if (boundary < room * 0.6) boundary = head.lastIndexOf('\n');
    if (boundary < room * 0.6) boundary = head.lastIndexOf(' ');
    if (boundary < room * 0.5) boundary = head.length;
    return head.slice(0, boundary).replace(/\s+$/, '') + marker;
  }

  function build() {
    var url = pageUrl();
    var title = '';
    try {
      title = collapse(document.title);
    } catch (e) {
      title = '';
    }
    if (title.length > 300) title = title.slice(0, 300);

    // Only the document access is guarded here. The walk itself is left to the
    // outer catch: swallowing a failure half way through would return a page that
    // silently lost its content, which is worse than a reported error.
    var body = null;
    try {
      body = document.body || document.documentElement || null;
    } catch (e) {
      body = null;
    }
    if (body) walk(chooseRegion(body), 0);

    var text = joinBlocks(dropRepeats(blocks));
    var truncated = false;
    if (text.length > MAX_CHARS) {
      text = cutText(text, MAX_CHARS);
      truncated = true;
    }

    if (!title && headings.length) title = headings[0].text;

    return {
      title: title,
      url: url,
      text: text,
      headings: headings,
      links: collectLinks(),
      inputs: collectInputs(),
      truncated: truncated,
      charCount: text.length
    };
  }

  try {
    return build();
  } catch (err) {
    return { __klaudError: describeError(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Injected script: locating an element to click or type into
 * ------------------------------------------------------------------ */

/**
 * Runs inside the page and reports candidate elements for a click or a keystroke.
 *
 * **This reads the DOM and never writes to it.** The alternative — tagging
 * elements with a data-klaud-idx attribute so a later command can find them
 * again — would mutate the page the agent is inspecting, trigger the site's own
 * MutationObservers, and make the id valid only until the next render. Instead a
 * match carries its viewport rect, and the caller dispatches a real input event
 * at the centre of that rect. The index field is reported for the session layer
 * to use in messages ("clicked match 3 of 4"), not as a lookup key: the caller
 * must run a fresh query before each click, because any query result goes stale
 * as soon as the page re-renders.
 */
function pageQuery(spec) {
  var req = spec || {};
  var LIMIT = num(req.limit, 10);

  var STRIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    HEAD: 1, META: 1, LINK: 1, TITLE: 1, OBJECT: 1, EMBED: 1
  };

  var TEXTY = {
    text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1,
    date: 1, 'datetime-local': 1, month: 1, week: 1, time: 1
  };

  function num(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  function tagOf(el) {
    return String(el.tagName || '').toUpperCase();
  }

  function attr(el, name) {
    try {
      var v = el.getAttribute(name);
      return v === null || v === undefined ? null : String(v);
    } catch (e) {
      return null;
    }
  }

  function attrOr(el, name) {
    var v = attr(el, name);
    return v === null ? '' : v;
  }

  function collapse(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function computed(el) {
    try {
      if (typeof getComputedStyle === 'function') return getComputedStyle(el) || null;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function isHidden(el) {
    if (!el) return true;
    if (el.hidden === true) return true;
    var aria = attr(el, 'aria-hidden');
    if (aria !== null && collapse(aria).toLowerCase() === 'true') return true;
    if (attr(el, 'hidden') !== null) return true;
    var cs = computed(el);
    if (!cs) return false;
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    var opacity = cs.opacity;
    if (opacity !== undefined && opacity !== null && opacity !== '' && Number(opacity) === 0) return true;
    return false;
  }

  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return null;
      var x = Math.round(Number(r.left));
      var y = Math.round(Number(r.top));
      var w = Math.round(Number(r.width));
      var h = Math.round(Number(r.height));
      if (!isFinite(x)) x = 0;
      if (!isFinite(y)) y = 0;
      if (!isFinite(w)) w = 0;
      if (!isFinite(h)) h = 0;
      return { x: x, y: y, width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  /** Rendering but not clickable: nothing to hit. */
  function visibleBox(el) {
    if (isHidden(el)) return false;
    var r = rectOf(el);
    if (!r) return true;
    if (r.width > 0 && r.height > 0) return true;
    var cs = computed(el);
    return !!(cs && cs.display === 'contents');
  }

  function ownText(el) {
    var out = '';
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) out += kids[i].nodeValue || '';
    }
    return collapse(out);
  }

  function textOf(el) {
    var t = '';
    try {
      t = el.textContent;
    } catch (e) {
      t = '';
    }
    return collapse(t);
  }

  function containsNode(ancestor, node) {
    var parent = node.parentNode;
    var hops = 0;
    while (parent && hops < 400) {
      if (parent === ancestor) return true;
      parent = parent.parentNode;
      hops++;
    }
    return false;
  }

  function classesOf(el) {
    var raw = collapse(attrOr(el, 'class'));
    if (!raw) return [];
    var parts = raw.split(' ');
    var out = [];
    for (var i = 0; i < parts.length && out.length < 8; i++) {
      if (parts[i]) out.push(parts[i]);
    }
    return out;
  }

  /** Can this element take typed input, a pasted value, or a selection? */
  function isEditable(el) {
    var tag = tagOf(el);
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXTY[collapse(attrOr(el, 'type')).toLowerCase() || 'text'] === 1;
    var ce = false;
    try {
      ce = el.isContentEditable === true;
    } catch (e) {
      ce = false;
    }
    if (ce) return true;
    return attr(el, 'contenteditable') !== null;
  }

  function bySelector(selector) {
    var nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (e) {
      throw new Error('Invalid CSS selector: ' + selector);
    }
    var out = [];
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
    return out;
  }

  /**
   * The most specific match: an element whose *own* text (its direct text nodes)
   * contains the needle, not merely one with a matching descendant. Without this,
   * a search for "Save" returns the body element on any page containing the word.
   *
   * When no element owns the text (it is split across inline children), fall back
   * to the innermost elements whose full text matches.
   */
  function byText(needle) {
    var lower = needle.toLowerCase();
    var all = [];
    try {
      all = document.querySelectorAll ? document.querySelectorAll('*') : [];
    } catch (e) {
      all = [];
    }
    var own = [];
    var loose = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (STRIP[tagOf(el)]) continue;
      if (isHidden(el)) continue;
      var mine = ownText(el);
      if (mine && mine.toLowerCase().indexOf(lower) !== -1) {
        own.push(el);
        continue;
      }
      var whole = textOf(el);
      if (whole && whole.toLowerCase().indexOf(lower) !== -1) loose.push(el);
    }
    if (own.length) return own;
    var innermost = [];
    for (var j = 0; j < loose.length; j++) {
      var isAncestor = false;
      for (var k = 0; k < loose.length; k++) {
        if (j === k) continue;
        if (containsNode(loose[j], loose[k])) {
          isAncestor = true;
          break;
        }
      }
      if (!isAncestor) innermost.push(loose[j]);
    }
    return innermost;
  }

  /**
   * Last resort: find a control by what it says about itself rather than by text
   * inside it. A search box has no visible text of its own, so its placeholder is
   * the only name it has, and "type into the search box" is the most common
   * request the browser tool gets.
   */
  function byLabel(needle) {
    var lower = needle.toLowerCase();
    var nodes = [];
    try {
      nodes = document.querySelectorAll
        ? document.querySelectorAll('input, textarea, select, [aria-label], [placeholder], [title], [alt]')
        : [];
    } catch (e) {
      nodes = [];
    }
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isHidden(el)) continue;
      var candidates = [
        attrOr(el, 'placeholder'), attrOr(el, 'aria-label'), attrOr(el, 'title'),
        attrOr(el, 'alt'), attrOr(el, 'value')
      ];
      for (var c = 0; c < candidates.length; c++) {
        var value = collapse(candidates[c]).toLowerCase();
        if (value && value.indexOf(lower) !== -1) {
          out.push(el);
          break;
        }
      }
    }
    return out;
  }

  try {
    var selector = typeof req.selector === 'string' ? collapse(req.selector) : '';
    var text = typeof req.text === 'string' ? collapse(req.text) : '';
    if (!selector && !text) {
      return { __klaudError: 'A query needs either a selector or some visible text.' };
    }

    var found = selector ? bySelector(selector) : byText(text);
    if (!selector && text && !found.length) found = byLabel(text);
    if (selector && text) {
      // Both given: narrow the selector's matches to the ones showing the text.
      var lower = text.toLowerCase();
      var narrowed = [];
      for (var i = 0; i < found.length; i++) {
        if (textOf(found[i]).toLowerCase().indexOf(lower) !== -1) narrowed.push(found[i]);
      }
      found = narrowed;
    }

    var matches = [];
    for (var m = 0; m < found.length && matches.length < LIMIT; m++) {
      var el = found[m];
      var visible = visibleBox(el);
      if (!visible) continue;
      matches.push({
        index: matches.length,
        tag: tagOf(el).toLowerCase(),
        text: textOf(el).slice(0, 120),
        id: attrOr(el, 'id'),
        classes: classesOf(el),
        // Viewport coordinates. An element below the fold has a large y: the
        // caller must scroll it into view before dispatching a click there.
        rect: rectOf(el) || { x: 0, y: 0, width: 0, height: 0 },
        visible: visible,
        editable: isEditable(el)
      });
    }
    return { matches: matches };
  } catch (err) {
    var message = '';
    try {
      message = err && err.message ? String(err.message) : String(err);
    } catch (e) {
      message = 'unknown error';
    }
    return { __klaudError: 'Page query failed: ' + (message || 'unknown error') };
  }
}

/* ------------------------------------------------------------------ *
 * Node-side wrappers
 * ------------------------------------------------------------------ */

/** A positive integer, or the fallback. Keeps JSON.stringify from emitting junk. */
function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const whole = Math.floor(n);
  return max && whole > max ? max : whole;
}

/**
 * Serialise a value into the position of a JS expression argument.
 *
 * JSON is a subset of JS, so this is safe — with one exception worth handling:
 * a caller-supplied string may contain a backtick or the two characters `${`,
 * and the returned script is allowed to be embedded in a template literal. Both
 * are rewritten as `\uXXXX` escapes, which mean the same thing to JS and to
 * JSON.parse but cannot break an enclosing template literal.
 */
function safeJson(value) {
  return JSON.stringify(value)
    .split('`')
    .join('\\u0060')
    .split('${')
    .join('\\u0024{');
}

/**
 * The script that turns the current page into text.
 *
 * `options` is passed straight to the page: `maxChars`, `maxLinks`, `maxInputs`,
 * `maxHeadings`, `tableRows`, `tableCols`. Values are coerced to numbers here, so
 * nothing a caller passes can escape into the source as code.
 *
 * The returned string is a single expression, suitable for
 * `Runtime.evaluate({ expression, returnByValue: true })`.
 */
function extractionScript(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const argv = {
    maxChars: positiveInt(opts.maxChars, DEFAULT_MAX_CHARS),
    maxLinks: positiveInt(opts.maxLinks, DEFAULT_MAX_LINKS),
    maxInputs: positiveInt(opts.maxInputs, DEFAULT_MAX_INPUTS),
    maxHeadings: positiveInt(opts.maxHeadings, DEFAULT_MAX_HEADINGS),
    tableRows: positiveInt(opts.tableRows, DEFAULT_TABLE_ROWS, 500),
    tableCols: positiveInt(opts.tableCols, DEFAULT_TABLE_COLS, 40),
  };
  return '(' + pageExtract.toString() + ')(' + safeJson(argv) + ')';
}

/**
 * The script that finds elements to click or type into.
 *
 * `spec` is `{ text?, selector?, limit? }`. The reply holds `matches`, each
 * `{ index, tag, text, id, classes, rect, visible, editable }`:
 *
 *   - `classes` is an array of class names (at most 8).
 *   - `rect` is **viewport** coordinates from `getBoundingClientRect`, which is
 *     what `Input.dispatchMouseEvent` needs. An element below the fold has a
 *     large `y`, so the caller must scroll it into view before dispatching a
 *     click at the centre of the rect.
 *   - `index` is a position in this reply, not a handle: a query goes stale as
 *     soon as the page re-renders, so run a fresh query before every click
 *     rather than remembering an index.
 *   - `editable` means the element accepts input: a text-like input, a textarea,
 *     a select, or a contenteditable region.
 */
function queryScript(spec = {}) {
  const raw = spec && typeof spec === 'object' ? spec : {};
  // Long enough for any real selector or label, short enough that a runaway
  // caller cannot push a megabyte of source through the debug pipe.
  const argv = {
    text: typeof raw.text === 'string' ? raw.text.slice(0, 300) : '',
    selector: typeof raw.selector === 'string' ? raw.selector.slice(0, 500) : '',
    limit: positiveInt(raw.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT),
  };
  return '(' + pageQuery.toString() + ')(' + safeJson(argv) + ')';
}

function clip(value, max = 200) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > max ? text.slice(0, max) + '...' : text;
}

/**
 * Pull the value out of a `Runtime.evaluate` reply, or explain why there is none.
 *
 * Every failure mode is distinct on purpose: "the page threw" and "the reply was
 * not JSON" need different fixes, and the caller has to show one of them to a
 * user.
 */
function unwrapValue(cdpResult) {
  if (cdpResult === undefined || cdpResult === null) {
    return { ok: false, error: 'The browser returned no result for the script (an empty CDP reply).' };
  }
  if (typeof cdpResult !== 'object') {
    return { ok: false, error: `The browser returned ${typeof cdpResult} instead of a CDP result object.` };
  }
  // A caller passing the page value instead of the CDP envelope is a bug, but it
  // should still fail with a readable message rather than "not page content".
  if (typeof cdpResult.__klaudError === 'string') {
    return { ok: false, error: cdpResult.__klaudError };
  }

  const exception = cdpResult.exceptionDetails;
  if (exception) {
    const detail =
      (exception.exception && (exception.exception.description || exception.exception.value)) ||
      exception.text ||
      'unknown error';
    const where = exception.lineNumber !== undefined ? ` (line ${exception.lineNumber})` : '';
    return { ok: false, error: `The script threw inside the page${where}: ${clip(detail, 300)}` };
  }

  const result = cdpResult.result;
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'The CDP reply had no result object, so there is no page to read.' };
  }
  if (result.type === 'undefined') {
    return { ok: false, error: 'The script evaluated to undefined in the page.' };
  }
  if (result.subtype === 'error') {
    return {
      ok: false,
      error: `The script failed inside the page: ${clip(result.description || result.className || 'error', 300)}`,
    };
  }

  let value = result.value;
  if (result.unserializableValue !== undefined && value === undefined) {
    return { ok: false, error: `The script returned ${result.unserializableValue}, which cannot be read as page content.` };
  }
  if (typeof value === 'string') {
    // returnByValue:false, or a caller that JSON.stringify'd in the page.
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: `The script returned text that is not JSON: ${clip(value)}` };
    }
  }
  if (value === undefined) {
    // `session.readPage` passes `{ result: { value } }` with no `type`, so this
    // branch has to read correctly without it: an object-typed result with no
    // value means CDP could not serialise it, and anything else means the script
    // returned nothing at all.
    const type = result.type || 'unknown';
    return {
      ok: false,
      error:
        `The script returned no value (CDP type "${type}").` +
        ' An object with no value is either not JSON-serialisable or the call did not set returnByValue: true.',
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.__klaudError === 'string') {
    return { ok: false, error: value.__klaudError };
  }
  return { ok: true, value };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizePage(value) {
  const headings = [];
  for (const heading of asArray(value.headings)) {
    if (!heading || typeof heading !== 'object') continue;
    const level = Math.min(6, Math.max(1, positiveInt(heading.level, 1)));
    const text = asString(heading.text, 300).trim();
    if (text) headings.push({ level, text });
  }

  const links = [];
  for (const link of asArray(value.links)) {
    if (!link || typeof link !== 'object') continue;
    const href = asString(link.href, 2000);
    if (!href) continue;
    links.push({ text: asString(link.text, 300).trim(), href, internal: link.internal === true });
  }

  const inputs = [];
  for (const input of asArray(value.inputs)) {
    if (!input || typeof input !== 'object') continue;
    const kind = asString(input.kind, 40).toLowerCase() || 'text';
    const field = {
      kind,
      name: asString(input.name, 200),
      placeholder: asString(input.placeholder, 200),
      label: asString(input.label, 200),
    };
    if (typeof input.value === 'string' && input.value) field.value = asString(input.value, 200);
    inputs.push(field);
  }

  const text = asString(value.text, Number.MAX_SAFE_INTEGER);
  return {
    title: asString(value.title, 300).trim(),
    url: asString(value.url, 4000),
    text,
    headings: headings.slice(0, 100),
    links: links.slice(0, 200),
    inputs: inputs.slice(0, 100),
    truncated: value.truncated === true,
    // Derived, never trusted: it has to agree with `text`, and a page that got
    // its own arithmetic wrong should not be able to make them disagree.
    charCount: text.length,
  };
}

function looksLikePage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.text === 'string' || typeof value.url === 'string' || typeof value.title === 'string';
}

/**
 * Turn a `Runtime.evaluate` reply into `{ ok: true, page }` or
 * `{ ok: false, error }`.
 *
 * The page object is
 * `{ title, url, text, headings: [{ level, text }], links: [{ text, href, internal }],
 *    inputs: [{ kind, name, placeholder, label, value? }], truncated, charCount }`.
 *
 * Never throws: a malformed reply is a tool result the model can read and react
 * to, not an exception that kills the turn.
 */
function parseExtraction(cdpResult) {
  try {
    const unwrapped = unwrapValue(cdpResult);
    if (!unwrapped.ok) return { ok: false, error: unwrapped.error };
    if (!looksLikePage(unwrapped.value)) {
      return { ok: false, error: `The script returned something that is not page content: ${clip(JSON.stringify(unwrapped.value))}` };
    }
    return { ok: true, page: normalizePage(unwrapped.value) };
  } catch (err) {
    return { ok: false, error: `Could not read the extraction result: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Turn a `Runtime.evaluate` reply for `queryScript` into
 * `{ ok: true, matches }` or `{ ok: false, error }`.
 *
 * An empty match list is a valid answer (`ok: true`, `matches: []`) — the caller
 * decides whether "no such element" is an error for its command.
 */
function parseQuery(cdpResult) {
  try {
    const unwrapped = unwrapValue(cdpResult);
    if (!unwrapped.ok) return { ok: false, error: unwrapped.error };
    const value = unwrapped.value;
    // A bare array is accepted too, so a hand-written probe in the page does not
    // have to match the wrapper exactly.
    const raw = Array.isArray(value) ? value : value && Array.isArray(value.matches) ? value.matches : null;
    if (!raw) {
      return {
        ok: false,
        error: `The query returned something that is not a match list: ${clip(JSON.stringify(value))}`,
      };
    }

    const matches = [];
    for (const match of raw) {
      if (!match || typeof match !== 'object') continue;
      const rect = match.rect && typeof match.rect === 'object' ? match.rect : {};
      const classes = asArray(match.classes)
        .map((name) => asString(name, 100))
        .filter(Boolean)
        .slice(0, 8);
      matches.push({
        index: matches.length,
        tag: asString(match.tag, 40).toLowerCase(),
        text: asString(match.text, 300),
        id: asString(match.id, 200),
        classes,
        rect: {
          x: Number(rect.x) || 0,
          y: Number(rect.y) || 0,
          width: Number(rect.width) || 0,
          height: Number(rect.height) || 0,
        },
        visible: match.visible === true,
        editable: match.editable === true,
      });
    }
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: `Could not read the query result: ${err && err.message ? err.message : String(err)}` };
  }
}

module.exports = {
  extractionScript,
  parseExtraction,
  queryScript,
  parseQuery,
};
