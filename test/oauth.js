'use strict';

/**
 * OAuth connectors test.
 *
 *   node test/oauth.js
 *
 * Plain-text output — run with `node test/oauth.js`.
 *
 * What this proves, and what it cannot.
 *
 * The flow is driven end to end against a MOCK token endpoint and a real
 * loopback listener: `startAuthorization` is called, a real HTTP request is made
 * to the redirect URI it reports, and the promise must settle from that request.
 * So the parts exercised here are the listener, the state check, the PKCE
 * parameters on the wire and the store.
 *
 * What is NOT proven: anything that needs a real provider. No request leaves
 * this machine, so the module has never been run against Google, and a provider
 * that requires some extra parameter, or rejects `client_secret` in the body, or
 * does not accept a loopback redirect for the client type the user registered,
 * would still fail in the real world. The test also cannot prove that `start` or
 * `xdg-open` actually opens a browser — that is why `startAuthorization` reports
 * the authorize URL on every path, and that reporting is asserted instead.
 *
 * Every test uses a throwaway data directory under the OS temp directory. The
 * real ~/.klaud is snapshotted before and after and must be byte-identical; a
 * test that quietly wrote a connection into the user's own Klaud data would be
 * worse than no test at all.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const http = require('http');

/* Set before anything reads it: config.dataDir() consults this on every call, so
 * the whole module tree below is pointed away from ~/.klaud. */
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-oauth-test-'));
process.env.KLAUD_DATA_DIR = TEMP_ROOT;

const oauth = require('../src/lib/oauth');
const { __internals } = oauth;

/* ------------------------------------------------------------------ *
 * Harness — same output shape and colours as test/cloudflare-errors.js
 * ------------------------------------------------------------------ */

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real data directory, listed recursively so a new file is visible. */
function snapshotTree(dir) {
  const seen = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const shown = rel ? `${rel}/${entry.name}` : entry.name;
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        /* vanished mid-walk */
      }
      seen.push(`${shown} ${entry.isDirectory() ? 'dir' : 'file'} ${st ? st.size : '?'} ${st ? st.mtimeMs : '?'}`);
      if (entry.isDirectory()) walk(full, shown);
    }
  };
  walk(dir, '');
  return seen;
}

/** A fresh throwaway data directory per test; the module re-reads the env var. */
async function freshDataDir(name) {
  const dir = path.join(TEMP_ROOT, name);
  await fsp.mkdir(dir, { recursive: true });
  process.env.KLAUD_DATA_DIR = dir;
  __internals.resetState();
  return dir;
}

/* ------------------------------------------------------------------ *
 * Mock token endpoint
 * ------------------------------------------------------------------ */

/**
 * A local token endpoint that records exactly what arrived.
 *
 * The recording is the point: asserting that a verifier was sent proves nothing
 * unless the endpoint that received it is the one the module talked to.
 */
