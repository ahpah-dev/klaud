'use strict';

/**
 * Proxied API tool and the external-effect gate.
 *
 *   node test/api-tool.js
 *
 * Plain text output and a non-zero exit code on failure, like the other suites.
 *
 * The bug this exists to prevent: Klaud's approval gate knew only about local
 * effects, so in read-only mode it could not write a file but could still act on
 * a third party service as the user — and a `send` action was never even asked
 * about in "ask" mode, because the gate matched on three tool names.
 *
 * Everything here runs against local mock HTTP servers and throwaway temp
 * directories. No live network call is made, and the real ~/.klaud is never
 * read or written: KLAUD_DATA_DIR is redirected before anything is required.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const assert = require('assert/strict');

/* The data directory has to point at a throwaway before the first require of
 * src/config, or a suite that connects a service would write to the real one. */
const TMP = path.join(os.tmpdir(), `klaud-api-tool-${process.pid}-${Date.now()}`);
process.env.KLAUD_DATA_DIR = path.join(TMP, 'data');
process.env.KLAUD_AGENTS_DIR = path.join(TMP, 'data', 'agents');

const api = require('../src/lib/api-tool');
const { executeTool, registerTools, permissionForCall, toolSchemas } = require('../src/lib/tools');
const { runAgentTurn } = require('../src/agent');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

/** The two refusals that already existed, verbatim. Nothing here may edit them. */
const WRITE_REFUSAL = 'Permission denied: writes are disabled (approval mode "readonly").';
const EXEC_REFUSAL = 'Permission denied: command execution is disabled (approval mode "readonly").';

