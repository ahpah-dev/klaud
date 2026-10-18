/**
 * capture-site-screenshots.js
 * Generates pixel-perfect Retina (2x DPR) screenshots of the current Klaud app
 * for the marketing website (site/img/).
 */

const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'nemotron-3.5-120b' }] }));
        return;
      }

      const body = JSON.parse(raw || '{}');
      const toolResults = (body.messages || []).filter((m) => m.role === 'tool');

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

      if (toolResults.length === 0) {
        // Step 1: Explain and call edit_file
        w({
          model: 'nemotron-3.5-120b',
          choices: [{
            index: 0,
            delta: { content: "I'll update the session validator in `src/auth.js` to enforce token expiry and run the test suite to verify.\n\n" }
          }]
        });
        w({
          model: 'nemotron-3.5-120b',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_edit_1',
                type: 'function',
                function: {
                  name: 'edit_file',
                  arguments: JSON.stringify({
                    path: 'src/auth.js',
                    old_string: "  const token = req.headers['authorization'];\n  if (!token) return res.writeHead(401).end();",
                    new_string: "  const token = req.headers['authorization'];\n  if (!token || token.expiresAt < Date.now()) {\n    res.writeHead(401, { 'content-type': 'application/json' });\n    return res.end(JSON.stringify({ error: 'token_expired' }));\n  }",
                  }),
                },
              }],
            },
          }],
        });
        w({ model: 'nemotron-3.5-120b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else if (toolResults.length === 1) {
        // Step 2: Call run_command
        w({
          model: 'nemotron-3.5-120b',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_run_1',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: JSON.stringify({
                    command: 'node test/auth.test.js',
                  }),
                },
              }],
            },
          }],
        });
        w({ model: 'nemotron-3.5-120b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // Step 3: Final confirmation
        w({
          model: 'nemotron-3.5-120b',
          choices: [{
            index: 0,
            delta: {
              content: 'Authentication middleware refactored and verified. Expired tokens are now rejected with HTTP 401 and an explicit error payload, and all 3 unit tests pass.'
            }
          }]
        });
        w({ model: 'nemotron-3.5-120b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }

      w({ choices: [], usage: { prompt_tokens: 34, completion_tokens: 28, total_tokens: 62 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  async screenshot(outFile, options = {}) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...options,
    });
    await fs.writeFile(outFile, Buffer.from(shot.data, 'base64'));
    console.log(`  Saved screenshot: ${outFile}`);
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

async function launchBrowser(port) {
  const profile = path.join(os.tmpdir(), `klaud-screen-${Date.now()}`);
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=1400,940',
      '--force-device-scale-factor=2',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) {
    chrome.kill();
    throw new Error('Chrome endpoint failed to start');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const client = new CDPClient(ws);
  client.chrome = chrome;
  client.profile = profile;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1384,
    height: 905,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return client;
}

(async () => {
  console.log('Capturing authentic current app screenshots...');
  const mock = await startMockProvider();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-shot-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-shot-ws-'));

  // Pre-seed realistic workspace files
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'src', 'auth.js'),
    `// Session authentication middleware\nmodule.exports = function authMiddleware(req, res, next) {\n  const token = req.headers['authorization'];\n  if (!token) return res.writeHead(401).end();\n  next();\n};\n`
  );
  await fs.writeFile(
    path.join(workspace, 'test', 'auth.test.js'),
    `console.log('✓ validates active session token');\nconsole.log('✓ rejects expired session tokens with 401');\nconsole.log('✓ rejects malformed headers');\nconsole.log('\\nAll 3 tests passed (142ms)');\nprocess.exit(0);\n`
  );
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'my-project', version: '1.0.0' }, null, 2)
  );

  // Pre-populate settings
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify(
      {
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiKey: 'nvapi-free-key',
        model: 'nemotron-3.5-120b',
        approvalMode: 'auto',
        workspace: workspace,
        maxSteps: 8,
        temperature: 0,
      },
      null,
      2
    )
  );

  // Pre-populate other chats in sidebar
  await fs.mkdir(path.join(dataDir, 'chats'), { recursive: true });
  const otherChats = [
    { id: 'chat-rate-limit', title: 'Add rate-limiting to API routes', time: Date.now() - 3600000 * 2 },
    { id: 'chat-docker-setup', title: 'Setup Docker multi-stage build', time: Date.now() - 3600000 * 24 },
    { id: 'chat-websocket-backoff', title: 'Fix WebSocket reconnect backoff', time: Date.now() - 3600000 * 48 },
  ];
  for (const c of otherChats) {
    await fs.writeFile(
      path.join(dataDir, 'chats', `${c.id}.json`),
      JSON.stringify({ id: c.id, title: c.title, created: c.time, updated: c.time, messages: [] })
    );
  }

  // Start Klaud server
  const serverPort = 24894;
  const cdpPort = 24895;

  const server = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(serverPort), KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace },
    stdio: 'ignore',
  });

  await sleep(1500);

  const session = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8'));
  const appUrl = `http://127.0.0.1:${serverPort}/?token=${session.token}`;

  let browser;
  try {
    browser = await launchBrowser(cdpPort);
    await browser.send('Page.navigate', { url: appUrl });
    await sleep(2000);

    const imgDir = path.join(PROJECT, 'site', 'img');

    // Clean display labels
    const fixLabels = `
      const ws = document.getElementById('ws-path');
      if (ws) ws.textContent = 'my-project';
      const composerWs = document.getElementById('composer-ws-label');
      if (composerWs) composerWs.textContent = 'my-project';
      const model = document.getElementById('model-name');
      if (model) model.textContent = 'nemotron-3.5-120b';
      const hint = document.getElementById('composer-hint');
      if (hint && hint.textContent.includes('tokens')) {
        hint.textContent = '186 tokens this turn · Klaud runs real commands in my-project';
      }
    `;
    await browser.evaluate(fixLabels);

    // 1. Capture WELCOME screenshot (Chat mode with Anthropic Serif font)
    await browser.evaluate(fixLabels);
    await browser.screenshot(path.join(imgDir, 'hero-welcome.png'));
    console.log('✓ hero-welcome.png captured');

    // 2. Capture COWORK screenshot (Cowork mode with Anthropic Serif font and Cowork starter cards)
    await browser.evaluate(`
      document.getElementById('mode-cowork').click();
    `);
    await sleep(800);
    await browser.evaluate(fixLabels);
    await browser.screenshot(path.join(imgDir, 'cowork.png'));
    console.log('✓ cowork.png updated');

    // Switch back to Chat mode
    await browser.evaluate(`
      document.getElementById('mode-chat').click();
    `);
    await sleep(500);

    // 3. Execute a turn to capture the active chat with tool cards and diffs!
    await browser.evaluate(`
      const box = document.getElementById('prompt');
      box.value = 'Refactor authentication middleware to check token expiration and verify with tests';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
    `);

    // Wait for the turn to complete
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(500);
      const streaming = await browser.evaluate(`return document.getElementById('send').classList.contains('stop');`);
      if (!streaming) break;
    }
    await sleep(1500);

    // Expand tool cards and fix labels
    await browser.evaluate(`
      document.querySelectorAll('details.tool').forEach(d => d.open = true);
      ${fixLabels}
    `);
    await sleep(500);

    // 4. Capture HERO screenshot (rich active turn with Claude styling, tool diff, command output)
    await browser.screenshot(path.join(imgDir, 'hero.png'));
    console.log('✓ hero.png updated');

    // 5. Capture TOOLS screenshot (focused on tool cards & diff)
    await browser.screenshot(path.join(imgDir, 'tools.png'));
    console.log('✓ tools.png updated');

    // 6. Capture DARK screenshot (dark mode active)
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();
    `);
    await sleep(700);
    await browser.evaluate(fixLabels);
    await browser.screenshot(path.join(imgDir, 'dark.png'));
    console.log('✓ dark.png updated');

  } finally {
    if (browser) await browser.close();
    server.kill();
    mock.server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  console.log('All screenshots captured successfully!');
  process.exit(0);
})().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
