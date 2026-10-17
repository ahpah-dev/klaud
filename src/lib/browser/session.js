'use strict';

/**
 * A browser session: one browser process, one page, and the handful of
 * operations an agent actually needs.
 *
 * Deliberately narrow. `cdp.js` owns the process and the framing; this file owns
 * the page, and only the page. Everything an agent would want to do to a web page
 * reduces to: go somewhere, read it, click something, type something, look at it.
 *
 * Two design choices worth stating, because both are easy to get wrong and both
 * change whether real sites work:
 *
 * 1. **Input goes through CDP, not the DOM.** `element.click()` and
 *    `element.value = x` are invisible to most JavaScript frameworks: React and
 *    Vue listen for real pointer and input events, so a DOM-level click appears
 *    to do nothing. Clicks are dispatched as `Input.dispatchMouseEvent` at the
 *    element's centre, and typing uses `Input.insertText` on the focused element.
 *
 * 2. **In-page code is stringified from real functions.** Building injected
 *    JavaScript as string literals means escaping a nested backtick wrong once
 *    and shipping a syntax error into the page. Functions are written normally
 *    and converted with `fn.toString()`, so they are syntax-checked by the parser
 *    before they ever reach a browser.
 */

const fs = require('fs/promises');
const path = require('path');
const { CdpConnection } = require('./cdp');
const { resolveInside } = require('../fsutil');

const VIEWPORT = { width: 1280, height: 800 };

/** Schemes an agent may navigate to. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:']);

/**
 * Refuse `file:` explicitly.
 *
 * Every other Klaud tool is confined to the working directory by
 * `resolveInside`. A browser pointed at `file:///C:/Users/...` would read any
 * file on the machine and hand it back as page text, which is a complete bypass
 * of that boundary — so it is blocked here rather than trusted to the model's
 * good behaviour.
 */
function checkNavigableUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('url is required.');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `"${text}" is not an absolute URL. Include the scheme, for example https://example.com.`
    );
  }

  if (url.protocol === 'file:') {
    throw new Error(
      'file:// URLs are not allowed: they would let the browser read any file on this machine, ' +
        'outside the working directory every other tool is confined to. ' +
        'Use read_file for local files.'
    );
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `"${url.protocol}" URLs are not supported. Use http:// or https://.`
    );
  }
  // about:blank is legitimate (a blank page to build on); other about: targets
  // are browser internals that would leak settings.
  if (url.protocol === 'about:' && url.pathname !== 'blank') {
    throw new Error('Only about:blank is supported, not other about: pages.');
  }
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * Functions that run inside the page
 *
 * Each is a plain function with no closure over this module. They are stringified
 * into the page, so they may only use browser globals.
 *
 * `extract.js` also exports `queryScript`/`parseQuery`, which list candidate
 * elements. They are deliberately not used for click/type targeting: that pair is
 * tested only against a DOM shim, while the matcher below is exercised against a
 * **real Chrome** by `test/browser-tools.js`. Targeting is where being wrong is
 * least visible — a click lands on the wrong element and the page quietly does the
 * wrong thing — so the version with real-browser coverage wins. The shim-tested
 * lister stays available for a future "what can I click here?" feature, a
 * read-only use where a wrong answer is obvious rather than harmful.
 * ------------------------------------------------------------------ */