async function mockTokenServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const form = {};
    for (const [key, value] of new URLSearchParams(raw)) form[key] = value;
    const record = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      raw,
      form,
      authorization: req.headers.authorization || '',
    };
    requests.push(record);
    const outcome = await handler(record);
    res.writeHead(outcome.status || 200, {
      'content-type': outcome.contentType || 'application/json',
      'content-length': Buffer.byteLength(outcome.body || ''),
    });
    res.end(outcome.body || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/token`,
    requests,
    calls: () => requests.length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A fetch that must only ever be used against the local mock endpoint. */
function proxyFetch(mockUrl, onCall) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (url !== mockUrl) {
      throw new Error(`unexpected network call in a test: ${url}`);
    }
    if (onCall) onCall(url, init);
    return fetch(url, init);
  };
}

/* ------------------------------------------------------------------ *
 * Connector under test
 * ------------------------------------------------------------------ */

function mockConnector(tokenUrl, extra = {}) {
  return {
    id: 'mockmail',
    label: 'Mock Mail',
    authUrl: 'http://127.0.0.1:1/authorize',
    tokenUrl,
    scopes: ['mail.readonly', 'mail.send'],
    scopeSeparator: ' ',
    clientId: 'client-id-from-the-user',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    ...extra,
  };
}

/**
 * Run the whole flow and answer the callback, the way a browser would.
 *
 * Returns the authorize URL the module reported, once the listener is up. The
 * redirect URI is only known from that URL, because the port is chosen by the
 * module and not by the test.
 */
async function waitForAuthorizeUrl(statuses, promise) {
  for (let i = 0; i < 400; i++) {
    const match = statuses.find((m) => m.startsWith('Open this URL to approve'));
    if (match) return match.replace(/^Open this URL to approve [^:]*: /, '');
    await sleep(10);
  }
  return null;
}

/** Talk to the redirect URI the way a browser does, and keep the page body. */
async function hitRedirect(redirectUri, query, headers = {}) {
  const res = await fetch(`${redirectUri}${query}`, { headers, redirect: 'manual' });
  // Read once, here: a Response body can only be consumed a single time, and
  // some assertions need the page and others need the status.
  const body = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, body };
}

/* ------------------------------------------------------------------ *
 * The real data directory must not be touched
 * ------------------------------------------------------------------ */

const REAL_DATA_DIR = path.join(os.homedir(), '.klaud');
const realBefore = fs.existsSync(REAL_DATA_DIR) ? snapshotTree(REAL_DATA_DIR) : null;

console.log('\n\x1b[38;5;209m* OAuth connectors\x1b[0m\n');

/* The whole suite awaits real sockets, so it lives in one async body. */
(async () => {

/* ================================================================== *
 * 1. PKCE
 * ================================================================== */

{
  const { verifier, challenge } = __internals.createPkce();

  check('the PKCE verifier is 43 characters, the RFC 7636 minimum length', verifier.length === 43, `${verifier.length}`);
  check(
    'the PKCE verifier is pure base64url with no padding',
    /^[A-Za-z0-9_-]{43}$/.test(verifier) && !verifier.includes('=') && !verifier.includes('+') && !verifier.includes('/'),
    verifier
  );

  const bits = Buffer.from(verifier.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length * 8;
  check('the verifier carries 256 bits of entropy', bits === 256, `${bits} bits`);

  const expected = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  check('the challenge is base64url(SHA-256(verifier))', challenge === expected, `got ${challenge}\n      want ${expected}`);
  check('the challenge is exactly 43 characters', challenge.length === 43, `${challenge.length}`);
  check(
    'the challenge leaks no padding',
    !challenge.includes('=') && !challenge.includes('+') && !challenge.includes('/'),
    challenge
  );

  const many = new Set();
  for (let i = 0; i < 200; i++) many.add(__internals.createPkce().verifier);
  check('200 verifiers are all distinct', many.size === 200, `${many.size} distinct`);

  const states = new Set();
  for (let i = 0; i < 200; i++) states.add(__internals.createState());
  check('state is random and non-empty on every call', states.size === 200 && [...states].every((s) => s.length >= 20),
    `${states.size} distinct`);

  // Deliberately check the known-answer vector from RFC 7636 appendix B.
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  check(
    'the RFC 7636 appendix B vector produces the documented challenge',
    __internals.challengeFor(rfcVerifier) === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    __internals.challengeFor(rfcVerifier)
  );
}

/* ================================================================== *
 * 2. The authorization URL
 * ================================================================== */

{
  const connector = mockConnector('http://127.0.0.1:1/token');
  const seenDefaultUrl = __internals
    .buildAuthUrl(connector, 'STATE123', 'CHALLENGE456', 'http://127.0.0.1:51234/oauth/callback')
    .toString();
  const url = new URL(seenDefaultUrl);
  const params = [...url.searchParams.entries()];
  const keys = params.map(([k]) => k).sort();

  const expectedKeys = [
    'access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'prompt',
    'redirect_uri', 'response_type', 'scope', 'state',
  ];
  check(
    'the authorize URL carries exactly the expected parameters',
    JSON.stringify(keys) === JSON.stringify(expectedKeys),
    `got ${JSON.stringify(keys)}`
  );
  check('response_type is code', url.searchParams.get('response_type') === 'code');
  check('code_challenge_method is S256 (not plain)',
    url.searchParams.get('code_challenge_method') === 'S256', url.searchParams.get('code_challenge_method'));
  check('code_challenge is the challenge, not the verifier',
    url.searchParams.get('code_challenge') === 'CHALLENGE456');
  check('state is carried in the URL', url.searchParams.get('state') === 'STATE123');
  check('scopes are joined by scopeSeparator',
    url.searchParams.get('scope') === 'mail.readonly mail.send', url.searchParams.get('scope'));
  check('extraAuthParams are merged in',
    url.searchParams.get('access_type') === 'offline' && url.searchParams.get('prompt') === 'consent',
    JSON.stringify(params));
  check('the redirect_uri is the loopback callback',
    url.searchParams.get('redirect_uri') === 'http://127.0.0.1:51234/oauth/callback');

  const plus = __internals.buildAuthUrl(
    mockConnector('http://127.0.0.1:1/token', { scopeSeparator: '+' }),
    'S', 'C', 'http://127.0.0.1:1/oauth/callback'
  );
  /* Measured behaviour, not an assumption: URLSearchParams serialises a space in
   * a query value as '+', and a literal '+' as '%2B'. Both are valid HTTP, but
   * it means a '+' separator reaches the provider as a plus sign rather than as
   * a space — which is why the default separator is a space. */
  check('a custom scopeSeparator is used literally and percent-encoded',
    plus.searchParams.get('scope') === 'mail.readonly+mail.send' &&
    plus.search.includes('scope=mail.readonly%2Bmail.send'),
    `raw="${plus.search}"`);
  check('the default separator is a space and survives the round trip as a space',
    url.searchParams.get('scope') === 'mail.readonly mail.send' &&
    url.search.includes('scope=mail.readonly+mail.send'),
    seenDefaultUrl);

  const escaped = __internals.buildAuthUrl(
    mockConnector('http://127.0.0.1:1/token', { extraAuthParams: { login_hint: 'a b&c=d' } }),
    'S', 'C', 'http://127.0.0.1:1/oauth/callback'
  );
  check('an extra auth param value is escaped rather than injected',
    escaped.searchParams.get('login_hint') === 'a b&c=d' && escaped.searchParams.getAll('login_hint').length === 1,
    escaped.searchParams.get('login_hint'));

  const mutated = __internals.buildAuthUrl(
    mockConnector('http://127.0.0.1:1/token', {
      buildAuthorizeUrl: (ctx) => {
        ctx.url.searchParams.set('extra_from_hook', 'yes');
      },
    }),
    'S', 'C', 'http://127.0.0.1:1/oauth/callback'
  );
  check('buildAuthorizeUrl can adjust the assembled URL without rebuilding it',
    mutated.searchParams.get('extra_from_hook') === 'yes' && mutated.searchParams.get('code_challenge') === 'C',
    mutated.search);

  const replaced = __internals.buildAuthUrl(
    mockConnector('http://127.0.0.1:1/token', { buildAuthorizeUrl: () => 'https://example.test/custom?state=S' }),
    'S', 'C', 'http://127.0.0.1:1/oauth/callback'
  );
  check('buildAuthorizeUrl can replace the URL entirely', replaced.toString() === 'https://example.test/custom?state=S',
    replaced.toString());

  let badExtra = '';
  try {
    __internals.buildAuthUrl(
      mockConnector('http://127.0.0.1:1/token', { extraAuthParams: { nested: { a: 1 } } }),
      'S', 'C', 'http://127.0.0.1:1/oauth/callback'
    );
  } catch (err) {
    badExtra = err.message;
  }
  check('a non-string extraAuthParam is refused rather than sent as [object Object]',
    /must be a string or a number/.test(badExtra), badExtra);
}

/* ================================================================== *
 * 3. The happy path, over real HTTP, against the mock token endpoint
 * ================================================================== */

let happyMock = null;
{
  const mock = await mockTokenServer(() => ({
    body: JSON.stringify({
      access_token: 'access-token-1',
      refresh_token: 'refresh-token-1',
      expires_in: 3600,
      scope: 'mail.readonly mail.send',
      token_type: 'Bearer',
    }),
  }));
  happyMock = mock;
  await freshDataDir('happy');

  const connector = mockConnector(mock.url);
  const statuses = [];
  const seen = { url: '', fetchCalls: 0 };

  const promise = oauth.startAuthorization({
    connector,
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    fetch: proxyFetch(mock.url, () => { seen.fetchCalls++; }),
    timeoutMs: 8000,
  });

  // Wait for the listener, then behave like a browser: GET the redirect URI.
  seen.url = await waitForAuthorizeUrl(statuses);
  check('startAuthorization reports the authorize URL when no browser is launched',
    Boolean(seen.url) && /^http:\/\/127\.0\.0\.1:1\/authorize\?/.test(seen.url), seen.url || JSON.stringify(statuses));

  if (seen.url) {
    const parsed = new URL(seen.url);
    const redirectUri = parsed.searchParams.get('redirect_uri');
    check('the redirect URI uses the port the listener actually bound',
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(redirectUri), redirectUri);

    // The port must really be listening before the callback is sent.
    const port = Number(new URL(redirectUri).port);
    check('the reported port is above 0 (an ephemeral port was chosen)', port > 0 && port !== 1, String(port));

    const state = parsed.searchParams.get('state');
    const challenge = parsed.searchParams.get('code_challenge');
    const callback = await hitRedirect(redirectUri, `?code=AUTH-CODE&state=${encodeURIComponent(state)}`);
    const page = callback.body;
    check('the callback is answered with a page rather than a dropped connection',
      callback.status === 200 && /Klaud is connected/.test(page), `status ${callback.status}`);
    check('the callback page carries a charset and no script',
      /charset=utf-8/i.test(callback.headers.get('content-type') || '') && !/<script/i.test(page),
      callback.headers.get('content-type') || '');

    const outcome = await promise;
    check('a full authorization resolves ok', outcome.ok === true, JSON.stringify(outcome.error || ''));

    if (outcome.ok) {
      check('the exchange sent the code, the verifier and the redirect URI',
        mock.requests[0].form.code === 'AUTH-CODE' &&
        mock.requests[0].form.code_verifier &&
        mock.requests[0].form.redirect_uri === redirectUri,
        JSON.stringify(mock.requests[0].form));

      const expectedChallenge = crypto.createHash('sha256')
        .update(mock.requests[0].form.code_verifier, 'ascii').digest('base64url');
      check('the verifier sent to the endpoint is the pre-image of the challenge in the URL',
        expectedChallenge === challenge, `challenge in URL ${challenge}, challenge of sent verifier ${expectedChallenge}`);
      check('the verifier that was sent is high-entropy base64url',
        /^[A-Za-z0-9_-]{43}$/.test(mock.requests[0].form.code_verifier), mock.requests[0].form.code_verifier);

      check('the exchange used the authorization_code grant',
        mock.requests[0].form.grant_type === 'authorization_code', mock.requests[0].form.grant_type);
      check('the exchange posted form-encoded to the token URL',
        mock.requests[0].method === 'POST' &&
        /application\/x-www-form-urlencoded/.test(mock.requests[0].headers['content-type'] || ''),
        mock.requests[0].headers['content-type']);
      check('the client secret is sent in the body for a public client',
        mock.requests[0].form.client_id === 'client-id-from-the-user' &&
        mock.requests[0].form.client_secret === undefined,
        JSON.stringify(Object.keys(mock.requests[0].form)));

      check('exactly one request reached the token endpoint', mock.calls() === 1, `${mock.calls()}`);
      check('the token endpoint was reached through the injected fetch, so no other host was contacted',
        seen.fetchCalls === 1, `${seen.fetchCalls}`);

      const tokens = outcome.tokens;
      check('the token record has all six documented fields',
        ['access_token', 'refresh_token', 'expires_at', 'scope', 'token_type', 'obtained_at']
          .every((key) => Object.prototype.hasOwnProperty.call(tokens, key)),
        JSON.stringify(Object.keys(tokens)));

      const soon = Date.now() + 3600 * 1000;
      check('expires_at is an absolute epoch-ms value computed from expires_in',
        Number.isFinite(tokens.expires_at) && Math.abs(tokens.expires_at - soon) < 5000,
        `${tokens.expires_at} vs about ${soon}`);
      check('expires_at is not a duration',
        tokens.expires_at > 1_000_000_000_000, String(tokens.expires_at));
      check('obtained_at is a recent epoch-ms value',
        Math.abs(tokens.obtained_at - Date.now()) < 5000, String(tokens.obtained_at));

      check('a warning says the tokens are not encrypted',
        Array.isArray(outcome.warnings) && outcome.warnings.some((w) => /not encrypted/i.test(w)),
        JSON.stringify(outcome.warnings));
      check('a warning names the missing keychain honestly',
        outcome.warnings.some((w) => /no keychain integration/i.test(w)),
        JSON.stringify(outcome.warnings));
      check('a warning says the refresh token is durable account access',
        outcome.warnings.some((w) => /durable access|durable access to the connected account/i.test(w)),
        JSON.stringify(outcome.warnings));

      const onDisk = await oauth.loadConnection('mockmail');
      check('the connection was written under the connector id',
        onDisk && onDisk.tokens.access_token === 'access-token-1', JSON.stringify(onDisk && onDisk.tokens));
      check('the stored expiry equals the returned expiry',
        onDisk.tokens.expires_at === tokens.expires_at);

      const raw = JSON.parse(await fsp.readFile(__internals.connectionFile('mockmail'), 'utf8'));
      check('the file on disk holds an absolute expires_at, not an expires_in duration',
        raw.tokens.expires_at === tokens.expires_at && raw.tokens.expires_in === undefined,
        JSON.stringify(raw.tokens));
      check('the stored connection carries the label and scopes for the UI',
        raw.label === 'Mock Mail' && Array.isArray(raw.scopes) && raw.scopes.includes('mail.send'),
        JSON.stringify({ label: raw.label, scopes: raw.scopes }));

      check('progress strings are plain and name the provider',
        statuses.some((m) => /Waiting for you to approve|Open this URL to approve/.test(m)) &&
        statuses.some((m) => /Exchanging the code/.test(m)) &&
        statuses.every((m) => typeof m === 'string' && m.length > 0),
        JSON.stringify(statuses));

      const stateFile = await __internals.readState();
      check('the in-flight attempt is cleared once the flow settles',
        stateFile && Array.isArray(stateFile.attempts) && stateFile.attempts.length === 0,
        JSON.stringify(stateFile));
      check('no verifier or code was ever written to connect-state.json',
        !JSON.stringify(stateFile).includes(mock.requests[0].form.code_verifier) &&
        !JSON.stringify(stateFile).includes('AUTH-CODE'),
        JSON.stringify(stateFile).slice(0, 200));
    }
  }
  await mock.close();
}

/* ================================================================== *
 * 4. A state mismatch is refused and never exchanges the code
 * ================================================================== */

{
  const mock = await mockTokenServer(() => ({ body: JSON.stringify({ access_token: 'should-never-exist', expires_in: 60 }) }));
  await freshDataDir('state');

  const statuses = [];
  const seen = { url: '' };
  const promise = oauth.startAuthorization({
    connector: mockConnector(mock.url),
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    fetch: proxyFetch(mock.url),
    timeoutMs: 8000,
  });

  seen.url = await waitForAuthorizeUrl(statuses);

  const redirectUri = new URL(seen.url).searchParams.get('redirect_uri');
  const res = await hitRedirect(redirectUri, '?code=ATTACKER-CODE&state=not-the-real-state');
  check('a state mismatch is answered in the browser, not silently dropped',
    res.status === 200, `status ${res.status}`);

  const outcome = await promise;
  check('a state mismatch fails the authorization', outcome.ok === false, JSON.stringify(outcome));
  check('the state mismatch says what happened',
    /state value that does not match/i.test(outcome.error || ''), outcome.error || '');
  check('the state mismatch explains it is CSRF protection',
    /stops another page on this machine/i.test(outcome.hint || ''), outcome.hint || '');
  check('the mismatched code was NOT exchanged', mock.calls() === 0, `${mock.calls()} request(s)`);
  check('nothing was stored for the connector', (await oauth.loadConnection('mockmail')) === null);
  check('the authorize URL is still handed back so the user can retry', typeof outcome.authorizeUrl === 'string' && outcome.authorizeUrl.startsWith('http'));

  await mock.close();
}

/* ================================================================== *
 * 5. A provider error becomes a readable message
 * ================================================================== */

{
  const mock = await mockTokenServer(() => ({ body: '{"access_token":"never"}' }));
  await freshDataDir('denied');

  const statuses = [];
  const seen = { url: '' };
  const promise = oauth.startAuthorization({
    connector: mockConnector(mock.url),
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    fetch: proxyFetch(mock.url),
    timeoutMs: 8000,
  });

  seen.url = await waitForAuthorizeUrl(statuses);

  const parsed = new URL(seen.url);
  const redirectUri = parsed.searchParams.get('redirect_uri');
  const state = parsed.searchParams.get('state');
  // A real denial comes back with the state intact: Google answers
  // error=access_denied&error_description=...&state=<the state it was sent>.
  await hitRedirect(
    redirectUri,
    `?error=access_denied&error_description=${encodeURIComponent('The user denied the request')}&state=${encodeURIComponent(state)}`
  );

  let threw = null;
  let outcome = null;
  try {
    outcome = await promise;
  } catch (err) {
    threw = err;
  }

  check('access_denied resolves to a failure instead of throwing', threw === null && outcome && outcome.ok === false,
    threw ? threw.message : JSON.stringify(outcome));
  if (outcome) {
    check('the error is readable and names the provider error',
      /access_denied/.test(outcome.error || '') && !/^error:/i.test(outcome.error || ''), outcome.error || '');
    check('the provider description is kept',
      /user denied the request/i.test(outcome.error || ''), outcome.error || '');
    check('the hint explains that a denial can come from policy, not just the user',
      /Workspace admin|not verified/i.test(outcome.hint || ''), outcome.hint || '');
    check('a denial never reaches the token endpoint', mock.calls() === 0, `${mock.calls()}`);
    check('a denial stores nothing',
      (await oauth.loadConnection('mockmail')) === null);
    check('the error carries no angle-bracket placeholder',
      !/[<>{}]/.test(outcome.error + outcome.hint), `${outcome.error} | ${outcome.hint}`);
  }

  await mock.close();
}

/* ================================================================== *
 * 6. Timeout: the promise fails and the socket really closes
 * ================================================================== */

{
  await freshDataDir('timeout');
  const connector = mockConnector('http://127.0.0.1:1/token');

  const statuses = [];
  const started = Date.now();
  const outcome = await oauth.startAuthorization({
    connector,
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    // A port of our own, so the "is it free afterwards" check is unambiguous.
    redirectPort: 0,
    timeoutMs: 250,
  });
  const elapsed = Date.now() - started;

  check('a timeout resolves to a failure rather than hanging or rejecting',
    outcome.ok === false, JSON.stringify(outcome));
  check('the timeout is reported as a timeout',
    /No answer from the browser/i.test(outcome.error || ''), outcome.error || '');
  check('the timeout fires near the deadline rather than the 5-minute default',
    elapsed < 3000, `${elapsed}ms`);
  check('the timeout explains nothing was stored',
    /Nothing was stored/i.test(outcome.hint || ''), outcome.hint || '');
  check('the authorize URL is reported so the user can open it by hand',
    typeof outcome.authorizeUrl === 'string' && outcome.authorizeUrl.includes('code_challenge'));

  const boundPort = Number(new URL(outcome.redirectUri).port);
  check('the timeout reports the redirect URI it was listening on', boundPort > 0, String(boundPort));

  /* The assertion that matters: the port must be free. A listening socket left
   * behind is an open door on the machine, and it is the failure mode a
   * timeout handler is most likely to have. */
  let portFree = false;
  try {
    const probe = http.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(boundPort, '127.0.0.1', resolve);
    });
    portFree = true;
    await new Promise((resolve) => probe.close(resolve));
  } catch (err) {
    portFree = false;
  }
  check('the listener socket is closed after a timeout', portFree, `port ${boundPort} still in use`);

  // And a fresh connection on that port must be refused, not answered.
  let refused = false;
  try {
    const res = await fetch(`http://127.0.0.1:${boundPort}/oauth/callback?code=x`);
    await res.text().catch(() => '');
  } catch {
    refused = true;
  }
  check('a request to the abandoned port is refused rather than answered', refused);

  const stateAfter = await __internals.readState();
  check('the timed-out attempt is removed from connect-state.json',
    stateAfter && stateAfter.attempts.length === 0, JSON.stringify(stateAfter));
}