/* Token-shaped strings, for asserting that none of them can reach a prompt. */
const TOKEN_SHAPES = [
  ['a Google access token', /ya29\.[A-Za-z0-9_-]{10,}/],
  ['a JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ['a Google refresh token', /1\/\/[A-Za-z0-9_-]{16,}/],
  ['a bearer header', /Bearer\s+[A-Za-z0-9._-]{10,}/i],
  ['a long opaque run', /[A-Za-z0-9_-]{32,}/],
];
const SECRET_ACCESS = 'ya29.MOCK-ACCESS-TOKEN-MUST-NEVER-BE-SHOWN-0123456789';
const SECRET_REFRESH = '1//MOCK-REFRESH-TOKEN-MUST-NEVER-BE-SHOWN-9876543210';

/* ------------------------------------------------------------------ *
 * Mock service
 * ------------------------------------------------------------------ */

function startMockApi() {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const send = (status, payload, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };

    if (req.url.startsWith('/api/search')) {
      return send(200, { messages: [{ id: 'm1', snippet: 'hello from the mock' }], resultSizeEstimate: 1 });
    }
    if (req.url.startsWith('/api/profile')) return send(200, { email: 'ada@example.com' });
    if (req.url.startsWith('/api/label')) return send(200, { id: 'm1', labelIds: ['STARRED'] });
    if (req.url.startsWith('/api/send')) return send(200, { id: 'sent-1', threadId: 't1' });
    if (req.url.startsWith('/api/empty')) return send(204, '');
    if (req.url.startsWith('/api/refuse')) {
      return send(403, {
        error: {
          code: 403,
          message: 'Insufficient Permission: the account was not granted mock.send',
          errors: [{ reason: 'insufficientPermissions' }],
        },
      });
    }
    if (req.url.startsWith('/api/broken')) return send(500, '<html>upstream exploded</html>', 'text/html');
    return send(404, { error: { message: 'no such route' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      state.base = `http://127.0.0.1:${state.port}`;
      resolve({ server, state });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Mock connector, registry and authorization store
 * ------------------------------------------------------------------ */

function buildConnector(base) {
  return {
    id: 'mockmail',
    label: 'MockMail',
    // The API root is what every request is built against; without it nothing
    // can be sent, which is asserted further down.
    baseUrl: `${base}/api`,
    authUrl: 'https://mockmail.test/authorize',
    tokenUrl: 'https://mockmail.test/token',
    scopes: ['mock.read', 'mock.write', 'mock.send'],
    setupHint: 'Create an OAuth client in the MockMail console and paste its id and secret into Settings.',
    actions: [
      {
        // Declarative request plus a thin run: the shape the contract describes.
        name: 'search',
        label: 'Search',
        description: 'Find messages.',
        permission: 'read',
        method: 'GET',
        path: '/search',
        query: (args) => ({ q: args.query }),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'What to look for.' } },
          required: ['query'],
        },
        async run(args, ctx) {
          return ctx.callApi('search', args);
        },
      },
      {
        // Purely declarative: no run at all.
        name: 'profile',
        label: 'Profile',
        description: 'The signed-in account.',
        permission: 'read',
        method: 'GET',
        path: '/profile',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        // A run that computes its own request description.
        name: 'label',
        label: 'Label',
        description: 'Add a label to a message.',
        permission: 'write',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Message id.' } },
          required: ['id'],
        },
        async run(args, ctx) {
          return ctx.callApi({ method: 'POST', path: '/label', body: { id: args.id, addLabelIds: ['STARRED'] } }, args);
        },
      },
      {
        name: 'send_message',
        label: 'Send',
        description: 'Send an email as the user.',
        permission: 'send',
        method: 'POST',
        path: '/send',
        body: (args) => ({ to: args.to, subject: args.subject, body: args.body }),
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient.' },
            subject: { type: 'string', description: 'Subject.' },
            body: { type: 'string', description: 'Body.' },
          },
          required: ['to', 'subject', 'body'],
        },
        async run(args, ctx) {
          return ctx.callApi('send_message', args);
        },
      },
      {
        name: 'refuse',
        label: 'Refused call',
        description: 'Always refused by the service. Used to prove a failure is explained.',
        permission: 'read',
        method: 'GET',
        path: '/refuse',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'broken',
        label: 'Broken call',
        description: 'Always fails with a server error.',
        permission: 'read',
        method: 'GET',
        path: '/broken',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'empty',
        label: 'Empty call',
        description: 'Succeeds with no body.',
        permission: 'read',
        method: 'GET',
        path: '/empty',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        // An action that never builds a request because its connector has no
        // base URL is a separate connector; see `noBaseUrl` below.
        name: 'unreachable',
        label: 'Unreachable',
        description: 'Never runs.',
        permission: 'read',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
  };
}

function registryFor(connector) {
  return {
    listConnectors: () => (connector ? [connector] : []),
    getConnector: (id) => (connector && connector.id === String(id).toLowerCase() ? connector : null),
  };
}

/** The authorization store, in the shape src/lib/oauth.js documents. */
function makeStore({ token = SECRET_ACCESS, account = 'ada@example.com', expired = false } = {}) {
  return {
    connections: [
      {
        connectorId: 'mockmail',
        label: 'MockMail',
        account,
        expires_at: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
        scopes: ['mock.read', 'mock.write', 'mock.send'],
        // Deliberately present: a real record carries tokens, and nothing this
        // module prints may ever carry them with it.
        tokens: { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH },
      },
    ],
    mode: 'ok',
    deleted: [],
    async listConnections() {
      return this.connections;
    },
    async loadConnection(id) {
      return this.connections.find((c) => c.connectorId === String(id)) || null;
    },
    async accessTokenFor() {
      if (this.mode === 'throw') throw new Error('the stored refresh token was revoked');
      if (this.mode === 'null') return null;
      if (this.mode === 'refused') {
        return {
          ok: false,
          error: 'No mockmail connection is stored.',
          hint: 'Nothing has been connected under that id yet.',
          needsReconnect: true,
        };
      }
      return { ok: true, token, connection: this.connections[0] || null, refreshed: false };
    },
    async startAuthorization({ onStatus }) {
      if (this.mode === 'throw') throw new Error('the authorization listener could not start');
      if (this.mode === 'refused') {
        return { ok: false, error: 'MockMail has no OAuth client ID.', hint: 'Register a desktop client first.', needsReconnect: false };
      }
      if (this.mode === 'silent') return { ok: true, connection: null, warnings: [] };
      onStatus('Preparing the MockMail sign-in...');
      return { ok: true, connection: this.connections[0], connectorId: 'mockmail', warnings: ['Tokens are stored as plain JSON.'] };
    },
    async deleteConnection(id) {
      this.deleted.push(String(id));
      this.connections = this.connections.filter((c) => c.connectorId !== String(id));
      return true;
    },
  };
}

/** Every JSON Schema this suite is willing to call valid. */
function schemaProblems(schema, where) {
  const problems = [];
  const allowed = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
  const walk = (node, at) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${at} is not an object`);
      return;
    }
    if ('type' in node) {
      const type = node.type;
      const ok = typeof type === 'string' ? allowed.includes(type) : Array.isArray(type) && type.every((t) => allowed.includes(t));
      if (!ok) problems.push(`${at}.type is not a valid JSON Schema type`);
    }
    if (node.type === 'object') {
      if (node.properties !== undefined && (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties))) {
        problems.push(`${at}.properties must be an object`);
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required)) problems.push(`${at}.required must be an array`);
        else {
          for (const key of node.required) {
            if (!node.properties || !Object.prototype.hasOwnProperty.call(node.properties, key)) {
              problems.push(`${at}.required names "${key}", which has no matching property`);
            }
          }
        }
      }
      for (const [key, value] of Object.entries(node.properties || {})) walk(value, `${at}.properties.${key}`);
    }
    if (node.type === 'array' && node.items) walk(node.items, `${at}.items`);
  };
  walk(schema, where);
  return problems;
}

/** A tool run that reports a throw instead of exploding the suite. */
async function runTool(def, args) {
  try {
    return { ok: true, output: await def.run(args || {}, {}) };
  } catch (err) {
    return { ok: false, output: err && err.message ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * A stand-in OpenAI-compatible provider, for the approval gate
 * ------------------------------------------------------------------ */

function startMockProvider(initialToolCall) {
  const state = { requests: [], toolCall: initialToolCall };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    state.requests.push(body);
    const answered = (body.messages || []).some((m) => m.role === 'tool');
    const payload = answered
      ? { choices: [{ index: 0, message: { content: 'Finished.' }, finish_reason: 'stop' }] }
      : { choices: [{ index: 0, message: { content: '', tool_calls: [state.toolCall] }, finish_reason: 'tool_calls' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}/v1`;
      resolve({ server, state });
    });
  });
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

