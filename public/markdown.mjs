/* ==========================================================================
   Klaud — markdown renderer
   A small, dependency-free renderer for the subset of markdown that models
   actually emit. Everything is escaped before any markup is produced.
   ========================================================================== */

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Placeholder plumbing.
 *
 * Step 1-2 stash structural markup; step 6 restores it. Two rules make the
 * scheme safe and, more subtly, *invisible to the emphasis patterns*:
 *
 *  - A placeholder is minted from `\x02`, which no markdown text contains, and
 *    the surrounding text is not escaped yet, so a model that writes a literal
 *    `<S0>` gets `&lt;S0&gt;` and cannot forge one.
 *  - The escape pass cannot touch `\x02`, so the placeholder is rewritten to
 *    the marker `\x01S0\x01` *after* escaping. Were it left as `<S0>` until
 *    then, the emphasis patterns would see it and the `[^*]` in them would stop
 *    at the `>` — which is why `**\`npm test\`**` and `**[link](url)**` used to
 *    render as literal asterisks.
 */
const SLOT_RE = /\x01S(\d+)\x01/g;

/**
 * Scan a URL starting at `start`, tracking bracket depth so a target may
 * contain parentheses: `.../wiki/Foo_(bar)` is one URL, not a URL that stops at
 * `Foo_(bar`. Stops at whitespace, at a closing bracket that would unbalance
 * the URL, and at `<`/`>` (which become `&lt;`/`&gt;` once escaped, so both
 * spellings are treated as terminators).
 */
function scanUrl(text, start) {
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const ch = text[j];
    if (/\s/.test(ch) || ch === '<' || ch === '>') break;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  return j;
}

/**
 * Read one entity in `text` back into the character it stands for, so a target
 * can be re-escaped exactly once. Without it, an `&` in a model-written URL is
 * escaped to `&amp;` and reaches `href` as `&amp;amp;`, which is a different
 * address from the one the model gave.
 */
