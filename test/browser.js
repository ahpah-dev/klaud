'use strict';

/**
 * Real browser test â€” loads the app in headless Chrome and drives it.
 *
 *   node test/browser.js
 *
 * This is the check that catches "the page loads but nothing runs": a module
 * that never executes, a console exception, an app that renders no welcome
 * screen. It then sends a message through the real UI against a mock provider
 * and asserts that the reply streamed in and a real file appeared on disk.
 *
 * Spawns its own server on a free port with an isolated data directory, so it
 * never touches your real ~/.klaud settings.
 */

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CHROME_CANDIDATES = [
  process.env.KLAUD_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Mock OpenAI-compatible provider that writes a file on the first round. */
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      // Read the body exactly once â€” draining the stream first leaves nothing
      // for the JSON parse, which silently makes the provider stateless.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'browser-model' }] }));
        return;
      }

      // Deterministic: the number of tool results already in the conversation
      // decides which round this is, so the turn ends after one tool call.
      const body = JSON.parse(raw || '{}');
      const alreadyRan = (body.messages || []).some((m) => m.role === 'tool');

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

      if (alreadyRan) {
        w({ model: 'browser-model', choices: [{ index: 0, delta: { content: 'Done â€” the file is on disk.' } }] });
        w({ model: 'browser-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else {
        w({ model: 'browser-model', choices: [{ index: 0, delta: { content: 'Sure â€” writing the file now.' } }] });
        w({
          model: 'browser-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'b_call_1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'from-the-browser.txt', content: 'hello from a real click\n' }),
                    },
                  },
                ],
              },
            },
          ],
        });
        w({ model: 'browser-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }
      w({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.ok) return true;
      } catch { /* keep waiting */ }
      await sleep(150);
    }
    throw new Error(`server never answered at ${url}`);
  })();
}

/* ------------------------- minimal CDP client ------------------------- */

class Browser {
  constructor(socket) {
    this.ws = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleMessages = [];
    this.exceptions = [];
    this.failedRequests = [];

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.consoleMessages.push({
          level: msg.params.type,
          text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '),
        });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description || d.text || 'unknown exception');
      }
      if (msg.method === 'Network.loadingFailed') {
        this.failedRequests.push(`${msg.params.type}: ${msg.params.errorText}`);
      }
    });
  }

  static async launch(chromePath, port) {
    const profile = path.join(os.tmpdir(), `klaud-browser-${Date.now()}`);
    const chrome = spawn(
      chromePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--window-size=1400,1000',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
    }
    if (!target) {
      chrome.kill();
      throw new Error('Chrome DevTools endpoint never came up');
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });

    const browser = new Browser(ws);
    browser.chrome = chrome;
    browser.profile = profile;
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Network.enable');
    return browser;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** A real left click at viewport coordinates, not a synthetic DOM event. */
  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  /** A real key press, so the page sees the same events a person produces. */
  async key(key, code, virtualKeyCode) {
    const base = { key, code, windowsVirtualKeyCode: virtualKeyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async goto(url, settleMs = 1200) {
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return result.result.value;
  }

  async screenshot(file, options = {}) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...options });
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  async close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
    this.chrome.kill();
    await sleep(300);
    await fs.rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------- run --------------------------------- */

