'use strict';

/**
 * Klaud test suite â€” no framework, no dependencies.
 *
 *   node test/run.js
 *
 * Covers the tool sandbox, the OpenAI-compatible streaming client (against a
 * mock provider), and the full agent loop including tool execution and the
 * human-approval path.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const assert = require('assert/strict');

const { executeTool, TOOLS, lineDiff } = require('../src/lib/tools');
const { resolveInside, globToRegExp, matchGlob } = require('../src/lib/fsutil');
const { streamChat, parseToolArguments, listModels, LLMError } = require('../src/llm');
const { runAgentTurn, sanitizeMessages, repairToolSequences, pruneHistory } = require('../src/agent');
const { DEFAULTS } = require('../src/config');

/* ------------------------------------------------------------------ *
 * Tiny harness: every check runs in order and every assertion is awaited.
 * ------------------------------------------------------------------ */

const results = { pass: 0, fail: 0 };
const failures = [];
let group = '';

function describe(name, fn) {
  group = name;
  process.stdout.write(`\n  \x1b[1m${name}\x1b[0m\n`);
  return fn();
}

async function it(name, fn) {
  try {
    await fn();
    results.pass++;
    process.stdout.write(`    \x1b[32m+\x1b[0m ${name}\n`);
  } catch (err) {
    results.fail++;
    failures.push({ group, name, err });
    process.stdout.write(`    \x1b[31mx\x1b[0m ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let tmpRoot;

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-test-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'app.js'),
    ['const greeting = "hello";', 'function main() {', '  console.log(greeting);', '}', 'main();', ''].join('\n'),
    'utf8'
  );
  await fs.writeFile(path.join(dir, 'readme.md'), '# Demo\n\nA tiny project.\n', 'utf8');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1\n', 'utf8');
  return dir;
}

const ctx = () => ({ cwd: tmpRoot, approvalMode: 'auto' });

async function tool(name, args, overrides = {}) {
  return executeTool(name, args, { ...ctx(), ...overrides });
}

/* ------------------------------------------------------------------ *
 * Mock OpenAI-compatible provider
 * ------------------------------------------------------------------ */

function startMockProvider() {
  const state = { scenario: 'text', requests: [], auth: [], lastToolResult: '' };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large', owned_by: 'klaud' }] }));
      return;
    }

    const body = JSON.parse(raw || '{}');
    state.requests.push(body);
    state.auth.push(req.headers.authorization || '');

    const messages = body.messages || [];
    const last = messages[messages.length - 1];
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (state.scenario === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      return;
    }
    if (state.scenario === 'bad_tools' && Array.isArray(body.tools) && body.tools.length) {
      // Reject the tool schema, but answer normally once the client drops them.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if (state.scenario === 'tool_calls') {
      // Deterministic and state-free: the number of `tool` results already in
      // the conversation decides which round this is.
      const toolResults = messages.filter((m) => m.role === 'tool');
      if (toolResults.length >= 2) {
        const lastResult = toolResults[toolResults.length - 1];
        state.lastToolResult = lastResult.content;
        write({
          model: 'mock-large',
          choices: [
            {
              index: 0,
              delta: { content: `Command output was:\n\n\`\`\`\n${lastResult.content.slice(0, 200)}\n\`\`\`` },
            },
          ],
        });
        write({ model: 'mock-large', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else {
        state.lastToolResult = toolResults.length ? toolResults[toolResults.length - 1].content : '';
        write({ model: 'mock-large', choices: [{ index: 0, delta: { content: 'Writing a greeting script.' } }] });
        write({
          model: 'mock-large',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: '{"path":"src/hello.js","content":"console.log(\\"hi from klaud\\");\\n"}',
                    },
                  },
                ],
              },
            },
          ],
        });
        write({
          model: 'mock-large',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: 'call_2',
                    type: 'function',
                    function: { name: 'run_command', arguments: '{"command":"node src/hello.js"}' },
                  },
                ],
              },
            },
          ],
        });
        write({ model: 'mock-large', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }
      write({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (state.scenario === 'split_tool_args') {
      write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_dir' } }] } }] });
      for (const piece of ['{"pa', 'th":', ' "src"', '}']) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] });
      }
      write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (state.scenario === 'loop_tools') {
      // Always asks for another tool, so only the step cap can end the turn.
      write({ model: 'mock-large', choices: [{ index: 0, delta: { content: 'Checking again.' } }] });
      write({
        model: 'mock-large',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: `c${Date.now()}`, type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
              ],
            },
          },
        ],
      });
      write({ model: 'mock-large', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (state.scenario === 'slow') {
      write({ choices: [{ index: 0, delta: { content: 'thinking' } }] });
      // Deliberately never finishes: the client is expected to abort.
      return;
    }

    if (state.scenario === 'reasoning') {
      write({ choices: [{ index: 0, delta: { reasoning_content: 'Let me consider. ' } }] });
      write({ choices: [{ index: 0, delta: { content: 'Answer.' } }] });
      write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    for (const word of ['Hello', ' from', ' the', ' mock', ' provider', '.']) {
      write({ model: 'mock-small', choices: [{ index: 0, delta: { content: word } }] });
    }
    write({ model: 'mock-small', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    write({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.baseUrl = `http://127.0.0.1:${state.port}/v1`;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  tmpRoot = await makeWorkspace();
  const provider = await startMockProvider();

  console.log('\n\x1b[38;5;209m* Klaud test suite\x1b[0m');
  console.log(`  workspace:     ${tmpRoot}`);
  console.log(`  mock provider: ${provider.baseUrl}`);

  /* ============================== path safety ============================== */
  await describe('path safety', async () => {
    await it('resolves a relative path inside the root', () => {
      assert.equal(resolveInside(tmpRoot, 'src/app.js').rel, 'src/app.js');
    });

    await it('rejects ../ escapes', () => {
      assert.throws(() => resolveInside(tmpRoot, '../secrets.txt'), /outside the working directory/);
    });

    await it('rejects absolute paths outside the root', () => {
      const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
      assert.throws(() => resolveInside(tmpRoot, outside), /outside the working directory/);
    });

    await it('rejects a null byte', () => {
      assert.throws(() => resolveInside(tmpRoot, 'src/\u0000evil'), /null byte/);
    });

    await it('normalises . and .. segments that stay inside', () => {
      assert.equal(resolveInside(tmpRoot, 'src/../readme.md').rel, 'readme.md');
    });

    await it('maps ** globs correctly', () => {
      assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
      assert.ok(globToRegExp('**/*.js').test('c.js'));
      assert.ok(!globToRegExp('**/*.js').test('c.ts'));
      assert.ok(globToRegExp('src/*.{js,ts}').test('src/x.ts'));
      assert.ok(matchGlob('src', 'src/deep/file.js'));
      assert.ok(!matchGlob('src/*.js', 'src/deep/file.js'));
    });
  });

  /* =============================== file tools ============================= */
  await describe('file tools', async () => {
    await it('lists a directory', async () => {
      const out = await tool('list_dir', { path: '.' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /src\//);
      assert.match(out.output, /readme\.md/);
    });

    await it('lists recursively', async () => {
      const out = await tool('list_dir', { path: '.', recursive: true });
      assert.match(out.output, /src\/app\.js/);
    });

    await it('reads a file with line numbers', async () => {
      const out = await tool('read_file', { path: 'src/app.js' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /1 \| const greeting/);
      assert.match(out.output, /end of file/);
    });

    await it('honours offset and limit', async () => {
      const out = await tool('read_file', { path: 'src/app.js', offset: 3, limit: 2 });
      assert.match(out.output, /3 \| {3}console\.log/);
      assert.match(out.output, /showing lines 3-4 of 6/);
    });

    await it('refuses to read a missing file', async () => {
      const out = await tool('read_file', { path: 'nope.txt' });
      assert.equal(out.ok, false);
      assert.match(out.output, /does not exist/);
    });

    await it('refuses to read outside the root', async () => {
      const out = await tool('read_file', { path: '../../../etc/passwd' });
      assert.equal(out.ok, false);
      assert.match(out.output, /outside the working directory/);
    });

    await it('creates a new file and its parent directories', async () => {
      const out = await tool('write_file', { path: 'deep/nested/new.txt', content: 'hi\n' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /Created deep\/nested\/new\.txt/);
      assert.equal(await fs.readFile(path.join(tmpRoot, 'deep/nested/new.txt'), 'utf8'), 'hi\n');
    });

    await it('refuses to overwrite without the flag', async () => {
      const out = await tool('write_file', { path: 'readme.md', content: 'clobber' });
      assert.equal(out.ok, false);
      assert.match(out.output, /already exists/);
    });

    await it('overwrites when asked and reports a diff', async () => {
      const out = await tool('write_file', { path: 'readme.md', content: '# Demo\n\nNow changed.\n', overwrite: true });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /Replaced readme\.md/);
      assert.match(out.output, /-A tiny project\./);
      assert.match(out.output, /\+Now changed\./);
    });

    await it('edits an exact string once', async () => {
      const out = await tool('edit_file', {
        path: 'src/app.js',
        old_string: 'const greeting = "hello";',
        new_string: 'const greeting = "goodbye";',
      });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /1 replacement/);
      assert.match(await fs.readFile(path.join(tmpRoot, 'src/app.js'), 'utf8'), /goodbye/);
    });

    await it('rejects an ambiguous edit', async () => {
      const out = await tool('edit_file', { path: 'src/app.js', old_string: 'n', new_string: 'm' });
      assert.equal(out.ok, false);
      assert.match(out.output, /appears \d+ times/);
    });

    await it('explains a failed match instead of guessing', async () => {
      const out = await tool('edit_file', { path: 'src/app.js', old_string: 'not in the file at all', new_string: 'x' });
      assert.equal(out.ok, false);
      assert.match(out.output, /was not found/);
    });

    await it('replaces all occurrences when allowed', async () => {
      await tool('write_file', { path: 'many.txt', content: 'aaa\naaa\n' });
      const out = await tool('edit_file', { path: 'many.txt', old_string: 'aaa', new_string: 'bbb', replace_all: true });
      assert.ok(out.ok, out.output);
      assert.equal(await fs.readFile(path.join(tmpRoot, 'many.txt'), 'utf8'), 'bbb\nbbb\n');
    });

    await it('finds files by glob', async () => {
      const out = await tool('glob_files', { pattern: '**/*.js' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /src\/app\.js/);
    });

    await it('searches file contents with line numbers', async () => {
      const out = await tool('search_text', { pattern: 'function main' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /src\/app\.js/);
      assert.match(out.output, /2: function main/);
    });

    await it('reports no matches cleanly', async () => {
      const out = await tool('search_text', { pattern: 'zzz_no_such_symbol' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /No matches/);
    });
  });

  /* ============================== run_command ============================= */
  await describe('run_command', async () => {
    await it('captures stdout and exit code', async () => {
      const out = await tool('run_command', { command: 'echo klaud-works' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /klaud-works/);
      assert.match(out.output, /exit: 0/);
    });

    await it('reports a non-zero exit code without throwing', async () => {
      // Written to a file so the quoting survives every shell.
      await tool('write_file', { path: 'exit3.js', content: 'process.exit(3);\n' });
      const out = await tool('run_command', { command: 'node exit3.js' });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /exit: 3/);
    });

    await it('captures stderr', async () => {
      await tool('write_file', { path: 'boom.js', content: 'console.error("boom");\n' });
      const out = await tool('run_command', { command: 'node boom.js' });
      assert.match(out.output, /boom/);
      assert.match(out.output, /stderr/);
    });

    await it('runs inside the requested subdirectory', async () => {
      await tool('write_file', { path: 'src/marker.txt', content: 'x' });
      const out = await tool('run_command', {
        command: 'node -e "console.log(require(\'fs\').readdirSync(\'.\').join(\',\'))"',
        cwd: 'src',
      });
      assert.match(out.output, /marker\.txt/);
    });

    await it('blocks destructive commands', async () => {
      const out = await tool('run_command', { command: 'rm -rf /' });
      assert.equal(out.ok, false);
      assert.match(out.output, /destructive/);
    });

    await it('kills a command that exceeds its timeout', async () => {
      const out = await tool('run_command', { command: 'node -e "setTimeout(()=>{},60000)"', timeout_ms: 1200 });
      assert.ok(out.ok, out.output);
      assert.match(out.output, /TIMEOUT|killed after/);
    });

    await it('is refused entirely in read-only mode', async () => {
      const out = await tool('run_command', { command: 'echo hi' }, { approvalMode: 'readonly' });
      assert.equal(out.ok, false);
      assert.match(out.output, /Permission denied/);
    });

    await it('refuses writes in read-only mode', async () => {
      const out = await tool('write_file', { path: 'x.txt', content: 'x' }, { approvalMode: 'readonly' });
      assert.equal(out.ok, false);
      assert.match(out.output, /Permission denied/);
    });
  });

  /* ============================== other tools ============================= */
  await describe('other tools', async () => {
    await it('validates a bad url', async () => {
      const out = await tool('fetch_url', { url: 'file:///etc/passwd' });
      assert.equal(out.ok, false);
      assert.match(out.output, /http/);
    });

    await it('records a todo list', async () => {
      let received = null;
      const out = await executeTool(
        'todo_write',
        { todos: [{ content: 'Do a thing', status: 'in_progress' }] },
        { ...ctx(), onTodos: (t) => (received = t) }
      );
      assert.ok(out.ok, out.output);
      assert.equal(received.length, 1);
      assert.match(out.output, /\[>\] Do a thing/);
    });

    await it('rejects unknown tools with a helpful message', async () => {
      const out = await tool('teleport', {});
      assert.equal(out.ok, false);
      assert.match(out.output, /Unknown tool "teleport"/);
      assert.match(out.output, /read_file/);
    });
  });

  /* ================================ lineDiff ============================== */
  await describe('lineDiff', async () => {
    await it('shows additions and removals with context', () => {
      const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
      assert.match(d, /-b/);
      assert.match(d, /\+B/);
    });
  });

  /* =============================== llm client ============================= */
  await describe('llm client', async () => {
    await it('explains that a missing Authorization header is code 1001', async () => {
      const { describeHttpErrorForTest } = require('../src/llm');
      const url = 'https://api.cloudflare.com/client/v4/accounts/aaaa/ai/v1/models';
      const fakeRes = {
        status: 400,
        url,
        text: async () =>
          JSON.stringify({ success: false, errors: [{ code: 1001, message: 'Missing "Authorization" header' }] }),
      };
      const message = await describeHttpErrorForTest(fakeRes, { url, baseUrl: url });
      assert.match(message, /1001/, message.slice(0, 200));
      assert.match(message, /-H/, message.slice(0, 300));
    });

    await it('names angle brackets as the cause of a bad hostname', async () => {
      const { chatCompletionsUrl, normalizeBaseUrl } = require('../src/llm');
      // A URL copied verbatim from documentation.
      assert.throws(
        () => chatCompletionsUrl('https://api.cloudflare.com/client/v4/accounts/<your-account-id>/ai/v1'),
        /angle brackets/i
      );
      assert.throws(
        () => chatCompletionsUrl('https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1'),
        /angle brackets/i
      );
      // Stripping them and substituting a real account ID makes it usable.
      const cleaned = normalizeBaseUrl(
        'https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1',
        'abcdef0123456789abcdef0123456789'
      );
      assert.equal(cleaned, 'https://api.cloudflare.com/client/v4/accounts/abcdef0123456789abcdef0123456789/ai/v1');
    });

    await it('turns a trailing /models into a chat completions URL', () => {
      const { chatCompletionsUrl } = require('../src/llm');
      assert.equal(
        chatCompletionsUrl('https://api.example.com/v1/models'),
        'https://api.example.com/v1/chat/completions'
      );
    });

    await it('lists Cloudflare models with POST, because GET returns 405 there', async () => {
      const { listModels } = require('../src/llm');
      const calls = [];
      const originalFetch = global.fetch;
      global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
        // Cloudflare's real behaviour: GET is rejected, POST answers.
        if ((init.method || 'GET') !== 'POST') {
          return new Response(
            JSON.stringify({ result: null, success: false, errors: [{ code: 7001, message: 'GET not supported for requested URI.' }] }),
            { status: 405, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ result: [{ name: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' }], success: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };
      try {
        const models = await listModels({
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
          apiKey: 'k',
        });
        assert.equal(calls[0].method, 'POST', 'Cloudflare model list must use POST');
        assert.equal(models[0].id, '@cf/meta/llama-3.1-8b-instruct-fp8-fast');
      } finally {
        global.fetch = originalFetch;
      }
    });

    await it('still uses GET for every other provider', async () => {
      const { listModels } = require('../src/llm');
      const calls = [];
      const originalFetch = global.fetch;
      global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        await listModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k' });
        await listModels({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
        assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET'], JSON.stringify(calls));
      } finally {
        global.fetch = originalFetch;
      }
    });

    await it('uses POST for Cloudflare even when the URL already ends in /models', async () => {
      const { listModels } = require('../src/llm');
      const calls = [];
      const originalFetch = global.fetch;
      global.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET' });
        return new Response(JSON.stringify({ result: [{ name: '@cf/meta/llama-3.1-8b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        const models = await listModels({
          baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/models',
          apiKey: 'k',
        });
        assert.equal(calls[0].method, 'POST', JSON.stringify(calls));
        assert.equal(calls[0].url.endsWith('/models'), true);
        assert.equal(models[0].id, '@cf/meta/llama-3.1-8b');
      } finally {
        global.fetch = originalFetch;
      }
    });

    await it('parses every model-list shape seen in the wild', async () => {
      const { listModels } = require('../src/llm');
      const originalFetch = global.fetch;
      const shapes = [
        ['OpenAI data', { data: [{ id: 'a', owned_by: 'x' }] }, 'a'],
        ['bare array', [{ id: 'b' }], 'b'],
        ['plain strings', { data: ['c'] }, 'c'],
        ['Cloudflare result + name', { result: [{ name: 'd' }] }, 'd'],
        ['models key with model field', { models: [{ model: 'e' }] }, 'e'],
      ];
      try {
        for (const [label, payload, expected] of shapes) {
          global.fetch = async () =>
            new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
          const models = await listModels({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' });
          assert.equal(models.length, 1, `${label}: got ${JSON.stringify(models)}`);
          assert.equal(models[0].id, expected, `${label}: got ${JSON.stringify(models)}`);
        }
      } finally {
        global.fetch = originalFetch;
      }
    });

    await it('never blames the API key for a Cloudflare account mismatch', async () => {
      // The real-world complaint: Cloudflare answers 401 "Authentication error"
      // when the account ID belongs to a different account than the token, and
      // the app used to tell the user their API key had been rejected.
      const { describeHttpErrorForTest } = require('../src/llm');
      const url = 'https://api.cloudflare.com/client/v4/accounts/aaaa/ai/v1/chat/completions';
      const fakeRes = {
        status: 401,
        url,
        text: async () =>
          JSON.stringify({ result: null, success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
      };
      const message = await describeHttpErrorForTest(fakeRes, { url, model: 'x', baseUrl: url });
      assert.ok(!/API key was rejected/i.test(message), message.slice(0, 200));
      assert.ok(/does not necessarily mean your key is wrong/i.test(message), message.slice(0, 240));
      assert.ok(/check-cloudflare/.test(message), message.slice(0, 300));
      assert.ok(/Cloudflare code 10000/.test(message), message.slice(0, 300));
    });

    await it('names the wrong Workers AI URL shape', async () => {
      const { describeHttpErrorForTest } = require('../src/llm');
      const url = 'https://api.cloudflare.com/client/v4/accounts/aaaa/ai/run/anthropic/claude-haiku-5.5';
      const fakeRes = {
        status: 401,
        url,
        text: async () => JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
      };
      const message = await describeHttpErrorForTest(fakeRes, { url, baseUrl: url, model: 'x' });
      assert.match(message, /native Workers AI shape/i, message.slice(0, 240));
      assert.match(message, /ai\/v1/, message.slice(0, 320));
    });

    await it('keeps the plain hint for other providers', async () => {
      const { describeHttpErrorForTest } = require('../src/llm');
      const url = 'https://openrouter.ai/api/v1/chat/completions';
      const fakeRes = {
        status: 401,
        url,
        text: async () => JSON.stringify({ error: { message: 'No auth credentials found' } }),
      };
      const message = await describeHttpErrorForTest(fakeRes, { url, baseUrl: 'https://openrouter.ai/api/v1' });
      assert.match(message, /API key was rejected/);
    });

    await it('streams text deltas in order', async () => {
      provider.scenario = 'text';
      const deltas = [];
      const result = await streamChat({
        baseUrl: provider.baseUrl,
        apiKey: 'test-key',
        model: 'mock-small',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: (e) => e.type === 'text' && deltas.push(e.value),
      });
      assert.equal(result.text, 'Hello from the mock provider.');
      assert.equal(deltas.length, 6);
      assert.equal(result.finishReason, 'stop');
      assert.equal(result.usage.total_tokens, 16);
    });

    await it('sends the bearer token and the tool definitions', async () => {
      provider.scenario = 'text';
      await streamChat({
        baseUrl: provider.baseUrl,
        apiKey: 'test-key',
        model: 'mock-small',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      });
      assert.equal(provider.auth[provider.auth.length - 1], 'Bearer test-key');
      assert.equal(provider.requests[provider.requests.length - 1].tools.length, 1);
    });

    await it('assembles tool calls streamed across chunks', async () => {
      provider.scenario = 'tool_calls';
      const result = await streamChat({
        baseUrl: provider.baseUrl,
        apiKey: 'k',
        model: 'mock-large',
        messages: [{ role: 'user', content: 'write a script' }],
      });
      assert.equal(result.toolCalls.length, 2);
      assert.equal(result.toolCalls[0].function.name, 'write_file');
      assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
        path: 'src/hello.js',
        content: 'console.log("hi from klaud");\n',
      });
      assert.equal(result.toolCalls[1].function.name, 'run_command');
      assert.equal(result.finishReason, 'tool_calls');
    });

    await it('assembles arguments split character by character', async () => {
      provider.scenario = 'split_tool_args';
      const result = await streamChat({
        baseUrl: provider.baseUrl,
        apiKey: 'k',
        model: 'mock-large',
        messages: [{ role: 'user', content: 'list' }],
      });
      assert.equal(result.toolCalls.length, 1);
      assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: 'src' });
    });

    await it('streams reasoning content separately', async () => {
      provider.scenario = 'reasoning';
      const events = [];
      const result = await streamChat({
        baseUrl: provider.baseUrl,
        apiKey: 'k',
        model: 'mock-large',
        messages: [{ role: 'user', content: 'think' }],
        onEvent: (e) => events.push(e.type),
      });
      assert.equal(result.reasoning, 'Let me consider. ');
      assert.equal(result.text, 'Answer.');
      assert.ok(events.includes('reasoning'));
    });

    await it('turns a 401 into an actionable message', async () => {
      provider.scenario = 'unauthorized';
      await assert.rejects(
        () => streamChat({ baseUrl: provider.baseUrl, apiKey: 'bad', model: 'm', messages: [] }),
        (err) => {
          assert.ok(err instanceof LLMError);
          assert.match(err.message, /401/);
          assert.match(err.message, /API key was rejected/);
          return true;
        }
      );
    });

    await it('explains an unreachable endpoint', async () => {
      await assert.rejects(
        () => streamChat({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', messages: [] }),
        /Could not reach/
      );
    });

    await it('lists models', async () => {
      const models = await listModels({ baseUrl: provider.baseUrl, apiKey: 'k' });
      assert.equal(models.length, 2);
      assert.equal(models[0].id, 'mock-large');
    });

    await it('repairs sloppy tool-call JSON', () => {
      assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
      assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { a: 1 });
      assert.deepEqual(parseToolArguments('{"a":1,}'), { a: 1 });
      assert.deepEqual(parseToolArguments('Sure! {"a":1} hope that helps'), { a: 1 });
      assert.equal(parseToolArguments('not json at all').__parse_error, true);
      assert.deepEqual(parseToolArguments(''), {});
    });
  });

  /* ============================ message hygiene =========================== */
  await describe('message sanitising', async () => {
    await it('drops unknown roles and fields', () => {
      const out = sanitizeMessages([
        { role: 'user', content: 'hi', evil: 'x' },
        { role: 'hacker', content: 'boom' },
        { role: 'assistant', content: 'ok' },
      ]);
      assert.equal(out.length, 2);
      assert.equal(out[0].evil, undefined);
    });

    await it('fills in tool results the model never got', () => {
      const repaired = repairToolSequences([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
      ]);
      assert.equal(repaired.length, 3);
      assert.equal(repaired[2].role, 'tool');
      assert.equal(repaired[2].tool_call_id, 'a');
    });

    await it('drops orphaned tool results', () => {
      const repaired = repairToolSequences([
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'ghost', content: 'x' },
        { role: 'assistant', content: 'done' },
      ]);
      assert.equal(repaired.length, 2);
    });
  });

  /* =============================== agent loop ============================= */
  await describe('agent loop', async () => {
    const baseSettings = () => ({
      ...DEFAULTS,
      baseUrl: provider.baseUrl,
      apiKey: 'test-key',
      model: 'mock-large',
      temperature: 0,
      maxSteps: 6,
    });

    await it('answers a plain question and reports usage', async () => {
      provider.scenario = 'text';
      const events = [];
      const result = await runAgentTurn({
        settings: { ...baseSettings(), model: 'mock-small' },
        messages: [{ role: 'user', content: 'hello' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.finished, 'stop');
      assert.equal(result.messages[0].role, 'assistant');
      assert.match(result.messages[0].content, /mock provider/);
      assert.equal(result.usage.total_tokens, 16);
      assert.ok(events.some((e) => e.type === 'text'));
      assert.ok(events.some((e) => e.type === 'done'));
    });

    await it('runs a write then a command, feeding results back', async () => {
      provider.scenario = 'tool_calls';
      const events = [];
      const result = await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'make a script and run it' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });

      assert.deepEqual(
        events.filter((e) => e.type === 'tool_call').map((e) => e.name),
        ['write_file', 'run_command']
      );

      const outcomes = events.filter((e) => e.type === 'tool_result');
      assert.equal(outcomes.length, 2);
      assert.ok(outcomes.every((r) => r.ok), JSON.stringify(outcomes));

      // The tool really ran on disk.
      assert.match(await fs.readFile(path.join(tmpRoot, 'src', 'hello.js'), 'utf8'), /hi from klaud/);

      // The command output travelled back to the provider.
      assert.match(provider.lastToolResult, /hi from klaud/);
      assert.match(provider.lastToolResult, /exit: 0/);

      const last = result.messages[result.messages.length - 1];
      assert.equal(last.role, 'assistant');
      assert.match(last.content, /Command output was/);
      assert.equal(result.finished, 'stop');
    });

    await it('merges streamed tool-call fragments into one executable call', async () => {
      provider.scenario = 'split_tool_args';
      const events = [];
      await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'list src' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });
      const call = events.find((e) => e.type === 'tool_call');
      assert.equal(call.name, 'list_dir');
      assert.deepEqual(call.args, { path: 'src' });
      const outcome = events.find((e) => e.type === 'tool_result');
      assert.ok(outcome.ok);
      assert.match(outcome.output, /app\.js/);
    });

    await it('degrades gracefully when the model rejects tools', async () => {
      provider.scenario = 'bad_tools';
      const events = [];
      const result = await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'hello' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });
      const notice = events.find((e) => e.type === 'notice');
      assert.ok(notice, 'expected a warning notice');
      assert.match(notice.message, /without them/);
      assert.equal(result.messages[0].role, 'assistant');
    });

    await it('asks for approval and honours a denial', async () => {
      provider.scenario = 'tool_calls';
      const events = [];
      const asked = [];
      await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'do it' }],
        cwd: tmpRoot,
        approvalMode: 'ask',
        onEvent: (e) => events.push(e),
        requestApproval: async ({ name }) => {
          asked.push(name);
          return false;
        },
      });
      assert.deepEqual(asked, ['write_file', 'run_command']);
      const outcomes = events.filter((e) => e.type === 'tool_result');
      assert.equal(outcomes.length, 2);
      assert.ok(outcomes.every((r) => r.denied === true));
      assert.ok(events.some((e) => e.type === 'approval_denied'));
      assert.match(provider.lastToolResult, /user denied permission/);
    });

    await it('asks for approval and proceeds when granted', async () => {
      provider.scenario = 'tool_calls';
      await fs.rm(path.join(tmpRoot, 'src', 'hello.js'), { force: true });
      const events = [];
      await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'do it' }],
        cwd: tmpRoot,
        approvalMode: 'ask',
        onEvent: (e) => events.push(e),
        requestApproval: async () => true,
      });
      const outcomes = events.filter((e) => e.type === 'tool_result');
      assert.ok(outcomes.every((r) => r.ok), JSON.stringify(outcomes));
      await fs.access(path.join(tmpRoot, 'src', 'hello.js'));
    });

    await it('stops promptly when aborted mid-stream', async () => {
      provider.scenario = 'slow';
      const controller = new AbortController();
      const events = [];
      const promise = runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'go' }],
        cwd: tmpRoot,
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      });
      setTimeout(() => controller.abort(), 250);
      const result = await promise;
      assert.equal(result.finished, 'aborted');
      assert.ok(events.some((e) => e.type === 'aborted'));
    });

    await it('surfaces a provider error as an event instead of throwing', async () => {
      provider.scenario = 'unauthorized';
      const events = [];
      const result = await runAgentTurn({
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'hello' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.finished, 'error');
      assert.match(events.find((e) => e.type === 'error').message, /API key was rejected/);
    });

    await it('respects the step limit', async () => {
      provider.scenario = 'loop_tools';
      const events = [];
      const result = await runAgentTurn({
        settings: { ...baseSettings(), maxSteps: 2 },
        messages: [{ role: 'user', content: 'loop forever' }],
        cwd: tmpRoot,
        onEvent: (e) => events.push(e),
      });
      assert.equal(result.steps, 2);
      assert.equal(result.finished, 'max_steps');
      assert.ok(
        events.some((e) => e.type === 'notice' && /step limit/.test(e.message)),
        `events were: ${events.map((e) => e.type).join(',')}`
      );
    });
  });

  /* =========================== history pruning =========================== */
  await describe('history pruning', async () => {
    const turn = (n, pad = '') => [
      { role: 'user', content: `question ${n} ${pad}` },
      { role: 'assistant', content: `answer ${n} ${pad}` },
    ];

    await it('leaves a short conversation alone', () => {
      const messages = [...turn(1), ...turn(2)];
      const result = pruneHistory(messages, 80_000);
      assert.equal(result.dropped, 0);
      assert.equal(result.messages.length, 4);
    });

    await it('drops the oldest turns when over budget', () => {
      const messages = [...turn(1, 'x'.repeat(500)), ...turn(2, 'x'.repeat(500)), ...turn(3, 'x'.repeat(500))];
      const result = pruneHistory(messages, 1_300);
      assert.ok(result.dropped > 0, 'expected something to be dropped');
      assert.match(result.messages[0].content, /question [23]/, result.messages[0].content);
      assert.ok(
        result.messages.reduce((n, m) => n + m.content.length, 0) <= 1_300 + 600,
        'pruned history should be near the budget'
      );
    });

    it('always keeps the newest turn', () => {
      const messages = [...turn(1, 'x'.repeat(5_000)), ...turn(2)];
      const result = pruneHistory(messages, 100);
      assert.ok(result.messages.some((m) => m.content.startsWith('question 2')));
    });

    it('never splits an assistant tool call from its result', () => {
      const messages = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a', content: 'file contents' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'answer' },
      ];
      const result = pruneHistory(messages, 1);
      const roles = result.messages.map((m) => m.role);
      // Whatever survives must still satisfy the provider's ordering rules.
      const repaired = repairToolSequences(result.messages);
      for (let i = 0; i < repaired.length; i++) {
        if (repaired[i].role === 'assistant' && repaired[i].tool_calls) {
          assert.equal(repaired[i + 1].role, 'tool', `roles were ${roles.join(',')}`);
        }
      }
    });

    it('keeps the newest turn whole at the very start', () => {
      const messages = [...turn(1, 'x'.repeat(200)), ...turn(2)];
      const result = pruneHistory(messages, 60);
      assert.equal(result.messages[0].role, 'user');
      assert.match(result.messages[0].content, /question 2/);
    });

    it('does nothing when no budget is configured', () => {
      const messages = [...turn(1, 'x'.repeat(5_000)), ...turn(2)];
      assert.equal(pruneHistory(messages, 0).dropped, 0);
      assert.equal(pruneHistory(messages, undefined).dropped, 0);
    });
  });

  /* ============================ tool catalogue =========================== */
  await describe('tool catalogue', async () => {
    await it('exposes every tool with a valid JSON schema', () => {
      assert.ok(TOOLS.length >= 9, `expected at least 9 tools, found ${TOOLS.length}`);
      for (const entry of TOOLS) {
        assert.ok(entry.name && entry.description, `${entry.name} needs a name and description`);
        assert.equal(entry.parameters.type, 'object');
        assert.ok(Array.isArray(entry.parameters.required));
        for (const key of entry.parameters.required) {
          assert.ok(entry.parameters.properties[key], `${entry.name}: required "${key}" has no property`);
        }
      }
    });
  });

  /* ================================ teardown ============================== */
  await provider.close().catch(() => {});
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  const total = results.pass + results.fail;
  console.log('');
  if (results.fail) {
    console.log(`\x1b[31mx ${results.fail} of ${total} checks failed\x1b[0m\n`);
    for (const failure of failures) {
      console.log(`  ${failure.group} > ${failure.name}`);
      console.log(`  ${String(failure.err.stack || failure.err.message).split('\n').slice(0, 4).join('\n  ')}\n`);
    }
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${total} checks passed\x1b[0m\n`);
}

main().catch((err) => {
  console.error('\nHarness crashed:', err);
  process.exit(1);
});