function unescapeForAttr(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Inline formatting.
 *
 * Order matters for safety: the only structural markup (links/images) is
 * extracted into placeholders first, then *everything* is HTML-escaped, then
 * the inline span patterns run on text that is already inert. Emitting markup
 * before escaping would let a model (or a compromised endpoint) inject script
 * tags straight into the transcript.
 */
function inline(text) {
  const slots = [];
  const stash = (html) => {
    slots.push(html);
    return `\x02S${slots.length - 1}\x02`;
  };

  const source = String(text);
  let out = source;

  /**
   * Replace a pattern with placeholders, where a match may consume more than
   * it matched.
   *
   * A target may hold balanced brackets, so the link pattern matches only up to
   * `[x](` and the `target)` is walked separately with `scanUrl`. The whole
   * construct — including that closing `)` — has to be replaced by one
   * placeholder: leave the `)` behind and the bare-URL pass stops there and
   * re-links the link's own target, which printed the address twice.
   *
   * `build(pattern-result)` returns `{ placeholder, to }` or `null` to leave the
   * match alone. `to` is an index into the text the pattern ran over, and the
   * string is rebuilt in a single forward sweep, so every offset stays valid.
   */
  const replaceAll = (input, re, build) => {
    let rebuilt = '';
    let cursor = 0;
    for (const m of input.matchAll(re)) {
      if (!m[0] || m.index < cursor) continue;
      const hit = build(m, input);
      if (!hit) continue;
      rebuilt += input.slice(cursor, m.index) + hit.placeholder;
      cursor = hit.to;
    }
    return rebuilt + input.slice(cursor);
  };

  // 1. Code spans — content is opaque.
  out = replaceAll(out, /`([^`\n]+)`/g, (m) => ({
    placeholder: stash(`<code>${escapeHtml(m[1])}</code>`),
    to: m.index + m[0].length,
  }));

  // 2. Links and images, whose targets get attribute-safe escaping. Images
  //    before links, because the link pattern would otherwise match inside
  //    `![alt](src)`, and a `!`-prefixed match is rejected explicitly as well.
  out = replaceAll(out, /!\[([^\]]*)\]\(/g, (m, text) => {
    const start = m.index + m[0].length; // just past the `(`
    const end = scanUrl(text, start);
    if (text[end] !== ')') return null;
    const src = text.slice(start, end);
    if (!/^https?:\/\//i.test(src)) return null;
    return {
      placeholder: stash(`<img src="${escapeHtml(src)}" alt="${escapeHtml(m[1])}" loading="lazy">`),
      to: end + 1,
    };
  });
  out = replaceAll(out, /(!?)\[([^\]]+)\]\(/g, (m, text) => {
    if (m[1]) return null; // already handled as an image
    const start = m.index + m[0].length; // just past the `(`
    const end = scanUrl(text, start);
    if (text[end] !== ')') return null;
    const href = text.slice(start, end);
    if (!/^https?:\/\//i.test(href)) return null;
    return {
      placeholder: stash(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m[2])}</a>`
      ),
      to: end + 1,
    };
  });

  // 3. Now escape what is left, so nothing in the text can become markup.
  out = escapeHtml(out);
  out = out.replace(/\x02S(\d+)\x02/g, (_m, n) => `\x01S${n}\x01`);

  // 4. Bare URLs become links. The run stops before the first space, so
  //    trailing words are never absorbed, and bracket/entity handling is the
  //    same code path as a real link's target — otherwise the label of a link
  //    whose target ends in `)` (`[x](.../Foo_(bar))`) would be re-linked and
  //    the URL would appear twice.
  //
  //    An `&` that the model wrote as part of a URL arrived here as `&amp;`,
  //    which is indistinguishable from a model that wrote `&amp;` itself. So
  //    the address pattern stops at `&` and takes an entity back only when one
  //    is followed by something that could not be the end of a sentence — the
  //    conservative reading, which never keeps a trailing `&amp;` in a label
  //    and never sends `&amp;amp;` as a query value.
  const entityAt = (text, at) => /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/.test(text.slice(at));
  const address = /https?:\/\/(?:&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);(?=\S)|[^\s<>&])+/g;
  out = out.replace(address, (url, offset) => {
    const start = offset;
    const limit = offset + url.length;
    let end = Math.min(scanUrl(out, start), limit);
    for (let amp = out.indexOf('&', start); amp !== -1 && amp < end; amp = out.indexOf('&', amp + 1)) {
      if (!entityAt(out, amp)) end = amp;
    }
    while (end > start && '.,;:!?*&\'"'.includes(out[end - 1])) end--;
    while (end > start && out[end - 1] === ')') {
      const open = out.lastIndexOf('(', end - 1);
      const close = out.lastIndexOf(')', end - 1);
      if (open <= close) end--; // unmatched: the bracket belongs to the prose
      else break;
    }
    if (end <= start) return url;
    // The anchor is stashed, so the emphasis patterns below have an atomic
    // placeholder to work with, and it is neither double-escaped nor asked to
    // hold an `&amp;` that was only an `&` a moment ago.
    return (
      stash(`<a href="${escapeHtml(unescapeForAttr(out.slice(start, end)))}" target="_blank" rel="noopener noreferrer">${out.slice(start, end)}</a>`) +
      out.slice(end, limit)
    );
  });

  // 5. Inline spans, inside any injected `<a>` so emphasis cannot rewrite a
  //    URL into its own markup. `emphasis()` carries the rules.
  out = out
    .split(/(<a\s[^>]*>[\s\S]*?<\/a>)/)
    .map((segment) => (segment.startsWith('<a ') ? segment : emphasis(segment)))
    .join('');

  // 6. Put the structural markup back.
  return out
    .replace(SLOT_RE, (_m, i) => slots[Number(i)])
    .replace(/\x02S(\d+)\x02/g, (_m, i) => slots[Number(i)]);
}

/**
 * A table row's cells, with escaped pipes and escaped backslashes resolved.
 *
 * `\|` is a literal pipe inside a cell and must not split the row; a real `|`
 * still does. `\\` is a literal backslash, so `a\\|b` keeps its backslash and
 * still splits — which is what CommonMark does.
 *
 * A literal pipe is mapped back to `|` in the cell text, not to `&#124;`. Every
 * cell is put through `inline()`, which hashes code spans into placeholders and
 * restores them after escaping — so an entity written here would either be
 * double-escaped in a code span or, in plain text, pass through as the entity
 * the author never wrote.
 */
