'use strict';

/**
 * The browser tools.
 *
 * Seven tools, not twenty. A browsing agent needs to go somewhere, read what is
 * there, click, type, look at it, and occasionally run a line of JavaScript to
 * find out why none of that worked. Anything else — tabs, cookies, device
 * emulation — is state the agent does not need and would only give it more ways
 * to get stuck.
 *
 * Permissions follow what each action can do to the user's world:
 *
 *   read  — navigating, reading, screenshots, closing. The page is the world's,
 *           not the user's; nothing on the user's behalf changes.
 *   write — clicking and typing. A click can buy something, post a comment or
 *           delete an account. In "Ask first" mode that is confirmed first, and
 *           in read-only mode it is refused.
 *   exec  — evaluating arbitrary JavaScript in the page context. Powerful enough
 *           to leave the sandbox, so it sits at the strictest level Klaud has
 *           short of `send`.
 *
 * One honest limitation, stated here so nobody discovers it by surprise: **Klaud
 * cannot see.** Screenshots are saved for the user and for the transcript; the
 * model's only view of a page is `browser_read`, which is text. A page that
 * renders its content to a canvas is invisible to it.
 */

const { BrowserSession, checkNavigableUrl, saveScreenshot, shutdown } = require('./session');
const { findBrowser } = require('./cdp');

/** Shared shape for "which element" arguments, used by click and type. */
const TARGET_PROPERTIES = {
  selector: {
    type: 'string',
    description: 'A CSS selector, e.g. "#submit" or "form.search input[name=q]". Prefer this when you know the markup.',
  },
  text: {
    type: 'string',
    description:
      'Visible text of the element, case-insensitive, matched as a substring. Use this when you do not know the markup. ' +
      'The most specific matching element is chosen, preferring real controls over containers.',
  },
};

function assertTarget(args) {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!selector && !text) {
    throw new Error(
      'Give either a "selector" or the visible "text" of the element to act on. ' +
        'Use browser_read first if you do not know what is on the page.'
    );
  }
  return selector ? { selector } : { text };
}

/** One line describing where the page ended up, so every tool reports position. */
function describePosition(page) {
  if (!page) return '';
  const title = page.title ? ` "${String(page.title).slice(0, 80)}"` : '';
  const url = page.url ? String(page.url).slice(0, 200) : '';
  return url ? `\n\nAt: ${url}${title}` : '';
}

