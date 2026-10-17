'use strict';

/**
 * OmniRoute setup test.
 *
 *   node test/omniroute.js
 *
 * Nothing here installs OmniRoute or starts one. A local HTTP server stands in
 * for its API, PATH state is a throwaway directory, and `fetch`, `spawn`,
 * `pathEnv` and `nodeVersion` are injected, so every assertion describes
 * something this suite actually ran rather than a global it quietly patched.
 *
 * The behaviour that matters, and why:
 *
 *   - `probe` is read-only and a refused connection is a normal answer. A port
 *     with no listener is what a fresh machine looks like, not an error.
 *   - `install` never runs without consent, and never touches Klaud's own
 *     package.json. A global npm install is a permanent change to the machine.
 *   - `ensureRunning` refuses below OmniRoute's declared Node range *before*
 *     spawning anything, because Klaud itself still runs on Node 18.
 *   - Setup decides what to do about a stored API key: Klaud's client sends
 *     whatever is saved as a Bearer token, so a user switching from NVIDIA to
 *     OmniRoute would otherwise send `nvapi-...` to a keyless local gateway.
 */

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { REGISTRY } = require('../src/providers');
const {
  probe,
  ensureRunning,
  install,
  setupOmniRoute,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  NODE_REQUIREMENT,
  NODE_REQUIREMENT_TEXT,
  INSTALL_COMMAND,
  satisfiesNodeRange,
} = require('../src/lib/omniroute');

const PROJECT = path.resolve(__dirname, '..');
const PLATFORM = process.platform;
const BIN_NAME = PLATFORM === 'win32' ? 'omniroute.cmd' : 'omniroute';
const NPM_NAME = PLATFORM === 'win32' ? 'npm.cmd' : 'npm';

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

/** Every failure result this suite saw, so "no unknown errors" is countable. */
const failures = [];
const record = (result) => {
  if (result && result.ok === false) failures.push(result);
  return result;
};

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-omni-'));
  tempDirs.push(dir);
  return dir;
}

/** Put a stand-in executable on a fake PATH. */
function writeShim(dir, name = BIN_NAME) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, PLATFORM === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return target;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A stand-in for OmniRoute's API.
 *
 * `rejectWhenHeader` answers an auth failure to any request that carries an
 * Authorization header and normally to one that does not — the behaviour a
 * keyless local gateway would show to a foreign Bearer token. `rejectAll` is the
 * case where it wants a key of its own.
 */
function startMock({
  port = 0,
  models = [DEFAULT_MODEL, 'oc/free'],
  status = 200,
  body = null,
  contentType = 'application/json',
  rejectWhenHeader = false,
  rejectAll = false,
  rejectStatus = 401,
} = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization || '';
    calls.push({ method: req.method, url: req.url, authorization });

    const sendJson = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (rejectAll) return sendJson(rejectStatus, { error: { message: 'Invalid API key provided' } });
    if (rejectWhenHeader && authorization) return sendJson(rejectStatus, { error: { message: 'Invalid API key provided' } });
    if (body !== null) {
      res.writeHead(status, { 'content-type': contentType });
      return res.end(body);
    }
    res.writeHead(status, { 'content-type': contentType });
    res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const listen = () =>
      server.listen(port, '127.0.0.1', () => {
        const actual = server.address().port;
        resolve({
          port: actual,
          calls,
          baseUrl: `http://127.0.0.1:${actual}/v1`,
          close: () => new Promise((done) => server.close(done)),
        });
      });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts++ < 40) return setTimeout(listen, 50);
      reject(err);
    });
    listen();
  });
}

/**
 * A spawn stand-in for both jobs in this module: running npm (output captured)
 * and launching the detached server.
 *
 * `onInstalled` fires when the fake npm exits 0, so a test can put a shim on the
 * fake PATH and prove the install path re-resolves it. `onServerStart` fires when
 * the detached launch happens, so a test can bring a mock up on the reserved
 * port and prove the polling actually waits for it.
 */
function fakeSpawn({
  npmCode = 0,
  npmStdout = '',
  npmStderr = '',
  npmError = null,
  onInstalled = null,
  onServerStart = null,
  serverExit = null,
  serverError = null,
} = {}) {
  const calls = [];
  const spawnFn = (file, args, opts = {}) => {
    const detached = opts.detached === true;
    const child = new EventEmitter();
    child.pid = 6000 + calls.length;
    child.unrefCalled = false;
    child.unref = () => {
      child.unrefCalled = true;
    };
    child.kill = () => {
      child.emit('close', null, 'SIGTERM');
    };
    calls.push({ file, args, opts, detached, child });

    if (detached) {
      if (serverError) setTimeout(() => child.emit('error', serverError), 10);
      else if (serverExit !== null) {
        setTimeout(() => {
          child.emit('exit', serverExit, null);
          child.emit('close', serverExit, null);
        }, 20);
      } else if (onServerStart) {
        setTimeout(() => onServerStart(), 20);
      }
      return child;
    }

    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (npmStdout) child.stdout.write(npmStdout);
    if (npmStderr) child.stderr.write(npmStderr);
    setTimeout(() => {
      if (npmError) return child.emit('error', npmError);
      if (npmCode === 0 && onInstalled) {
        try {
          onInstalled();
        } catch {
          /* a fixture problem, not a behaviour under test */
        }
      }
      child.emit('close', npmCode, null);
    }, 10);
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

/** A file-tree snapshot, used to prove the real ~/.klaud is untouched. */
function snapshotDir(dir) {
  const out = {};
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        out[full] = 'dir';
        walk(full);
      } else {
        out[full] = String(fs.statSync(full).mtimeMs);
      }
    }
  };
  try {
    if (fs.existsSync(dir)) {
      out[dir] = 'dir';
      walk(dir);
    }
  } catch (err) {
    out[dir] = `unreadable: ${err.code || err.message}`;
  }
  return out;
}