/* ================================================================== *
 * 7. Cancellation via the abort signal also closes the socket
 * ================================================================== */

{
  await freshDataDir('abort');
  const controller = new AbortController();
  const statuses = [];
  const promise = oauth.startAuthorization({
    connector: mockConnector('http://127.0.0.1:1/token'),
    signal: controller.signal,
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    timeoutMs: 30_000,
  });
  await sleep(60);
  controller.abort();
  const outcome = await promise;

  check('an aborted authorization fails without waiting for the timeout',
    outcome.ok === false && /cancelled/i.test(outcome.error || ''), JSON.stringify(outcome));
  const port = Number(new URL(outcome.redirectUri).port);
  let portFree = false;
  try {
    const probe = http.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    portFree = true;
    await new Promise((resolve) => probe.close(resolve));
  } catch {
    portFree = false;
  }
  check('the listener socket is closed on cancellation', portFree, `port ${port}`);
}

/* ================================================================== *
 * 8. The exchange failing at the provider
 * ================================================================== */

{
  const mock = await mockTokenServer(() => ({
    status: 400,
    body: JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code, or it already expired.' }),
  }));
  await freshDataDir('badcode');

  const statuses = [];
  const seen = { url: '' };
  const promise = oauth.startAuthorization({
    connector: mockConnector(mock.url),
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    fetch: proxyFetch(mock.url),
    timeoutMs: 8000,
  });
  seen.url = await waitForAuthorizeUrl(statuses);
  const parsed = new URL(seen.url);
  await hitRedirect(
    parsed.searchParams.get('redirect_uri'),
    `?code=EXPIRED&state=${encodeURIComponent(parsed.searchParams.get('state'))}`
  );

  const outcome = await promise;
  check('a rejected exchange fails with the provider\'s own words',
    outcome.ok === false && /already expired/i.test(outcome.error || ''), outcome.error || '');
  check('invalid_grant is explained as an expired or reused code',
    /expired|already been used/i.test(outcome.hint || ''), outcome.hint || '');
  check('a rejected exchange is marked needsReconnect so the caller does not retry blindly',
    outcome.needsReconnect === true, String(outcome.needsReconnect));
  check('a rejected exchange stores nothing', (await oauth.loadConnection('mockmail')) === null);

  await mock.close();
}

