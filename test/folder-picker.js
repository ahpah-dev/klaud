'use strict';

/**
 * Folder browser and workspace-picker test.
 *
 *   node test/folder-picker.js
 *
 * Covers the three ways the picker used to fail:
 *   1. Typing a path appended to the existing value instead of replacing it,
 *      producing "C:\newC:\old" and "path not found".
 *   2. There was no way to create a folder at all, so starting a new project
 *      was impossible from the UI.
 *   3. A bad path failed silently in the list area instead of saying why.
 *
 * Drives the real page in headless Chrome against its own server.
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

  /** Real keystrokes, so select-on-focus and append-vs-replace both show up. */
  async type(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(120);
  }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await sleep(900);
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

  console.log('\n\x1b[38;5;209m* Klaud folder picker test\x1b[0m\n');
  if (!chromePath) {
    console.log('  no Chrome or Edge found; set KLAUD_CHROME to run this suite.\n');
    process.exit(0);
  }

  const appPort = await freePort();
  const cdpPort = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-picker-data-'));
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-picker-sandbox-'));
  const profile = path.join(os.tmpdir(), `klaud-picker-profile-${Date.now()}`);

  // A parent with one child folder, so both navigation and creation are testable.
  const parent = path.join(sandbox, 'projects');
  const workspace = path.join(parent, 'existing-app');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.js'), 'console.log(1);\n', 'utf8');

  const server = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(appPort), KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  const TOKEN_HEADERS = {};

  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    await waitForHttp(`${appUrl}/api/health`);
    const token = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8')).token;
    TOKEN_HEADERS['x-klaud-token'] = token;

    /* ---------- the endpoint ---------- */
    const created = await fetch(`${appUrl}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...TOKEN_HEADERS },
      body: JSON.stringify({ parent, name: 'brand-new-project' }),
    });
    const createdBody = await created.json();
    check('POST /api/fs/mkdir creates a folder', created.status === 201 && createdBody.created === true,
      `${created.status} ${JSON.stringify(createdBody)}`);
    const stat = await fs.stat(path.join(parent, 'brand-new-project')).catch(() => null);
    check('the folder really exists on disk', Boolean(stat && stat.isDirectory()));

    const again = await fetch(`${appUrl}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...TOKEN_HEADERS },
      body: JSON.stringify({ parent, name: 'brand-new-project' }),
    });
    const againBody = await again.json();
    check('creating an existing folder succeeds idempotently',
      again.status === 200 && againBody.created === false, `${again.status} ${JSON.stringify(againBody)}`);

    for (const [label, payload, expect] of [
      ['rejects path separators', { parent, name: 'a/b' }, /cannot use/],
      ['rejects a name of ".."', { parent, name: '..' }, /cannot use/],
      ['rejects an empty name', { parent, name: '  ' }, /Type a folder name/],
      ['rejects a missing parent', { parent: path.join(sandbox, 'nope'), name: 'x' }, /does not exist/],
      ['rejects a file as parent', { parent: path.join(workspace, 'index.js'), name: 'x' }, /does not exist/],
    ]) {
      const res = await fetch(`${appUrl}/api/fs/mkdir`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...TOKEN_HEADERS },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      check(label, res.status === 400 && expect.test(body.error || ''), `${res.status} ${JSON.stringify(body)}`);
    }

    /* ---------- the UI ---------- */
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
      } catch { /* wait */ }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    await page.goto(`${appUrl}/?token=${token}`);
    await page.evaluate(`document.getElementById('workspace-chip').click(); return true;`);
    await sleep(1400);

    const opened = await page.evaluate(`
      return {
        title: document.querySelector('.modal-head h2')?.textContent || null,
        path: document.getElementById('b-path')?.value || null,
        newButton: !!document.getElementById('b-new'),
        footButtons: Array.from(document.querySelectorAll('.modal-foot button')).map((b) => b.textContent.trim())
      };
    `);
    check('clicking the workspace chip opens the picker', opened.title === 'Choose a folder', JSON.stringify(opened));
    check('the picker starts at the current workspace', String(opened.path).endsWith('existing-app'), String(opened.path));
    check('there is a New folder button', opened.newButton === true && opened.footButtons.some((b) => /new folder/i.test(b)),
      JSON.stringify(opened.footButtons));

    /* ---------- typing must replace, not append ---------- */
    await page.evaluate(`const el = document.getElementById('b-path'); el.focus(); el.select(); return true;`);
    const typedPath = path.join(parent, 'typed-target');
    await page.type(typedPath);
    const afterTyping = await page.evaluate(`return document.getElementById('b-path').value;`);
    check('typing a path replaces the old value instead of appending to it',
      afterTyping.trim() === typedPath, `field holds ${JSON.stringify(afterTyping)}`);

    // The field's own Enter key should navigate, and report failure clearly.
    await page.pressEnter();
    const afterEnter = await page.evaluate(`
      return {
        status: document.getElementById('b-status')?.innerText || '',
        pathReset: document.getElementById('b-path')?.value || null
      };
    `);
    check('a nonexistent path reports why it failed',
      /not found|does not exist|no such/i.test(afterEnter.status), JSON.stringify(afterEnter.status));
    check('a failed navigation resets the path field to where we are',
      String(afterEnter.pathReset).endsWith('existing-app'), String(afterEnter.pathReset));

    /* ---------- navigate to the parent by typing ---------- */
    await page.evaluate(`const el = document.getElementById('b-path'); el.focus(); el.select(); return true;`);
    await page.type(parent);
    await page.pressEnter();

    const navigated = await page.evaluate(`
      return {
        path: document.getElementById('b-path')?.value || null,
        listed: Array.from(document.querySelectorAll('#b-list .model-item')).map((n) => n.textContent.trim()),
        emptyHint: /New folder/i.test(document.getElementById('b-list')?.innerText || '')
      };
    `);
    check('typing the parent path navigates to it', navigated.path === parent, String(navigated.path));
    check('the sibling project folder is listed', navigated.listed.includes('existing-app'),
      JSON.stringify(navigated.listed));

    /* ---------- create a folder through the UI ---------- */
    await page.evaluate(`document.getElementById('b-new').click(); return true;`);
    await sleep(400);

    const formShown = await page.evaluate(`
      return { form: !!document.getElementById('b-newform'), focused: document.activeElement?.id || null };
    `);
    check('New folder opens a name field and focuses it',
      formShown.form === true && formShown.focused === 'b-new-input', JSON.stringify(formShown));

    const uiName = 'made-from-the-ui';
    await page.type(uiName);
    await page.evaluate(`document.getElementById('b-new-create').click(); return true;`);
    await sleep(1500);

    const made = await page.evaluate(`
      return {
        status: document.getElementById('b-status')?.innerText || '',
        path: document.getElementById('b-path')?.value || null,
        formGone: !document.getElementById('b-newform'),
        useLabel: document.getElementById('b-use')?.textContent || '',
        listed: Array.from(document.querySelectorAll('#b-list .model-item')).map((n) => n.textContent.trim())
      };
    `);
    const onDisk = await fs.stat(path.join(parent, uiName)).catch(() => null);
    check('creating a folder from the UI says it worked', /created/i.test(made.status), JSON.stringify(made.status));
    check('the new folder exists on disk', Boolean(onDisk && onDisk.isDirectory()));
    check('the picker enters the new folder', String(made.path).endsWith(uiName), String(made.path));
    check('the name form closes after creating', made.formGone === true);
    check('from inside the new folder, the sibling is one level Up', made.listed.length === 0,
      JSON.stringify(made.listed));

    /* ---------- pick the folder we just created ---------- */
    const useLabel = await page.evaluate(`return document.getElementById('b-use')?.textContent || '';`);
    check('the Use button names the folder it will select', useLabel.includes(uiName), JSON.stringify(useLabel));

    await page.evaluate(`document.getElementById('b-use').click(); return true;`);
    await sleep(1200);
    const picked = await page.evaluate(`
      return {
        overlay: !!document.querySelector('.overlay'),
        workspace: document.getElementById('ws-path')?.textContent || null
      };
    `);
    check('Use this folder closes the picker', picked.overlay === false);
    check('the created folder becomes the workspace', String(picked.workspace).endsWith(uiName),
      String(picked.workspace));

    const info = await (await fetch(`${appUrl}/api/info`, { headers: TOKEN_HEADERS })).json();
    check('the server persisted the new workspace', info.workspace.endsWith(uiName), info.workspace);

    /* ---------- Up + relabel, the case that used to pick the wrong folder ---------- */
    await page.evaluate(`document.getElementById('workspace-chip').click(); return true;`);
    await sleep(1200);
    await page.evaluate(`document.getElementById('b-up').click(); return true;`);
    await sleep(900);
    const afterUp = await page.evaluate(`
      return {
        listed: Array.from(document.querySelectorAll('#b-list .model-item')).map((n) => n.textContent.trim()),
        useLabel: document.getElementById('b-use')?.textContent || ''
      };
    `);
    check('Up returns to the parent and lists both folders',
      afterUp.listed.includes('existing-app') && afterUp.listed.includes(uiName), JSON.stringify(afterUp.listed));
    check('the Use button relabels to the folder now open, so it cannot pick the wrong one',
      afterUp.useLabel.includes('projects') && !afterUp.useLabel.includes(uiName), JSON.stringify(afterUp.useLabel));

    /* ---------- a rejected name is explained ---------- */
    await page.evaluate(`document.getElementById('b-new').click(); return true;`);
    await sleep(300);
    await page.type('bad/name');
    await page.evaluate(`document.getElementById('b-new-create').click(); return true;`);
    await sleep(1200);
    const badName = await page.evaluate(`
      return { status: document.getElementById('b-status')?.innerText || '', formStillOpen: !!document.getElementById('b-newform') };
    `);
    check('an unusable folder name is explained, and the form stays open',
      /cannot use/i.test(badName.status) && badName.formStillOpen === true, JSON.stringify(badName));

    await page.evaluate(`document.getElementById('b-new-cancel').click(); return true;`);
    await sleep(200);

    check('no uncaught exceptions in the picker', page.exceptions.length === 0, page.exceptions.join('\n'));
  } finally {
    server.kill();
    chrome.kill();
    await sleep(300);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} folder picker checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} folder picker checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nPicker harness crashed:', err);
  process.exit(1);
});