/** Resolve a click/type target to a single element plus its geometry. */
function _klaudFindTarget(spec) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };

  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.textContent || '').slice(0, 120),
      id: el.id || '',
      classes: typeof el.className === 'string' ? el.className : '',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      editable:
        el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true,
    };
  };

  let candidates = [];

  if (spec && spec.selector) {
    try {
      candidates = Array.from(document.querySelectorAll(spec.selector));
    } catch (err) {
      return { error: `"${spec.selector}" is not a valid CSS selector: ${err.message}` };
    }
  } else if (spec && spec.text) {
    const wanted = clean(spec.text).toLowerCase();
    const all = Array.from(document.querySelectorAll('body *'));
    const matches = all.filter((el) => {
      if (!visible(el)) return false;
      const own = clean(el.innerText || el.textContent || '').toLowerCase();
      return own.includes(wanted);
    });
    if (!matches.length) return { error: `No visible element on this page contains "${spec.text}".` };

    /* "Most specific" matters: a click on <body> because it happens to contain the
     * word is never what was meant. Prefer the deepest match, and among equals
     * prefer anything that is actually interactive. */
    const clickable = (el) => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      if (el.getAttribute && el.getAttribute('role') === 'button') return true;
      if (el.getAttribute && el.getAttribute('onclick')) return true;
      return false;
    };
    matches.sort((a, b) => {
      const ac = clickable(a) ? 1 : 0;
      const bc = clickable(b) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      const ad = a.querySelectorAll('*').length;
      const bd = b.querySelectorAll('*').length;
      return ad - bd; // fewer descendants = more specific
    });
    candidates = matches;
  } else {
    return { error: 'Give either a selector or the visible text of the element.' };
  }

  const usable = candidates.filter(visible);
  if (!usable.length) {
    return {
      error: candidates.length
        ? 'The matching element exists but is not visible (hidden, zero-sized, or off the layout).'
        : 'No element matched.',
    };
  }

  const target = usable[0];
  // A click on a <span> inside a <button> does nothing in most frameworks; walk up
  // to the nearest interactive ancestor when there is one.
  let actionable = target;
  for (let i = 0; i < 5 && actionable; i++) {
    const tag = actionable.tagName.toLowerCase();
    if (['button', 'a', 'input', 'select', 'textarea', 'label', 'summary'].includes(tag)) break;
    if (actionable.getAttribute && actionable.getAttribute('role') === 'button') break;
    actionable = actionable.parentElement;
  }
  if (!actionable || !visible(actionable)) actionable = target;

  actionable.scrollIntoView({ block: 'center', inline: 'center' });

  const info = describe(actionable);
  info.totalMatches = usable.length;
  info.matchedText = describe(target).text;
  return { ok: true, element: info };
}

/** Read the document's readiness, used to decide whether a navigation settled. */
function _klaudReadyState() {
  return { state: document.readyState, url: location.href, title: document.title };
}

const findTargetScript = (spec) => `(${_klaudFindTarget.toString()})(${JSON.stringify(spec)})`;

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

/** The lazily-created browser for this process. */
let current = null;

class BrowserSession {
  constructor(connection, { sessionId, targetId }) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.lastNavigation = null;
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * The browser for this process, started on first use.
   *
   * Lazy on purpose: a user who never asks Klaud to browse should not have a
   * browser process and a 300 MB profile sitting in memory for the whole session.
   */
  static async get({ headless = true } = {}) {
    if (current && !current.connection._closed && !current.connection._exited) return current;
    return BrowserSession.launch({ headless });
  }

  static async launch({ headless = true } = {}) {
    if (current) {
      await current.close().catch(() => {});
      current = null;
    }
    const connection = await CdpConnection.launch({ headless });

    const { targetInfos } = await connection.send('Target.getTargets');
    const page = (targetInfos || []).find((t) => t.type === 'page');
    let targetId = page && page.targetId;
    if (!targetId) {
      const created = await connection.send('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
    }

    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false },
      sessionId
    ).catch(() => { /* not fatal: the default viewport is usable */ });