(async () => {
  console.log('\n\x1b[38;5;209m* OmniRoute setup\x1b[0m\n');

  const klaudDir = path.join(os.homedir(), '.klaud');
  const klaudBefore = snapshotDir(klaudDir);

  /* ---------------------- the registry entry ---------------------- */

  const entry = REGISTRY.find((p) => p.id === 'omniroute');
  const required = [
    'id',
    'name',
    'baseUrl',
    'model',
    'signupUrl',
    'limitsSource',
    'toolCalling',
    'tier',
    'estimateRank',
    'headline',
    'tagline',
    'detail',
    'limits',
    'limitBasis',
    'caveat',
    'verified',
    'verifiedNote',
    'verifyHint',
    'setup',
    'requiresNode',
  ];
  const missing = entry ? required.filter((key) => entry[key] === undefined || entry[key] === '') : required;

  check('the catalogue lists OmniRoute', Boolean(entry));
  check('the entry has every field the card and the setup path read', missing.length === 0, missing.join(', '));
  check(
    'the base URL is the loopback literal, not localhost',
    entry?.baseUrl === 'http://127.0.0.1:20128/v1' && !/localhost/i.test(String(entry?.baseUrl)),
    String(entry?.baseUrl)
  );
  check('the base URL is the one the setup module probes', entry?.baseUrl === DEFAULT_BASE_URL, String(DEFAULT_BASE_URL));
  check('the model is the zero-config auto alias', entry?.model === 'auto' && DEFAULT_MODEL === 'auto', String(entry?.model));
  check('the default port is 20128, the port the catalogue points at', DEFAULT_PORT === 20128, String(DEFAULT_PORT));
  check('it is flagged as local setup rather than a pasted key', entry?.setup === 'omniroute', String(entry?.setup));
  check(
    'it declares the Node range the setup path enforces',
    entry?.requiresNode === NODE_REQUIREMENT && /22\.22\.2/.test(String(entry?.requiresNode)),
    `${entry?.requiresNode} vs ${NODE_REQUIREMENT}`
  );
  check('it does not claim to be recommended', entry?.recommended !== true && entry?.best !== true);
  check(
    'NVIDIA is still the only recommended pick',
    REGISTRY.filter((p) => p.recommended).map((p) => p.id).join(',') === 'nvidia',
    JSON.stringify(REGISTRY.filter((p) => p.recommended).map((p) => p.id))
  );
  check('it is tiered generous and claims tool calling', entry?.tier === 'generous' && entry?.toolCalling === true);
  check(
    'its allowance is marked as published by nobody',
    entry?.limitBasis === 'not-published',
    String(entry?.limitBasis)
  );
  check(
    'the limits text attributes the allowance to the upstreams, not to OmniRoute',
    /upstream/i.test(String(entry?.limits)) && /quota OmniRoute grants/i.test(String(entry?.limits)),
    String(entry?.limits).slice(0, 200)
  );
  check(
    'the limits text says plainly that nothing is published',
    /not published/i.test(String(entry?.limits)),
    String(entry?.limits).slice(0, 120)
  );
  check(
    'the caveat names the exact Node floor and the excluded major',
    /22\.22\.2/.test(String(entry?.caveat)) && /23\.x is excluded/.test(String(entry?.caveat)),
    String(entry?.caveat).slice(0, 200)
  );
  check(
    'the caveat separates routing from a granted allowance',
    /free tiers behind a local gateway|over other providers' free tiers/i.test(String(entry?.caveat)),
    String(entry?.caveat).slice(0, 200)
  );
  /* Measured here rather than read in a README: the running build answers 401
   * without a key, so the "keyless" framing had to go. If a later version really
   * is keyless, this assertion is what will say so. */
  check(
    'the entry does not claim to be keyless, because the running build requires a key',
    /not what the running build does|needs its own API key/i.test(String(entry?.detail)) &&
      !/free and keyless/i.test(String(entry?.headline || '')),
    `${entry?.headline} | ${String(entry?.detail).slice(0, 160)}`
  );
  check(
    'the caveat warns that a first start is slow',
    /two and a half minutes|150 seconds|first start/i.test(String(entry?.caveat)),
    String(entry?.caveat).slice(0, 240)
  );
  check(
    'the verification note separates what was measured from what was documented',
    /measured/i.test(String(entry?.verifiedNote)) &&
      /not observed/i.test(String(entry?.verifiedNote)) &&
      /not a measurement/i.test(String(entry?.verifiedNote)),
    String(entry?.verifiedNote).slice(0, 240)
  );
  check('the card is told this one was not verified live', entry?.verifiedLive === false);
  check(
    'the links point at the project itself',
    /^https:\/\/github\.com\/diegosouzapw\/OmniRoute$/.test(String(entry?.signupUrl)) &&
      /^https:\/\//.test(String(entry?.limitsSource)),
    `${entry?.signupUrl} / ${entry?.limitsSource}`
  );

  /* ---------------------- the version gate ---------------------- */

  const rangeCases = [
    ['18.20.4', false, 'Klaud still supports 18, OmniRoute does not'],
    ['20.11.1', false, '20 is below the floor'],
    ['22.22.1', false, 'one patch below the floor'],
    ['22.22.2', true, 'exactly the floor'],
    ['22.99.0', true, 'later in 22.x'],
    ['23.5.0', false, '23.x is excluded by the range'],
    ['24.0.0', true, 'the next line'],
    ['26.7.1', true, 'last in-range major'],
    ['27.0.0', false, 'past the ceiling'],
  ];
  const wrongRange = rangeCases.filter(([version, want]) => satisfiesNodeRange(version) !== want);
  check('the declared engine range is evaluated, not guessed', wrongRange.length === 0, JSON.stringify(wrongRange));
  check('a string that is not a version is refused', satisfiesNodeRange('not-a-version') === false);
  check(
    'the human-readable range matches the machine one',
    /22\.22\.2/.test(NODE_REQUIREMENT_TEXT) && /26/.test(NODE_REQUIREMENT_TEXT) && /23/.test(NODE_REQUIREMENT_TEXT),
    NODE_REQUIREMENT_TEXT
  );

  /* ---------------------- probe is read-only ---------------------- */

  {
    const mock = await startMock();
    try {
      const result = await probe({ baseUrl: mock.baseUrl, timeoutMs: 2000 });
      check(
        'probe reports running when /v1/models answers',
        result.running === true && result.reachable === true && result.refused === false,
        JSON.stringify(result)
      );
      check(
        'probe returns the model ids the server lists',
        Array.isArray(result.models) && result.models.includes('auto') && result.models.includes('oc/free'),
        JSON.stringify(result.models)
      );
      check('probe reports no error when it worked', result.error === null, String(result.error));
      check(
        'probe issues one GET to /v1/models and nothing else',
        mock.calls.length === 1 && mock.calls[0].method === 'GET' && mock.calls[0].url === '/v1/models',
        JSON.stringify(mock.calls)
      );
      check(
        'probe sends no Authorization header when no key is given',
        mock.calls[0].authorization === '',
        JSON.stringify(mock.calls[0])
      );
    } finally {
      await mock.close();
    }
  }

  {
    const mock = await startMock();
    try {
      await probe({ baseUrl: mock.baseUrl, timeoutMs: 2000, apiKey: 'nvapi-from-another-provider' });
      check(
        'probe sends a stored key as a Bearer token, which is what the chat client does',
        mock.calls[0].authorization === 'Bearer nvapi-from-another-provider',
        String(mock.calls[0].authorization)
      );
    } finally {
      await mock.close();
    }
  }

  {
    const port = await freePort();
    let threw = null;
    let result = null;
    try {
      result = await probe({ baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 1000 });
    } catch (err) {
      threw = err;
    }
    check('probe does not throw when nothing is listening', threw === null, String(threw && threw.message));
    check(
      'a refused connection is a normal not-running answer, not an error',
      result?.running === false && result?.refused === true && result?.error === null,
      JSON.stringify(result)
    );
  }

  {
    const mock = await startMock({ body: '<html><body>OmniRoute dashboard</body></html>', contentType: 'text/html' });
    try {
      const result = await probe({ baseUrl: mock.baseUrl, timeoutMs: 2000 });
      check(
        'a non-JSON answer means "not this API", reported without throwing',
        result.running === false && result.reachable === true && /not JSON/i.test(String(result.error)),
        String(result.error)
      );
      check(
        'the non-JSON answer names the address that answered',
        String(result.error).includes(mock.baseUrl),
        String(result.error)
      );
    } finally {
      await mock.close();
    }
  }

  {
    const mock = await startMock({ status: 503, body: JSON.stringify({ error: { message: 'warming up' } }) });
    try {
      const result = await probe({ baseUrl: mock.baseUrl, timeoutMs: 2000 });
      check(
        'an HTTP failure is reported with its status and the provider\'s own words',
        result.running === false && result.reachable === true && result.status === 503 && /warming up/.test(String(result.error)),
        JSON.stringify(result)
      );
    } finally {
      await mock.close();
    }
  }

  {
    const mock = await startMock({ body: JSON.stringify({ hello: 'world' }) });
    try {
      const result = await probe({ baseUrl: mock.baseUrl, timeoutMs: 2000 });
      check(
        'JSON that is not a model list is not mistaken for a working endpoint',
        result.running === false && result.reachable === true && /no model list/i.test(String(result.error)),
        String(result.error)
      );
    } finally {
      await mock.close();
    }
  }

  /* ---------------------- install never runs unasked ---------------------- */

  {
    const pathDir = makeTempDir();
    const spawnFn = fakeSpawn();
    const result = record(await install({ allowInstall: false, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '24.5.0' }));
    check(
      'install refuses without allowInstall',
      result.ok === false && result.installed === false && result.stage === 'needs-consent',
      JSON.stringify(result).slice(0, 220)
    );
    check(
      'the refusal names the exact command it would run',
      result.command === INSTALL_COMMAND && INSTALL_COMMAND === 'npm install -g omniroute',
      String(result.command)
    );
    check(
      'the refusal explains that it is a global install, not a project dependency',
      /global npm install/i.test(String(result.message)) && /package\.json/i.test(String(result.hint)),
      String(result.hint)
    );
    check('the refusal never spawns anything', spawnFn.calls.length === 0, JSON.stringify(spawnFn.calls));
    check('the refusal carries an actionable hint', String(result.hint).trim().length > 30, String(result.hint));
  }

  {
    const pathDir = makeTempDir();
    const spawnFn = fakeSpawn();
    const result = record(
      await install({ allowInstall: true, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '18.20.4' })
    );
    check(
      'install refuses below the Node requirement before running npm',
      result.ok === false && result.stage === 'node' && spawnFn.calls.length === 0,
      JSON.stringify(result).slice(0, 220)
    );
    check(
      'that refusal quotes the real requirement',
      /22\.22\.2/.test(String(result.message)) && /23\.x is excluded/.test(String(result.message)),
      String(result.message)
    );
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir, NPM_NAME);
    const spawnFn = fakeSpawn({ onInstalled: () => writeShim(pathDir) });
    const result = await install({ allowInstall: true, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '24.5.0' });
    check(
      'install runs exactly a global npm install',
      spawnFn.calls.length === 1 &&
        JSON.stringify(spawnFn.calls[0].args) === JSON.stringify(['install', '-g', 'omniroute']) &&
        /npm(\.cmd)?"?$/i.test(String(spawnFn.calls[0].file)),
      JSON.stringify(spawnFn.calls.map((call) => [call.file, call.args]))
    );
    check(
      'it reports installed once the command is on PATH',
      result.ok === true && result.installed === true && String(result.path).includes(BIN_NAME),
      JSON.stringify(result).slice(0, 220)
    );
    check('the successful install says npm reported success', /success/i.test(String(result.message)), String(result.message));
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir, NPM_NAME);
    const spawnFn = fakeSpawn({
      npmCode: 1,
      npmStderr: 'npm error code EBADENGINE\nnpm error engine Unsupported engine',
    });
    const result = record(
      await install({ allowInstall: true, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '24.5.0' })
    );
    check(
      'a failing npm install is reported with npm\'s own words and exit code',
      result.ok === false && /EBADENGINE/.test(String(result.message)) && /code 1/.test(String(result.message)),
      String(result.message)
    );
    check('the failure suggests running it by hand', /in a terminal/i.test(String(result.hint)), String(result.hint));
  }

  {
    const pathDir = makeTempDir();
    const spawnFn = fakeSpawn();
    const result = record(
      await install({ allowInstall: true, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '24.5.0' })
    );
    check(
      'a missing npm is named rather than left as an obscure failure',
      result.ok === false && result.stage === 'npm-missing' && /npm is not on PATH/i.test(String(result.message)),
      String(result.message)
    );
    check(
      'that failure names the Node download that brings npm',
      /nodejs\.org/i.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir, NPM_NAME);
    const spawnFn = fakeSpawn({}); // succeeds, but never puts omniroute on PATH
    const result = record(
      await install({ allowInstall: true, spawn: spawnFn, pathEnv: pathDir, nodeVersion: '24.5.0' })
    );
    check(
      'an install npm calls successful but PATH cannot see is reported honestly',
      result.ok === false && result.installed === true && /PATH/.test(String(result.message)),
      String(result.message)
    );
  }

  {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
    /* The intent is "OmniRoute is never a dependency of Klaud", not "the string
     * never appears": the test script legitimately names test/omniroute.js, and a
     * whole-file match failed for that reason rather than for the reason it was
     * written to catch. Any dependency field counts, not just `dependencies`. */
    const depFields = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundledDependencies',
    ];
    const offenders = depFields.flatMap((field) =>
      Object.keys(pkg[field] || {}).filter((name) => /omniroute/i.test(name)).map((name) => `${field}:${name}`)
    );
    check(
      'OmniRoute is never added to Klaud\'s own dependencies',
      Object.keys(pkg.dependencies || {}).length === 0 && offenders.length === 0,
      offenders.length ? offenders.join(', ') : JSON.stringify(pkg.dependencies)
    );
  }

  /* ---------------------- ensureRunning ---------------------- */

  {
    const port = await freePort();
    const spawnFn = fakeSpawn();
    const result = record(
      await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '18.20.4',
        spawn: spawnFn,
        pathEnv: makeTempDir(),
        startTimeoutMs: 500,
        pollMs: 50,
      })
    );
    check(
      'ensureRunning refuses on Node 18 with the real requirement',
      result.ok === false && result.stage === 'node' && /22\.22\.2/.test(String(result.message)),
      JSON.stringify(result).slice(0, 260)
    );
    check('the Node refusal never spawns a process', spawnFn.calls.length === 0, JSON.stringify(spawnFn.calls));
    check(
      'the Node refusal offers a way forward',
      /newer|docker/i.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const mock = await startMock();
    const spawnFn = fakeSpawn();
    try {
      const result = await ensureRunning({
        allowStart: true,
        baseUrl: mock.baseUrl,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: makeTempDir(),
      });
      check(
        'ensureRunning is a no-op when it is already running',
        result.ok === true && result.alreadyRunning === true && result.started === false,
        JSON.stringify(result).slice(0, 220)
      );
      check('the no-op says it started nothing', /nothing was started/i.test(String(result.message)), String(result.message));
      check('an already-running instance is not spawned again', spawnFn.calls.length === 0);
    } finally {
      await mock.close();
    }
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    const spawnFn = fakeSpawn();
    const result = record(
      await ensureRunning({
        allowStart: false,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: pathDir,
        startTimeoutMs: 500,
        pollMs: 50,
      })
    );
    check(
      'ensureRunning will not start a process without permission',
      result.ok === false && result.stage === 'needs-start-consent' && spawnFn.calls.length === 0,
      JSON.stringify(result).slice(0, 220)
    );
    check(
      'that refusal tells the user to run it themselves',
      /terminal/i.test(String(result.hint)) && /omniroute/.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const port = await freePort();
    const result = record(
      await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: fakeSpawn(),
        pathEnv: '',
        startTimeoutMs: 400,
        pollMs: 50,
      })
    );
    check(
      'a machine without the command reports it as not installed',
      result.ok === false && result.stage === 'not-installed' && /not installed/i.test(String(result.message)),
      JSON.stringify(result).slice(0, 220)
    );
    check(
      'that message names the install command and the Node requirement',
      /npm install -g omniroute/.test(String(result.message) + String(result.hint)) && /22\.22\.2/.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    let mock = null;
    const spawnFn = fakeSpawn({
      onServerStart: () => {
        startMock({ port })
          .then((started) => {
            mock = started;
          })
          .catch(() => {});
      },
    });
    try {
      const result = await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: pathDir,
        startTimeoutMs: 5000,
        pollMs: 50,
      });
      check(
        'ensureRunning starts it when allowed, and reports the real outcome',
        result.ok === true && result.started === true && result.alreadyRunning === false,
        JSON.stringify(result).slice(0, 260)
      );
      check(
        'it spawns detached, with stdio discarded so a detached child cannot block on our pipes',
        spawnFn.calls.length === 1 &&
          spawnFn.calls[0].detached === true &&
          spawnFn.calls[0].opts.stdio === 'ignore',
        JSON.stringify(spawnFn.calls[0]?.opts)
      );
      check(
        'the started child is unref\'d, so Klaud does not wait for OmniRoute',
        spawnFn.calls[0]?.child?.unrefCalled === true
      );
      check(
        'the success message reports how long it took',
        /after \d+\.\ds/i.test(String(result.message)),
        String(result.message)
      );
      check(
        'the success hint says it runs detached and how to start it again',
        /detached/i.test(String(result.hint)) && /omniroute/.test(String(result.hint)),
        String(result.hint)
      );
    } finally {
      if (mock) await mock.close();
    }
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    const result = record(
      await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: fakeSpawn({ onServerStart: () => {} }), // starts, never answers
        pathEnv: pathDir,
        startTimeoutMs: 400,
        pollMs: 50,
      })
    );
    check(
      'a process that starts but never answers is reported as a timeout',
      result.ok === false && result.stage === 'start-timeout' && /did not answer/i.test(String(result.message)),
      JSON.stringify(result).slice(0, 240)
    );
    check(
      'the timeout says what the last probe saw',
      /nothing is listening|last probe/i.test(String(result.message)),
      String(result.message)
    );
    check(
      'the timeout tells the user how to see its output',
      /terminal/i.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    const result = record(
      await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: fakeSpawn({ serverExit: 1 }),
        pathEnv: pathDir,
        startTimeoutMs: 3000,
        pollMs: 50,
      })
    );
    check(
      'a process that exits before answering reports the exit code',
      result.ok === false && result.stage === 'start-failed' && /code 1/.test(String(result.message)),
      JSON.stringify(result).slice(0, 240)
    );
    check(
      'the exit failure names the likely causes rather than "unknown"',
      /22\.22\.2|native/i.test(String(result.hint)),
      String(result.hint)
    );
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    const spawnError = Object.assign(new Error('spawn omniroute ENOENT'), { code: 'ENOENT' });
    const result = record(
      await ensureRunning({
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: fakeSpawn({ serverError: spawnError }),
        pathEnv: pathDir,
        startTimeoutMs: 500,
        pollMs: 50,
      })
    );
    check(
      'a spawn error is reported with Node\'s own message',
      result.ok === false && result.stage === 'start-failed' && /ENOENT/.test(String(result.message)),
      String(result.message)
    );
  }

  {
    const mock = await startMock({ body: 'not json', contentType: 'text/plain' });
    const spawnFn = fakeSpawn();
    try {
      const result = record(
        await ensureRunning({
          allowStart: true,
          baseUrl: mock.baseUrl,
          nodeVersion: '24.5.0',
          spawn: spawnFn,
          pathEnv: makeTempDir(),
        })
      );
      check(
        'a port held by something else is not started over',
        result.ok === false && result.stage === 'blocked' && spawnFn.calls.length === 0,
        JSON.stringify(result).slice(0, 240)
      );
      check(
        'it explains that the listener is not the API it expected',
        /not as an OpenAI-compatible API/i.test(String(result.message)),
        String(result.message)
      );
    } finally {
      await mock.close();
    }
  }

  /* ---------------------- setupOmniRoute ---------------------- */

  {
    const mock = await startMock();
    const spawnFn = fakeSpawn();
    try {
      const result = await setupOmniRoute({
        allowInstall: true,
        allowStart: true,
        baseUrl: mock.baseUrl,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: makeTempDir(),
      });
      check(
        'setup short-circuits when OmniRoute is already running',
        result.ok === true && result.stage === 'running' && result.started === false && result.alreadyRunning === true,
        JSON.stringify(result).slice(0, 240)
      );
      check('the plain-success path sets clearApiKey: false', result.clearApiKey === false);
      check('no process was started', spawnFn.calls.length === 0);
      check(
        'its checks[] explains what happened',
        Array.isArray(result.checks) &&
          result.checks.some((c) => c.step === 'probe' && c.ok === true) &&
          result.checks.some((c) => c.step === 'model' && c.ok === true),
        JSON.stringify(result.checks)
      );
      check(
        'every check carries a non-empty step and detail',
        result.checks.every((c) => typeof c.step === 'string' && c.step && String(c.detail || '').trim().length > 4),
        JSON.stringify(result.checks)
      );
      check(
        'the result carries the base URL and model the caller should save',
        result.baseUrl === mock.baseUrl && result.model === 'auto',
        JSON.stringify({ baseUrl: result.baseUrl, model: result.model })
      );
      check('the message says it was already answering', /already answering/i.test(String(result.message)), String(result.message));
    } finally {
      await mock.close();
    }
  }

  {
    const mock = await startMock(); // accepts any credentials
    try {
      const result = await setupOmniRoute({
        allowInstall: false,
        allowStart: false,
        baseUrl: mock.baseUrl,
        nodeVersion: '24.5.0',
        storedApiKey: 'nvapi-still-valid',
      });
      check(
        'a stored key that is accepted is left in place',
        result.ok === true && result.clearApiKey === false,
        JSON.stringify(result).slice(0, 240)
      );
      check(
        'the saved key really was sent on that probe',
        mock.calls.length === 1 && mock.calls[0].authorization === 'Bearer nvapi-still-valid',
        JSON.stringify(mock.calls.map((c) => c.authorization))
      );
      check('a key that works does not trigger a second probe', mock.calls.length === 1, String(mock.calls.length));
    } finally {
      await mock.close();
    }
  }

  {
    // A keyless local gateway refusing a foreign Bearer token: 401 with the key,
    // 200 without it. This is the NVIDIA -> OmniRoute switch.
    const mock = await startMock({ rejectWhenHeader: true });
    try {
      const result = await setupOmniRoute({
        allowInstall: false,
        allowStart: false,
        baseUrl: mock.baseUrl,
        nodeVersion: '24.5.0',
        storedApiKey: 'nvapi-from-another-provider',
      });
      check(
        'a key the gateway rejects is flagged for clearing, not silently kept',
        result.ok === true && result.clearApiKey === true,
        JSON.stringify(result).slice(0, 260)
      );
      check(
        'it proved the gateway answers by probing again with no Authorization header',
        mock.calls.length === 2 &&
          mock.calls[0].authorization === 'Bearer nvapi-from-another-provider' &&
          mock.calls[1].authorization === '',
        JSON.stringify(mock.calls.map((c) => c.authorization))
      );
      check(
        /* It must NOT assert provenance. A user who mistyped their own OmniRoute
         * key would be told it "belongs to a different provider", which is a
         * confident wrong answer; the message offers both readings instead. */
        'the message reports the refusal without guessing whose key it was',
        /refused the API key/i.test(String(result.message)) &&
          /401/.test(String(result.message)) &&
          /another provider|different provider/i.test(String(result.message)) &&
          !/belongs to a different provider/i.test(String(result.message)),
        String(result.message)
      );
      check(
        'the checks record both probes',
        result.checks.some((c) => c.step === 'stored key' && c.ok === false) &&
          result.checks.some((c) => c.step === 'probe without key' && c.ok === true),
        JSON.stringify(result.checks)
      );
      check(
        'the setup is still usable once the key is out of the way',
        result.stage === 'running' && result.model === 'auto' && result.ok === true
      );
    } finally {
      await mock.close();
    }
  }

  {
    // It wants a key of its own: both arrangements are refused.
    const mock = await startMock({ rejectAll: true, rejectStatus: 401 });
    try {
      const result = record(
        await setupOmniRoute({
          allowInstall: false,
          allowStart: false,
          baseUrl: mock.baseUrl,
          nodeVersion: '24.5.0',
          storedApiKey: 'nvapi-from-another-provider',
        })
      );
      check(
        'when neither arrangement works, both outcomes are reported',
        result.ok === false &&
          result.stage === 'auth' &&
          /with your saved key/i.test(String(result.message)) &&
          /without any key/i.test(String(result.message)),
        String(result.message)
      );
      check('it does not clear a key it could not explain', result.clearApiKey === false);
      check(
        'both probe outcomes are in the checks',
        result.checks.filter((c) => c.step === 'stored key' || c.step === 'probe without key').length === 2,
        JSON.stringify(result.checks.map((c) => c.step))
      );
      check(
        'the auth failure offers a concrete next step',
        /dashboard|settings/i.test(String(result.hint)),
        String(result.hint)
      );
    } finally {
      await mock.close();
    }
  }

  {
    const port = await freePort();
    const spawnFn = fakeSpawn();
    const result = record(
      await setupOmniRoute({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '18.20.4',
        spawn: spawnFn,
        pathEnv: makeTempDir(),
      })
    );
    check(
      'setup stops at the Node requirement and says why',
      result.ok === false && result.stage === 'node' && /22\.22\.2/.test(String(result.message)),
      JSON.stringify(result).slice(0, 260)
    );
    check(
      'the Node stop is recorded in checks[]',
      result.checks.some((c) => c.step === 'node' && c.ok === false),
      JSON.stringify(result.checks)
    );
    check('nothing is installed or started on an unsupported Node', spawnFn.calls.length === 0);
  }

  {
    const port = await freePort();
    const spawnFn = fakeSpawn();
    const result = record(
      await setupOmniRoute({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: makeTempDir(),
      })
    );
    check(
      'without consent setup returns the command instead of installing',
      result.ok === false && result.stage === 'needs-consent' && result.command === INSTALL_COMMAND,
      JSON.stringify(result).slice(0, 260)
    );
    check(
      'it names the command in prose as well as in a field',
      /npm install -g omniroute/.test(String(result.message) + String(result.hint)),
      String(result.hint)
    );
    check('it ran nothing at all', spawnFn.calls.length === 0, JSON.stringify(spawnFn.calls));
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    const spawnFn = fakeSpawn();
    const result = record(
      await setupOmniRoute({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: pathDir,
      })
    );
    check(
      'an installed but stopped OmniRoute is not started without permission',
      result.ok === false && result.stage === 'needs-start-consent' && spawnFn.calls.length === 0,
      JSON.stringify(result).slice(0, 240)
    );
    check(
      'the checks show it found the command before asking',
      result.checks.some((c) => c.step === 'installed' && c.ok === true),
      JSON.stringify(result.checks)
    );
  }

  {
    // The whole path: not installed -> npm installs it -> started -> answering.
    const pathDir = makeTempDir();
    writeShim(pathDir, NPM_NAME);
    const port = await freePort();
    let mock = null;
    const spawnFn = fakeSpawn({
      onInstalled: () => writeShim(pathDir),
      onServerStart: () => {
        startMock({ port })
          .then((started) => {
            mock = started;
          })
          .catch(() => {});
      },
    });
    try {
      const result = await setupOmniRoute({
        allowInstall: true,
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: spawnFn,
        pathEnv: pathDir,
        startTimeoutMs: 5000,
        pollMs: 50,
      });
      check(
        'the whole path installs, starts and reports success',
        result.ok === true && result.stage === 'started' && result.started === true,
        JSON.stringify(result).slice(0, 260)
      );
      check(
        'it ran an npm install and then a detached start, in that order',
        spawnFn.calls.length === 2 &&
          JSON.stringify(spawnFn.calls[0].args) === JSON.stringify(['install', '-g', 'omniroute']) &&
          spawnFn.calls[1].detached === true,
        JSON.stringify(spawnFn.calls.map((c) => [c.file, c.args, c.detached]))
      );
      check(
        'every stage is recorded in checks[]',
        ['probe', 'node', 'installed', 'install', 'start', 'model'].every((step) =>
          result.checks.some((c) => c.step === step)
        ),
        JSON.stringify(result.checks.map((c) => c.step))
      );
      check(
        'the final steps of a successful setup are green',
        result.checks.filter((c) => c.step === 'start' || c.step === 'model').every((c) => c.ok === true),
        JSON.stringify(result.checks.filter((c) => !c.ok))
      );
      check(
        'checks that only describe the state before setup are labelled as such',
        result.checks.filter((c) => !c.ok).every((c) => /starting state:/i.test(String(c.detail))),
        JSON.stringify(result.checks.filter((c) => !c.ok))
      );
      check('no key was involved, so nothing is cleared', result.clearApiKey === false);
      check(
        'the hint says no key is needed',
        /no key/i.test(String(result.hint) + String(result.message)),
        String(result.hint)
      );
    } finally {
      if (mock) await mock.close();
    }
  }

  {
    // A stored foreign key plus a fresh install: the decision has to be made
    // again against the instance that was just started.
    const pathDir = makeTempDir();
    writeShim(pathDir);
    const port = await freePort();
    let mock = null;
    const spawnFn = fakeSpawn({
      onServerStart: () => {
        startMock({ port, rejectWhenHeader: true })
          .then((started) => {
            mock = started;
          })
          .catch(() => {});
      },
    });
    try {
      const result = await setupOmniRoute({
        allowInstall: false,
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        storedApiKey: 'nvapi-from-another-provider',
        spawn: spawnFn,
        pathEnv: pathDir,
        startTimeoutMs: 5000,
        pollMs: 50,
      });
      check(
        'a fresh start re-checks the stored key against the instance it started',
        result.ok === true && result.clearApiKey === true,
        JSON.stringify(result).slice(0, 300)
      );
      check(
        'that case says the key was refused and is no longer used',
        /refused/i.test(String(result.message)) && /no longer used/i.test(String(result.message)),
        String(result.message)
      );
      check(
        'the keyed probe ran against the started instance',
        mock && mock.calls.some((c) => c.authorization === 'Bearer nvapi-from-another-provider'),
        JSON.stringify((mock?.calls || []).map((c) => c.authorization))
      );
    } finally {
      if (mock) await mock.close();
    }
  }

  {
    const pathDir = makeTempDir();
    writeShim(pathDir, NPM_NAME);
    const port = await freePort();
    const result = record(
      await setupOmniRoute({
        allowInstall: true,
        allowStart: true,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        nodeVersion: '24.5.0',
        spawn: fakeSpawn({ npmCode: 1, npmStderr: 'npm error EACCES: permission denied' }),
        pathEnv: pathDir,
        startTimeoutMs: 300,
        pollMs: 50,
      })
    );
    check(
      'a failed install stops setup, carrying npm\'s own words',
      result.ok === false && result.stage === 'install-failed' && /EACCES/.test(String(result.message)),
      String(result.message)
    );
    check(
      'the failed install never reaches the start step',
      !result.checks.some((c) => c.step === 'start'),
      JSON.stringify(result.checks.map((c) => c.step))
    );
    check('the failed install keeps an actionable hint', /terminal/i.test(String(result.hint)), String(result.hint));
  }

  /* ---------------------- no dead-end messages ---------------------- */

  check('the suite produced failure results to inspect', failures.length >= 10, String(failures.length));
  check(
    'every failure result has ok: false',
    failures.every((result) => result.ok === false),
    JSON.stringify(failures.map((result) => result.ok))
  );
  check(
    'no failure message is empty, and none says "unknown"',
    failures.every(
      (result) => String(result.message || '').trim().length > 20 && !/\bunknown\b/i.test(String(result.message))
    ),
    JSON.stringify(failures.map((result) => String(result.message || '').slice(0, 60)))
  );
  check(
    'every failure result carries an actionable hint',
    failures.every((result) => String(result.hint || '').trim().length > 20),
    JSON.stringify(failures.filter((result) => String(result.hint || '').trim().length <= 20).map((r) => r.stage))
  );
  check(
    'every setup failure names the URL and model it was about',
    failures
      .filter((result) => Array.isArray(result.checks))
      .every((result) => /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(String(result.baseUrl)) && result.model === DEFAULT_MODEL),
    JSON.stringify(
      failures
        .filter((result) => Array.isArray(result.checks))
        .map((result) => [result.stage, result.baseUrl, result.model])
    )
  );

  /* ---------------------- the real data directory ---------------------- */

  const klaudAfter = snapshotDir(klaudDir);
  const changed = [...new Set([...Object.keys(klaudBefore), ...Object.keys(klaudAfter)])].filter(
    (key) => klaudBefore[key] !== klaudAfter[key]
  );
  check('the real ~/.klaud was not modified by this suite', changed.length === 0, changed.slice(0, 6).join(', '));

  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is not a test failure */
    }
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} OmniRoute checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} OmniRoute checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nOmniRoute harness crashed:', err);
  process.exit(1);
});
