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
    return `\x00S${slots.length - 1}\x00`;
  };

  let out = String(text);

  // 1. Code spans — content is opaque.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // 2. Links and images, whose targets get attribute-safe escaping.
  out = out.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_m, alt, src) =>
    /^https?:\/\//i.test(src) ? stash(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`) : _m
  );
  out = out.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_m, label, href) =>
    /^https?:\/\//i.test(href)
      ? stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
      : _m
  );

  // 3. Now escape what is left, so nothing in the text can become markup.
  out = escapeHtml(out);

  // 4. Bare URLs become links.
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );

  // 5. Inline spans. The brackets in these patterns cannot occur in the
  //    placeholders, and the placeholders contain no asterisks or tildes.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 6. Put the structural markup back.
  return out.replace(/\x00S(\d+)\x00/g, (_m, i) => slots[Number(i)]);
}

function renderTable(rows) {
  const header = rows[0];
  const body = rows.slice(1);
  const head = `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
    : '';
  return `<table>${head}${tbody}</table>`;
}

const LIST_RE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

/** Render markdown to sanitized HTML. */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const html = [];

  // Block level state.
  let i = 0;
  let paragraph = [];
  let listStack = []; // [{ ordered, items: [ [content, children?] ] }]
  let inFence = false;
  let fenceLang = '';
  let fenceLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    while (listStack.length) {
      const list = listStack.pop();
      const tag = list.ordered ? 'ol' : 'ul';
      const cls = list.task ? ' class="todo"' : '';
      const items = list.items
        .map((item) => {
          let content = inline(item.text);
          if (item.task !== null && item.task !== undefined) {
            content = `<span class="box">${item.task ? '☑' : '☐'}</span><span>${content}</span>`;
          }
          const nested = item.children && item.children.length ? item.children.join('') : '';
          return `<li>${content}${nested}</li>`;
        })
        .join('');
      const rendered = `<${tag}${cls}>${items}</${tag}>`;
      if (listStack.length) {
        const parent = listStack[listStack.length - 1];
        parent.items[parent.items.length - 1].children.push(rendered);
      } else {
        html.push(rendered);
      }
    }
  };

  const closeBlocks = () => {
    flushParagraph();
    flushList();
  };

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ----
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (inFence) {
      if (fence) {
        const code = escapeHtml(fenceLines.join('\n'));
        const label = fenceLang ? `<span class="lang">${escapeHtml(fenceLang)}</span>` : '';
        html.push(
          `<pre data-lang="${escapeHtml(fenceLang)}">${label}<code>${code}</code></pre>`
        );
        inFence = false;
        fenceLines = [];
        fenceLang = '';
      } else {
        fenceLines.push(line);
      }
      i++;
      continue;
    }
    if (fence) {
      closeBlocks();
      inFence = true;
      fenceLang = fence[2] || '';
      i++;
      continue;
    }

    // ---- blank line ----
    if (!line.trim()) {
      closeBlocks();
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
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
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
      const split = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const rows = [split(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(split(lines[i]));
        i++;
      }
      closeBlocks();
      html.push(renderTable(rows));
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
    const item = line.match(LIST_RE);
    if (item) {
      flushParagraph();
      const indent = line.match(/^\s*/)[0].length;
      const ordered = /\d/.test(item[1]);
      let content = item[2];

      let task = null;
      const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskMatch) {
        task = taskMatch[1].toLowerCase() === 'x';
        content = taskMatch[2];
      }

      const depth = Math.max(1, Math.floor(indent / 2) + 1);
      while (listStack.length > depth) {
        const list = listStack.pop();
        const tag = list.ordered ? 'ol' : 'ul';
        const cls = list.task ? ' class="todo"' : '';
        const rendered = `<${tag}${cls}>${list.items
          .map((it) => `<li>${inline(it.text)}${(it.children || []).join('')}</li>`)
          .join('')}</${tag}>`;
        if (listStack.length) {
          const parent = listStack[listStack.length - 1];
          parent.items[parent.items.length - 1].children.push(rendered);
        } else {
          html.push(rendered);
        }
      }
      const top = listStack[listStack.length - 1];
      // Deeper indentation opens a nested list; a different marker type starts
      // a sibling list at the same level.
      if (!top || top.ordered !== ordered || listStack.length < depth) {
        if (top && top.items.length === 0) listStack.pop();
        listStack.push({ ordered, items: [], task: task !== null });
      }
      if (task !== null) listStack[listStack.length - 1].task = true;
      listStack[listStack.length - 1].items.push({ text: content, task, children: [] });
      i++;
      continue;
    }

    // ---- paragraph text ----
    if (listStack.length && /^\s{2,}\S/.test(line)) {
      // Continuation of the previous list item.
      const list = listStack[listStack.length - 1];
      const last = list.items[list.items.length - 1];
      if (last) last.text += `\n${line.trim()}`;
      i++;
      continue;
    }
    if (listStack.length) flushList();
    paragraph.push(line);
    i++;
  }

  if (inFence) {
    // Unterminated fence — render what we have so streaming looks right.
    html.push(`<pre data-lang="${escapeHtml(fenceLang)}"><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  }
  closeBlocks();

  return html.join('\n');
}

/** Split rendered HTML so diff/code blocks can be decorated after insertion. */
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
