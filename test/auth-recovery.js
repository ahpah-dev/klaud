'use strict';

/**
 * Session-token recovery test.
 *
 *   node test/auth-recovery.js
 *
 * A stale token in browser storage used to be a dead end: every request 401'd,
 * including the settings call, so the UI showed "Unauthorized" and offered no
 * way back in. This drives the real page through that exact state and asserts
 * the user can recover without touching devtools.
 *
 * Spawns its own server on a throwaway data directory.
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

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* keep waiting */ }
    await sleep(150);
  }
  throw new Error(`server never answered at ${url}`);
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result);
        this.pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = this.id++;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async goto(url, settle = 2500) {
    await this.send('Page.navigate', { url });
    await sleep(settle);
  }
}

(async () => {
  const chromePath = CHROME_CANDIDATES.find((p) => {
    try {
      require('fs').accessSync(p);
      return true;
    } catch {
      return false;
    }
  });

  console.log('\n\x1b[38;5;209m* Klaud session recovery test\x1b[0m\n');
  if (!chromePath) {
    console.log('  no Chrome or Edge found; set KLAUD_CHROME to run this suite.\n');
    process.exit(0);
  }

  const appPort = await freePort();
  const cdpPort = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-auth-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-auth-ws-'));
  const profile = path.join(os.tmpdir(), `klaud-auth-profile-${Date.now()}`);

  const server = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(appPort), KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => (serverOutput += d));
  server.stderr.on('data', (d) => (serverOutput += d));

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1300,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let page = null;

  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    await waitForHttp(`${appUrl}/api/health`);
    const token = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8')).token;

    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* wait */ }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    /* ---------- the good path ---------- */
    await page.goto(`${appUrl}/?token=${token}`);
    const authorized = await page.evaluate(`
      return {
        heading: document.querySelector('.welcome h1')?.textContent || null,
        model: document.getElementById('model-name')?.textContent || null,
        stored: (() => { try { return localStorage.getItem('klaud.token') ? 'yes' : 'no'; } catch (e) { return 'blocked'; } })()
      };
    `);
    check('the printed URL authorizes the browser', /Here we go/i.test(String(authorized.heading)),
      JSON.stringify(authorized));
    check('the token is stored for next time', authorized.stored === 'yes');

    /* ---------- plant a stale token ---------- */
    await page.evaluate(`localStorage.setItem('klaud.token', 'STALE-TOKEN-FROM-AN-OLD-RUN'); return true;`);
    await page.goto(appUrl);

    const stuck = await page.evaluate(`
      return {
        heading: document.querySelector('.welcome h1')?.textContent || null,
        hasRecovery: !!document.querySelector('.recovery'),
        hasCta: !!document.getElementById('recover-open'),
        hasInput: !!document.getElementById('recover-token'),
        staleCleared: (() => { try { return localStorage.getItem('klaud.token') === null; } catch (e) { return false; } })(),
        mentionsTerminal: /terminal/i.test(document.body.innerText)
      };
    `);
    check('a stale token shows the re-authorization screen, not a dead end',
      stuck.hasRecovery === true, JSON.stringify(stuck));
    check('the screen leads with a one-click fix', stuck.hasCta === true);
    check('the heading says it is one click', /one button/i.test(String(stuck.heading)), String(stuck.heading));
    check('the stale token is cleared from storage', stuck.staleCleared === true);
    check('the paste-a-token fallback is still offered', stuck.hasInput === true);
    check('the manual instructions are still available', stuck.mentionsTerminal === true);

    /* ---------- the one-click path ---------- */
    const authorize = await page.evaluate(`
      return fetch('/api/authorize', { method: 'POST' })
        .then((r) => r.json().then((b) => ({ status: r.status, body: b })));
    `);
    check('POST /api/authorize works without a token and returns a URL',
      authorize.status === 200 && authorize.body.ok === true && /token=/.test(authorize.body.url || ''),
      JSON.stringify(authorize).slice(0, 200));
    check('the returned URL carries the token the server actually accepts',
      String(authorize.body.url).includes(token), String(authorize.body.url).replace(token, '<token>'));
    check('the response reports whether a browser window could be opened',
      typeof authorize.body.opened === 'boolean' && typeof authorize.body.message === 'string');

    const spoofed = await page.evaluate(`
      return fetch('/api/authorize', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } })
        .then((r) => r.status);
    `);
    check('a forwarded off-machine address is refused', spoofed === 403, String(spoofed));

    await page.evaluate(`document.getElementById('recover-open').click(); return true;`);
    await sleep(2000);
    const afterClick = await page.evaluate(`
      return { status: document.getElementById('recover-cta-status')?.innerText || '' };
    `);
    check('clicking the button tells the user what happened', afterClick.status.length > 10,
      JSON.stringify(afterClick));
    check('no uncaught exceptions from the button', page.exceptions.length === 0,
      page.exceptions.join('\n'));

    /* ---------- settings must not open an empty modal ---------- */
    const settingsClick = await page.evaluate(`
      document.getElementById('open-settings-top').click();
      return { emptyModal: !!document.querySelector('.overlay'), recovery: !!document.querySelector('.recovery') };
    `);
    check('Settings does not open an empty modal while unauthorized',
      settingsClick.emptyModal === false && settingsClick.recovery === true, JSON.stringify(settingsClick));

    /* ---------- a wrong token is refused ---------- */
    // Open the fallback the way a user would, then fill it in.
    await page.evaluate(`
      const more = document.querySelector('.recovery-more');
      if (more) more.open = true;
      return true;
    `);
    await sleep(300);
    await page.evaluate(`
      const i = document.getElementById('recover-token');
      i.value = 'not-the-right-token';
      document.getElementById('recover-go').click();
      return true;
    `);
    await sleep(1200);
    const wrong = await page.evaluate(`return document.querySelector('#recover-status')?.innerText || '';`);
    check('a wrong token is refused with a readable message', /rejected/i.test(String(wrong)), String(wrong));

    /* ---------- the right token gets you back in ---------- */
    await page.evaluate(`
      const i = document.getElementById('recover-token');
      i.value = ${JSON.stringify(token)};
      document.getElementById('recover-go').click();
      return true;
    `);
    await sleep(3200);
    const recovered = await page.evaluate(`
      return {
        heading: document.querySelector('.welcome h1')?.textContent || null,
        model: document.getElementById('model-name')?.textContent || null,
        recoveryGone: !document.querySelector('.recovery'),
        stored: (() => { try { return localStorage.getItem('klaud.token') ? 'yes' : 'no'; } catch (e) { return 'blocked'; } })()
      };
    `);
    check('pasting the right token restores the app',
      /Here we go/i.test(String(recovered.heading)) && recovered.recoveryGone === true,
      JSON.stringify(recovered));
    check('the corrected token is stored', recovered.stored === 'yes');
    check('the model config loads after recovery', recovered.model === 'gpt-4o-mini', String(recovered.model));

    /* ---------- the server tells the user where to go ---------- */
    check('the server prints the working URL when it rejects a request',
      /Unauthorized request/.test(serverOutput) && serverOutput.includes(`?token=${token}`),
      serverOutput.split('\n').filter((l) => l.includes('token')).slice(-2).join(' | '));

    check('no uncaught exceptions during recovery', page.exceptions.length === 0, page.exceptions.join('\n'));
  } finally {
    server.kill();
    chrome.kill();
    await sleep(300);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} session recovery checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} session recovery checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nRecovery harness crashed:', err);
  process.exit(1);
});