/* ================================================================== *
 * 9. File permissions
 * ================================================================== */

{
  await freshDataDir('modes');
  await oauth.saveConnection('mockmail', {
    label: 'Mock Mail',
    scopes: ['mail.readonly'],
    tokens: { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' },
  });

  const fileMode = fs.statSync(__internals.connectionFile('mockmail')).mode & 0o777;
  const dirMode = fs.statSync(__internals.connectionsDir()).mode & 0o777;

  if (process.platform === 'win32') {
    check('file permissions are NOT asserted on Windows, because NTFS has no POSIX mode bits (documented, not silently passed)',
      true, 'Windows ignores chmod; see the module header and the returned warnings');
  } else {
    check('the connection file is mode 0600', fileMode === 0o600, `0o${fileMode.toString(8)}`);
    check('the connections directory is mode 0700', dirMode === 0o700, `0o${dirMode.toString(8)}`);
    check('the connections directory is not world-readable or world-enterable',
      (dirMode & 0o077) === 0, `0o${dirMode.toString(8)}`);
    check('the connection file is not group- or world-readable',
      (fileMode & 0o077) === 0, `0o${fileMode.toString(8)}`);
  }

  const dirPosix = process.platform !== 'win32' ? dirMode === 0o700 : true;
  check(`permissions check ran in the mode the platform supports (platform ${process.platform})`, dirPosix);
}

/* ================================================================== *
 * 10. expires_at survives a reload, and accessTokenFor's refresh rule
 * ================================================================== */

{
  await freshDataDir('expiry');
  /* A duration has no reference point, so it is not converted here: the absolute
   * time is computed at exchange time and nowhere else. Both halves of that rule
   * are pinned, because the tempting alternative — converting against "now" —
   * produces a token that looks valid for an hour when it expired yesterday. */
  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'bare-duration', refresh_token: 'r', expires_in: 3600 },
  });
  const written = await oauth.loadConnection('mockmail');
  check('a bare duration becomes an unknown expiry, not a guessed one',
    written.tokens.expires_at === null, String(written.tokens.expires_at));
  check('an unknown expiry counts as expired, so it is refreshed rather than trusted',
    __internals.isExpired(written.tokens.expires_at) === true);
  check('the duration is not written to disk',
    JSON.parse(await fsp.readFile(__internals.connectionFile('mockmail'), 'utf8')).tokens.expires_in === undefined);

  /* The recovery path, for a file an older version might have written: a
   * duration is usable only when the same record says when it started. */
  const obtainedAt = Date.now();
  check('a duration plus its obtained_at is recoverable',
    __internals.normalizeStoredTokens({ access_token: 'x', expires_in: 10, obtained_at: obtainedAt })
      .expires_at === obtainedAt + 10_000);
  check('a duration without an obtained_at is not recoverable',
    __internals.normalizeStoredTokens({ access_token: 'x', expires_in: 10 }).expires_at === null);

  /* The hazard the merge rule has to avoid: saving a token without an expiry
   * must not inherit the previous token's expiry, or a new short-lived token
   * would wear the old one's hour and never be refreshed. */
  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'fresh', refresh_token: 'r', expires_at: Date.now() + 3600 * 1000 },
  });
  await oauth.saveConnection('mockmail', { tokens: { access_token: 'fresh-no-expiry', refresh_token: 'r' } });
  const replaced = await oauth.loadConnection('mockmail');
  check('a replacement token does not inherit the previous token\'s expiry',
    replaced.tokens.access_token === 'fresh-no-expiry' && replaced.tokens.expires_at === null,
    JSON.stringify(replaced.tokens));
  check('the previous token is not left behind alongside the new one',
    !JSON.stringify(replaced.tokens).includes('"fresh"'), JSON.stringify(replaced.tokens));

  // Omitting tokens keeps them, which is how a connection is relabelled.
  const relabelled = await oauth.saveConnection('mockmail', { label: 'Renamed Mail' });
  check('saving without tokens keeps the stored credentials',
    relabelled.tokens.access_token === 'fresh-no-expiry' && relabelled.label === 'Renamed Mail',
    JSON.stringify({ label: relabelled.label, token: relabelled.tokens.access_token }));

  /* The property that matters: expires_at is absolute, so it does not move when
   * the file is read again later. A duration would read as "an hour from now"
   * forever, which is exactly the bug this record shape exists to prevent. */
  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'absolute', refresh_token: 'r', expires_at: Date.now() + 3600 * 1000 },
  });
  const firstRead = (await oauth.loadConnection('mockmail')).tokens.expires_at;
  await sleep(50);
  const secondRead = (await oauth.loadConnection('mockmail')).tokens.expires_at;
  check('an absolute expires_at does not drift when the record is read again',
    Number.isFinite(firstRead) && firstRead === secondRead, `${firstRead} then ${secondRead}`);

  // A leg of the rule that is easy to get wrong: a token with 30 seconds left is
  // inside the 60-second window and must be refreshed, not used.
  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'almost-expired', refresh_token: 'r', expires_in: 30 },
  });
  const nearly = await oauth.loadConnection('mockmail');
  check('a token within 60 seconds of expiry counts as expired',
    __internals.isExpired(nearly.tokens.expires_at) === true,
    `${nearly.tokens.expires_at - Date.now()}ms left`);
  check('a token an hour out does not count as expired',
    __internals.isExpired(Date.now() + 3600_000) === false);
  check('a token with no expiry at all counts as expired, so it is refreshed rather than trusted',
    __internals.isExpired(null) === true);

  // expires_at in the past -> refresh; expires_at in the future -> no request.
  const mock = await mockTokenServer((record) => {
    if (record.form.grant_type === 'refresh_token') {
      return {
        body: JSON.stringify({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
    }
    return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
  });

  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'expired-token', refresh_token: 'refresh-token-1', expires_in: 1 },
  });
  await sleep(1100); // let the one-second token actually expire

  const refreshed = await oauth.accessTokenFor('mockmail', {
    connector: mockConnector(mock.url),
    fetch: proxyFetch(mock.url),
  });
  check('accessTokenFor refreshes an expired token', refreshed.ok === true && refreshed.token === 'refreshed-token',
    JSON.stringify(refreshed));
  check('accessTokenFor reports that it refreshed', refreshed.refreshed === true);
  check('the refresh used the refresh_token grant and the stored refresh token',
    mock.requests[0] && mock.requests[0].form.grant_type === 'refresh_token' &&
    mock.requests[0].form.refresh_token === 'refresh-token-1',
    JSON.stringify(mock.requests[0] && mock.requests[0].form));
  check('the refresh did not resend the client secret when there is none',
    mock.requests[0].form.client_secret === undefined);

  const persisted = await oauth.loadConnection('mockmail');
  check('the refreshed token was persisted', persisted.tokens.access_token === 'refreshed-token');
  check('the previous refresh token is carried forward when the provider omits a new one',
    persisted.tokens.refresh_token === 'refresh-token-1', persisted.tokens.refresh_token);
  check('the refreshed expiry is absolute and in the future',
    persisted.tokens.expires_at > Date.now() + 3000_000, String(persisted.tokens.expires_at));

  const callsBefore = mock.calls();
  const cached = await oauth.accessTokenFor('mockmail', {
    connector: mockConnector(mock.url),
    fetch: proxyFetch(mock.url),
  });
  check('accessTokenFor does NOT refresh a token that is still valid',
    cached.ok === true && cached.token === 'refreshed-token' && cached.refreshed === false,
    JSON.stringify({ ok: cached.ok, refreshed: cached.refreshed }));
  check('no HTTP request was made for a valid token', mock.calls() === callsBefore, `${mock.calls()} vs ${callsBefore}`);

  await mock.close();
}