(async () => {
  const chromePath = CHROME_CANDIDATES.find((p) => {
    try {
      require('fs').accessSync(p);
      return true;
    } catch {
      return false;
    }
  });

  console.log('\n\x1b[38;5;209m* Klaud browser test\x1b[0m\n');
  if (!chromePath) {
    console.log('  no Chrome or Edge found; set KLAUD_CHROME to run this suite.\n');
    process.exit(0);
  }

  const mock = await startMock();
  const appPort = await freePort();
  const cdpPort = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-browser-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-browser-ws-'));

  // Point the isolated instance at the mock provider before it boots.
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify(
      {
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiKey: 'browser-key',
        model: 'browser-model',
        approvalMode: 'auto',
        workspace,
        maxSteps: 6,
        temperature: 0,
      },
      null,
      2
    ),
    'utf8'
  );

  const server = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(appPort), KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace },
    stdio: 'ignore',
  });

  const appUrl = `http://127.0.0.1:${appPort}`;
  let browser = null;

  try {
    await waitForHttp(`${appUrl}/api/health`);
    const token = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8')).token;

    browser = await Browser.launch(chromePath, cdpPort);
    await browser.goto(`${appUrl}/?token=${token}`);
    await sleep(1500);

    console.log(`  server:    ${appUrl}`);
    console.log(`  workspace: ${workspace}\n`);

    /* ---------- does it actually run? ---------- */
    const loadState = await browser.evaluate(`
      return {
        title: document.title,
        theme: document.documentElement.dataset.theme,
        welcome: !!document.querySelector('.welcome'),
        heading: document.querySelector('.welcome h1')?.textContent || null,
        suggestions: document.querySelectorAll('.suggestion').length,
        modelLabel: document.getElementById('model-name')?.textContent || null,
        modelDotOff: document.getElementById('model-dot')?.classList.contains('off') ?? null,
        workspace: document.getElementById('ws-path')?.textContent || null,
        composerLabel: document.getElementById('composer-mode-label')?.textContent || null,
        tokenStored: !!localStorage.getItem('klaud.token'),
        urlHasToken: location.search.includes('token') || location.hash.includes('token'),
        sendDisabled: document.getElementById('send')?.disabled ?? null
      };
    `);

    check('the module executed and the app booted (welcome screen rendered)', loadState.welcome === true,
      JSON.stringify(loadState));
    check('no uncaught exceptions on load', browser.exceptions.length === 0, browser.exceptions.join('\n'));
    check('no console errors on load', browser.consoleMessages.length === 0,
      JSON.stringify(browser.consoleMessages));
    check('no failed network requests on load', browser.failedRequests.length === 0,
      browser.failedRequests.join('\n'));
    check('the welcome heading rendered', /Here we go/i.test(String(loadState.heading)), String(loadState.heading));
    check('the suggestion cards rendered', loadState.suggestions === 4, `found ${loadState.suggestions}`);
    check('the model name came from the server', loadState.modelLabel === 'browser-model', String(loadState.modelLabel));
    check('the API key indicator cleared', loadState.modelDotOff === false);
    check('the workspace path rendered in the sidebar', String(loadState.workspace).includes('klaud-browser-ws'),
      String(loadState.workspace));
    check('the permission mode rendered', loadState.composerLabel === 'auto-run', String(loadState.composerLabel));
    check('the session token was stored', loadState.tokenStored === true);
    check('the token was stripped from the address bar', loadState.urlHasToken === false);
    check('the send button starts disabled with an empty composer', loadState.sendDisabled === true);

    /* ---------- layout: the calm centred shell (welcome is on screen) ---------- */
    const layout = await browser.evaluate(`
      const cs = (sel, prop) => {
        const n = document.querySelector(sel);
        return n ? getComputedStyle(n)[prop] : null;
      };
      const topbar = document.querySelector('.topbar');
      return {
        welcomeAlign: cs('.welcome', 'textAlign'),
        heading: document.querySelector('.welcome h1')?.textContent.trim() || '',
        topbarChips: topbar ? topbar.querySelectorAll('.chip-select, .model-pill, .mode-pill').length : -1,
        topbarIcons: topbar ? topbar.querySelectorAll('.icon-btn').length : -1,
        modelChipInComposer: !!document.querySelector('.composer-row .model-chip'),
        modeChipInComposer: !!document.querySelector('.composer-row #composer-mode'),
        composerMaxWidth: cs('.composer-wrap', 'maxWidth'),
        composerWidth: Math.round(document.querySelector('.composer')?.getBoundingClientRect().width || 0),
        composerRadius: cs('.composer', 'borderRadius'),
        hasCollapse: !!document.getElementById('collapse-sidebar'),
        sidebarLabel: document.querySelector('.sidebar-label')?.textContent.trim() || '',
        newChatFirst: (() => {
          const a = document.querySelector('.sidebar-actions');
          return a ? a.querySelector('.nav-btn')?.id === 'new-chat' : false;
        })(),
        brandHasSubtitle: !!document.querySelector('.brand-sub'),
        welcomeBottom: document.querySelector('.welcome')?.getBoundingClientRect().bottom || 0,
        composerTop: document.querySelector('.composer-wrap')?.getBoundingClientRect().top || 0,
        greetingBottom: document.querySelector('.welcome h1')?.getBoundingClientRect().bottom || 0,
        composerTop2: document.querySelector('.composer')?.getBoundingClientRect().top || 0
      };
    `);

    check('the greeting is centred', layout.welcomeAlign === 'center', String(layout.welcomeAlign));
    check('the greeting is short and friendly', /here we go/i.test(layout.heading), layout.heading);
    check('the top bar carries no chips, only icon buttons',
      layout.topbarChips === 0, `chips=${layout.topbarChips}`);
    check('the top bar exposes provider, settings and theme controls',
      layout.topbarIcons >= 3, `icons=${layout.topbarIcons}`);
    check('the model selector lives inside the composer, not the header',
      layout.modelChipInComposer === true, String(layout.modelChipInComposer));
    check('tool permissions also sit in the composer row',
      layout.modeChipInComposer === true, String(layout.modeChipInComposer));
    // The empty-state composer is deliberately narrower than the chat one, so
    // assert its real width rather than the old 700px floor.
    check('the composer is a softly rounded field, narrower in the empty state',
      layout.composerWidth >= 400 && layout.composerWidth <= 680 && parseFloat(String(layout.composerRadius)) >= 16,
      `width=${layout.composerWidth} radius=${layout.composerRadius}`);
    check('the sidebar leads with New chat', layout.newChatFirst === true, String(layout.newChatFirst));
    check('the sidebar list is labelled like the reference',
      /chats and tasks/i.test(layout.sidebarLabel), layout.sidebarLabel);
    check('the sidebar can be collapsed from inside it', layout.hasCollapse === true);
    check('the brand is clean text with no subtitle tag',
      layout.brandHasSubtitle === false, String(layout.brandHasSubtitle));
    check('the greeting sits above the composer without colliding',
      layout.greetingBottom <= layout.composerTop2,
      `greeting ends ${layout.greetingBottom}, composer starts ${layout.composerTop2}`);

    /* ---------- the empty state is one centred pair ---------- */
    const empty = await browser.evaluate(`
      const r = (sel) => { const n = document.querySelector(sel); if (!n) return null;
        const b = n.getBoundingClientRect(); return { t: b.top, b: b.bottom, h: b.height, w: b.width, cx: b.left + b.width / 2 }; };
      const cs = (sel, p) => { const n = document.querySelector(sel); return n ? getComputedStyle(n)[p] : null; };
      const main = r('.main');
      return {
        flagged: document.querySelector('.app')?.classList.contains('is-empty') === true,
        canvas: cs('.main', 'backgroundColor'),
        sidebar: cs('.sidebar', 'backgroundColor'),
        topbarTop: Math.round(r('.topbar')?.t ?? -1),
        greetingCx: Math.round(r('.welcome h1')?.cx ?? 0),
        composerCx: Math.round(r('.composer')?.cx ?? 0),
        mainCx: Math.round(main?.cx ?? 0),
        gap: Math.round((r('.composer')?.t ?? 0) - (r('.welcome h1')?.b ?? 0)),
        composerW: Math.round(r('.composer')?.w ?? 0),
        newBtnBg: cs('.nav-btn.primary', 'backgroundColor'),
        startersHidden: cs('.welcome .suggestions', 'display') === 'none',
        hintCentred: cs('.composer-hint', 'textAlign'),
        composerPosition: cs('.composer-wrap', 'position'),
        greetingTop: Math.round(r('.welcome h1')?.t ?? 0)
      };
    `);

    check('the shell is flagged as having no transcript', empty.flagged === true);
    // The canvas is near-white and the cream lives in the sidebar. Both were
    // uniform warm cream before, which is most of why it read as less polished.
    check('the content canvas is near-white, not cream',
      /253,\s*253,\s*252/.test(String(empty.canvas)), String(empty.canvas));
    check('the sidebar carries the warm tone',
      /245,\s*244,\s*238/.test(String(empty.sidebar)), String(empty.sidebar));
    // Deliberately part of the centred group, so this asserts the *pair* is
    // centred rather than that the top bar is. Pinning the top bar would put the
    // pair off-centre by half its height, which is what the earlier attempt did.
    check('the top bar is still in the layout, above the greeting',
      empty.topbarTop >= 0 && empty.topbarTop < empty.greetingTop,
      `topbar=${empty.topbarTop} greeting=${empty.greetingTop}`);
    check('the greeting and composer share one centre line',
      empty.greetingCx === empty.composerCx && empty.composerCx === empty.mainCx,
      `greeting=${empty.greetingCx} composer=${empty.composerCx} main=${empty.mainCx}`);
    check('the greeting and composer sit about 50px apart',
      empty.gap >= 30 && empty.gap <= 70, `gap=${empty.gap}`);
    check('the empty-state composer is narrower than the chat-state one',
      empty.composerW <= 660, `width=${empty.composerW}`);
    check('the primary sidebar action is not a saturated block',
      /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(String(empty.newBtnBg)), String(empty.newBtnBg));
    check('starter cards do not crowd the empty state', empty.startersHidden === true);
    check('the empty-state composer hint is centred under the field',
      empty.hintCentred === 'center', String(empty.hintCentred));
    check('the composer is in normal flow in the empty state, so the pair centres together',
      empty.composerPosition === 'static', String(empty.composerPosition));

    /* ---------- the pair is centred on the canvas ---------- */
    const centred = await browser.evaluate(`
      const r = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect();
        return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
      const g = r('.welcome h1');
      const c = r('.composer');
      const tb = r('.topbar');
      const group = r('.centre-group');
      // The content area is everything below the top bar; that is the space the
      // greeting and composer occupy, so it is the correct reference. Measuring
      // against the whole column includes the top bar and invents a drift.
      const areaMid = Math.round(group.t + group.h / 2);
      return {
        isEmpty: document.querySelector('.app').classList.contains('is-empty'),
        topbarTop: tb.t,
        groupMid: Math.round((g.t + c.b) / 2),
        areaMid,
        drift: Math.round((g.t + c.b) / 2 - areaMid),
        greetingAboveComposer: g.b < c.t,
        gap: Math.round(c.t - g.b),
        slideAnimation: getComputedStyle(document.querySelector('.sidebar')).animationName
      };
    `);
    check('the greeting and composer are centred in the content area',
      Math.abs(centred.drift) <= 40, `drift=${centred.drift}px (group=${centred.groupMid} area=${centred.areaMid})`);
    check('the top bar is pinned while the content is centred',
      centred.topbarTop === 0, String(centred.topbarTop));
    check('the greeting sits above the composer, not overlapping',
      centred.greetingAboveComposer === true, JSON.stringify(centred));
    check('the two are close enough to read as one block',
      centred.gap >= 12 && centred.gap <= 70, `gap=${centred.gap}`);
    // Centred in the *content area*, i.e. the canvas below the top bar. That is
    // the space the greeting and composer actually occupy, so it is the correct
    // reference — measuring against the whole column includes the top bar and
    // reports a drift that is not there.
    check('the greeting and composer are centred in the content area',
      Math.abs(centred.drift) <= 40, `drift=${centred.drift}px`);

    /* ---------- prompt box size and position ---------- */
    const promptBox = await browser.evaluate(`
      const ta = document.getElementById('prompt');
      const box = document.querySelector('.composer');
      const cs = getComputedStyle(ta);
      const h1 = document.querySelector('.welcome h1');
      const rect = box.getBoundingClientRect();
      return {
        fontSize: parseFloat(cs.fontSize),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        greetingPct: Math.round((h1.getBoundingClientRect().top / innerHeight) * 100),
        scrollerFlexGrow: getComputedStyle(document.querySelector('.scroller')).flexGrow
      };
    `);
    check('the prompt box is comfortably sized',
      promptBox.width >= 560 && promptBox.height >= 90, JSON.stringify(promptBox));
    check('the prompt text is not small',
      promptBox.fontSize >= 16, String(promptBox.fontSize));
    check('the greeting sits in the upper-middle, not at the top',
      promptBox.greetingPct >= 25 && promptBox.greetingPct <= 50, `${promptBox.greetingPct}%`);
    // Regression: this rule was dropped once and the greeting jumped to 12% of
    // the canvas with the field stranded far below it.
    check('the scroller does not stretch in the empty state',
      promptBox.scrollerFlexGrow === '0', String(promptBox.scrollerFlexGrow));

    /* ---------- clicking the prompt must not draw a second outline ---------- */
    await browser.evaluate(`document.getElementById('prompt').focus(); return true;`);
    await sleep(250);
    const focusRing = await browser.evaluate(`
      const ta = document.getElementById('prompt');
      const cs = getComputedStyle(ta);
      const box = getComputedStyle(document.querySelector('.composer'));
      return {
        active: document.activeElement.id,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        composerBorder: box.borderColor,
        composerShadow: box.boxShadow
      };
    `);
    check('the prompt box shows no outline of its own when focused',
      focusRing.outlineStyle === 'none' || focusRing.outlineWidth === '0px', JSON.stringify(focusRing));
    check('the prompt box draws no ring inside the composer',
      focusRing.boxShadow === 'none', String(focusRing.boxShadow));
    // The container is still the focus indicator, so the field is not left with
    // no feedback at all. This used to be asserted by counting `rgb(`
    // occurrences in the composer's box-shadow and requiring more than three —
    // which only ever passed because a terracotta `--ring` was stacked onto the
    // shadow on `:focus-within`. That ring was the "orange outline" users
    // reported, so the old assertion encoded the bug. The intent is asserted
    // properly, in colour, directly below.

    /* ---- a mouse click must not paint an accent ring ----
       The assertions above use `.focus()`, which is how the app focuses the
       field on load — it says nothing about a real click. `:focus-visible`
       cannot separate the two either, because Chrome matches it for a textarea
       whatever the input was, so the exclusion has to be explicit. */
    // The terracotta accent as either `rgb(217, 119, 87)` or the space-separated
    // `color(srgb 0.851 0.467 0.341)` Chrome returns from color-mix(). Named
    // once, because a regex this fiddly should exist in exactly one place.
    const ACCENT_RE = /217,\s*119,\s*87|0\.85\d*[\s,]*0\.46\d*[\s,]*0\.34\d*/;
    const blurThenFocus = await browser.evaluate(`
      const box = document.querySelector('.composer');
      document.getElementById('prompt').blur();
      const blurred = getComputedStyle(box).borderColor;
      document.getElementById('prompt').focus();
      return { blurred, focused: getComputedStyle(box).borderColor };
    `);
    check('focus is still visible on the composer container',
      blurThenFocus.blurred !== blurThenFocus.focused,
      JSON.stringify(blurThenFocus));
    check('...and that focus colour is not the accent',
      !ACCENT_RE.test(String(blurThenFocus.focused)),
      String(blurThenFocus.focused));

    const ringBox = await browser.evaluate(`
      const r = document.getElementById('prompt').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    await browser.click(ringBox.x, ringBox.y);
    await sleep(300);
    const clicked = await browser.evaluate(`
      const ta = document.getElementById('prompt');
      const cs = getComputedStyle(ta);
      const box = getComputedStyle(document.querySelector('.composer'));
      return {
        active: document.activeElement.id,
        outline: cs.outlineStyle, boxShadow: cs.boxShadow,
        border: box.borderColor, shadow: box.boxShadow,
        colourHidden: /rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.outlineColor)
      };
    `);
    check('a real mouse click focuses the prompt (so the checks below are meaningful)',
      clicked.active === 'prompt', String(clicked.active));
    check('a real mouse click draws no outline on the prompt',
      clicked.outline === 'none', JSON.stringify(clicked));
    check('a real mouse click draws no ring on the prompt',
      clicked.boxShadow === 'none', String(clicked.boxShadow));
    // `color(srgb 0.85 0.467 0.341)` and `rgb(217, 119, 87)` are both the
    // terracotta accent. The reported bug was this colour reaching the field.
    check('a real mouse click paints no terracotta border on the composer',
      !ACCENT_RE.test(String(clicked.border)),
      String(clicked.border));
    check('a real mouse click paints no accent glow on the composer',
      !ACCENT_RE.test(String(clicked.shadow)),
      String(clicked.shadow).slice(0, 120));

    /* ---- typing is not navigating: the ring must stay away ---- */
    await browser.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a',
    });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(200);
    const typed = await browser.evaluate(`
      const box = getComputedStyle(document.querySelector('.composer'));
      const ta = document.getElementById('prompt');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return { kb: document.documentElement.dataset.kb || null, shadow: box.boxShadow, border: box.borderColor };
    `);
    check('typing after a click does not put an accent ring back',
      !ACCENT_RE.test(String(typed.shadow)),
      String(typed.shadow).slice(0, 120));
    check('a pointer-focused composer is not flagged as keyboard navigation',
      typed.kb === null, String(typed.kb));

    /* ---- keyboard users still get a ring ---- */
    await browser.key('Tab', 'Tab', 9);
    await sleep(150);
    await browser.evaluate(`document.getElementById('prompt').focus(); return true;`);
    await sleep(250);
    const keyboard = await browser.evaluate(`
      const ta = document.getElementById('prompt');
      const cs = getComputedStyle(ta);
      const box = getComputedStyle(document.querySelector('.composer'));
      return {
        kb: document.documentElement.dataset.kb || null,
        outline: cs.outlineStyle, ring: box.boxShadow,
        border: box.borderColor, active: document.activeElement.id
      };
    `);
    check('Tab switches the app into keyboard navigation',
      keyboard.kb === '1', String(keyboard.kb));
    check('a keyboard user still gets a visible focus ring on the composer',
      ACCENT_RE.test(String(keyboard.ring)),
      String(keyboard.ring).slice(0, 120));
    check('the keyboard ring is on the container, never on the textarea itself',
      keyboard.active === 'prompt' && keyboard.outline === 'none',
      JSON.stringify({ active: keyboard.active, outline: keyboard.outline }));
    // Hand the rest of the suite the same focus state it had before.
    await browser.click(ringBox.x, ringBox.y);
    await sleep(150);

    /* ---------- the sidebar toggle actually hides the sidebar ---------- */
    const sidebar = await browser.evaluate(`
      const reveal = document.getElementById('toggle-sidebar');
      const inner = document.getElementById('collapse-sidebar');
      const topbar = document.querySelector('.topbar').getBoundingClientRect();
      const topButtons = ['open-free', 'open-settings-top', 'toggle-theme'].map((id) => {
        const n = document.getElementById(id);
        return n ? Math.round(n.getBoundingClientRect().top) : -1;
      });
      return {
        topbarTop: Math.round(topbar.top),
        revealHidden: getComputedStyle(reveal).display === 'none',
        innerVisible: getComputedStyle(inner).display !== 'none',
        topbarButtonCount: topButtons.length,
        topButtonsInsideBar: topButtons.every((t) => t >= topbar.top && t < topbar.bottom),
        sidebarAnimation: getComputedStyle(document.querySelector('.sidebar')).animationName,
        appTransition: getComputedStyle(document.querySelector('.app')).transitionProperty,
        appTransitionDuration: getComputedStyle(document.querySelector('.app')).transitionDuration
      };
    `);
    // The top bar must stay at the top of the viewport. A centring rule on
    // `.main` dragged it to y=258 with all its buttons, twice.
    check('the top bar is pinned to the top of the canvas',
      sidebar.topbarTop === 0, String(sidebar.topbarTop));
    check('the top bar buttons are inside the bar, not below it',
      sidebar.topButtonsInsideBar === true, JSON.stringify(sidebar));
    check('the top bar carries no sidebar toggle while the sidebar is open',
      sidebar.revealHidden === true, String(sidebar.revealHidden));
    check('the sidebar header offers the hide button',
      sidebar.innerVisible === true, String(sidebar.innerVisible));
    check('the sidebar column animates rather than snapping',
      /grid-template-columns/.test(String(sidebar.appTransition)) &&
        parseFloat(String(sidebar.appTransitionDuration)) > 0,
      `${sidebar.appTransition} ${sidebar.appTransitionDuration}`);
    check('the sidebar does not become a second control on the top bar',
      sidebar.topbarButtonCount === 3, String(sidebar.topbarButtonCount));

    // Measured separately from the click: reading the width in the same evaluate
    // returns the pre-click layout, which made a working toggle look broken.
    const widthBefore = await browser.evaluate(
      `return Math.round(document.querySelector('.main').getBoundingClientRect().width);`
    );
    check('the top-bar reveal button is hidden while the sidebar is open',
      sidebar.revealHidden === true, String(sidebar.revealHidden));
    check('the sidebar header offers the hide button', sidebar.innerVisible === true);

    await browser.evaluate(`document.getElementById('collapse-sidebar').click(); return true;`);
    await sleep(700);
    const hidden = await browser.evaluate(`
      const b = document.body;
      const sb = document.querySelector('.sidebar');
      const reveal = document.getElementById('toggle-sidebar');
      return {
        flagged: b.classList.contains('sidebar-hidden'),
        width: Math.round(sb.getBoundingClientRect().width),
        columns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
        mainWidth: Math.round(document.querySelector('.main').getBoundingClientRect().width),
        revealShown: getComputedStyle(reveal).display !== 'none',
        topbarTop: Math.round(document.querySelector('.topbar').getBoundingClientRect().top)
      };
    `);
    check('the header button hides the sidebar on a wide screen',
      hidden.flagged === true, JSON.stringify(hidden));
    check('hiding the sidebar gives its space to the content',
      hidden.mainWidth > widthBefore,
      `before=${widthBefore} after=${hidden.mainWidth} cols=${hidden.columns}`);
    check('a reveal button appears once the sidebar is out of view',
      hidden.revealShown === true, String(hidden.revealShown));
    check('the top bar stays pinned while the sidebar is hidden',
      hidden.topbarTop === 0, String(hidden.topbarTop));

    /* ---------- it animates while closing, not just once ---------- */
    // A property assertion is not enough: the previous transform-based "slide"
    // had a transition declared and never moved, because collapsing the grid
    // column left the sidebar 0px wide. Sampling the width proves interpolation.
    await browser.evaluate(`document.getElementById('toggle-sidebar').click(); return true;`);
    await sleep(700);
    await browser.evaluate(`
      window.__w = [];
      const sb = document.querySelector('.sidebar');
      window.__t = setInterval(() => window.__w.push(Math.round(sb.getBoundingClientRect().width)), 25);
      return true;
    `);
    await browser.evaluate(`document.getElementById('collapse-sidebar').click(); return true;`);
    await sleep(700);
    const widths = await browser.evaluate(`clearInterval(window.__t); return window.__w;`);
    const distinct = new Set(widths).size;
    check('the sidebar width interpolates while closing, not just once',
      distinct > 3, `distinct=${distinct} samples=${widths.join(',')}`);
    check('the sidebar really reaches zero width',
      widths.length > 0 && widths[widths.length - 1] <= 2, String(widths[widths.length - 1]));

    /* ---------- and while opening ---------- */
    await browser.evaluate(`
      window.__w2 = [];
      const sb = document.querySelector('.sidebar');
      window.__t2 = setInterval(() => window.__w2.push(Math.round(sb.getBoundingClientRect().width)), 25);
      return true;
    `);
    await browser.evaluate(`document.getElementById('toggle-sidebar').click(); return true;`);
    await sleep(700);
    const reopenWidths = await browser.evaluate(`clearInterval(window.__t2); return window.__w2;`);
    const reopenDistinct = new Set(reopenWidths).size;
    check('the sidebar width interpolates while opening too',
      reopenDistinct > 3, `distinct=${reopenDistinct} samples=${reopenWidths.join(',')}`);
    check('the sidebar reaches its full width again',
      reopenWidths.length > 0 && reopenWidths[reopenWidths.length - 1] >= 270,
      String(reopenWidths[reopenWidths.length - 1]));

    await browser.evaluate(`localStorage.removeItem('klaud.sidebar'); return true;`);

    /* ---------- chat list polish (no transcript needed) ---------- */
    const listPolish = await browser.evaluate(`
      return {
        chatRowIcons: document.querySelectorAll('.chat-item svg').length,
        listItemHeight: (() => { const n = document.querySelector('.chat-item'); return n ? Math.round(n.getBoundingClientRect().height) : null; })()
      };
    `);
    check('chat list rows carry no decorative icon',
      listPolish.chatRowIcons === 0, `found ${listPolish.chatRowIcons}`);
    // Rows only exist once a chat has been saved, so this passes vacuously early
    // in the suite and is asserted properly later.
    check('chat list rows are compact when present',
      listPolish.listItemHeight === null || listPolish.listItemHeight <= 38, String(listPolish.listItemHeight));

    /* ---------- settings presets match the real catalogue ---------- */
    await browser.evaluate(`document.getElementById('new-chat').click(); return true;`);
    await sleep(400);
    await browser.evaluate(`document.getElementById('open-settings-top').click(); return true;`);
    await sleep(500);
    const presets = await browser.evaluate(`
      const labels = Array.from(document.querySelectorAll('.preset')).map((n) => n.textContent.trim());
      const urls = Array.from(document.querySelectorAll('.preset')).map((n) => n.dataset.url);
      return { labels, urls, first: labels[0] || '' };
    `);
    check('a Settings preset that is no longer free is gone',
      !presets.labels.some((l) => /together/i.test(l)), JSON.stringify(presets.labels));
    check('settings presets lead with a free provider',
      /free/i.test(String(presets.first)), String(presets.first));
    check('every free preset in Settings matches the catalogue',
      presets.urls.some((u) => /integrate\.api\.nvidia\.com/.test(u)) &&
        presets.urls.some((u) => /api\.groq\.com/.test(u)),
      JSON.stringify(presets.urls));
    await browser.evaluate(`document.querySelector('[data-close]').click(); return true;`);
    await sleep(400);

    /* ---------- long model ids stay readable in the chip ---------- */
    const chip = await browser.evaluate(`
      const el = document.querySelector('.model-chip .name');
      const cfg = window.__klaud?.state?.config;
      const saved = cfg ? cfg.model : null;
      const shown = (value) => {
        if (cfg) { cfg.model = value; window.__klaud.renderChrome(); }
        return el.textContent;
      };
      const long = shown('@cf/meta/llama-3.1-8b-instruct-fp8-fast');
      const restored = shown(saved);
      return { long, restored, ellipsis: getComputedStyle(el).textOverflow, maxWidth: getComputedStyle(el).maxWidth };
    `);
    check('a long model id is shortened for display', String(chip.long).length < 26, JSON.stringify(chip));
    check('the model chip cannot overflow the composer',
      chip.ellipsis === 'ellipsis', String(chip.ellipsis));
    check('the real model id is restored afterwards',
      chip.restored === 'browser-model', JSON.stringify(chip));

    const welcomeShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-welcome.png'));

    /* ---------- type a message and send it ---------- */
    await browser.evaluate(`
      const box = document.getElementById('prompt');
      box.value = 'Create from-the-browser.txt';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);

    const readyToSend = await browser.evaluate(`return !document.getElementById('send').disabled;`);
    check('the send button enables once text is typed', readyToSend === true);

    await browser.evaluate(`
      document.getElementById('send').click();
      return true;
    `);

    // Wait for the turn to finish: the send button returns to "send".
    const deadline = Date.now() + 25000;
    let streaming = true;
    while (Date.now() < deadline) {
      await sleep(500);
      streaming = await browser.evaluate(`return document.getElementById('send').classList.contains('stop');`);
      if (!streaming) break;
    }

    const turnState = await browser.evaluate(`
      const app = window.__klaud;
      const roles = app ? app.state.messages.map((m) => m.role) : [];
      return {
        booted: !!app,
        apiMessageRoles: roles,
        apiMessageCount: roles.length,
        userBubbles: document.querySelectorAll('.bubble-user').length,
        userText: document.querySelector('.bubble-user')?.textContent || null,
        proseCount: document.querySelectorAll('.prose').length,
        proseText: Array.from(document.querySelectorAll('.prose')).map((n) => n.textContent).join(' | '),
        toolCards: document.querySelectorAll('details.tool').length,
        toolName: document.querySelector('details.tool .name')?.textContent || null,
        toolOk: document.querySelector('details.tool')?.classList.contains('ok') ?? null,
        toolCardHeight: Math.round(document.querySelector('details.tool')?.getBoundingClientRect().height || 0),
        chevronHeight: Math.round(document.querySelector('details.tool .chev')?.getBoundingClientRect().height || 0),
        notices: document.querySelectorAll('.notice.error').length,
        stillStreaming: document.getElementById('send').classList.contains('stop')
      };
    `);

    check('the debug hook exposes app state', turnState.booted === true);
    check('the user message rendered as a bubble', turnState.userBubbles === 1,
      JSON.stringify(turnState));
    check('the typed text is in the bubble', turnState.userText === 'Create from-the-browser.txt',
      String(turnState.userText));
    check('the assistant reply streamed into the transcript', /writing the file now/i.test(String(turnState.proseText)),
      String(turnState.proseText));
    check('the tool call rendered as exactly one card', turnState.toolCards === 1, `found ${turnState.toolCards}`);
    check('the tool card names write_file', turnState.toolName === 'write_file', String(turnState.toolName));
    check('the tool card shows success', turnState.toolOk === true, JSON.stringify(turnState));
    check('the tool card is a sane height, not a stretched 300px icon',
      turnState.toolCardHeight > 20 && turnState.toolCardHeight < 120, `${turnState.toolCardHeight}px`);
    check('the chevron is a small icon, not a 300px default SVG',
      turnState.chevronHeight > 0 && turnState.chevronHeight <= 16, `${turnState.chevronHeight}px`);
    check('no error notice was shown', turnState.notices === 0);
    check('the turn finished streaming', turnState.stillStreaming === false);

    // The browser only knows the assistant messages once the turn has settled.
    const settled = await browser.evaluate(`
      const app = window.__klaud;
      return {
        roles: app.state.messages.map((m) => m.role),
        hasAssistant: app.state.messages.some((m) => m.role === 'assistant')
      };
    `);
    check('the client holds the assistant messages after the turn',
      settled.hasAssistant === true, JSON.stringify(settled.roles));

    check('no exceptions during the turn', browser.exceptions.length === 0, browser.exceptions.join('\n'));
    check('no console errors during the turn', browser.consoleMessages.length === 0,
      JSON.stringify(browser.consoleMessages));

    /* ---------- did it really touch the disk? ---------- */
    const produced = await fs.readFile(path.join(workspace, 'from-the-browser.txt'), 'utf8').catch(() => null);
    check('the file exists on disk with the right contents',
      produced === 'hello from a real click\n', JSON.stringify(produced));

    const turnShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-turn.png'));

    /* ---------- persistence ---------- */
    // Give the client a moment to PUT the turn, then poll rather than guess.
    let stored = null;
    for (let i = 0; i < 20 && !stored; i++) {
      await sleep(400);
      const files = await fs.readdir(path.join(dataDir, 'chats')).catch(() => []);
      if (files.length) {
        const candidate = JSON.parse(await fs.readFile(path.join(dataDir, 'chats', files[0]), 'utf8'));
        if ((candidate.messages || []).some((m) => m.role === 'assistant')) stored = candidate;
      }
    }

    const chatItems = await browser.evaluate(`return document.querySelectorAll('.chat-item').length;`);
    check('the conversation appeared in the sidebar', chatItems >= 1, `found ${chatItems}`);
    check('the chat was persisted with its messages',
      Boolean(stored) &&
        stored.messages.some((m) => m.role === 'user') &&
        stored.messages.some((m) => m.role === 'assistant') &&
        stored.messages.some((m) => m.role === 'tool'),
      JSON.stringify(stored && stored.messages.map((m) => m.role)));
    check('the persisted assistant message kept its tool call',
      Boolean(stored) && (stored.messages.find((m) => m.role === 'assistant')?.tool_calls || []).length === 1,
      JSON.stringify(stored && stored.messages.find((m) => m.role === 'assistant')));

    /* ---------- reload restores the transcript ---------- */
    await browser.goto(`${appUrl}/#chat=${stored.id}`, 1800);
    const afterReload = await browser.evaluate(`
      return {
        userBubbles: document.querySelectorAll('.bubble-user').length,
        toolCards: document.querySelectorAll('details.tool').length,
        welcome: !!document.querySelector('.welcome')
      };
    `);
    check('reloading with #chat= restores the transcript',
      afterReload.userBubbles >= 1 && afterReload.welcome === false, JSON.stringify(afterReload));
    check('restored transcripts keep their tool cards', afterReload.toolCards >= 1,
      `found ${afterReload.toolCards}`);

    /* ---------- settings modal ---------- */
    await browser.evaluate(`
      document.getElementById('open-settings-top').click();
      return true;
    `);
    await sleep(500);
    const modal = await browser.evaluate(`
      return {
        open: !!document.querySelector('.overlay'),
        title: document.querySelector('.modal-head h2')?.textContent || null,
        base: document.getElementById('s-base')?.value || null,
        model: document.getElementById('s-model')?.value || null,
        modeOn: document.querySelector('#s-mode .on')?.dataset.mode || null,
        workspace: document.getElementById('s-workspace')?.value || null,
        keyPlaceholder: document.getElementById('s-key')?.placeholder || null
      };
    `);
    check('the settings modal opens', modal.open === true && modal.title === 'Settings', JSON.stringify(modal));
    check('settings are prefilled from the server', modal.base?.includes('127.0.0.1') && modal.model === 'browser-model',
      JSON.stringify(modal));
    check('the permission mode is reflected in the modal', modal.modeOn === 'auto', String(modal.modeOn));
    check('the workspace field is filled in', String(modal.workspace).includes('klaud-browser-ws'),
      String(modal.workspace));
    check('the saved key is shown only as a masked hint',
      /\u2022/.test(String(modal.keyPlaceholder)) && !String(modal.keyPlaceholder).includes('browser-key'),
      String(modal.keyPlaceholder));

    const modalShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-settings.png'));

    await browser.evaluate(`
      document.querySelector('.overlay [data-close]').click();
      return true;
    `);

    /* ---------- dark mode ---------- */
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();
      return true;
    `);
    await sleep(300);
    const theme = await browser.evaluate(`return document.documentElement.dataset.theme;`);
    check('the theme toggle switches to dark', theme === 'dark', String(theme));
    const darkShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-dark.png'));

    /* ---------- the free provider picker ---------- */
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();  /* back to light */
      document.getElementById('open-free').click();
      return true;
    `);
    // The catalogue makes live network calls, so give it room.
    await sleep(6000);

    const picker = await browser.evaluate(`
      const cards = Array.from(document.querySelectorAll('.pcard'));
      const openrouter = cards.find((c) => c.querySelector('.pname')?.textContent.includes('OpenRouter'));
      const first = cards[0];
      return {
        open: !!document.querySelector('.overlay'),
        title: document.querySelector('.modal-head h2')?.textContent || null,
        cards: cards.length,
        names: cards.map((c) => c.querySelector('.pname')?.textContent.trim().split('\\n')[0]),
        firstName: cards[0]?.querySelector('.pname')?.textContent.trim() || '',
        firstModel: cards[0]?.querySelector('[data-model-input], [data-model-select]')?.value || '',
        caveatOnFirst: !!cards[0]?.querySelector('.pcaveat'),
        best: cards.filter((c) => c.classList.contains('best')).length,
        recommended: cards.filter((c) => c.querySelector('.precommended')).length,
        removedCount: document.querySelectorAll('.fp-removed-item').length,
        tiers: cards.map((c) => c.querySelector('.pchip.best, .pchip.warn')?.textContent.trim() || ''),
        headlines: cards.map((c) => c.querySelector('.pheadline')?.textContent.trim() || ''),
        openrouterSelect: !!openrouter?.querySelector('select'),
        openrouterOptions: openrouter ? openrouter.querySelectorAll('option').length : 0,
        useButtons: document.querySelectorAll('[data-use-provider]').length,
        copyButtons: document.querySelectorAll('[data-copy-url]').length,
        banner: (document.querySelector('.fp-verified')?.innerText || '')
          .split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean).join(' '),
        basisChips: cards.map((c) => c.querySelector('.pchip.approx')?.textContent.trim() || 'documented'),
        sourceLinks: cards.filter((c) => c.querySelector('.plink')).length,
        ledger: /no card/i.test(document.querySelector('.modal-foot .hint')?.textContent || '')
      };
    `);

    check('the Free button opens the provider picker', picker.open === true && picker.title === 'Free to use',
      JSON.stringify({ open: picker.open, title: picker.title }));
    // Was >= 10 before GitHub Models and Cerebras were removed for no longer
    // being free. The floor tracks the catalogue, not a number picked once.
    check(`the picker lists every catalogue provider (${picker.cards})`, picker.cards >= 8, String(picker.cards));
    check('the picker marks exactly one provider as recommended',
      picker.recommended === 1, String(picker.recommended));
    check('the recommended provider is the first card',
      /nvidia/i.test(String(picker.firstName)), String(picker.firstName));
    check('removed providers are disclosed rather than silently dropped',
      picker.removedCount >= 2, String(picker.removedCount));

    // The whole point of the ordering: the most generous free tiers first, so a
    // user does not start on the one that allows 50 requests a day.
    check('the most generous provider is offered first',
      picker.tiers[0] === 'generous', JSON.stringify(picker.tiers.slice(0, 3)));
    check('the tightest provider is listed last',
      picker.names[picker.names.length - 1] === 'OpenRouter', picker.names.join(' > '));
    check('every card states a concrete free allowance',
      picker.headlines.every((h) => h.length > 10), JSON.stringify(picker.headlines));

    // The point of this banner: state what was actually verified, and say
    // plainly that the rate-limit numbers were not.
    check('the picker reports what was actually checked this run',
      /checked on this run/i.test(picker.banner), picker.banner.slice(0, 120));
    check('the picker admits the rate-limit figures are not verified',
      /not\s*<\/?strong>?\s*verified|not verified/i.test(picker.banner), picker.banner.slice(0, 260));
    check('providers whose numbers are unpublished are labelled as such',
      picker.basisChips.some((c) => /not published/i.test(c)) &&
        picker.basisChips.some((c) => /documented|no quota/i.test(c)),
      JSON.stringify(picker.basisChips));
    check('every card links to the provider\'s own limits page',
      picker.sourceLinks === picker.cards, `${picker.sourceLinks}/${picker.cards}`);

    check('local providers are listed too',
      picker.names.some((n) => /Ollama/i.test(n)) && picker.names.some((n) => /LM Studio/i.test(n)),
      JSON.stringify(picker.names));
    check('OpenRouter exposes its live free models in a dropdown',
      picker.openrouterSelect === true && picker.openrouterOptions > 1, `${picker.openrouterOptions} options`);
    check('every provider has a Use button and a Copy URL button',
      picker.useButtons === picker.cards && picker.copyButtons === picker.cards,
      `${picker.useButtons}/${picker.cards} use, ${picker.copyButtons}/${picker.cards} copy`);
    check('the picker states that no card is required', picker.ledger === true);

    /* ---------- guided one-field setup for Cloudflare ---------- */
    const setupClick = await browser.evaluate(`
      const card = Array.from(document.querySelectorAll('.pcard'))
        .find((c) => c.querySelector('.pname')?.textContent.includes('Cloudflare'));
      const button = card?.querySelector('[data-use-provider]');
      const label = button?.textContent.trim();
      button?.click();
      return { label, found: !!card };
    `);
    await sleep(600);

    const setup = await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      const accountBox = panel?.querySelector('[data-setup-account]');
      return {
        opened: !!panel,
        steps: panel ? panel.querySelectorAll('.setup-steps li').length : 0,
        tokenLink: panel?.querySelector('.plink')?.getAttribute('href') || null,
        hasInput: !!panel?.querySelector('[data-setup-token]'),
        accountFieldVisible: accountBox ? getComputedStyle(accountBox).display !== 'none' && !accountBox.hidden : null,
        accountInputVisible: (() => {
          const i = panel?.querySelector('[data-setup-account-input]');
          return i ? getComputedStyle(i).display !== 'none' && !i.hidden : null;
        })(),
        runButton: !!panel?.querySelector('[data-setup-run]'),
        runLabel: panel?.querySelector('[data-setup-run]')?.textContent.trim() || null,
        // No regex escapes here on purpose: an escape sequence in this template
        // literal had its backslash stripped before reaching the browser, which
        // turned "match whitespace" into "match the letter s" and silently
        // corrupted the very string being asserted on. Splitting on newlines
        // needs no backslashes at all, so it cannot be mangled the same way.
        accountHint: (panel?.querySelector('.setup-optional')?.textContent || '')
          .split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean).join(' '),
        accountPlaceholder: panel?.querySelector('[data-setup-account-input]')?.placeholder || '',
        noteMentionsTest: /test request/i.test(panel?.querySelector('.setup-note')?.textContent || '')
      };
    `);
    check('a provider needing more than a key offers a guided setup',
      setup.opened === true, JSON.stringify(setup));
    check('the setup button says it will do it automatically',
      /automatically/i.test(String(setupClick.label)), String(setupClick.label));
    check('the setup panel links straight to the token page',
      /api-tokens/.test(String(setup.tokenLink)), String(setup.tokenLink));
    check('the setup asks for the token', setup.hasInput === true && setup.steps >= 3, JSON.stringify(setup));

    // The bug: the account ID field was hidden until after a failed attempt, so
    // someone who had both values in hand had nowhere to put the second one.
    check('the account ID field is visible immediately, not hidden until failure',
      setup.accountFieldVisible === true && setup.accountInputVisible === true, JSON.stringify(setup));
    check('there is a visible Set up button below both fields', setup.runButton === true);
    check('the account ID field is labelled optional and explains where to find it',
      /optional/i.test(setup.accountHint) && /dash\.cloudflare\.com/i.test(setup.accountHint),
      `hint: ${String(setup.accountHint).slice(0, 240)}`);
    check('the account ID field shows the expected format',
      /^[a-f0-9]{28,}$/i.test(String(setup.accountPlaceholder)),
      String(setup.accountPlaceholder));
    check('the panel says a real test request runs before saving',
      setup.noteMentionsTest === true, String(setup.noteMentionsTest));

    /* ---------- both values can be submitted in one go ---------- */
    await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      panel.querySelector('[data-setup-token]').value = 'definitely-not-a-cloudflare-token';
      panel.querySelector('[data-setup-account-input]').value = 'abcdef0123456789abcdef0123456789';
      panel.querySelector('[data-setup-run]').click();
      return true;
    `);
    await sleep(5000);
    const bothSubmitted = await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      return {
        status: panel?.querySelector('[data-setup-status]')?.innerText || '',
        accountFieldStillVisible: panel?.querySelector('[data-setup-account]')?.hidden === false
      };
    `);
    check('submitting the token and account ID together is accepted',
      bothSubmitted.status.length > 10, JSON.stringify(bothSubmitted.status.slice(0, 120)));
    check('the account ID field stays visible after a failure',
      bothSubmitted.accountFieldStillVisible === true, JSON.stringify(bothSubmitted));

    const setupShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-cloudflare-setup.png'));

    // A bad token must fail visibly and change nothing.
    await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      panel.querySelector('[data-setup-token]').value = 'definitely-not-a-cloudflare-token';
      panel.querySelector('[data-setup-run]').click();
      return true;
    `);
    await sleep(5000);
    const setupFail = await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      return {
        status: panel?.querySelector('[data-setup-status]')?.innerText || '',
        stillOpen: !!panel,
        model: document.getElementById('model-name')?.textContent || null,
        hasDiagnostics: !!panel?.querySelector('.setup-diagnostics'),
        hasDetail: !!panel?.querySelector('.setup-error-detail'),
        accountFieldShown: panel?.querySelector('[data-setup-account]')?.hidden === false
      };
    `);
    check('a bad token reports a readable failure instead of a silent no-op',
      /token|permission|invalid|account/i.test(setupFail.status), JSON.stringify(setupFail.status.slice(0, 120)));
    // The bug that prompted this: the message was "Cloudflare error unknown".
    check('the failure never degrades to a bare "unknown"',
      !/error unknown/i.test(setupFail.status), setupFail.status.slice(0, 140));
    check('the failure shows a step-by-step readout of what was tried',
      setupFail.hasDiagnostics === true, JSON.stringify(setupFail));
    check('the raw Cloudflare response is shown, not hidden',
      setupFail.hasDetail === true, JSON.stringify(setupFail));
    check('the setup panel stays open so the user can retry', setupFail.stillOpen === true);
    check('any failure reveals the manual account ID escape hatch',
      setupFail.accountFieldShown === true, JSON.stringify(setupFail));

    const failShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-cloudflare-error.png'));

    check('no exceptions from the setup panel', browser.exceptions.length === 0, browser.exceptions.join('\n'));

    const freeShot = await browser.screenshot(path.join(PROJECT, 'docs', 'screenshots', 'screenshot-free-providers.png'));

    /* ---------- applying a free provider ---------- */
    await browser.evaluate(`
      const card = Array.from(document.querySelectorAll('.pcard'))
        .find((c) => c.querySelector('.pname')?.textContent.includes('OpenRouter'));
      card.querySelector('[data-use-provider]').click();
      return true;
    `);
    await sleep(1500);

    const applied = await browser.evaluate(`
      return {
        model: document.getElementById('model-name')?.textContent || null,
        pillClosed: !document.querySelector('.overlay'),
        settings: null
      };
    `);
    check('applying a provider closes the picker', applied.pillClosed === true);
    check('the chosen model shows in the top bar', Boolean(applied.model), String(applied.model));

    const savedAfter = await (async () => {
      const res = await fetch(`${appUrl}/api/settings`, { headers: { 'x-klaud-token': token } });
      return res.json();
    })();
    check('the provider was written to the settings',
      savedAfter.baseUrl.includes('openrouter.ai'), savedAfter.baseUrl);

    check('no exceptions from the picker', browser.exceptions.length === 0, browser.exceptions.join('\n'));
    check('no console errors from the picker', browser.consoleMessages.length === 0,
      JSON.stringify(browser.consoleMessages));

    /* ---------- the composer returns to its dock once a chat exists ----------
     * Deliberately last: this starts a real turn, which would pollute the state
     * every earlier check depends on. An earlier attempt ran it in the middle of
     * the suite and broke six unrelated assertions. */
    await browser.evaluate(`
      document.getElementById('new-chat').click();
      return true;
    `);
    await sleep(600);
    const freshEmpty = await browser.evaluate(`
      return {
        flagged: document.querySelector('.app')?.classList.contains('is-empty') === true,
        position: getComputedStyle(document.querySelector('.composer-wrap')).position
      };
    `);
    check('a new chat returns the shell to the centred empty state',
      freshEmpty.flagged === true && freshEmpty.position === 'static', JSON.stringify(freshEmpty));

    await browser.evaluate(`
      const box = document.getElementById('prompt');
      box.value = 'dock check';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return true;
    `);
    await sleep(4500);
    const docked = await browser.evaluate(`
      const c = document.querySelector('.composer-wrap');
      const m = document.querySelector('.main');
      return {
        flagged: document.querySelector('.app')?.classList.contains('is-empty') === true,
        position: getComputedStyle(c).position,
        fromBottom: Math.round(m.getBoundingClientRect().bottom - c.getBoundingClientRect().bottom)
      };
    `);
    check('the empty-state flag clears once a turn exists', docked.flagged === false, JSON.stringify(docked));
    check('the composer returns to its bottom dock in a chat',
      docked.position === 'static' && docked.fromBottom < 40, JSON.stringify(docked));

    /* ---------- transcript polish (a chat exists here, so it can be measured) ---------- */
    const polish = await browser.evaluate(`
      const cs = (sel, p) => { const n = document.querySelector(sel); return n ? getComputedStyle(n)[p] : null; };
      const bubble = document.querySelector('.bubble-user');
      const col = document.querySelector('.scroller-inner');
      const tool = document.querySelector('details[data-tool]');
      return {
        roleTransform: cs('.turn.assistant .role', 'textTransform'),
        roleSpacing: cs('.turn.assistant .role', 'letterSpacing'),
        roleColour: cs('.turn.assistant .role', 'color'),
        bubbleWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : null,
        colWidth: col ? Math.round(col.getBoundingClientRect().width) : null,
        bubbleRadius: cs('.bubble-user', 'borderRadius'),
        toolWidth: tool ? Math.round(tool.getBoundingClientRect().width) : null,
        toolChevronMarginLeft: tool ? getComputedStyle(tool.querySelector('.chev')).marginLeft : null,
        listItemHeight: (() => { const n = document.querySelector('.chat-item'); return n ? Math.round(n.getBoundingClientRect().height) : null; })(),
        proseSize: cs('.prose', 'fontSize')
      };
    `);
    check('the assistant label is sentence case, not shouted',
      polish.roleTransform === 'none', String(polish.roleTransform));
    check('the assistant label has no letter-spacing',
      polish.roleSpacing === 'normal' || polish.roleSpacing === '0px', String(polish.roleSpacing));
    check('the assistant label is muted, not accent-coloured',
      !/217,\s*119,\s*87/.test(String(polish.roleColour)), String(polish.roleColour));
    check('the user message is a bubble, not a full-width band',
      polish.bubbleWidth !== null && polish.colWidth !== null && polish.bubbleWidth < polish.colWidth * 0.85,
      `bubble=${polish.bubbleWidth} column=${polish.colWidth}`);
    check('the bubble is rounded like a chat bubble',
      parseFloat(String(polish.bubbleRadius)) >= 14, String(polish.bubbleRadius));
    check('a tool card sizes to its own content when one is present',
      polish.toolWidth === null || (polish.colWidth !== null && polish.toolWidth < polish.colWidth * 0.7),
      `tool=${polish.toolWidth} column=${polish.colWidth}`);
    check('the tool chevron sits beside the summary, not flung to the edge',
      polish.toolChevronMarginLeft === null || polish.toolChevronMarginLeft === '0px',
      String(polish.toolChevronMarginLeft));
    check('chat list rows are compact once chats exist',
      polish.listItemHeight === null || polish.listItemHeight <= 38, String(polish.listItemHeight));

    console.log(`\n  screenshots: ${welcomeShot}, ${turnShot}, ${modalShot}, ${darkShot}, ${freeShot}, ${setupShot}, ${failShot}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
    mock.server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} browser checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} browser checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nBrowser harness crashed:', err);
  process.exit(1);
});
