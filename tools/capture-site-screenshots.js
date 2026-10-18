/**
 * capture-site-screenshots.js
 * Generates sanitized, pixel-perfect screenshots of the Klaud app
 * for both documentation (docs/screenshots/) and marketing (site/img/ and site/og.png).
 *
 * Privacy Guarantees:
 * - NO private chats: sidebar always displays the clean default empty state
 *   ("No conversations yet. Your chats are saved locally.")
 * - NO personal machine paths: workspace is masked to "my-project" and dataDir to "~/.klaud"
 * - NO usernames or temporary directory identifiers anywhere in the captures.
 */

const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* What the first prompt "writes": a real, self-contained Anthropic-styled page.
   It is the content of the artifact card in the marketing shots, so it has to
   be an actual page — the pane opens it in a sandboxed frame, and a page of
   lorem ipsum would show. */
const ARTIFACT_LEDE =
  "Single self-contained HTML page styled after Anthropic's warm, editorial look: " +
  'ivory and clay palette, serif headlines, a rotating burst logo, three model-tier ' +
  'cards, a principles grid, a dark research section, and a newsletter signup. ' +
  'It switches between light and dark mode and works on mobile.\n\n';

const ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anthropic Theme — an unofficial concept</title>
<style>
  :root { --ivory:#faf9f5; --ink:#141413; --clay:#d97757; --line:#e5e2d9; --muted:#5c594f; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ivory); color:var(--ink); font:17px/1.6 Georgia, "Times New Roman", serif; transition: background .25s, color .25s; }
  body.dark { --ivory:#141413; --ink:#faf9f5; --line:#33322e; --muted:#b5b1a6; }
  header { display:flex; align-items:center; justify-content:space-between; padding:18px clamp(20px,5vw,48px); border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--ivory); }
  .mark { font:700 17px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing:-.02em; }
  nav a { margin-left:22px; color:var(--ink); text-decoration:none; font:500 14px/1 ui-sans-serif, system-ui, sans-serif; }
  nav a:hover { color:var(--clay); }
  .toggle { margin-left:22px; padding:7px 15px; border:1px solid var(--line); border-radius:999px; background:transparent; color:var(--ink); font:600 13px ui-sans-serif, system-ui, sans-serif; cursor:pointer; }
  .hero { max-width:980px; margin:0 auto; padding:clamp(48px,8vw,88px) clamp(20px,5vw,48px) 36px; text-align:left; }
  .burst { width:56px; height:56px; border-radius:50%; margin-bottom:26px; background:conic-gradient(var(--clay) 0 25%, transparent 0 50%, var(--clay) 0 75%, transparent 0); animation:spin 11s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { margin:0 0 16px; font:700 clamp(32px,5.4vw,58px)/1.06 ui-sans-serif, system-ui, sans-serif; letter-spacing:-.03em; }
  .lede { margin:0; max-width:56ch; font-size:clamp(17px,2vw,21px); color:var(--muted); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(215px,1fr)); gap:16px; max-width:980px; margin:0 auto; padding:24px clamp(20px,5vw,48px) 56px; }
  .card { border:1px solid var(--line); border-radius:14px; padding:22px; background:color-mix(in srgb, var(--ink) 3%, var(--ivory)); }
  .card h3 { margin:0 0 4px; font:600 16px ui-sans-serif, system-ui, sans-serif; }
  .price { display:block; margin:10px 0 8px; color:var(--clay); font:700 26px ui-sans-serif, system-ui, sans-serif; }
  .card p { margin:0; font-size:15px; color:var(--muted); }
  .principles { max-width:980px; margin:0 auto; padding:0 clamp(20px,5vw,48px) 64px; }
  .principles h2, .research h2 { margin:0 0 20px; font:700 clamp(24px,3.4vw,34px)/1.15 ui-sans-serif, system-ui, sans-serif; letter-spacing:-.02em; }
  .p-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:20px; }
  .p-grid div { border-top:2px solid var(--clay); padding-top:12px; }
  .p-grid strong { display:block; font:600 15px ui-sans-serif, system-ui, sans-serif; margin-bottom:6px; }
  .p-grid span { font-size:15px; color:var(--muted); }
  .research { background:#141413; color:#faf9f5; padding:clamp(40px,6vw,64px) clamp(20px,5vw,48px); }
  .research p { max-width:62ch; color:#c9c5ba; font-size:16px; }
  .research .inner { max-width:980px; margin:0 auto; }
  .signup { display:flex; gap:8px; max-width:440px; margin-top:18px; }
  .signup input { flex:1; min-width:0; padding:11px 14px; border:1px solid #3a3934; border-radius:10px; background:#1f1e1c; color:#faf9f5; font:15px ui-sans-serif, system-ui, sans-serif; }
  .signup button { padding:11px 20px; border:0; border-radius:999px; background:var(--clay); color:#fff; font:600 14px ui-sans-serif, system-ui, sans-serif; cursor:pointer; }
  .ok { color:#8fd3a5; font-size:14px; margin-top:10px; }
  footer { border-top:1px solid var(--line); padding:20px clamp(20px,5vw,48px); font:13px ui-sans-serif, system-ui, sans-serif; color:var(--muted); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  @media (max-width:640px) { nav a { display:none; } }
</style>
</head>
<body>
<header>
  <div class="mark">Anthropic-ish</div>
  <nav>
    <a href="#models">Models</a><a href="#principles">Principles</a><a href="#research">Research</a>
    <button class="toggle" onclick="document.body.classList.toggle('dark')">Light / dark</button>
  </nav>
</header>

<section class="hero">
  <div class="burst" aria-hidden="true"></div>
  <h1>AI research and products that put safety at the frontier</h1>
  <p class="lede">A single self-contained page in the Anthropic style — ivory and clay, serif headlines,
  no dependencies, no build step. This is an unofficial concept, not an Anthropic site.</p>
</section>

<section class="cards" id="models">
  <div class="card"><h3>Haiku</h3><span class="price">$1</span><p>Fastest tier. Drafts, summaries and the short calls an agent makes in a loop.</p></div>
  <div class="card"><h3>Sonnet</h3><span class="price">$3</span><p>The working tier: code, review, and multi-step tool use at a steady pace.</p></div>
  <div class="card"><h3>Opus</h3><span class="price">$15</span><p>Deepest reasoning for the hard third of the work, where being right is the point.</p></div>
</section>

<section class="principles" id="principles">
  <h2>Principles</h2>
  <div class="p-grid">
    <div><strong>Safety at the frontier</strong><span>Capability and safeguards advance together, or not at all.</span></div>
    <div><strong>Honesty over polish</strong><span>Numbers are labelled published or estimated, never implied.</span></div>
    <div><strong>Yours to inspect</strong><span>Ivory, clay and type — a design system you can read in one file.</span></div>
  </div>
</section>

<section class="research" id="research">
  <div class="inner">
    <h2>Research</h2>
    <p>Interpretability, alignment and societal impacts — the work behind the products,
    published where it can be checked. This section is dark because the hours it is
    written in usually are.</p>
    <form class="signup" onsubmit="event.preventDefault(); this.innerHTML=''; document.getElementById('ok').textContent='Thanks — this is a static demo, nothing was sent.'">
      <input type="email" placeholder="you@example.com" aria-label="Email">
      <button type="submit">Subscribe</button>
    </form>
    <div class="ok" id="ok"></div>
  </div>
</section>

<footer>
  <span>Unofficial concept · not affiliated with Anthropic</span>
  <span>One file, no dependencies · Klaud artifact</span>
</footer>
</body>
</html>`;

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
      const messages = body.messages || [];

      /* Tool results from THIS turn only. The conversation carries the first
         turn's result into the second turn's request, and the two turns follow
         different scripts — counting across the whole history would start the
         second turn halfway through its own. */
      const lastUserAt = messages.map((m) => m.role).lastIndexOf('user');
      const prompt = String((messages[lastUserAt] && messages[lastUserAt].content) || '');
      const toolResults = messages.slice(lastUserAt + 1).filter((m) => m.role === 'tool');
      const refactorTurn = /refactor authentication/i.test(prompt);

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

      if (!refactorTurn && toolResults.length === 0) {
        // Turn 1: describe the page, then write it — the write is what becomes
        // the artifact card.
        w({
          model: 'nemotron-3.5-120b',
          choices: [{ index: 0, delta: { content: ARTIFACT_LEDE } }],
        });
        w({
          model: 'nemotron-3.5-120b',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_artifact_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'anthropic-theme.html', content: ARTIFACT_HTML }),
                },
              }],
            },
          }],
        });
        w({ model: 'nemotron-3.5-120b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else if (!refactorTurn) {
        w({
          model: 'nemotron-3.5-120b',
          choices: [{ index: 0, delta: { content:
            'Built anthropic-theme.html — open the artifact to preview it. It is a single file: the toggle switches light and dark, the signup is wired to a demo handler, and the footer says plainly that this is a concept rather than an Anthropic site.' } }],
        });
        w({ model: 'nemotron-3.5-120b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (toolResults.length === 0) {
        // Refactor turn, step 1: Explain and call edit_file
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
        // Refactor turn, step 2: Call run_command
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
        // Refactor turn, step 3: Final confirmation
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

  async setViewport(width, height, deviceScaleFactor = 2) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }

  async screenshot(outFile, options = {}) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...options,
    });
    await fs.writeFile(outFile, Buffer.from(shot.data, 'base64'));
    console.log(`  Saved screenshot: ${path.relative(PROJECT, outFile)}`);
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
  return client;
}

const SANITIZE_CODE = `
  // 1. Sidebar - always pristine empty state, absolutely NO mock or private chats
  const chatList = document.getElementById('chat-list');
  if (chatList) {
    chatList.innerHTML = '<div class="chat-list-empty">No conversations yet. Your chats are saved locally.</div>';
  }

  // 2. Workspace indicators - always generic "my-project"
  const ws = document.getElementById('ws-path');
  if (ws) ws.textContent = 'my-project';
  const composerWs = document.getElementById('composer-ws-label');
  if (composerWs) composerWs.textContent = 'my-project';
  const model = document.getElementById('model-name');
  if (model) model.textContent = 'nemotron-3.5-120b';

  // 3. Settings inputs & paths
  const sWs = document.getElementById('s-workspace');
  if (sWs) sWs.value = 'my-project';
  const sBase = document.getElementById('s-base');
  if (sBase && sBase.value.includes('127.0.0.1')) {
    sBase.value = 'http://127.0.0.1:20128/v1';
  }

  // 4. Sanitize all machine paths in code elements
  document.querySelectorAll('code').forEach(c => {
    if (c.textContent.includes('settings.json')) {
      c.textContent = '~/.klaud/settings.json';
    }
  });

  // 5. Sanitize any stray path text in hints or setup text
  document.querySelectorAll('.conn-setup-where, .hint').forEach(el => {
    if (el.innerHTML.includes('settings.json')) {
      el.innerHTML = el.innerHTML
        .replace(/in &lt;code&gt;[^<]+settings\.json/g, 'in &lt;code&gt;~/.klaud/settings.json')
        .replace(/in <code>[^<]+settings\.json/g, 'in <code>~/.klaud/settings.json')
        .replace(/to &lt;code&gt;[^<]+settings\.json/g, 'to &lt;code&gt;~/.klaud/settings.json')
        .replace(/to <code>[^<]+settings\.json/g, 'to <code>~/.klaud/settings.json');
    }
  });
`;

(async () => {
  console.log('Generating sanitized screenshots (zero private chats, zero personal paths)...');
  const mock = await startMockProvider();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-shot-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-shot-ws-'));

  // Pre-seed realistic workspace files
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.klaud', 'skills', 'house-style'), { recursive: true });

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
  await fs.writeFile(
    path.join(workspace, '.klaud', 'skills', 'house-style', 'SKILL.md'),
    `---\nname: house-style\ndescription: House conventions for any file in this project. Use when writing or reviewing code here.\ndisable-model-invocation: true\n---\n\nHouse style.\n`
  );

  // Pre-populate settings without any mock chats
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

  // Ensure dataDir/chats is empty directory
  await fs.mkdir(path.join(dataDir, 'chats'), { recursive: true });

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

    const siteImgDir = path.join(PROJECT, 'site', 'img');
    const docsShotDir = path.join(PROJECT, 'docs', 'screenshots');
    await fs.mkdir(siteImgDir, { recursive: true });
    await fs.mkdir(docsShotDir, { recursive: true });

    // Helper to apply sanitization and optional composer hint
    const applySanitize = async (hintText = null) => {
      await browser.evaluate(`
        ${SANITIZE_CODE}
        const h = document.getElementById('composer-hint');
        if (h && ${JSON.stringify(hintText)}) {
          h.textContent = ${JSON.stringify(hintText)};
        }
      `);
    };

    /* =====================================================================
     * 1. WELCOME & GREETING SCREENSHOTS (Chat Mode Empty State)
     * ===================================================================== */
    console.log('\n--- Capturing Welcome & Greeting Screenshots ---');
    await browser.setViewport(1384, 905, 1);

    // 1a. Standard welcome
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Here we go!';
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-welcome.png'));

    // 1b. Morning greeting ("Coffee and Klaud time?")
    await browser.setViewport(1384, 725, 1);
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Coffee and <span class="accent">Klaud</span> time?';
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'greeting-morning.png'));

    // 1c. Midday greeting ("What are we working on?")
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'What are we <span class="accent">working</span> on?';
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'greeting-midday.png'));

    // 1d. Evening greeting ("Evening thoughts?")
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Evening <span class="accent">thoughts</span>?';
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'greeting-evening.png'));

    // 1e. Late night greeting ("Late night coding?")
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Late night <span class="accent">coding</span>?';
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'greeting-late-night.png'));

    /* =====================================================================
     * 2. PROMPT HINT & SKILL MENU SCREENSHOTS
     * ===================================================================== */
    console.log('\n--- Capturing Prompt Hint & Skill Menu Screenshots ---');
    await browser.setViewport(1384, 905, 1);

    // 2a. Prompt hint ("Type / for skills")
    await browser.evaluate(`
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Here we go!';
      const prompt = document.getElementById('prompt');
      prompt.value = '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      const hint = document.getElementById('prompt-hint');
      if (hint) {
        hint.classList.remove('is-off');
        const lines = hint.querySelectorAll('.hint-line');
        if (lines[0]) lines[0].classList.add('is-on');
      }
    `);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-prompt-hint.png'));

    // 2b. Skill menu open (Light Mode)
    await browser.evaluate(`
      const prompt = document.getElementById('prompt');
      prompt.value = '/';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(400);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-skill-menu.png'));

    // 2c. Skill menu open (Dark Mode)
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();
    `);
    await sleep(400);
    await applySanitize('Enter to send · Shift+Enter for a new line · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-skill-menu-dark.png'));

    // Switch back to light mode and clear prompt
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();
      const prompt = document.getElementById('prompt');
      prompt.value = '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(300);

    /* =====================================================================
     * 3. COWORK MODE SCREENSHOTS
     * ===================================================================== */
    console.log('\n--- Capturing Cowork Mode Screenshots ---');
    await browser.evaluate(`
      document.getElementById('mode-cowork').click();
      const h1 = document.querySelector('.welcome h1 span');
      if (h1) h1.innerHTML = 'Here we go!';
    `);
    await sleep(600);
    await applySanitize('Cowork — longer tasks, it plans and works through them step by step.');

    // 3a. Docs cowork composer (1x DPR)
    await browser.setViewport(1384, 905, 1);
    await applySanitize('Cowork — longer tasks, it plans and works through them step by step.');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-cowork-composer.png'));

    // 3b. Marketing site cowork (2x DPR Retina)
    await browser.setViewport(1384, 905, 2);
    await applySanitize('Cowork — longer tasks, it plans and works through them step by step.');
    await browser.screenshot(path.join(siteImgDir, 'cowork.png'));

    // Switch back to Chat mode
    await browser.evaluate(`
      document.getElementById('mode-chat').click();
    `);
    await sleep(400);

    /* =====================================================================
     * 4. SETTINGS & CONNECTIONS MODALS
     * ===================================================================== */
    console.log('\n--- Capturing Settings & Connections Screenshots ---');
    await browser.setViewport(1384, 905, 1);

    // Open settings modal
    await browser.evaluate(`
      document.getElementById('open-settings-top').click();
    `);
    await sleep(500);
    await applySanitize();
    await browser.screenshot(path.join(docsShotDir, 'screenshot-settings.png'));

    // Connections panel inside settings
    await browser.evaluate(`
      const panel = document.querySelector('[data-conn-panel]');
      if (panel) panel.scrollIntoView();
    `);
    await sleep(400);
    await applySanitize();
    await browser.screenshot(path.join(docsShotDir, 'screenshot-connections.png'));

    // Close settings modal
    await browser.evaluate(`
      document.querySelector('.overlay [data-close]')?.click();
    `);
    await sleep(300);

    /* =====================================================================
     * 5. FREE PROVIDERS & CLOUDFLARE SETUP MODALS
     * ===================================================================== */
    console.log('\n--- Capturing Free Providers & Setup Screenshots ---');
    await browser.evaluate(`
      document.getElementById('open-free').click();
    `);
    await sleep(6000);
    await applySanitize();
    await browser.screenshot(path.join(docsShotDir, 'screenshot-free-providers.png'));

    // Cloudflare guided setup panel
    await browser.evaluate(`
      const cards = Array.from(document.querySelectorAll('.pcard'));
      const cf = cards.find(c => c.querySelector('.pname')?.textContent.includes('Cloudflare'));
      if (cf) {
        cf.scrollIntoView();
        cf.querySelector('[data-setup-open]')?.click();
      }
    `);
    await sleep(800);
    await applySanitize();
    await browser.screenshot(path.join(docsShotDir, 'screenshot-cloudflare-setup.png'));

    // Bad token error readout
    await browser.evaluate(`
      const panel = document.querySelector('.setup-panel');
      if (panel) {
        const tok = panel.querySelector('[data-setup-token]');
        if (tok) tok.value = 'invalid-token-test';
        const acc = panel.querySelector('[data-setup-account-input]');
        if (acc) acc.value = 'abcdef0123456789abcdef0123456789';
        panel.querySelector('[data-setup-run]')?.click();
      }
    `);
    await sleep(4000);
    await applySanitize();
    await browser.screenshot(path.join(docsShotDir, 'screenshot-cloudflare-error.png'));

    // Close free providers overlay
    await browser.evaluate(`
      document.querySelector('.overlay [data-close]')?.click();
    `);
    await sleep(400);

    /* =====================================================================
     * 6. THINKING STATE SCREENSHOT
     * ===================================================================== */
    console.log('\n--- Capturing Thinking State Screenshot ---');
    await browser.setViewport(1384, 805, 1);
    await browser.evaluate(`
      const shell = document.querySelector('.shell');
      if (shell) shell.classList.remove('has-no-transcript');
      const messages = document.getElementById('messages');
      if (messages) {
        messages.innerHTML = \`
          <div class="turn user">
            <div class="bubble bubble-user">list files in my-project</div>
          </div>
          <div class="turn assistant">
            <div class="thinking-row" data-thinking aria-live="polite">
              <span class="tr-indicator"><span class="tr-dot"></span><span class="tr-dot"></span><span class="tr-dot"></span></span>
              <span class="tr-label" data-thinking-label>Thinking · step 1/4</span>
            </div>
          </div>
        \`;
      }
      const send = document.getElementById('send');
      if (send) send.className = 'send stop';
    `);
    await applySanitize('Working... 0 tool calls so far · press Stop to cancel');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-thinking.png'));

    // Reset messages and send button
    await browser.evaluate(`
      const shell = document.querySelector('.shell');
      if (shell) shell.classList.add('has-no-transcript');
      const messages = document.getElementById('messages');
      if (messages) messages.innerHTML = '';
      const send = document.getElementById('send');
      if (send) send.className = 'send';
    `);
    await sleep(300);

    /* =====================================================================
     * 7. REAL TURNS — an artifact first, then the tool/diff turn
     * ===================================================================== */
    console.log('\n--- Running Real Turns for Hero & Turn Screenshots ---');

    const sendPrompt = async (text) => {
      await browser.evaluate(`
        const box = document.getElementById('prompt');
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send').click();
      `);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(500);
        const streaming = await browser.evaluate(`return document.getElementById('send').classList.contains('stop');`);
        if (!streaming) break;
      }
      await sleep(1400);
    };

    /* 7a. The first prompt writes a page, and a written page is an artifact.
       Refusing to continue if the card did not render: a marketing shot of a
       feature that is not there is worse than no shot. */
    await sendPrompt('Create an anthropic themed website in HTML');
    const artifactCards = await browser.evaluate(`return document.querySelectorAll('.artifact').length;`);
    if (artifactCards < 1) {
      throw new Error('the artifact card did not render after the first prompt');
    }
    console.log(`  artifact card rendered (${artifactCards})`);

    // Docs: the artifact open in the pane (1x DPR, light)
    await browser.setViewport(1384, 905, 1);
    await browser.evaluate(`document.getElementById('scroller').scrollTop = 0;`);
    await sleep(300);
    await browser.evaluate(`document.querySelector('.artifact-open')?.click();`);
    await sleep(800);
    await applySanitize('142 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-artifact.png'));
    await browser.evaluate(`document.querySelector('.ap-close')?.click();`);
    await sleep(400);

    // Marketing hero + OpenGraph: transcript scrolled to the first prompt, so
    // the frame reads prompt → description → artifact card (2x DPR).
    await browser.setViewport(1384, 905, 2);
    await browser.evaluate(`document.getElementById('scroller').scrollTop = 0;`);
    await sleep(300);
    await applySanitize('142 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(siteImgDir, 'hero.png'));
    await browser.screenshot(path.join(PROJECT, 'site', 'og.png'));

    /* 7b. The second prompt: diffs and real exit codes. */
    await sendPrompt('Refactor authentication middleware to check token expiration and verify with tests');

    // Expand tool cards
    await browser.evaluate(`
      document.querySelectorAll('details.tool').forEach(d => d.open = true);
    `);
    await applySanitize('186 tokens this turn · Klaud runs real commands in my-project');

    // Docs screenshot-turn.png (1x DPR)
    await browser.setViewport(1384, 905, 1);
    await applySanitize('186 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-turn.png'));

    // Marketing tools.png (2x DPR, width 1084)
    await browser.setViewport(1084, 905, 2);
    await applySanitize('186 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(siteImgDir, 'tools.png'));
    await browser.setViewport(1384, 905, 2);

    /* 7c. Dark mode: the transcript for the docs, the artifact pane open for
       the marketing shot — the pane is the feature, so that is what the site
       should show. */
    await browser.evaluate(`
      document.getElementById('toggle-theme').click();
    `);
    await sleep(600);

    await browser.setViewport(1384, 905, 1);
    await applySanitize('186 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(docsShotDir, 'screenshot-dark.png'));

    await browser.setViewport(1384, 905, 2);
    await browser.evaluate(`
      document.getElementById('scroller').scrollTop = 0;
      document.querySelector('.artifact-open')?.click();
    `);
    await sleep(900);
    await applySanitize('186 tokens this turn · Klaud runs real commands in my-project');
    await browser.screenshot(path.join(siteImgDir, 'dark.png'));

    console.log('\n✓ All screenshots captured and sanitized successfully!');
  } finally {
    if (browser) await browser.close();
    server.kill();
    mock.server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(0);
})().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