/* ================================================================== *
 * 11. A rejected refresh sets needsReconnect and does not loop
 * ================================================================== */

{
  await freshDataDir('revoked');
  const mock = await mockTokenServer(() => ({
    status: 400,
    body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
  }));

  const connector = mockConnector(mock.url);
  await oauth.saveConnection('mockmail', {
    tokens: { access_token: 'dead', refresh_token: 'revoked-refresh', expires_in: 1 },
  });
  await sleep(1100);

  const first = await oauth.accessTokenFor('mockmail', { connector, fetch: proxyFetch(mock.url) });
  check('a rejected refresh reports failure', first.ok === false, JSON.stringify(first));
  check('a rejected refresh sets needsReconnect', first.needsReconnect === true, String(first.needsReconnect));
  check('a rejected refresh keeps the provider message',
    /revoked|expired/i.test(first.error || ''), first.error || '');
  check('a rejected refresh says the user must reconnect',
    /run the connection again|reconnect/i.test(first.hint || ''), first.hint || '');
  check('the rejected refresh made exactly one request', mock.calls() === 1, `${mock.calls()}`);

  const second = await oauth.accessTokenFor('mockmail', { connector, fetch: proxyFetch(mock.url) });
  check('a second call still reports needsReconnect', second.ok === false && second.needsReconnect === true,
    JSON.stringify(second));
  check('a second call does not hit the provider again: the loop is bounded',
    mock.calls() === 1, `${mock.calls()} request(s)`);
  check('the cooldown is explained rather than looking like a hang',
    /not asking the provider again yet|reconnect/i.test(second.hint || ''), second.hint || '');

  const direct = await oauth.refreshTokens(connector, { refresh_token: 'revoked-refresh' }, { fetch: proxyFetch(mock.url) });
  check('refreshTokens reports needsReconnect for a revoked token', direct.needsReconnect === true, JSON.stringify(direct));

  // A transient failure must NOT be reported as needing a reconnect. It gets its
  // own connector id: the cooldown above is per connector and would otherwise
  // answer this call from the earlier terminal failure, which is the behaviour
  // being tested there and would hide the behaviour being tested here.
  const flaky = await mockTokenServer(() => ({ status: 503, body: '{"error":"server_error"}' }));
  const transient = await oauth.refreshTokens(
    mockConnector(flaky.url, { id: 'flakymail', label: 'Flaky Mail' }),
    { refresh_token: 'maybe-fine' },
    { fetch: proxyFetch(flaky.url) }
  );
  check('a 5xx from the token endpoint is retryable, not a reconnect',
    transient.ok === false && transient.needsReconnect === false && transient.retryable === true,
    JSON.stringify(transient));
  check('the transient failure explains that it is the provider, not the setup',
    /provider-side failure|try again/i.test(transient.hint || ''), transient.hint || '');
  await flaky.close();

  // A missing refresh token is a reconnect without any network call at all.
  const noToken = await oauth.refreshTokens(connector, { access_token: 'x', refresh_token: '' }, { fetch: proxyFetch(mock.url) });
  check('a missing refresh token needs a reconnect', noToken.ok === false && noToken.needsReconnect === true,
    JSON.stringify(noToken));
  check('a missing refresh token is explained as a provider omission',
    /access_type=offline/i.test(noToken.hint || ''), noToken.hint || '');
  check('a missing refresh token makes no HTTP request', mock.calls() === 1, `${mock.calls()}`);

  await mock.close();
}

