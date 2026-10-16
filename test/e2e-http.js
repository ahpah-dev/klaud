'use strict';

/**
 * End-to-end HTTP check.
 *
 *   node test/e2e-http.js                 # spawns its own isolated server
 *   node test/e2e-http.js <port> <dataDir>  # test an already-running server
 *
 * Starts a mock OpenAI-compatible provider, points the server at it, drives a
 * full agent turn over SSE, and verifies that a real file landed on disk and
 * that the chat was persisted.
 *
 * In self-contained mode it uses a throwaway data directory and workspace, so
 * it cannot disturb a real ~/.klaud configuration.
 */

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const SELF_CONTAINED = !process.argv[2];
const PORT = Number(process.argv[2] || 0);
const DATA_DIR = process.argv[3] || '';
let BASE = `http://127.0.0.1:${PORT}`;

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

/* ---------------- mock provider ---------------- */

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'e2e-model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      w({ model: 'e2e-model', choices: [{ index: 0, delta: { content: 'Creating the file now.' } }] });
      w({
        model: 'e2e-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'e2e_call_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'e2e-proof.txt', content: 'written by klaud e2e\n' }),
                  },
                },
              ],
            },
          },
        ],
      });
      w({ model: 'e2e-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      w({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------- helpers ---------------- */

async function readToken(dir = DATA_DIR) {
  const raw = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
  return JSON.parse(raw).token;
}

function api(token, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${pathname}`,
      {
        method,
        headers: { 'x-klaud-token': token, 'content-type': 'application/json' },
      },
      (res) => {
        const contentType = res.headers['content-type'] || '';
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch {
            payload = { raw: text };
          }
          resolve({ status: res.statusCode, payload, text, contentType });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** POST /api/chat and collect every SSE event. */
function chat(token, body) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request(
      `${BASE}/api/chat`,
      { method: 'POST', headers: { 'x-klaud-token': token, 'content-type': 'application/json' } },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!raw.trim() || raw.startsWith(':')) continue;
            const data = raw
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (!data) continue;
            try {
              events.push(JSON.parse(data));
            } catch { /* ignore keepalives */ }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, events }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/* ---------------- run ---------------- */

let spawnedServer = null;
let tempDataDir = null;
let tempWorkspace = null;

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
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server never answered at ${url}`);
}

/** Boot a private server so this suite cannot disturb a real configuration. */
async function startIsolatedServer() {
  const port = await freePort();
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-e2e-data-'));
  tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-e2e-ws-'));
  await fs.writeFile(
    path.join(tempWorkspace, 'package.json'),
    JSON.stringify({ name: 'klaud', version: '1.0.0' }, null, 2),
    'utf8'
  );
  spawnedServer = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), KLAUD_DATA_DIR: tempDataDir, KLAUD_WORKSPACE: tempWorkspace },
    stdio: 'ignore',
  });
  BASE = `http://127.0.0.1:${port}`;
  await waitForHttp(`${BASE}/api/health`);
  return tempDataDir;
}

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud end-to-end HTTP check\x1b[0m');
  const dataDir = SELF_CONTAINED ? await startIsolatedServer() : DATA_DIR;
  const token = await readToken(dataDir);
  const mock = await startMock();
  console.log(`  server:        ${BASE}${SELF_CONTAINED ? ' (isolated, throwaway data dir)' : ''}`);
  console.log(`  mock provider: http://127.0.0.1:${mock.port}/v1\n`);

  // --- public + auth ---
  const health = await api('', '/api/health');
  check('GET /api/health is public', health.status === 200 && health.payload.ok);

  const page = await api('', '/');
  check('GET / serves the UI shell', page.status === 200 && /Klaud/.test(page.text) && /app\.js/.test(page.text));

  const css = await api('', '/styles.css');
  check('GET /styles.css is served', css.status === 200 && /--accent/.test(css.text));

  const js = await api('', '/app.js');
  check('GET /app.js is served', js.status === 200 && /consumeStream/.test(js.text));

  const md = await api('', '/markdown.mjs');
  check('GET /markdown.mjs is served as a JS module',
    md.status === 200 && md.contentType.includes('javascript') && /renderMarkdown/.test(md.text),
    md.contentType);

  const noAuth = await api('wrong-token', '/api/info');
  check('bad token is rejected with 401', noAuth.status === 401);

  const info = await api(token, '/api/info');
  check('GET /api/info lists the tools', info.status === 200 && info.payload.tools.length > 0,
    JSON.stringify(info.payload).slice(0, 200));

  const tools = (info.payload.tools || []).map((t) => t.name);
  for (const expected of ['read_file', 'write_file', 'edit_file', 'run_command', 'search_text', 'glob_files']) {
    check(`tool catalogue exposes ${expected}`, tools.includes(expected));
  }

  /* The extension tools are registered when a turn runs, so on a freshly started
   * server the catalogue used to report the nine built-ins while the agent
   * actually had twelve. Asserting a lower bound of 9 is what let that through;
   * the endpoint now registers before reporting, and this demands the real set. */
  for (const expected of ['list_skills', 'read_skill', 'task']) {
    check(`the info catalogue includes the extension tool ${expected} before any turn has run`,
      tools.includes(expected), tools.join(', '));
  }
  check('the catalogue reports every tool, not only the built-ins',
    info.payload.tools.length >= 12, `${info.payload.tools.length} tools: ${tools.join(', ')}`);

  // --- settings ---
  // Snapshot first: this suite changes the provider config, and it must hand
  // the previous settings back so it can never clobber a real configuration.
  const original = (await api(token, '/api/settings')).payload;
  const restore = async () => {
    await api(token, '/api/settings', {
      method: 'PATCH',
      body: {
        baseUrl: original.baseUrl,
        apiKey: original.hasApiKey ? undefined : '',
        model: original.model,
        approvalMode: original.approvalMode,
        maxSteps: original.maxSteps,
        temperature: original.temperature,
        maxContextChars: original.maxContextChars,
      },
    }).catch(() => {});
  };

  const saved = await api(token, '/api/settings', {
    method: 'PATCH',
    body: {
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      apiKey: 'e2e-key',
      model: 'e2e-model',
      approvalMode: 'auto',
      maxSteps: 6,
    },
  });
  check('PATCH /api/settings saves the provider config',
    saved.status === 200 && saved.payload.hasApiKey === true && saved.payload.model === 'e2e-model',
    JSON.stringify(saved.payload));

  const reread = await api(token, '/api/settings');
  check('the raw API key is never returned to the browser',
    reread.payload.apiKey === undefined && String(reread.payload.apiKeyHint).includes('e2e'),
    JSON.stringify(reread.payload));

  // --- models ---
  const models = await api(token, '/api/models', { method: 'POST', body: {} });
  check('POST /api/models lists provider models',
    models.status === 200 && models.payload.models.some((m) => m.id === 'e2e-model'),
    JSON.stringify(models.payload).slice(0, 200));

  const test = await api(token, '/api/models/test', { method: 'POST', body: {} });
  check('POST /api/models/test reports a successful connection',
    test.status === 200 && test.payload.ok === true, JSON.stringify(test.payload));

  // --- workspace browsing ---
  const fsBrowse = await api(token, `/api/fs?path=${encodeURIComponent(info.payload.workspace)}`);
  check('GET /api/fs lists directories for the picker',
    fsBrowse.status === 200 && fsBrowse.payload.type === 'dir' && Array.isArray(fsBrowse.payload.entries),
    JSON.stringify(fsBrowse.payload).slice(0, 200));

  // --- direct tool call ---
  const toolResult = await api(token, '/api/tool', {
    method: 'POST',
    body: { name: 'read_file', args: { path: 'package.json' } },
  });
  check('POST /api/tool executes a real tool',
    toolResult.status === 200 && toolResult.payload.ok && /"name": "klaud"/.test(toolResult.payload.output),
    JSON.stringify(toolResult.payload).slice(0, 200));

  const escape = await api(token, '/api/tool', {
    method: 'POST',
    body: { name: 'read_file', args: { path: '../../../Windows/win.ini' } },
  });
  check('the tool API refuses to escape the workspace',
    escape.payload.ok === false && /outside the working directory/.test(escape.payload.output),
    JSON.stringify(escape.payload).slice(0, 200));

  // --- a real agent turn ---
  const proof = path.join(info.payload.workspace, 'e2e-proof.txt');
  await fs.rm(proof, { force: true });

  const turn = await chat(token, {
    turnId: 'e2eturn0000000001',
    messages: [{ role: 'user', content: 'Create e2e-proof.txt' }],
    approvalMode: 'auto',
    maxSteps: 4,
  });

  const types = turn.events.map((e) => e.type);
  check('POST /api/chat streams a turn', turn.status === 200 && types.includes('turn_start') && types.includes('turn_end'),
    types.join(','));
  check('the turn emitted text', turn.events.some((e) => e.type === 'text' && /Creating the file/.test(e.value)));
  check('the turn emitted a tool call', turn.events.some((e) => e.type === 'tool_call' && e.name === 'write_file'));
  const toolOutcome = turn.events.find((e) => e.type === 'tool_result');
  check('the tool executed successfully', Boolean(toolOutcome && toolOutcome.ok), JSON.stringify(toolOutcome).slice(0, 200));
  check('usage was reported', turn.events.some((e) => e.type === 'usage' && e.usage.total_tokens === 16));

  // Regression: the transcript has to travel back in turn_end. Without it the
  // browser cannot persist the chat and every turn starts from scratch.
  const turnEnd = turn.events.find((e) => e.type === 'turn_end');
  const sentMessages = (turnEnd && turnEnd.messages) || [];
  check('turn_end carries the transcript back to the client', sentMessages.length >= 2,
    `messages: ${sentMessages.length}`);
  check('the returned transcript contains the assistant turn and its tool result',
    sentMessages.some((m) => m.role === 'assistant' && (m.tool_calls || []).length === 1) &&
      sentMessages.some((m) => m.role === 'tool'),
    JSON.stringify(sentMessages.map((m) => m.role)));

  const written = await fs.readFile(proof, 'utf8').catch(() => null);
  check('the file really exists on disk with the right contents',
    written === 'written by klaud e2e\n', JSON.stringify(written));

  // --- persistence ---
  const created = await api(token, '/api/chats', { method: 'POST', body: { title: 'e2e chat' } });
  check('POST /api/chats creates a chat', created.status === 201 && Boolean(created.payload.chat.id));

  const history = [
    { role: 'user', content: 'say hi' },
    { role: 'assistant', content: 'hi' },
  ];
  const put = await api(token, `/api/chats/${created.payload.chat.id}`, {
    method: 'PUT',
    body: { messages: history },
  });
  check('PUT /api/chats/:id stores messages', put.status === 200 && put.payload.chat.messages.length === 2);

  const loaded = await api(token, `/api/chats/${created.payload.chat.id}`);
  check('GET /api/chats/:id returns them', loaded.payload.chat.messages[1].content === 'hi');

  const list = await api(token, '/api/chats');
  check('GET /api/chats lists the chat', list.payload.chats.some((c) => c.id === created.payload.chat.id));

  const removed = await api(token, `/api/chats/${created.payload.chat.id}`, { method: 'DELETE' });
  check('DELETE /api/chats/:id removes it', removed.status === 200);
  const gone = await api(token, `/api/chats/${created.payload.chat.id}`);
  check('the deleted chat is gone', gone.status === 404);

  // --- static fallback ---
  const fallback = await api('', '/some/deep/link');
  check('unknown paths fall back to the app shell', fallback.status === 200 && /Klaud/.test(fallback.text));

  // --- robustness: odd requests must not take the server down ---
  // A ReferenceError inside one route used to kill the whole process, which
  // looked to the user like "the connection was reset" with no explanation.
  const odd = [
    ['POST /api/authorize with no body', 'POST', '/api/authorize', undefined],
    ['POST /api/chat with a malformed body', 'POST', '/api/chat', 'not json at all'],
    ['POST /api/settings with an array', 'POST', '/api/settings', '[1,2,3]'],
    ['POST /api/fs/mkdir with no body', 'POST', '/api/fs/mkdir', undefined],
    ['POST /api/tool naming nothing', 'POST', '/api/tool', '{}'],
    ['GET /api/fs with a path that does not exist', 'GET', '/api/fs?path=Z%3A%5Cnope-nope', undefined],
    ['POST to a route that only takes GET', 'POST', '/api/info', '{}'],
    ['GET a route that only takes POST', 'GET', '/api/authorize', undefined],
  ];

  for (const [, method, path, body] of odd) {
    await api(token, path, { method, body: body === undefined ? undefined : body });
  }
  const stillAlive = await api('', '/api/health');
  check('the server survives a batch of malformed requests',
    stillAlive.status === 200 && stillAlive.payload && stillAlive.payload.ok,
    JSON.stringify(stillAlive).slice(0, 160));

  const afterOdd = await api(token, '/api/info');
  check('it still answers authenticated requests afterwards',
    afterOdd.status === 200 && (afterOdd.payload.tools || []).length >= 12, String(afterOdd.status));

  await fs.rm(proof, { force: true });
  await restore();
  mock.server.close();

  if (spawnedServer) {
    spawnedServer.kill();
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} end-to-end checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} end-to-end checks passed\x1b[0m`);
  console.log('  the provider settings were restored to their previous values\n');
  process.exit(0);
})().catch((err) => {
  if (spawnedServer) spawnedServer.kill();
  console.error('\nE2E harness crashed:', err);
  process.exit(1);
});