async function main() {
  await fs.mkdir(path.join(TMP, 'workspace'), { recursive: true });
  const workspace = path.join(TMP, 'workspace');
  const mock = await startMockApi();
  const connector = buildConnector(mock.state.base);
  const registry = registryFor(connector);
  const noBaseUrl = { ...connector, id: 'nowhere', label: 'Nowhere', baseUrl: undefined };

  const provider = await startMockProvider({
    id: 'call_1',
    type: 'function',
    function: {
      name: 'use_mockmail',
      arguments: JSON.stringify({
        action: 'send_message',
        args: { to: 'ada@example.com', subject: 'Hello', body: 'Sent by a test.' },
      }),
    },
  });

  const BASE_PROMPT = 'You are a test agent. Reply briefly.';
  const settings = () => ({
    baseUrl: provider.state.base,
    apiKey: 'test-key',
    model: 'mock-model',
    systemPrompt: BASE_PROMPT,
    temperature: 0,
    maxSteps: 3,
  });

  console.log('\n\x1b[38;5;209m* Proxied API tool and the external-effect gate\x1b[0m\n');

  /* ---------------- definitions ---------------- */

  console.log('  \x1b[1mtool definitions\x1b[0m');

  const serviceTools = api.listServiceTools({ registry, oauth: makeStore() });
  check('one umbrella tool per connector', serviceTools.length === 1 && serviceTools[0].name === 'use_mockmail',
    serviceTools.map((t) => t.name).join(', '));

  const umbrella = serviceTools[0] || {
    parameters: { type: 'object', properties: {}, required: [] },
    permission: '',
    description: '',
  };
  const problems = schemaProblems(umbrella.parameters, 'use_mockmail.parameters');
  check('the umbrella tool has a valid JSON Schema', problems.length === 0, JSON.stringify(problems));
  check('the umbrella takes {action, args}',
    umbrella.parameters.properties.action.type === 'string' &&
      umbrella.parameters.properties.args.type === 'object' &&
      Array.isArray(umbrella.parameters.required) && umbrella.parameters.required.includes('action'),
    JSON.stringify(umbrella.parameters));

  const levels = ['read', 'write', 'send'];
  check('every service tool declares read, write or send', serviceTools.every((t) => levels.includes(t.permission)),
    serviceTools.map((t) => `${t.name}:${t.permission}`).join(', '));
  check('the declared permission is the strongest action the tool can reach', umbrella.permission === 'send',
    String(umbrella.permission));
  check('the description lists the real actions',
    ['search', 'profile', 'label', 'send_message'].every((n) => umbrella.description.includes(n)),
    umbrella.description.slice(0, 160));

  const builtInProblems = toolSchemas()
    .filter((t) => t.function.name.startsWith('use_') || t.function.name.endsWith('_connections') || t.function.name.endsWith('_service'))
    .flatMap((t) => schemaProblems(t.function.parameters, t.function.name));
  check('the built-in schemas this suite adds are valid too', builtInProblems.length === 0, JSON.stringify(builtInProblems));

  check('permissionForCall resolves a send action to send',
    permissionForCall(umbrella, { action: 'send_message', args: {} }) === 'send');
  check('permissionForCall resolves a read action to read',
    permissionForCall(umbrella, { action: 'search', args: {} }) === 'read');
  check('permissionForCall resolves a write action to write',
    permissionForCall(umbrella, { action: 'label', args: {} }) === 'write');
  check('permissionForCall still reports a plain tool by its declared level',
    permissionForCall('write_file', {}) === 'write' && permissionForCall('run_command', {}) === 'exec');

  /* the registry may not be installed at all */
  check('a missing connector registry yields no service tools',
    Array.isArray(api.listServiceTools({ registry: null })) && api.listServiceTools({ registry: null }).length === 0);
  check('a registry shaped wrongly also yields no tools rather than throwing',
    api.listServiceTools({ registry: { listConnectors: 'not a function' } }).length === 0);
  check('a registry whose listing throws yields no tools rather than throwing',
    api.listServiceTools({ registry: { listConnectors() { throw new Error('broken connector file'); } } }).length === 0);
  check('the authorization tools exist with no registry and no store',
    api.authToolDefinitions({ registry: null, oauth: null }).map((t) => t.name).join(',') ===
      'list_connections,connect_service,disconnect_service');

  /* ---------------- read-only mode ---------------- */

  console.log('\n  \x1b[1mread-only refusals\x1b[0m');

  const writeAttempt = await executeTool('write_file', { path: 'x.txt', content: 'x' }, { cwd: workspace, approvalMode: 'readonly' });
  check('a write refusal says exactly what it said before', writeAttempt.ok === false && writeAttempt.output === WRITE_REFUSAL,
    writeAttempt.output);

  const execAttempt = await executeTool('run_command', { command: 'echo hi' }, { cwd: workspace, approvalMode: 'readonly' });
  check('a command refusal says exactly what it said before', execAttempt.ok === false && execAttempt.output === EXEC_REFUSAL,
    execAttempt.output);

  registerTools(api.listServiceTools({ registry, oauth: makeStore() }));
  registerTools(api.authToolDefinitions({ registry, oauth: makeStore() }));

  const sendAttempt = await executeTool(
    'use_mockmail',
    { action: 'send_message', args: { to: 'a@b.c', subject: 's', body: 'b' } },
    { cwd: workspace, approvalMode: 'readonly' }
  );
  check('a send action is refused in read-only mode', sendAttempt.ok === false, sendAttempt.output);
  check('the send refusal names the external effect, not a file',
    /external actions are disabled \(approval mode "readonly"\)/.test(sendAttempt.output) &&
      /could not be\s+taken back|taken back/.test(sendAttempt.output),
    sendAttempt.output);
  check('the send refusal is not the write refusal',
    sendAttempt.output !== writeAttempt.output && !/writes are disabled/.test(sendAttempt.output),
    sendAttempt.output);
  check('the send refusal says nothing was sent', /nothing was sent/i.test(sendAttempt.output), sendAttempt.output);
  check('the send refusal names the mode that blocked it', /readonly/.test(sendAttempt.output), sendAttempt.output);
  check('the refused send never reached the service',
    mock.state.requests.filter((r) => r.url.includes('/api/send')).length === 0);

  const writeActionAttempt = await executeTool('use_mockmail', { action: 'label', args: { id: 'm1' } }, { cwd: workspace, approvalMode: 'readonly' });
  check('a write action on a service is refused too', writeActionAttempt.ok === false, writeActionAttempt.output);
  check('the service write refusal is the same write refusal as before',
    writeActionAttempt.output === WRITE_REFUSAL, writeActionAttempt.output);
  check('a service write refusal is distinguishable from a service send refusal',
    writeActionAttempt.output !== sendAttempt.output && /external actions/.test(sendAttempt.output),
    `${JSON.stringify(writeActionAttempt.output)} vs ${JSON.stringify(sendAttempt.output)}`);

  const readAttempt = await executeTool('use_mockmail', { action: 'search', args: { query: 'hello' } }, { cwd: workspace, approvalMode: 'readonly' });
  check('a read action is allowed in read-only mode', readAttempt.ok === true, readAttempt.output);
  check('the read action really made its request',
    mock.state.requests.some((r) => r.url.includes('/api/search') && r.url.includes('q=hello')),
    JSON.stringify(mock.state.requests.map((r) => r.url)));
  check('the read action carried the access token',
    mock.state.requests.some((r) => r.url.includes('/api/search') && /^Bearer ya29\./.test(r.headers.authorization || '')),
    mock.state.requests.map((r) => r.headers.authorization).join(' | '));
  check('the read result is the service payload', /hello from the mock/.test(readAttempt.output), readAttempt.output);

  const declarative = await executeTool('use_mockmail', { action: 'profile', args: {} }, { cwd: workspace, approvalMode: 'readonly' });
  check('a purely declarative read action works with no run function',
    declarative.ok === true && /ada@example\.com/.test(declarative.output), declarative.output);

  const empty = await executeTool('use_mockmail', { action: 'empty', args: {} }, { cwd: workspace, approvalMode: 'readonly' });
  check('an empty success is spelled out rather than returned as an empty string',
    empty.ok === true && empty.output.trim().length > 0 && /empty body/.test(empty.output), empty.output);

  /* ---------------- failures ---------------- */

  console.log('\n  \x1b[1mfailures\x1b[0m');

  const refused = await executeTool('use_mockmail', { action: 'refuse', args: {} }, { cwd: workspace, approvalMode: 'auto' });
  check('a refused request produces a non-empty result', typeof refused.output === 'string' && refused.output.trim().length > 0);
  check('the refusal names the status', /403/.test(refused.output), refused.output);
  check('the refusal repeats the service\'s own words',
    /Insufficient Permission/.test(refused.output), refused.output);
  check('the refusal offers a next step', /\[Klaud\]/.test(refused.output), refused.output);
  check('the refusal does not read as success', !/succeeded|accepted/i.test(refused.output), refused.output);

  const broken = await executeTool('use_mockmail', { action: 'broken', args: {} }, { cwd: workspace, approvalMode: 'auto' });
  check('a 500 is reported as the service\'s failure', /500/.test(broken.output) && /inside MockMail/.test(broken.output),
    broken.output);

  const journal = [
    await api.callConnector(connector, 'search', { query: 'x' }, { approvalMode: 'readonly', oauth: makeStore() }),
    await api.callConnector(connector, 'send_message', { to: 'a@b.c', subject: 's', body: 'b' }, { approvalMode: 'readonly', oauth: makeStore() }),
    await api.callConnector(connector, 'label', { id: 'm1' }, { approvalMode: 'readonly', oauth: makeStore() }),
  ];
  check('callConnector refuses a send under readonly with its own sentence',
    /external actions are disabled \(approval mode "readonly"\)/.test(journal[1]) &&
      !/writes are disabled/.test(journal[1]),
    journal[1]);
  check('callConnector refuses a write under readonly',
    /write actions are disabled \(approval mode "readonly"\)/.test(journal[2]) && journal[2] !== journal[1], journal[2]);
  check('callConnector allows the read action under readonly and reads it back',
    /HTTP 200/.test(journal[0]) && /hello from the mock/.test(journal[0]), journal[0]);

  const unknown = await api.callConnector(connector, 'no_such_action', {}, { approvalMode: 'auto' });
  check('an unknown action names the real ones instead of crashing',
    /Unknown action "no_such_action"/.test(unknown) && /search \(read\)/.test(unknown) && /send_message \(send\)/.test(unknown),
    unknown);
  check('an unknown action reports that nothing was sent', /nothing was sent/i.test(unknown), unknown);
  check('an unknown action does not ask a connector for a request',
    mock.state.requests.filter((r) => r.url.includes('no_such_action')).length === 0);

  const unknownTool = await executeTool('use_mockmail', { action: 'gmail_send', args: {} }, { cwd: workspace, approvalMode: 'auto' });
  check('an unknown action through the tool gets the same list', /Available actions/.test(unknownTool.output), unknownTool.output);

  const stranded = await api.callConnector(noBaseUrl, 'search', { query: 'x' }, { approvalMode: 'auto', oauth: makeStore() });
  check('a connector with no API root says so instead of guessing a host',
    /no baseUrl/.test(stranded) && /nothing was sent/i.test(stranded), stranded);

  /* ---------------- tokens ---------------- */

  console.log('\n  \x1b[1maccess tokens\x1b[0m');

  for (const [label, store] of [
    ['no token at all', makeStore({ token: null })],
    ['the store throwing', (() => { const s = makeStore(); s.mode = 'throw'; return s; })()],
    ['the store reporting a failure', (() => { const s = makeStore(); s.mode = 'refused'; return s; })()],
    ['no authorization module', null],
  ]) {
    let output;
    let threw = false;
    try {
      output = await api.callConnector(connector, 'search', { query: 'x' }, { approvalMode: 'auto', oauth: store });
    } catch (err) {
      threw = true;
      output = `threw: ${err.message}`;
    }
    check(`${label}: does not throw, and asks for a reconnect`,
      threw === false && typeof output === 'string' && /reconnect/i.test(output), String(output).slice(0, 200));
    check(`${label}: nothing was sent`, /nothing was sent/i.test(String(output)), String(output).slice(0, 200));
  }

  const before = mock.state.requests.length;
  await api.callConnector(connector, 'search', { query: 'x' }, { approvalMode: 'auto', oauth: makeStore({ token: null }) });
  check('a call with no usable token never reaches the service', mock.state.requests.length === before);

  /* ---------------- connections ---------------- */

  console.log('\n  \x1b[1mconnections\x1b[0m');

  const auth = (store, reg = registry) =>
    Object.fromEntries(api.authToolDefinitions({ registry: reg, oauth: store }).map((t) => [t.name, t]));

  const emptyStore = {
    connections: [],
    async listConnections() {
      return [];
    },
    async loadConnection() {
      return null;
    },
    async accessTokenFor() {
      return null;
    },
    async deleteConnection() {
      return true;
    },
  };
  const emptyList = await runTool(auth(emptyStore).list_connections);
  check('list_connections says nothing is connected', /No services are connected/.test(emptyList.output), emptyList.output);
  check('list_connections offers what could be connected', /mockmail \(MockMail\)/.test(emptyList.output), emptyList.output);

  const connectedStore = makeStore();
  const list = await runTool(auth(connectedStore).list_connections);
  check('list_connections names the service', /MockMail/.test(list.output), list.output);
  check('list_connections names the account', /ada@example\.com/.test(list.output), list.output);
  check('list_connections says the token is valid', /valid until/.test(list.output), list.output);
  check('list_connections says nothing token-shaped',
    TOKEN_SHAPES.every(([, re]) => !re.test(list.output)) && !list.output.includes(SECRET_ACCESS) && !list.output.includes(SECRET_REFRESH),
    list.output);

  const expiredList = await runTool(auth(makeStore({ expired: true })).list_connections);
  check('list_connections flags an expired token and says what to do',
    /expired/.test(expiredList.output) && /connect_service/.test(expiredList.output), expiredList.output);

  const unknownService = await runTool(auth(connectedStore).connect_service, { service: 'gmail' });
  check('connecting an unknown service lists the real ones',
    unknownService.ok === false && /Unknown service "gmail"/.test(unknownService.output) && /mockmail/.test(unknownService.output),
    unknownService.output);

  const brokenFlow = makeStore();
  brokenFlow.mode = 'refused';
  const failedConnect = await runTool(auth(brokenFlow).connect_service, { service: 'mockmail' });
  check('a failed connection reports failure rather than success',
    failedConnect.ok === false && /Could not connect MockMail/.test(failedConnect.output), failedConnect.output);
  check('a failed connection shows the connector\'s setup hint',
    /Create an OAuth client in the MockMail console/.test(failedConnect.output), failedConnect.output);
  check('a failed connection repeats the flow\'s own reason',
    /no OAuth client ID/.test(failedConnect.output), failedConnect.output);

  const throwingFlow = makeStore();
  throwingFlow.mode = 'throw';
  const threwConnect = await runTool(auth(throwingFlow).connect_service, { service: 'mockmail' });
  check('a flow that throws is still reported with the setup hint',
    threwConnect.ok === false && /setup hint|Setup: Create an OAuth client/i.test(threwConnect.output), threwConnect.output);

  const goodFlow = makeStore();
  const connected = await runTool(auth(goodFlow).connect_service, { service: 'mockmail' });
  check('a successful connection says so', connected.ok === true && /Connected MockMail/.test(connected.output), connected.output);
  check('a successful connection lists the actions now available',
    /send_message \(send\)/.test(connected.output) && /search \(read\)/.test(connected.output), connected.output);
  check('a successful connection passes on where the token is kept',
    /plain JSON/.test(connected.output), connected.output);

  const deleted = await runTool(auth(makeStore()).disconnect_service, { service: 'mockmail' });
  check('disconnect deletes the stored credential and says so',
    deleted.ok === true && /Disconnected MockMail/.test(deleted.output) && /deleted/.test(deleted.output), deleted.output);

  const alreadyGone = await runTool(auth(emptyStore).disconnect_service, { service: 'mockmail' });
  check('disconnecting something that is not connected says nothing changed',
    /not connected/.test(alreadyGone.output) && /Nothing changed/.test(alreadyGone.output), alreadyGone.output);

  /* ---------------- the prompt ---------------- */

  console.log('\n  \x1b[1mprompt text\x1b[0m');

  check('the prompt block is empty when nothing is connected',
    (await api.describeConnectionsForPrompt({ registry, oauth: emptyStore })) === '');
  check('the prompt block is empty when there is no authorization module at all',
    (await api.describeConnectionsForPrompt({ registry, oauth: null })) === '');
  check('the prompt block is empty for the real store in a fresh data directory',
    (await api.describeConnectionsForPrompt()) === '', await api.describeConnectionsForPrompt());

  const prompt = await api.describeConnectionsForPrompt({ registry, oauth: connectedStore });
  check('the prompt block lists the service and its account', /MockMail as ada@example\.com/.test(prompt), prompt);
  check('the prompt block lists the actions with their permissions',
    /search \(read\)/.test(prompt) && /send_message \(send\)/.test(prompt), prompt);
  check('the prompt block states that a send goes out as the user and needs confirming',
    /go out as the user/.test(prompt) && /Confirm the exact recipient/.test(prompt), prompt);
  check('the prompt block never carries a token value',
    TOKEN_SHAPES.every(([, re]) => !re.test(prompt)) && !prompt.includes(SECRET_ACCESS) && !prompt.includes(SECRET_REFRESH),
    prompt.slice(0, 300));
  check('the prompt block says nothing about a raw access_token field',
    !/access_token|refresh_token|"tokens"/.test(prompt), prompt.slice(0, 300));

  for (const [label, re] of TOKEN_SHAPES) {
    const hit = re.exec(prompt);
    check(`no ${label} in the prompt block`, hit === null, hit ? `matched ${hit[0]}` : '');
  }

  /* ---------------- the approval gate ---------------- */

  console.log('\n  \x1b[1mthe approval gate\x1b[0m');

  const runTurn = async (mode, { approve = true, onAsk = () => {} } = {}) => {
    const events = [];
    const asked = [];
    const result = await runAgentTurn({
      settings: settings(),
      messages: [{ role: 'user', content: 'send that email' }],
      cwd: workspace,
      approvalMode: mode,
      skipExtensions: true,
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        asked.push(request);
        onAsk(request);
        return approve;
      },
    });
    return { events, asked, result };
  };

  const sendsBefore = mock.state.requests.filter((r) => r.url.includes('/api/send')).length;

  const denied = await runTurn('ask', { approve: false });
  check('a send action asks for approval in "ask" mode', denied.asked.length === 1, JSON.stringify(denied.asked));
  check('the request carries the send permission, not "write"',
    denied.asked[0] && denied.asked[0].permission === 'send', JSON.stringify(denied.asked[0]));
  check('the request names the service and the action',
    denied.asked[0] && denied.asked[0].name === 'use_mockmail' && denied.asked[0].args.action === 'send_message',
    JSON.stringify(denied.asked[0] && denied.asked[0].args));
  check('the reason says Klaud wants to send this as the user',
    denied.asked[0] && /wants to send this as you/.test(denied.asked[0].reason) && /mockmail/i.test(denied.asked[0].reason),
    denied.asked[0] && denied.asked[0].reason);
  check('the reason says it cannot be taken back',
    denied.asked[0] && /cannot be taken back/.test(denied.asked[0].reason), denied.asked[0] && denied.asked[0].reason);
  check('the reason reaches the transcript as a notice the user can read',
    denied.events.some((e) => e.type === 'notice' && /wants to send this as you/.test(e.message)),
    JSON.stringify(denied.events.filter((e) => e.type === 'notice')));
  check('a denied send is reported as denied', denied.events.some((e) => e.type === 'approval_denied'));
  check('a denied send tells the model nothing was sent',
    denied.events.some((e) => e.type === 'tool_result' && /Nothing was sent/.test(e.output)),
    JSON.stringify(denied.events.filter((e) => e.type === 'tool_result').map((e) => e.output)));
  check('a denied send never reached the service',
    mock.state.requests.filter((r) => r.url.includes('/api/send')).length === sendsBefore);

  const allowed = await runTurn('ask', { approve: true });
  check('an approved send is sent', mock.state.requests.filter((r) => r.url.includes('/api/send')).length === sendsBefore + 1,
    JSON.stringify(mock.state.requests.map((r) => r.url)));
  check('the approved send carried the token and the body',
    mock.state.requests.some((r) => r.url.includes('/api/send') && /^Bearer ya29\./.test(r.headers.authorization || '') &&
      /"to":"ada@example\.com"/.test(r.body)),
    JSON.stringify(mock.state.requests.filter((r) => r.url.includes('/api/send'))));
  check('the approved send reports what the service answered',
    allowed.events.some((e) => e.type === 'tool_result' && /sent-1|HTTP 200/.test(e.output)),
    JSON.stringify(allowed.events.filter((e) => e.type === 'tool_result').map((e) => e.output).slice(0, 2)));

  const auto = await runTurn('auto');
  check('auto-run mode asks for nothing', auto.asked.length === 0, JSON.stringify(auto.asked.map((a) => a.name)));
  check('auto-run mode does not add a permission notice',
    !auto.events.some((e) => e.type === 'notice' && /wants to send this as you/.test(e.message)));

  /* A read action, through a real turn: it must not be gated in "ask" mode, and
   * it must still be performed. */
  const sendsNow = mock.state.requests.filter((r) => r.url.includes('/api/send')).length;
  provider.state.toolCall = {
    id: 'call_2',
    type: 'function',
    function: {
      name: 'use_mockmail',
      arguments: JSON.stringify({ action: 'search', args: { query: 'unread' } }),
    },
  };
  const readTurn = await runTurn('ask');
  check('a read action is never gated in "ask" mode', readTurn.asked.length === 0,
    JSON.stringify(readTurn.asked.map((a) => a.name)));
  check('the read action was still performed under "ask" mode',
    mock.state.requests.some((r) => r.url.includes('/api/search') && r.url.includes('q=unread')),
    JSON.stringify(mock.state.requests.map((r) => r.url).slice(-4)));
  check('no send happened while reading',
    mock.state.requests.filter((r) => r.url.includes('/api/send')).length === sendsNow);

  /* the prompt the model actually receives */
  provider.state.requests.length = 0;
  await runTurn('auto');
  const firstPrompt = provider.state.requests[0] || null;
  check('the system prompt is byte-identical when nothing is connected',
    firstPrompt && firstPrompt.messages[0].role === 'system' && firstPrompt.messages[0].content === BASE_PROMPT,
    firstPrompt ? JSON.stringify(firstPrompt.messages[0].content) : 'no request captured');
  check('the provider request really did offer the service tool',
    firstPrompt && Array.isArray(firstPrompt.tools) && firstPrompt.tools.some((t) => t.function.name === 'use_mockmail'),
    firstPrompt ? JSON.stringify((firstPrompt.tools || []).map((t) => t.function.name)) : '');

  /* Now with a connection in the real store: the prompt must gain the block, and
   * still must not gain a token. */
  const realOauth = require('../src/lib/oauth');
  const connectionsDir = realOauth.__internals.connectionsDir();
  await fs.mkdir(connectionsDir, { recursive: true });
  await fs.writeFile(
    path.join(connectionsDir, 'mockmail.json'),
    JSON.stringify({
      connectorId: 'mockmail',
      label: 'MockMail',
      account: 'ada@example.com',
      scopes: ['mock.read'],
      connected_at: Date.now(),
      updated_at: Date.now(),
      tokens: { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_at: Date.now() + 3_600_000 },
    }),
    'utf8'
  );

  const connectedPrompt = await api.describeConnectionsForPrompt();
  check('a stored connection reaches the prompt through the real store',
    /mockmail/.test(connectedPrompt) && /Connected services/.test(connectedPrompt), connectedPrompt.slice(0, 200));
  check('a connection with no installed connector is reported honestly rather than given a fake tool',
    /no connector is installed/.test(connectedPrompt), connectedPrompt.slice(0, 200));
  check('the real-store prompt carries no token either',
    TOKEN_SHAPES.every(([, re]) => !re.test(connectedPrompt)) && !connectedPrompt.includes(SECRET_ACCESS),
    connectedPrompt.slice(0, 300));

  provider.state.requests.length = 0;
  await runTurn('auto');
  const withConnection = provider.state.requests[0];
  check('the real prompt changes once something is connected',
    withConnection && withConnection.messages[0].content.startsWith(BASE_PROMPT) &&
      withConnection.messages[0].content.includes('Connected services'),
    withConnection ? JSON.stringify(withConnection.messages[0].content.slice(0, 240)) : 'no request captured');
  check('the real prompt never carries a token',
    withConnection && TOKEN_SHAPES.every(([, re]) => !re.test(withConnection.messages[0].content)),
    withConnection ? withConnection.messages[0].content.slice(0, 200) : '');

  await realOauth.deleteConnection('mockmail');
  check('disconnecting through the real store removes it',
    (await api.describeConnectionsForPrompt()) === '');

  /* the callable surface the brief fixed */
  check('the module exports exactly the four documented functions',
    Object.keys(api).sort().join(',') === 'authToolDefinitions,callConnector,describeConnectionsForPrompt,listServiceTools',
    Object.keys(api).join(', '));
  check('callConnector takes (connector, action, args, ctx)',
    api.callConnector.length === 4, String(api.callConnector.length));

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} proxied-API checks failed\x1b[0m\n`);
    return 1;
  }
  console.log(`\x1b[32m+ all ${pass} proxied-API checks passed\x1b[0m\n`);
  return 0;
}

main()
  .then(async (code) => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`\n\x1b[31mThe suite itself failed: ${err && err.stack ? err.stack : err}\x1b[0m\n`);
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