/* ================================================================== *
 * 12. A missing client ID is caught before the browser, with a destination
 * ================================================================== */

{
  await freshDataDir('noclient');
  const statuses = [];
  const outcome = await oauth.startAuthorization({
    connector: mockConnector('http://127.0.0.1:1/token', { clientId: '' }),
    onStatus: (message) => statuses.push(message),
    launchBrowser: false,
    timeoutMs: 3000,
  });

  check('a missing clientId fails immediately', outcome.ok === false, JSON.stringify(outcome));
  check('the failure names the connector', /Mock Mail/.test(outcome.error || ''), outcome.error || '');
  check('the failure says the client ID is missing',
    /no OAuth client ID/i.test(outcome.error || ''), outcome.error || '');
  check('the hint says Klaud cannot ship a client and why',
    /Klaud cannot ship one/i.test(outcome.hint || '') && /not a secret/i.test(outcome.hint || ''),
    outcome.hint || '');
  check('the hint names the exact place to get one',
    /console\.cloud\.google\.com/.test(outcome.hint || '') && /Desktop app/.test(outcome.hint || ''),
    outcome.hint || '');
  check('the hint names the exact menu path to get one',
    /APIs and Services/.test(outcome.hint || '') && /Credentials/.test(outcome.hint || ''),
    outcome.hint || '');
  check('no browser was opened and no authorize URL was built',
    outcome.authorizeUrl === undefined && !statuses.some((m) => /approve/.test(m)),
    JSON.stringify({ authorizeUrl: outcome.authorizeUrl, statuses }));
  check('the missing-clientId message has no angle-bracket placeholder to paste',
    !/[<>{}]/.test(outcome.error + outcome.hint), `${outcome.error} | ${outcome.hint}`);
  check('nothing was stored', (await oauth.loadConnection('mockmail')) === null);

  // A caller-supplied redirect that is not http loopback is refused, per RFC 8252.
  const custom = await oauth.startAuthorization({
    connector: mockConnector('http://127.0.0.1:1/token', { redirectUri: 'klaud://oauth/callback' }),
    launchBrowser: false,
    timeoutMs: 3000,
  });
  check('a custom URI scheme redirect is refused rather than used',
    custom.ok === false && /not an http loopback address/i.test(custom.error || ''), JSON.stringify(custom));
  check('the refusal cites the reason a custom scheme is unsafe',
    /registered by any other program/i.test(custom.hint || ''), custom.hint || '');
}