    const session = new BrowserSession(connection, { sessionId, targetId });
    current = session;
    return session;
  }

  static peek() {
    return current;
  }

  /** Drop the singleton without closing (used by tests and by crash recovery). */
  static forget() {
    current = null;
  }

  /** Close the browser. Safe to call repeatedly. */
  async close() {
    if (current === this) current = null;
    await this.connection.close().catch(() => {});
  }

  async ensureAlive() {
    if (this.connection._closed || this.connection._exited) {
      throw new Error(
        'The browser is no longer running (it may have crashed or been closed). ' +
          'Call browser_goto again to start a fresh one; the previous page state is gone.'
      );
    }
  }

  /* ---------------- primitives ---------------- */

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    await this.ensureAlive();
    const result = await this.connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      this.sessionId
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const message =
        (detail.exception && (detail.exception.description || detail.exception.value)) ||
        detail.text ||
        'the page threw an exception';
      throw new Error(`Page script failed: ${String(message).split('\n')[0]}`);
    }
    return result.result ? result.result.value : undefined;
  }

  /** Current page url, title and readiness. */
  async info() {
    return this.evaluate(`(${_klaudReadyState.toString()})()`);
  }

  /**
   * Navigate and wait for the page to settle.
   *
   * `Page.navigate` reports network failures in `errorText` instead of throwing,
   * so a DNS failure would otherwise look like a successful navigation to a blank
   * page — the single most confusing failure mode for a browsing agent.
   */
  async goto(rawUrl, { timeoutMs = 30_000 } = {}) {
    const url = checkNavigableUrl(rawUrl);
    await this.ensureAlive();

    const loaded = this.connection.once('Page.loadEventFired', timeoutMs).catch(() => null);
    const result = await this.connection.send('Page.navigate', { url }, this.sessionId, timeoutMs);

    if (result.errorText) {
      throw new Error(
        `Could not load ${url}: ${result.errorText}.\n` +
          (result.errorText === 'net::ERR_NAME_NOT_RESOLVED'
            ? 'That hostname does not resolve — check the spelling.'
            : result.errorText === 'net::ERR_CONNECTION_REFUSED'
              ? 'The server refused the connection — is it running, and on that port?'
              : result.errorText === 'net::ERR_CERT_AUTHORITY_INVALID' ||
                  result.errorText === 'net::ERR_CERT_DATE_INVALID'
                ? 'The site presented a certificate the browser does not trust. Klaud will not bypass it.'
                : 'The navigation itself failed, so the page was not loaded.')
      );
    }
    if (result.isDownload) {
      throw new Error(`${url} is a file download, not a page. Klaud can read it with fetch_url or run_command instead.`);
    }

    // Wait for the load event, then for readyState to actually be complete. The
    // event can fire before a framework finishes its first render.
    await loaded;
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    while (Date.now() < deadline) {
      const state = await this.info().catch(() => null);
      if (state && state.state === 'complete') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    this.lastNavigation = { url, at: Date.now() };
    return this.info().catch(() => ({ url, title: '' }));
  }

  /** Resolve a selector/text to an element, with geometry. */
  async findTarget(spec) {
    const found = await this.evaluate(findTargetScript(spec));
    if (!found || !found.ok) {
      throw new Error((found && found.error) || 'The element could not be located.');
    }
    return found.element;
  }

  /**
   * Click an element the way a mouse would.
   *
   * Dispatch at the element's centre so the page sees pointer, mouse and click
   * events in the right order — which is what a framework needs to react.
   */
  async click(spec) {
    const element = await this.findTarget(spec);
    const { x, y } = element;
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.sessionId);
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.sessionId);
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.sessionId);

    // A click often navigates. Give the page a moment, then report where it ended
    // up so the caller does not have to guess whether anything happened.
    await new Promise((r) => setTimeout(r, 250));
    const after = await this.info().catch(() => null);
    return {
      element,
      navigatedTo: after && after.url !== this.lastNavigation?.url ? after.url : null,
      page: after,
    };
  }

  /**
   * Type into a focusable element.
   *
   * Focus is set in the page, then text is inserted through CDP so the page
   * receives real `beforeinput`/`input` events. Assigning `.value` directly
   * leaves React-controlled inputs unchanged, which reads to the agent as "typing
   * does nothing".
   */
  async type(spec, text, { submit = false } = {}) {
    const element = await this.findTarget(spec);
    if (!element.editable) {
      // Not a hard failure: clicking then typing is a legitimate pattern for
      // custom widgets, so focus and continue rather than refusing.
      await this.click(spec);
    }

    await this.evaluate(`(${_klaudFocusElement.toString()})(${JSON.stringify(spec)})`);

    if (text) {
      await this.connection.send('Input.insertText', { text: String(text) }, this.sessionId);
    }
    if (submit) {
      /* Enter needs `text: '\r'` to trigger implicit form submission. A bare
       * keyDown/keyUp without text is delivered to the element but the browser
       * never runs the form's submit behaviour, so the button "does nothing" and
       * the agent concludes the page is broken. Verified by test: without the
       * text field the value goes in and no submit event fires. */
      await this.connection.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
        },
        this.sessionId
      );
      await this.connection.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        },
        this.sessionId
      );
      await new Promise((r) => setTimeout(r, 400));
    }

    const page = await this.info().catch(() => null);
    return { element, page, submitted: Boolean(submit) };
  }

  /** A PNG of the current viewport, or of the whole document. */
  async screenshot({ fullPage = false } = {}) {    await this.ensureAlive();
    let restore = null;

    if (fullPage) {
      const size = await this.evaluate(
        `({ width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
            height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })`
      );
      const width = Math.max(320, Math.min(Number(size.width) || VIEWPORT.width, 4000));
      const height = Math.max(200, Math.min(Number(size.height) || VIEWPORT.height, 12000));
      restore = { ...VIEWPORT };
      await this.connection.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false },
        this.sessionId
      );
      await new Promise((r) => setTimeout(r, 150));
    }

    try {
      const shot = await this.connection.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: fullPage },
        this.sessionId
      );
      return Buffer.from(shot.data, 'base64');
    } finally {
      if (restore) {
        await this.connection
          .send('Emulation.setDeviceMetricsOverride', { ...restore, deviceScaleFactor: 1, mobile: false }, this.sessionId)
          .catch(() => {});
      }
    }
  }

  /** Read the current page as text an agent can reason about. */
  async readPage({ maxChars = 40_000 } = {}) {
    await this.ensureAlive();
    const extract = require('./extract');
    const script = extract.extractionScript({ maxChars });
    const raw = await this.evaluate(script);
    const parsed = extract.parseExtraction({ result: { value: raw } });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.page;
  }

  /**
   * Evaluate user-supplied JavaScript, accepting top-level `await`.
   *
   * `Runtime.evaluate` runs a *classic script*, where `await` outside a function
   * is a syntax error. The tool's own description invites
   * `await new Promise(r => setTimeout(r, 500))` — the natural way to wait for a
   * page — so the bare form has to work.
   *
   * The raw expression is tried first, because that preserves exact semantics for
   * both expressions and multi-statement bodies. Only when it fails to *parse* is
   * it retried wrapped in an async function; a genuine runtime error is reported
   * as-is rather than retried, or one mistake would become three.
   */
  async evalExpression(expression) {
    const source = String(expression == null ? '' : expression);
    const attempts = [
      source,
      `(async () => (${source}))()`,
      `(async () => { ${source} })()`,
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await this.evaluate(attempt);
      } catch (err) {
        lastError = err;
        // Only a *parse* failure is worth another shape. A real exception means
        // the code ran and threw, and rewriting it would just throw again.
        if (!/SyntaxError/.test(String(err && err.message))) throw err;
      }
    }
    throw new Error(
      `The expression could not be evaluated: ${String(lastError && lastError.message).split('\n')[0]}\n` +
        'Pass an expression (e.g. "document.title") or a function body; top-level await is supported.'
    );
  }

  /** Go back one entry in history. */
  async back() {    const history = await this.evaluate('history.length');
    if (!history || history <= 1) throw new Error('There is no previous page in this tab to go back to.');
    await this.evaluate('history.back()');
    await new Promise((r) => setTimeout(r, 500));
    return this.info();
  }
}