/** The tools, in the same shape as every other entry in `src/lib/tools.js`. */
function browserToolDefinitions() {
  return [
    {
      name: 'browser_goto',
      permission: 'read',
      description:
        'Open a web page in a real browser and wait for it to load. Use this whenever a task needs the rendered ' +
        'page rather than raw HTML: anything behind JavaScript, a login, a search box, or a site whose HTML is ' +
        'unreadable. Follow it with browser_read to see the content. Only http and https URLs are allowed.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL including the scheme, e.g. https://example.com/docs.' },
        },
        required: ['url'],
      },
      async run(args) {
        const url = checkNavigableUrl(args.url);
        const session = await BrowserSession.get();
        const page = await session.goto(url);
        const summary = await session.readPage({ maxChars: 200 }).catch(() => null);
        return (
          `Loaded ${url}` +
          describePosition(page) +
          (summary && summary.charCount
            ? `\n\nThe page has about ${summary.charCount} characters of readable text. Call browser_read to read it.`
            : '\n\nThe page has no readable text yet — it may still be loading, or it may render to a canvas.')
        );
      },
    },

    {
      name: 'browser_read',
      permission: 'read',
      description:
        'Read the page currently open in the browser as clean markdown-ish text, with its links and fillable ' +
        'form fields. This is how you see a web page. Substantially better than fetch_url for anything that ' +
        'needs JavaScript.',
      parameters: {
        type: 'object',
        properties: {
          max_chars: {
            type: 'integer',
            description: 'Cap on returned characters (default 40000). Lower it for a long page you only need the start of.',
          },
          include_links: { type: 'boolean', description: 'Include the list of links on the page (default true).' },
        },
        required: [],
      },
      async run(args) {
        const session = await BrowserSession.get();
        const maxChars = Math.max(2_000, Math.min(Number(args.max_chars) || 40_000, 120_000));
        const page = await session.readPage({ maxChars });

        const parts = [];
        const heading = [page.title || '(untitled)', page.url].filter(Boolean).join(' — ');
        parts.push(heading);
        if (page.headings && page.headings.length) {
          const outline = page.headings.slice(0, 12).map((h) => `${'#'.repeat(h.level || 1)} ${h.text}`).join('\n');
          if (outline) parts.push(`Page outline:\n${outline}`);
        }

        parts.push(page.text && page.text.trim() ? page.text : '(no readable text on this page)');

        if (args.include_links !== false && page.links && page.links.length) {
          const links = page.links
            .slice(0, 40)
            .map((l) => `- ${l.text} -> ${l.href}`)
            .join('\n');
          parts.push(`Links on this page (${page.links.length}):\n${links}`);
        }
        if (page.inputs && page.inputs.length) {
          const fields = page.inputs
            .slice(0, 20)
            .map((f) => `- ${f.kind}${f.name ? ` name="${f.name}"` : ''}${f.placeholder ? ` placeholder="${f.placeholder}"` : ''}${f.label ? ` label="${f.label}"` : ''}`)
            .join('\n');
          parts.push(`Fillable fields (${page.inputs.length}):\n${fields}`);
        }
        if (page.truncated) {
          parts.push(`[Truncated at ${maxChars} characters. Use max_chars for more, or browser_eval to read a specific element.]`);
        }

        return parts.join('\n\n');
      },
    },

    {
      name: 'browser_click',
      permission: 'write',
      description:
        'Click an element on the current page, as a real mouse click so JavaScript frameworks react to it. ' +
        'Follows a link or submits a form if that is what the element does. This can have real-world effects ' +
        '(a purchase, a post, a deletion), so it is confirmed in "Ask first" mode.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          index: {
            type: 'integer',
            description: 'When several elements match, which one to click (0-based, default 0).',
          },
        },
        required: [],
      },
      async run(args) {
        const target = assertTarget(args);
        const session = await BrowserSession.get();
        const result = await session.click(target);
        const what = `<${result.element.tag}>${result.element.text ? ` "${result.element.text.slice(0, 60)}"` : ''}`;
        const lines = [`Clicked ${what}.`];
        if (result.element.totalMatches > 1) {
          lines.push(`(${result.element.totalMatches} elements matched; used the most specific.)`);
        }
        if (result.navigatedTo) lines.push(`The page navigated to ${result.navigatedTo}.`);
        return lines.join(' ') + describePosition(result.page);
      },
    },

    {
      name: 'browser_type',
      permission: 'write',
      description:
        'Type text into a field on the current page, as real keystrokes so that autocomplete and validated ' +
        'inputs behave. Set submit to true to press Enter afterwards, which usually submits the surrounding form.',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPERTIES,
          value: { type: 'string', description: 'The text to type.' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
          clear_first: {
            type: 'boolean',
            description: 'Select and overwrite any existing text first (default true).',
          },
        },
        required: ['value'],
      },
      async run(args) {
        const target = assertTarget(args);
        if (typeof args.value !== 'string') throw new Error('"value" must be a string.');
        const session = await BrowserSession.get();

        if (args.clear_first !== false) {
          // Select-all then type, so typing replaces rather than appends. Done
          // through CDP for the same reason as everything else: a framework will
          // not notice a programmatic value change.
          await session.type(target, '');
          await session.evaluate(
            'document.activeElement && document.activeElement.select ? (document.activeElement.select(), true) : true'
          );
        }

        const typed = await session.type(target, args.value, { submit: Boolean(args.submit) });
        const lines = [
          `Typed ${args.value.length} character${args.value.length === 1 ? '' : 's'} into <${typed.element.tag}>` +
            `${typed.element.placeholder ? ` "${typed.element.placeholder}"` : typed.element.text ? ` "${typed.element.text.slice(0, 40)}"` : ''}.`,
        ];
        if (args.submit) lines.push('Pressed Enter.');
        return lines.join(' ') + describePosition(typed.page);
      },
    },

    {
      name: 'browser_screenshot',
      permission: 'read',
      description:
        'Save a PNG of the current page. The image is written to the working directory and the path is returned ' +
        'so it can be shown to the user or opened. Note that you cannot see the image yourself — use browser_read ' +
        'to understand the page content.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the whole scrollable document, not just the viewport.' },
          name: { type: 'string', description: 'Optional file name, e.g. "login-error.png".' },
        },
        required: [],
      },
      async run(args, ctx) {
        const session = await BrowserSession.get();
        const buffer = await session.screenshot({ fullPage: Boolean(args.full_page) });
        const cwd = ctx && ctx.cwd ? ctx.cwd : process.cwd();
        const file = await saveScreenshot(buffer, cwd, args.name);
        const page = await session.info().catch(() => null);
        return (
          `Saved ${Math.round(buffer.length / 1024)} KB screenshot to ${file}` +
          describePosition(page) +
          '\n\nYou cannot see this image. It is for the user, or to confirm that something rendered.'
        );
      },
    },

    {
      name: 'browser_eval',
      permission: 'exec',
      description:
        'Run one JavaScript expression in the page and return its value. The escape hatch for when the page ' +
        'is readable but the tools cannot reach something: measuring layout, reading a data attribute, waiting ' +
        'on a promise, or checking why a click did not work. The result must be JSON-serialisable.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'JavaScript to evaluate. An expression such as "document.title" is ideal; top-level await is ' +
              'supported, so "await new Promise(r => setTimeout(r, 500))" works. Multi-statement bodies work too, ' +
              'though only an expression returns a value.',
          },
        },
        required: ['expression'],
      },
      async run(args) {
        const expression = String(args.expression == null ? '' : args.expression);
        if (!expression.trim()) throw new Error('expression is required.');
        const session = await BrowserSession.get();
        const value = await session.evalExpression(expression);
        let rendered;
        try {
          rendered = JSON.stringify(value, null, 2);
        } catch {
          rendered = String(value);
        }
        if (rendered === undefined) rendered = String(value);
        return rendered.length > 40_000 ? `${rendered.slice(0, 40_000)}\n\n[truncated]` : rendered;
      },
    },

    {
      name: 'browser_close',
      permission: 'read',
      description:
        'Close the browser and throw away its session, including any cookies and logged-in state. Use this when ' +
        'you are finished browsing, or to start over from a clean state.',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const session = BrowserSession.peek();
        if (!session) return 'No browser was open, so there was nothing to close.';
        await shutdown();
        return 'Closed the browser. Its session and cookies are gone; the next browser_goto starts a fresh one.';
      },
    },
  ];
}

/**
 * Whether a browser is installed at all.
 *
 * Consulted before the tools are advertised, so a machine without Chrome gets a
 * clear "not available" instead of tools that fail on every call. Cached because
 * `findBrowser` stats a dozen paths and this is asked on every turn.
 */
let _available = null;
function browserAvailable() {
  if (_available === null) _available = Boolean(findBrowser());
  return _available;
}

/** For tests: forget the cached answer. */
function _resetAvailability() {
  _available = null;
}

module.exports = {
  browserToolDefinitions,
  browserAvailable,
  _resetAvailability,
  // Re-exported so the tool layer and tests do not reach into session/cdp.
  BrowserSession,
  shutdown,
};