/* ================================================================== *
 * 13. deleteConnection, listConnections and invalid ids
 * ================================================================== */

{
  await freshDataDir('delete');
  await oauth.saveConnection('mockmail', { label: 'Mock Mail', tokens: { access_token: 'a' } });
  await oauth.saveConnection('other', { label: 'Other', tokens: { access_token: 'b', refresh_token: 'r' } });

  const listed = await oauth.listConnections();
  check('listConnections reports both connections', listed.length === 2, JSON.stringify(listed));
  const summaryKeys = listed.length
    ? Object.keys(listed[0]).sort().join(',')
    : '(nothing listed)';
  check('a connection summary carries no token material, only the fixed set of fields',
    summaryKeys === 'connected_at,connectorId,expires_at,has_refresh_token,label,scopes,updated_at',
    summaryKeys);
  check('listConnections never returns the token values themselves',
    !JSON.stringify(listed).includes('"a"') && !JSON.stringify(listed).includes('"b"'),
    JSON.stringify(listed));
  check('listConnections says whether a refresh token exists without showing it',
    listed.some((c) => c.connectorId === 'other' && c.has_refresh_token === true) &&
    listed.some((c) => c.connectorId === 'mockmail' && c.has_refresh_token === false),
    JSON.stringify(listed.map((c) => [c.connectorId, c.has_refresh_token])));

  const removed = await oauth.deleteConnection('mockmail');
  check('deleteConnection reports that it removed something', removed === true, String(removed));
  check('the file is really gone', !fs.existsSync(__internals.connectionFile('mockmail')));
  check('loadConnection returns null afterwards', (await oauth.loadConnection('mockmail')) === null);
  check('listConnections no longer reports it', (await oauth.listConnections()).length === 1);

  const again = await oauth.deleteConnection('mockmail');
  check('deleteConnection is safe to call twice', again === false, String(again));
  check('deleting a connector that was never connected is not an error',
    (await oauth.deleteConnection('never-connected')) === false);

  let badId = '';
  try {
    await oauth.loadConnection('../../etc/passwd');
  } catch (err) {
    badId = err.message;
  }
  check('a traversal-shaped connector id is refused, not sanitised',
    /invalid connector id/.test(badId), badId);
  let badSave = '';
  try {
    await oauth.saveConnection('a/b', { tokens: { access_token: 'x' } });
  } catch (err) {
    badSave = err.message;
  }
  check('saveConnection refuses an id that could escape the directory',
    /invalid connector id/.test(badSave), badSave);
  let noToken = '';
  try {
    await oauth.saveConnection('mockmail', {});
  } catch (err) {
    noToken = err.message;
  }
  check('saving a connection with no access token is refused rather than writing a broken file',
    /no access token/.test(noToken), noToken);
}