function splitRow(raw) {
  return raw
    .trim()
    .replace(/\\\\/g, '\x03')
    .replace(/\\\|/g, '\x04')
    .replace(/^\||\|$/g, '')
    .replace(/\x03/g, '\\')
    .split('|')
    .map((c) => c.replace(/\x04/g, '|').trim());
}

/**
 * Columns named by the delimiter row. A row with more cells than columns has
 * the extras dropped; a ragged one is padded with empties, so a short row
 * cannot silently shift the columns beside it.
 */
function normalizeRow(cells, columns) {
  const row = cells.slice(0, columns);
  while (row.length < columns) row.push('');
  return row;
}

function renderTable(header, body) {
  const columns = Math.max(header.length, 1);
  const head = `<thead><tr>${normalizeRow(header, columns)
    .map((c) => `<th>${inline(c)}</th>`)
    .join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body
        .map((row) => `<tr>${normalizeRow(row, columns).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
    : '';
  return `<table>${head}${tbody}</table>`;
}

/**
 * `1.` / `1)` as well as `-`, `*` and `+`, at any indentation.
 *
 * The indent may not be capped: the parser reads nesting from it, and a cap of
 * three spaces meant `- one` / `  - two` / `    - three` lost its third level —
 * the deepest marker stopped being a marker at all. A continuation line needs no
 * allowance here, because it is recognised by *not* starting with a marker.
 */
const LIST_RE = /^( *)([-*+]|\d+[.)])[ \t]+(.*)$/;