/** Focus an element by selector or text; used as a page-side helper. */
function _klaudFocusElement(spec) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  let el = null;
  if (spec && spec.selector) {
    try {
      el = document.querySelector(spec.selector);
    } catch {
      return false;
    }
  } else if (spec && spec.text) {
    const wanted = clean(spec.text).toLowerCase();
    el = Array.from(document.querySelectorAll('body *')).find((node) =>
      clean(node.innerText || node.textContent || '').toLowerCase().includes(wanted)
    );
  }
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  // Report what actually happened rather than assuming success: if focus could
  // not move (a disabled input, a shadow root), the caller needs to know before
  // it types into whatever *is* focused.
  return document.activeElement === el || el.contains(document.activeElement);
}

/**
 * Write a screenshot inside the working directory, never outside it.
 *
 * The location is hidden from directory listings on purpose: a screenshot is a
 * by-product, and a `screenshots/` folder appearing at the top of someone's
 * project after one browse would be a nuisance. The tool returns the absolute
 * path, so it stays reachable and `read_file` still works on it.
 */
async function saveScreenshot(buffer, cwd, name = null) {
  const dir = resolveInside(cwd, '.klaud/screenshots').abs;
  await fs.mkdir(dir, { recursive: true });

  // A caller-supplied name is a path fragment, so it goes through the same
  // containment check as everything else rather than being trusted.
  let target;
  if (name) {
    const safe = resolveInside(dir, String(name));
    target = safe.abs.endsWith('.png') ? safe.abs : `${safe.abs}.png`;
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    target = path.join(dir, `shot-${stamp}.png`);
  }
  await fs.writeFile(target, buffer);
  return target;
}

/** Close any browser this process started. For shutdown and for tests. */
async function shutdown() {
  const session = current;
  current = null;
  if (session) await session.close().catch(() => {});
}

module.exports = {
  BrowserSession,
  checkNavigableUrl,
  saveScreenshot,
  shutdown,
  findTargetScript,
  VIEWPORT,
  ALLOWED_SCHEMES,
};