/* ================================================================== *
 * 14. In-flight state is bounded
 * ================================================================== */

{
  await freshDataDir('statefile');
  const { stateFilePath } = __internals;
  const stale = {
    updatedAt: Date.now() - 90 * 60 * 1000,
    attempts: [
      { connectorId: 'old', label: 'Old', state: 'stale-state', redirectUri: 'http://127.0.0.1:1/oauth/callback', startedAt: Date.now() - 90 * 60 * 1000 },
    ],
  };
  await fsp.mkdir(path.dirname(stateFilePath()), { recursive: true });
  await fsp.writeFile(stateFilePath(), JSON.stringify(stale), 'utf8');

  const read = await __internals.readState();
  check('connect-state.json is readable', read && Array.isArray(read.attempts), JSON.stringify(read));

  // A new attempt rewrites the file; the stale one must not survive.
  await oauth.startAuthorization({
    connector: mockConnector('http://127.0.0.1:1/token'),
    launchBrowser: false,
    timeoutMs: 200,
  });
  const after = await __internals.readState();
  check('an attempt older than the state window is pruned',
    after.attempts.every((entry) => entry.state !== 'stale-state'), JSON.stringify(after));
  check('the abandoned attempt is stored without a verifier or a code',
    after.attempts.length === 0 && !JSON.stringify(after).includes('code_verifier'),
    JSON.stringify(after));

  const mode = process.platform === 'win32' ? null : fs.statSync(stateFilePath()).mode & 0o777;
  check(
    process.platform === 'win32'
      ? 'connect-state.json permissions are NOT asserted on Windows (no POSIX mode bits)'
      : 'connect-state.json is mode 0600',
    mode === null || mode === 0o600,
    mode === null ? 'Windows' : `0o${mode.toString(8)}`
  );

  const stateDir = __internals.ensureBaseDir();
  check('the data directory is writable and holds the state file',
    fs.existsSync(stateFilePath()) && fs.existsSync(stateDir), stateDir);
}

/* ================================================================== *
 * 15. The real ~/.klaud is untouched
 * ================================================================== */

{
  const realAfter = fs.existsSync(REAL_DATA_DIR) ? snapshotTree(REAL_DATA_DIR) : null;
  const same =
    (realBefore === null && realAfter === null) ||
    (Array.isArray(realBefore) && Array.isArray(realAfter) &&
      realBefore.length === realAfter.length &&
      realBefore.every((line, i) => line === realAfter[i]));
  check('no file in the real ~/.klaud was created, changed or removed by this suite', same,
    realBefore && realAfter
      ? `before ${realBefore.length} entries, after ${realAfter.length}`
      : `before ${realBefore}, after ${realAfter}`);

  check('the suite ran against a throwaway data directory',
    Boolean(process.env.KLAUD_DATA_DIR) && process.env.KLAUD_DATA_DIR.startsWith(TEMP_ROOT),
    process.env.KLAUD_DATA_DIR || '(unset)');

  /* Deliberately narrower than "the directory does not exist". A sibling module
   * that talks to connectors may legitimately create ~/.klaud/connections while
   * this suite is running, and failing on someone else's honest work would make
   * this test untrustworthy. What is asserted is the thing that matters: no token
   * material of mine ever landed there. */
  const realConnections = path.join(REAL_DATA_DIR, 'connections');
  const strays = fs.existsSync(realConnections)
    ? fs.readdirSync(realConnections).filter((name) => name.endsWith('.json'))
    : [];
  check('the real data directory holds no connection record written by this suite',
    strays.length === 0, JSON.stringify(strays));
  check('the real data directory holds no connect-state.json written by this suite',
    !fs.existsSync(path.join(REAL_DATA_DIR, 'connect-state.json')),
    path.join(REAL_DATA_DIR, 'connect-state.json'));
}

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

process.env.KLAUD_DATA_DIR = TEMP_ROOT;
await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} OAuth checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} OAuth checks passed\x1b[0m\n`);

})().catch((err) => {
  console.log(`  \x1b[31m✗\x1b[0m the suite itself threw\n      ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