/** Render markdown to sanitized HTML. */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const html = [];

  // Block level state.
  let i = 0;
  let paragraph = [];
  let listStack = []; // [{ depth, ordered, start, task, items: [{ text, task, children }] }]
  let inFence = false;
  let fenceChar = '';
  let fenceLang = '';
  let fenceLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };

  /**
   * Render one list: sort its ordered items numerically, and append it either
   * to the previous list item's children (a nested list) or to the document (a
   * top-level one).
   *
   * The list is passed in rather than popped here, because whether it nests
   * depends on what is still on the stack — popping first made every list look
   * top-level, which dropped three levels of nesting out of the document.
   */
  const renderList = (list) => {
    const tag = list.ordered ? 'ol' : 'ul';
    const items = (list.ordered
      ? list.items.slice().sort((a, b) => (a.num ?? 0) - (b.num ?? 0))
      : list.items
    )
      .map((item) => {
        let content = inline(item.text);
        if (item.task !== null && item.task !== undefined) {
          content = `<span class="box">${item.task ? '☑' : '☐'}</span><span>${content}</span>`;
        }
        const nested = item.children && item.children.length ? item.children.join('') : '';
        return `<li>${content}${nested}</li>`;
      })
      .join('');
    // A list that does not start at 1 must say so, or `3.` renders as `1.` and
    // the numbers in the reply contradict the reply. The lowest number wins, so
    // a list written out of order still counts from its first real value.
    const first = list.ordered ? Math.min(...list.items.map((it) => it.num ?? 1)) : 1;
    const start = list.ordered && first > 1 ? ` start="${first}"` : '';
    const cls = list.task ? ' class="todo"' : '';
    const rendered = `<${tag}${start}${cls}>${items}</${tag}>`;
    if (listStack.length) {
      const parent = listStack[listStack.length - 1];
      const last = parent.items[parent.items.length - 1];
      // A pop with no item under it would drop the markup on the floor.
      if (last) last.children.push(rendered);
      else html.push(rendered);
    } else {
      html.push(rendered);
    }
  };

  /** Close the innermost list. */
  const closeList = () => renderList(listStack.pop());

  /** Close the front of the list stack — every one of them. */
  const flushList = () => {
    while (listStack.length) closeList();
  };

  /** Close every list that sits at a depth deeper than `depth`. */
  const popListsDeeperThan = (depth) => {
    while (listStack.length > depth) closeList();
  };

  const closeBlocks = () => {
    flushParagraph();
    flushList();
  };

  /** Close the open fence. `unclosed` is a fence the input stopped inside. */
  const emitFence = (unclosed) => {
    const code = escapeHtml(fenceLines.join('\n'));
    const label = fenceLang ? `<span class="lang">${escapeHtml(fenceLang)}</span>` : '';
    // An unterminated fence is how a streamed reply looks mid-block, so it
    // still renders as code — but it is marked, because a fence that never
    // closes otherwise swallows every remaining line of the document without
    // saying so.
    const open = unclosed ? ' data-unclosed="1"' : '';
    html.push(
      `<pre data-lang="${escapeHtml(fenceLang)}"${open}>${label}<code>${code}</code></pre>`
    );
    inFence = false;
    fenceChar = '';
    fenceLines = [];
    fenceLang = '';
  };

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ----
    if (inFence) {
      // Only the marker that opened the fence closes it.
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fenceChar) {
        emitFence(false);
      } else {
        fenceLines.push(line);
      }
      i++;
      continue;
    }

    // ---- fence opening ----
    // The info string is anything up to the end of the line: a fence declared
    // ```js {1,3} or ```python 3 is still a fence. Verified fence languages are
    // never embedded in HTML, so this cannot introduce an attribute of its own.
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open) {
      closeBlocks();
      inFence = true;
      fenceChar = open[1][0];
      fenceLang = open[2].trim();
      i++;
      continue;
    }

    // ---- blank line ----
    if (!line.trim()) {
      flushParagraph();
      // A line indented two spaces or more belongs to the item above it even
      // across a blank line:
      //
      //   - item one
      //
      //     more text
      //
      //     - nested
      //
      // Closing the list on the blank line made the paragraph a top-level one
      // and the nested list a sibling of its own parent. Anything less indented
      // is not the item's, so the list is closed here rather than swallowing
      // the paragraph that follows it.
      const next = lines[i + 1] ?? '';
      if (!/^ {2,}\S/.test(next)) flushList();
      i++;
      continue;
    }

    // ---- heading ----
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeBlocks();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inline(heading[2].replace(/\s*#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }

    // ---- horizontal rule ----
    // Before the list check, because a spaced rule (`* * *`, `- - -`) is a list
    // marker followed by text to every list pattern there is.
    if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      closeBlocks();
      html.push('<hr>');
      i++;
      continue;
    }

    // ---- table ----
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      closeBlocks();
      html.push(renderTable(rows[0], rows.slice(1)));
      continue;
    }

    // ---- blockquote ----
    if (/^\s*>\s?/.test(line)) {
      closeBlocks();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // ---- lists ----
    // The indent is the only thing that says "nested", and it is only readable
    // while the line is raw, so it is measured before anything is matched.
    const indent = line.match(/^ */)[0].length;
    const item = line.match(LIST_RE);

    /**
     * Which nesting level an indent opens. The list stack holds one entry per
     * open list, so this is the level the marker's own indent maps to.
     *
     * Bare `indent / 2` is wrong as soon as one prefix is not a multiple of two:
     * `- a` / `  - b` / `    - c` (the shape a model writes when it indents by
     * four) opened a new list for `    - c` instead of nesting it, because there
     * are only two open lists but three levels. Both the indent and the stack
     * are therefore sorted and paired, and anything past the deepest open list
     * nests one level further.
     */
    const indentOf = (n) => {
      const depths = [...new Set(listStack.map((l) => l.indent))].sort((a, b) => a - b);
      let level = 1;
      for (const base of depths) if (n > base) level++;
      return level;
    };

    // A line indented deeper than an open item and carrying no marker of its own
    // is that item's continuation — a wrapped sentence, or a second paragraph.
    // The indent is dropped: it is layout, and it would render as a gap.
    //
    // This test comes before the marker test so a nested list is not mistaken
    // for text at the item's own level. `- one` / `    - two` used to close the
    // outer list and append "- two" to the item's text, which is how a list
    // reply lost its shape.
    if (listStack.length && !item && indent >= 2 && indentOf(indent) >= Math.max(listStack.length, 2)) {
      const depth = indentOf(indent);
      const owner = listStack.find((l) => l.depth === depth) || listStack[listStack.length - 1];
      // Text at a level above the innermost list closes that list first: the
      // paragraph is the outer item's, so the nested list inside it has ended.
      popListsDeeperThan(owner ? listStack.indexOf(owner) + 1 : 1);
      const last = owner && owner.items[owner.items.length - 1];
      if (last) last.text += `\n${line.trim()}`;
      i++;
      continue;
    }

    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[2]);
      const num = ordered ? Number(item[2].slice(0, -1)) : null;
      let content = item[3];

      let task = null;
      const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        task = taskMatch[1].toLowerCase() === 'x';
        content = taskMatch[2];
      }

      const depth = indentOf(indent);
      popListsDeeperThan(depth);
      const open = listStack[listStack.length - 1];
      // A shallower marker continues the list at that level; a different marker
      // type starts a sibling list; and a list whose only item was just closed
      // as a nested child is finished, so the next marker at this indent opens
      // a new list rather than reopening the item that owns the child.
      if (!open || open.depth !== depth || open.ordered !== ordered || open.items.length === 0) {
        listStack.push({ depth, indent, ordered, task: task !== null, items: [] });
      }
      if (task !== null) listStack[listStack.length - 1].task = true;
      listStack[listStack.length - 1].items.push({ text: content, task, children: [], num });
      i++;
      continue;
    }

    // ---- paragraph text ----
    if (listStack.length) flushList();
    paragraph.push(line);
    i++;
  }

  if (inFence) emitFence(true);
  closeBlocks();

  return html.join('\n');
}

/**
 * Inline emphasis.
 *
 * Two rules keep this honest on real text. The character just inside each mark
 * must be a non-space, so `2 * 3 * 4` and `2 ** 3 ** 4` stay arithmetic instead
 * of becoming emphasis — `* 3 *` used to render as `<em> 3 </em>`. And a mark
 * may not touch a word character on the outside, which is what keeps
 * `snake_case_name` an identifier rather than an italicised `case`. A
 * multi-word or multi-line span still works: only the edges are constrained.
 */
const emphasis = (segment) =>
  segment
    .replace(/(^|[^*])\*\*\*(?!\*)(\S(?:[^*]*\S)?)\*\*\*(?!\*)/g, '$1<strong><em>$2</em></strong>')
    .replace(/(^|[^*])\*\*(?!\*)(\S(?:[^*]*\S)?)\*\*(?!\*)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*])\*(?!\*)(\S(?:[^*\n]*\S)?)\*(?!\*)(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(\S(?:[^_\n]*\S)?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])~~(\S(?:[^~]*\S)?)~~/g, '$1<del>$2</del>');

/** Splits rendered HTML so diff/code blocks can be decorated after insertion. */
export function decorateCodeBlocks(root) {
  root.querySelectorAll('pre[data-lang]').forEach((pre) => {
    if (pre.dataset.decorated) return;
    pre.dataset.decorated = '1';
    const lang = pre.dataset.lang;
    const code = pre.querySelector('code');
    if (!code) return;
    if (/^(diff|patch)$/i.test(lang)) {
      code.innerHTML = code.innerHTML
        .split('\n')
        .map((line) => {
          const plain = line;
          if (/^\+/.test(plain.replace(/<[^>]+>/g, ''))) return `<span class="diff-add">${line}</span>`;
          if (/^-/.test(plain.replace(/<[^>]+>/g, ''))) return `<span class="diff-del">${line}</span>`;
          if (/^@@/.test(plain.replace(/<[^>]+>/g, ''))) return `<span class="diff-hunk">${line}</span>`;
          return line;
        })
        .join('\n');
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.type = 'button';
    btn.textContent = 'Copy';
    // Appearance lives in styles.css. It was set inline here, and an inline
    // `opacity: 0` cannot be overridden by a stylesheet — so a keyboard user,
    // who never fires `mouseenter`, could never see the button at all.
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } catch {
        btn.textContent = 'Failed';
      }
    });
    pre.style.position = 'relative';
    pre.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    pre.addEventListener('mouseleave', () => (btn.style.opacity = '0'));
    pre.appendChild(btn);
  });
}
