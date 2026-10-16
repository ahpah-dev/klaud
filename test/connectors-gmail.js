'use strict';

/**
 * Gmail connector test.
 *
 *   node test/connectors-gmail.js
 *
 * No live calls to Google: every request goes to a loopback HTTP server started
 * by this file, and everything that can be checked without a network is checked
 * directly.
 *
 * The failures this exists to prevent, in order of how badly they would hurt:
 *
 *   1. A message that sends but arrives with a mojibake subject, because the
 *      Subject header was not RFC 2047 encoded.
 *   2. An attachment's base64 dumped into the body, filling the model's context
 *      with noise — or a base64url body decoded with the wrong alphabet, which
 *      silently produces garbage rather than failing.
 *   3. A 403 reported as "Forbidden" when the real cause is a missing scope, a
 *      per-user rate limit or a project quota, each needing a different fix.
 *   4. An action that could not proceed returning an empty string, which reads
 *      to the user as success.
 */

const http = require('http');
const path = require('path');

const gmail = require('../src/lib/connectors/gmail.js');

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

const oneLine = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').slice(0, 220);

/** A message that says something a user could act on, rather than a bare cause. */
const isUseful = (text) =>
  typeof text === 'string' &&
  text.length > 60 &&
  !/error unknown$/i.test(text.trim()) &&
  !/^error:/i.test(text.trim());

/* ------------------------------------------------------------------ *
 * Mock Gmail over loopback HTTP
 * ------------------------------------------------------------------ */

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** A doc-shaped Message. parts[0] is the body unless built otherwise. */
function message(headerList, { id = 'm1', threadId = 't1', labels = ['INBOX'], body = null } = {}) {
  return {
    id,
    threadId,
    labelIds: labels,
    snippet: 'a snippet',
    payload: {
      mimeType: 'text/plain',
      headers: headerList,
      body: body || { size: 0, data: '' },
    },
  };
}

const routeKey = (req) => `${req.method} ${req.url}`;
const recorded = [];
let routes = new Map();
// Assigned once the mock server is up. routeGmail clears it so each block sees
// only the calls it triggered.
let currentCtx = null;

const respond = (json, status = 200, contentType = 'application/json') =>
  ({ status, body: json, contentType });

function startMockGmail() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      recorded.push({ method: req.method, url: req.url, body: rawBody });
      const handler = routes.get(routeKey(req)) || routes.get(routeKey({ method: req.method, url: req.url.split('?')[0] }));
      const answer = typeof handler === 'function'
        ? handler({ url: req.url, method: req.method, body: rawBody })
        : handler;
      const result = answer || { status: 404, body: { error: { code: 404, message: 'no route' } }, contentType: 'application/json' };
      const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      res.writeHead(result.status, { 'content-type': result.contentType || 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Stand in for the OAuth framework.
 *
 * This deliberately performs a real HTTP request against the mock server over a
 * real socket: it proves the connector's path, method, query and JSON body are
 * complete enough for a server to answer, which a fake function returning an
 * object would not. Only the base URL is substituted — `ctx.callApi` is what
 * would supply it, and the connector passes through everything else untouched.
 */
function makeCtx(base) {
  const calls = [];
  return {
    calls,
    async callApi(descriptor, options) {
      const url = new URL(options.path.replace(/^\/+/, ''), `${base}/`);
      for (const [key, value] of Object.entries(options.query || {})) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const entry of value) url.searchParams.append(key, String(entry));
        else url.searchParams.set(key, String(value));
      }
      calls.push({
        descriptorId: descriptor && descriptor.id,
        method: options.method,
        path: options.path,
        query: options.query || {},
        body: options.body,
        permission: options.permission,
      });
      const init = { method: options.method || 'GET' };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
        init.headers = { 'content-type': 'application/json' };
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch { /* keep the raw text so a non-JSON body is still visible */ }
      return { ok: res.ok, status: res.status, body, headers: res.headers };
    },
  };
}

/** Run one action; return its text, or `Error: <message>` if it refused. */
async function runAction(name, args, ctx) {
  const action = gmail.actions.find((entry) => entry.name === name);
  if (!action) throw new Error(`no such action: ${name}`);
  try {
    return await action.run(args, ctx);
  } catch (err) {
    return `Error: ${err && err.message ? err.message : String(err)}`;
  }
}

function routeGmail(routes_) {
  routes = new Map(Object.entries(routes_));
  // Cleared, not just left to grow. Several actions hit the same paths (a
  // metadata fetch and a full read share /messages/<id>; the 403 cases each post
  // to /messages/send), so assertions that searched the whole accumulated list
  // found an earlier call and passed or failed for the wrong reason.
  recorded.length = 0;
  if (currentCtx) currentCtx.calls.length = 0;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PLAIN_MESSAGE = message(
  [
    { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
    { name: 'To', value: 'grace@example.com' },
    { name: 'Subject', value: 'Plain subject' },
    { name: 'Date', value: 'Mon, 5 May 2025 10:00:00 +0000' },
  ],
  { id: 'plain-1', body: { size: 10, data: b64('Hello there\nSecond line\n') } }
);

const ALTERNATIVE_MESSAGE = {
  id: 'alt-1',
  threadId: 't-alt',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'snippet here',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Bob <bob@example.com>' },
      { name: 'To', value: 'ada@example.com' },
      { name: 'Subject', value: 'Both halves' },
      { name: 'Date', value: 'Tue, 6 May 2025 11:00:00 +0000' },
    ],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { size: 8, data: b64('plain version') } },
      { partId: '1', mimeType: 'text/html', body: { size: 40, data: b64('<p><b>html</b> version</p>') } },
    ],
  },
};

const NESTED_ATTACHMENT_MESSAGE = {
  id: 'nested-1',
  threadId: 't-nested',
  labelIds: ['INBOX'],
  snippet: 'with an attachment',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Carol <carol@example.com>' },
      { name: 'Subject', value: 'Report attached' },
      { name: 'Date', value: 'Wed, 7 May 2025 09:30:00 +0000' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          { partId: '0.0', mimeType: 'text/plain', body: { size: 5, data: b64('see attached') } },
          { partId: '0.1', mimeType: 'text/html', body: { size: 20, data: b64('<p>see attached</p>') } },
        ],
      },
      {
        partId: '1',
        mimeType: 'image/png',
        filename: 'photo.png',
        body: { size: 68, attachmentId: 'ATTACHMENT-ID-ABC', data: b64('PNG-BASE64-NOISE-PNG-BASE64-NOISE') },
      },
    ],
  },
};

const HTML_ONLY_MESSAGE = {
  id: 'html-1',
  threadId: 't-html',
  labelIds: [],
  snippet: 'html only',
  payload: {
    mimeType: 'text/html',
    headers: [
      { name: 'From', value: '"Grace Hopper" <grace@example.com>' },
      { name: 'Subject', value: 'Html only' },
      { name: 'Date', value: 'Thu, 8 May 2025 08:00:00 +0000' },
    ],
    body: {
      size: 60,
      // Real mail carries a style block and a script with attributes; a stripper
      // that only handles bare `<style>` leaks CSS into the body the model reads.
      data: b64('<html><head><style type="text/css">p{color:red}</style></head>' +
        '<body><p>Real text</p><br>line two<script src="x.js">x()</script></body></html>'),
    },
  },
};

const ENCODED_SUBJECT_MESSAGE = message(
  [
    { name: 'From', value: '=?UTF-8?B?w4VzYSA=?= <asa@example.com>' },
    { name: 'Subject', value: '=?UTF-8?B?SGVsbG8g4oCUIGNoZWNrIC0g4oKsMTIz?=' },
    { name: 'Date', value: 'Fri, 9 May 2025 07:00:00 +0000' },
  ],
  { id: 'enc-1', body: { data: b64('encoded subject body') } }
);

const NON_ASCII = 'R\u00e9sum\u00e9 \u2014 \u00e5ngstr\u00f6m \u4e2d\u6587 \u20ac9';
const UTF8_PLAIN = 'Gr\u00fc\u00dfe aus M\u00fcnchen \u2014 \u4f60\u597d';

/** The wire form of a built message, as gmail_send puts it on the request. */
const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[38;5;209m* Gmail connector\x1b[0m\n');

  const { server, port } = await startMockGmail();
  const base = `http://127.0.0.1:${port}`;
  const ctx = makeCtx(base);
  currentCtx = ctx;

  /* ---------------- descriptor ---------------- */
  const d = gmail.descriptor;
  check('descriptor.id is "gmail"', d.id === 'gmail', String(d.id));
  check('descriptor.id is safe as a filename', /^[a-z0-9][a-z0-9._-]*$/.test(d.id) && !/[\\/]/.test(d.id), String(d.id));
  check('descriptor.label is present', typeof d.label === 'string' && d.label.length > 1, String(d.label));
  check('authUrl is Google\'s authorisation endpoint',
    d.authUrl === 'https://accounts.google.com/o/oauth2/v2/auth', String(d.authUrl));
  check('tokenUrl is Google\'s token endpoint',
    d.tokenUrl === 'https://oauth2.googleapis.com/token', String(d.tokenUrl));
  /* Verified against the registry: buildRequest resolves the API root from the
   * descriptor and refuses to build a request without one, and the registry has
   * no apiBaseUrlFor fallback. Without this field every action fails before any
   * HTTP is attempted. */
  check('baseUrl is the host from the reference\'s request URLs',
    d.baseUrl === 'https://gmail.googleapis.com/gmail/v1', String(d.baseUrl));
  check('baseUrl has no trailing slash, so path joining is unambiguous',
    typeof d.baseUrl === 'string' && !d.baseUrl.endsWith('/'), String(d.baseUrl));
  check('scopeSeparator is a single space', d.scopeSeparator === ' ', JSON.stringify(d.scopeSeparator));
  check('extraAuthParams asks for a refresh token',
    d.extraAuthParams && d.extraAuthParams.access_type === 'offline', JSON.stringify(d.extraAuthParams));
  check('extraAuthParams forces the consent prompt so a refresh token is reissued',
    d.extraAuthParams && d.extraAuthParams.prompt === 'consent', JSON.stringify(d.extraAuthParams));
  check('setupHint explains the user must create their own OAuth client',
    /oauth client/i.test(d.setupHint) &&
      (/cloud console/i.test(d.setupHint) || /console\.cloud\.google\.com/i.test(d.setupHint)),
    oneLine(d.setupHint));
  check('setupHint says to enable the Gmail API',
    /enable the gmail api/i.test(d.setupHint), oneLine(d.setupHint));
  check('setupHint mentions the loopback redirect URI',
    /redirect uri/i.test(d.setupHint) && /loopback/i.test(d.setupHint), oneLine(d.setupHint));
  check('setupHint says the unverified-app warning is expected and not a Klaud bug',
    /unverified/i.test(d.setupHint) && /not a klaud bug/i.test(d.setupHint), oneLine(d.setupHint));
  check('setupHint carries no credential material',
    !/client[_-]?id\s*[:=]\s*\S/i.test(d.setupHint) && !/client[_-]?secret\s*[:=]\s*\S/i.test(d.setupHint),
    oneLine(d.setupHint));
  check('descriptor carries no credentials of its own',
    d.clientId === undefined && d.clientSecret === undefined,
    JSON.stringify({ clientId: d.clientId, clientSecret: d.clientSecret }));

  /* ---------------- scopes ---------------- */
  const scopeList = gmail.scopes;
  check('scopes is a non-empty array of strings',
    Array.isArray(scopeList) && scopeList.length > 0 && scopeList.every((s) => typeof s === 'string' && s.startsWith('https://')),
    JSON.stringify(scopeList));
  check('descriptor.scopes and the exported scopes agree',
    Array.isArray(d.scopes) && d.scopes.join(' ') === scopeList.join(' '),
    `${JSON.stringify(d.scopes)} vs ${JSON.stringify(scopeList)}`);
  check('no full-access scope is requested',
    !scopeList.includes('https://mail.google.com/'), JSON.stringify(scopeList));
  check('no scope string contains mail.google.com at all',
    !scopeList.some((s) => s.includes('mail.google.com')), JSON.stringify(scopeList));
  check('gmail.send is requested', scopeList.includes('https://www.googleapis.com/auth/gmail.send'),
    JSON.stringify(scopeList));
  check('gmail.readonly is requested', scopeList.includes('https://www.googleapis.com/auth/gmail.readonly'),
    JSON.stringify(scopeList));
  check('gmail.modify is requested for label changes', scopeList.includes('https://www.googleapis.com/auth/gmail.modify'),
    JSON.stringify(scopeList));
  const exactScopeSet = ['gmail.readonly', 'gmail.send', 'gmail.modify'].every((name) => scopeList.includes(`https://www.googleapis.com/auth/${name}`)) &&
    scopeList.length === 3;
  check('exactly the three needed scopes, nothing broader', exactScopeSet, JSON.stringify(scopeList));
  check('no compose scope, which could also send mail',
    !scopeList.some((s) => s.includes('gmail.compose')), JSON.stringify(scopeList));
  check('no metadata-only scope, which cannot be used with the q parameter',
    !scopeList.some((s) => s.includes('gmail.metadata')), JSON.stringify(scopeList));

  /* ---------------- actions: shape ---------------- */
  check('actions is a non-empty array', Array.isArray(gmail.actions) && gmail.actions.length > 0,
    `${(gmail.actions || []).length}`);
  const expectedNames = ['gmail_search', 'gmail_read', 'gmail_send', 'gmail_labels', 'gmail_modify'];
  const actualNames = gmail.actions.map((a) => a.name);
  check(`all five actions exist (${expectedNames.join(', ')})`,
    expectedNames.every((name) => actualNames.includes(name)), JSON.stringify(actualNames));
  check('no unexpected actions', actualNames.length === expectedNames.length, JSON.stringify(actualNames));

  for (const action of gmail.actions) {
    const p = action.parameters;
    check(`${action.name}: has name, label and description`,
      typeof action.name === 'string' && typeof action.label === 'string' && action.label.length > 1 &&
        typeof action.description === 'string' && action.description.length > 20);
    check(`${action.name}: run is an async function`, typeof action.run === 'function');
    check(`${action.name}: parameters.type is "object"`, p && p.type === 'object', JSON.stringify(p && p.type));
    check(`${action.name}: parameters.properties is an object`,
      p && p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties));
    check(`${action.name}: parameters.required is an array`, p && Array.isArray(p.required),
      JSON.stringify(p && p.required));
    check(`${action.name}: every required key is declared in properties`,
      p && Array.isArray(p.required) && p.required.every((key) => Object.prototype.hasOwnProperty.call(p.properties, key)),
      JSON.stringify(p && p.required));
    for (const [key, schema] of Object.entries((p && p.properties) || {})) {
      check(`${action.name}.${key}: is a valid JSON Schema`,
        schema && typeof schema === 'object' && typeof schema.type === 'string' && typeof schema.description === 'string',
        JSON.stringify(schema));
    }
  }

  /* ---------------- actions: permissions ---------------- */
  const permissionOf = (name) => (gmail.actions.find((a) => a.name === name) || {}).permission;
  const allowedPermissions = ['read', 'write', 'send'];
  for (const action of gmail.actions) {
    check(`${action.name}: permission is one of read/write/send`,
      allowedPermissions.includes(action.permission), String(action.permission));
  }
  check('gmail_send permission is exactly "send"', permissionOf('gmail_send') === 'send', String(permissionOf('gmail_send')));
  check('gmail_send is the only action at the send level',
    gmail.actions.filter((a) => a.permission === 'send').length === 1,
    JSON.stringify(gmail.actions.filter((a) => a.permission === 'send').map((a) => a.name)));
  check('gmail_search is a read', permissionOf('gmail_search') === 'read', String(permissionOf('gmail_search')));
  check('gmail_read is a read', permissionOf('gmail_read') === 'read', String(permissionOf('gmail_read')));
  check('gmail_labels is a read', permissionOf('gmail_labels') === 'read', String(permissionOf('gmail_labels')));
  check('gmail_modify is a write, not a send', permissionOf('gmail_modify') === 'write', String(permissionOf('gmail_modify')));

  /* ---------------- parseGmailMessage ---------------- */
  const parsed = {};

  parsed.plain = gmail.parseGmailMessage(PLAIN_MESSAGE);
  check('parse: simple text/plain body is decoded',
    parsed.plain.body.includes('Hello there') && parsed.plain.body.includes('Second line'), oneLine(parsed.plain.body));
  check('parse: the body is not left as base64',
    !/[A-Za-z0-9+/]{16,}={0,2}/.test(parsed.plain.body.replace(/Second line/g, '')), oneLine(parsed.plain.body));
  check('parse: id and threadId are carried through',
    parsed.plain.id === 'plain-1' && parsed.plain.threadId === 't1', `${parsed.plain.id}/${parsed.plain.threadId}`);
  check('parse: subject, from, to and date are read from headers',
    parsed.plain.subject === 'Plain subject' && parsed.plain.from === 'ada@example.com' &&
      parsed.plain.to === 'grace@example.com' && /5 May 2025/.test(parsed.plain.date),
    JSON.stringify({ s: parsed.plain.subject, f: parsed.plain.from, t: parsed.plain.to, d: parsed.plain.date }));
  check('parse: labels array is preserved',
    Array.isArray(parsed.plain.labels) && parsed.plain.labels.includes('INBOX'), JSON.stringify(parsed.plain.labels));
  check('parse: snippet is preserved', parsed.plain.snippet === 'a snippet', parsed.plain.snippet);
  check('parse: returns exactly the documented keys',
    ['id', 'threadId', 'from', 'to', 'subject', 'date', 'body', 'snippet', 'labels']
      .every((key) => Object.prototype.hasOwnProperty.call(parsed.plain, key)),
    JSON.stringify(Object.keys(parsed.plain)));

  parsed.alternative = gmail.parseGmailMessage(ALTERNATIVE_MESSAGE);
  check('parse: multipart/alternative prefers text/plain over text/html',
    parsed.alternative.body.includes('plain version') && !parsed.alternative.body.includes('html'),
    oneLine(parsed.alternative.body));

  parsed.nested = gmail.parseGmailMessage(NESTED_ATTACHMENT_MESSAGE);
  check('parse: nested multipart/mixed finds the text part',
    parsed.nested.body.includes('see attached'), oneLine(parsed.nested.body));
  check('parse: the attachment is NOT the body',
    !parsed.nested.body.includes('PNG-BASE64-NOISE'), oneLine(parsed.nested.body));
  check('parse: the attachment id is not leaked into the body',
    !parsed.nested.body.includes('ATTACHMENT-ID-ABC'), oneLine(parsed.nested.body));
  check('parse: text/html is not chosen when text/plain exists in a nested tree',
    !parsed.nested.body.includes('<p>'), oneLine(parsed.nested.body));

  parsed.html = gmail.parseGmailMessage(HTML_ONLY_MESSAGE);
  check('parse: falls back to stripped text/html when there is no text/plain',
    parsed.html.body.includes('Real text'), oneLine(parsed.html.body));
  check('parse: html tags are stripped', !/[<>]/.test(parsed.html.body), oneLine(parsed.html.body));
  check('parse: a <style> block does not become body text',
    !parsed.html.body.includes('color:red'), oneLine(parsed.html.body));
  check('parse: a <script> block does not become body text',
    !parsed.html.body.includes('x()'), oneLine(parsed.html.body));
  check('parse: quoted display names are reduced to the address',
    parsed.html.from === 'grace@example.com', parsed.html.from);

  parsed.encoded = gmail.parseGmailMessage(ENCODED_SUBJECT_MESSAGE);
  check('parse: an RFC 2047 encoded subject is decoded',
    parsed.encoded.subject === 'Hello \u2014 check - \u20ac123', JSON.stringify(parsed.encoded.subject));
  check('parse: no encoded-word survives in the subject',
    !/=\?UTF-8\?/.test(parsed.encoded.subject), parsed.encoded.subject);
  check('parse: an encoded display name is decoded too',
    parsed.encoded.from === 'asa@example.com', parsed.encoded.from);

  let missingPayload = null;
  let missingThrew = false;
  try {
    missingPayload = gmail.parseGmailMessage({ id: 'x', threadId: 'y', snippet: 's' });
  } catch (err) {
    missingThrew = true;
  }
  check('parse: a message with no payload does not throw', !missingThrew);
  check('parse: a message with no payload yields an empty body',
    missingPayload && missingPayload.body === '', JSON.stringify(missingPayload && missingPayload.body));
  check('parse: a message with no payload still returns the id',
    missingPayload && missingPayload.id === 'x', JSON.stringify(missingPayload && missingPayload.id));
  check('parse: a message with no payload labels an absent subject',
    missingPayload && missingPayload.subject === '(no subject)', JSON.stringify(missingPayload && missingPayload.subject));

  let emptyBody = null;
  let emptyThrew = false;
  try {
    emptyBody = gmail.parseGmailMessage(message([{ name: 'Subject', value: 'Empty' }], { body: { size: 0, data: '' } }));
  } catch (err) {
    emptyThrew = true;
  }
  check('parse: an empty body does not throw', !emptyThrew);
  check('parse: an empty body is the empty string', emptyBody && emptyBody.body === '', JSON.stringify(emptyBody && emptyBody.body));

  for (const [label, input] of [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['a number', 42],
    ['an empty object', {}],
    ['payload as a string', { id: 'z', payload: 'not an object' }],
    ['payload.parts as a string', { id: 'z', payload: { parts: 'no' } }],
    ['a header with no value', { id: 'z', payload: { headers: [{ name: 'Subject' }] } }],
  ]) {
    let threw = false;
    let result = null;
    try {
      result = gmail.parseGmailMessage(input);
    } catch (err) {
      threw = true;
    }
    check(`parse: ${label} input does not throw and returns an object`,
      !threw && result && typeof result === 'object' && typeof result.body === 'string',
      threw ? 'threw' : JSON.stringify(result));
  }

  /* ---------------- base64url decoding ---------------- */
  /* `-` (base64 index 62) needs a byte of 0xF8 or above in that position, and
   * valid UTF-8 has no such byte at all — so a *text* body can never contain
   * `-`, and a fixture claiming otherwise would be testing something Gmail
   * cannot send. `_` (index 63) is reachable: the trailing 0xBF continuation
   * byte of `\u00bf` lands on it. Both are still exercised below, the `-` case
   * through raw bytes, because the decoder must handle the full alphabet
   * whatever the content. */
  const TILDE_TEXT = 'a~b?c';
  const UNDERSCORE_TEXT = '>\u00bf\u00bf<';
  const underscoreEncoded = Buffer.from(UNDERSCORE_TEXT, 'utf8').toString('base64url');
  check('base64url fixture really contains an underscore',
    underscoreEncoded.includes('_'), underscoreEncoded);
  check('decode: a body containing _ decodes correctly',
    gmail.decodeBase64Url(underscoreEncoded) === UNDERSCORE_TEXT,
    `${underscoreEncoded} -> ${JSON.stringify(gmail.decodeBase64Url(underscoreEncoded))}`);

  // 0xFB base64-encodes to '+', and to '-' in the url-safe alphabet. This is the
  // one case that cannot come from text, and the decoder must still be exact.
  const dashEncoded = Buffer.from([0xfb]).toString('base64url');
  check('base64url fixture for raw bytes contains a dash', dashEncoded === '-w', dashEncoded);
  check('decode: a value containing - decodes rather than throwing or emptying',
    typeof gmail.decodeBase64Url(dashEncoded) === 'string' && gmail.decodeBase64Url(dashEncoded).length > 0,
    JSON.stringify(gmail.decodeBase64Url(dashEncoded)));
  check('decode: the - character is not silently dropped or replaced by +',
    !gmail.decodeBase64Url(dashEncoded).includes('+') &&
      gmail.decodeBase64Url(dashEncoded) === gmail.decodeBase64Url('+w'),
    JSON.stringify(gmail.decodeBase64Url(dashEncoded)));

  const standardAlphabet = Buffer.from(UNDERSCORE_TEXT, 'utf8').toString('base64');
  check('decode: the same bytes in the standard alphabet decode too',
    gmail.decodeBase64Url(standardAlphabet) === UNDERSCORE_TEXT, standardAlphabet);
  check('decode: re-encoding the url-safe form does not produce + or /',
    !/[+/]/.test(underscoreEncoded), underscoreEncoded);

  const unpadded = underscoreEncoded.replace(/=+$/, '');
  check('decode: missing padding is tolerated',
    gmail.decodeBase64Url(unpadded) === UNDERSCORE_TEXT, unpadded);

  const utf8Encoded = b64(UTF8_PLAIN);
  const unpaddedUtf8 = utf8Encoded.replace(/=+$/, '');
  check('decode: multi-byte UTF-8 survives with padding present',
    gmail.decodeBase64Url(utf8Encoded) === UTF8_PLAIN, gmail.decodeBase64Url(utf8Encoded));
  check('decode: multi-byte UTF-8 survives with padding absent',
    gmail.decodeBase64Url(unpaddedUtf8) === UTF8_PLAIN, gmail.decodeBase64Url(unpaddedUtf8));

  const multiline = Buffer.from('one\ntwo\r\nthree', 'utf8').toString('base64url');
  check('decode: newlines in the decoded body are preserved',
    gmail.decodeBase64Url(multiline) === 'one\ntwo\r\nthree', JSON.stringify(gmail.decodeBase64Url(multiline)));
  check('decode: an empty string decodes to an empty string', gmail.decodeBase64Url('') === '');
  check('decode: null does not throw', gmail.decodeBase64Url(null) === '');
  check('decode: an empty padded value decodes to an empty string', gmail.decodeBase64Url('====') === '');

  /* ---------------- building a send request ---------------- */
  const builtRaw = gmail.buildRawMessage({
    to: 'ada@example.com',
    subject: 'Hello',
    body: 'Line one.\nLine two.',
  });
  const rawMessage = builtRaw;
  check('send: encodeRawMessage is what actually goes on the wire, and is base64url',
    /^[A-Za-z0-9_-]+$/.test(gmail.encodeRawMessage(builtRaw)) &&
      !gmail.encodeRawMessage(builtRaw).includes('+') &&
      !gmail.encodeRawMessage(builtRaw).includes('/'),
    oneLine(gmail.encodeRawMessage(builtRaw)));
  // Compared whole, not by searching for the body text: the body is base64 (as
  // the Content-Transfer-Encoding header promises), so "Line one." is not a
  // literal substring of the built message. That decode is asserted separately.
  check('send: decoding the wire form recovers the exact plain message',
    decodeRaw(gmail.encodeRawMessage(builtRaw)) === builtRaw,
    oneLine(decodeRaw(gmail.encodeRawMessage(builtRaw))));
  check('send: raw declares the To header', /^To: ?ada@example\.com/m.test(rawMessage), oneLine(rawMessage));
  check('send: raw declares the Subject header', /^Subject: ?Hello$/m.test(rawMessage), oneLine(rawMessage));
  check('send: raw declares text/plain with an explicit UTF-8 charset',
    /Content-Type: text\/plain; charset="UTF-8"/.test(rawMessage), oneLine(rawMessage));
  check('send: raw declares MIME-Version', /MIME-Version: 1\.0/.test(rawMessage), oneLine(rawMessage));
  check('send: headers use CRLF line endings', rawMessage.startsWith('To:') && rawMessage.includes('\r\n'), JSON.stringify(rawMessage.slice(0, 40)));
  check('send: there is exactly one blank line before the body',
    (rawMessage.match(/\r\n\r\n/g) || []).length === 1, JSON.stringify(rawMessage));
  check('send: the body really is encoded with the declared transfer encoding',
    /Content-Transfer-Encoding: base64/.test(rawMessage), oneLine(rawMessage));
  check('send: decoding the body yields the original text',
    Buffer.from(rawMessage.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8') === 'Line one.\nLine two.',
    JSON.stringify(Buffer.from(rawMessage.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')));

  const ccRaw = gmail.buildRawMessage({
    to: 'a@example.com, b@example.com', cc: 'c@example.com', bcc: 'd@example.com',
    subject: 'S', body: 'B',
  });
  check('send: multiple To recipients are kept', /^To: ?a@example\.com, b@example\.com$/m.test(ccRaw), oneLine(ccRaw));
  check('send: Cc is included when given', /^Cc: ?c@example\.com$/m.test(ccRaw), oneLine(ccRaw));
  check('send: Bcc is included when given', /^Bcc: ?d@example\.com$/m.test(ccRaw), oneLine(ccRaw));
  const bareRaw = gmail.buildRawMessage({ to: 'a@example.com', subject: 'S', body: 'B' });
  check('send: Cc and Bcc are omitted when not given',
    !/^Cc:/m.test(bareRaw) && !/^Bcc:/m.test(bareRaw), oneLine(bareRaw));

  /* ---------------- RFC 2047 subject round trip ---------------- */
  const encodedHeader = gmail.encodeHeaderValue(NON_ASCII);
  check('rfc2047: a non-ASCII subject is encoded as an encoded-word',
    /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/.test(encodedHeader), encodedHeader);
  check('rfc2047: an already-ASCII subject is left readable',
    gmail.encodeHeaderValue('Plain ASCII subject') === 'Plain ASCII subject',
    gmail.encodeHeaderValue('Plain ASCII subject'));

  const nonAsciiRaw = gmail.buildRawMessage({
    to: 'x@example.com', subject: NON_ASCII, body: 'body',
  });
  check('rfc2047: the raw message carries no raw non-ASCII bytes',
    /^[\x00-\x7F]*$/.test(nonAsciiRaw), oneLine(nonAsciiRaw));
  const subjectLine = (nonAsciiRaw.match(/^Subject: (.*)$/m) || [])[1] || '';
  check('rfc2047: the Subject line is a folded-safe encoded word',
    /^=\?UTF-8\?B\?.+\?=$/.test(subjectLine), subjectLine);
  check('rfc2047: the encoded word is short enough not to need folding',
    subjectLine.length <= 76, `${subjectLine.length} chars`);
  const decodedSubject = Buffer.from(subjectLine.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8');
  check('rfc2047: decoding the Subject line gives back exactly the original text',
    decodedSubject === NON_ASCII, JSON.stringify(decodedSubject));

  /* ---------------- gmail_search ---------------- */
  routeGmail({
    [`GET /users/me/messages?q=${encodeURIComponent('from:ada@example.com')}&maxResults=2`]: respond({
      messages: [{ id: 'plain-1', threadId: 't1' }, { id: 'alt-1', threadId: 't-alt' }],
      resultSizeEstimate: 2,
    }),
    'GET /users/me/messages/plain-1?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject':
      respond(PLAIN_MESSAGE),
    'GET /users/me/messages/alt-1?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject':
      respond(ALTERNATIVE_MESSAGE),
  });
  const searchOut = await runAction('gmail_search', { query: 'from:ada@example.com', max_results: 2 }, ctx);
  check('gmail_search: returns a list rather than JSON',
    searchOut.includes('Plain subject') && searchOut.includes('Both halves'), oneLine(searchOut));
  check('gmail_search: each entry names its sender',
    searchOut.includes('ada@example.com') && searchOut.includes('bob@example.com'), oneLine(searchOut));
  check('gmail_search: each entry names its date',
    /5 May 2025/.test(searchOut) && /6 May 2025/.test(searchOut), oneLine(searchOut));
  check('gmail_search: each entry carries the message id',
    searchOut.includes('plain-1') && searchOut.includes('alt-1'), oneLine(searchOut));
  const searchCall = ctx.calls.find((c) => c.path === '/users/me/messages');
  check('gmail_search: uses the q query parameter', Boolean(searchCall) && searchCall.query.q === 'from:ada@example.com',
    JSON.stringify(searchCall && searchCall.query));
  check('gmail_search: passes maxResults', Boolean(searchCall) && Number(searchCall.query.maxResults) === 2,
    JSON.stringify(searchCall && searchCall.query));
  check('gmail_search: asks for the declared read permission',
    Boolean(searchCall) && searchCall.permission === 'read', String(searchCall && searchCall.permission));
  const titleCalls = ctx.calls.filter((c) => /\/messages\/(plain-1|alt-1)$/.test(c.path));
  check('gmail_search: header fetches are metadata-only, never full messages',
    titleCalls.length >= 2 && titleCalls.every((c) => c.query.format === 'metadata'), JSON.stringify(titleCalls.map((c) => c.query)));

  routeGmail({
    [`GET /users/me/messages?q=${encodeURIComponent('from:nobody@example.com')}&maxResults=10`]: respond({ resultSizeEstimate: 0 }),
  });
  const noResults = await runAction('gmail_search', { query: 'from:nobody@example.com' }, ctx);
  check('gmail_search: no matches says so instead of returning an empty string',
    noResults.length > 20 && /no messages matched/i.test(noResults), oneLine(noResults));
  check('gmail_search: no matches does not read as a failure',
    !/^error/i.test(noResults.trim()), oneLine(noResults));
  check('gmail_search: the empty result still teaches the query syntax',
    /from:|is:unread/.test(noResults), oneLine(noResults));

  const emptyQuery = await runAction('gmail_search', { query: '   ' }, ctx);
  check('gmail_search: a blank query is refused with an explanation, not an empty string',
    emptyQuery.startsWith('Error:') && emptyQuery.length > 40, oneLine(emptyQuery));

  /* ---------------- gmail_read ---------------- */
  routeGmail({ 'GET /users/me/messages/plain-1?format=full': respond(PLAIN_MESSAGE) });
  const readOut = await runAction('gmail_read', { id: 'plain-1' }, ctx);
  check('gmail_read: returns the subject', readOut.includes('Subject: Plain subject'), oneLine(readOut));
  check('gmail_read: returns the decoded body', readOut.includes('Hello there'), oneLine(readOut));
  check('gmail_read: returns the sender', readOut.includes('ada@example.com'), oneLine(readOut));
  /* Matched on `format` as well as path: gmail_search fetches the same message
   * path with format=metadata, so a path-only match finds the wrong call and the
   * assertion passes or fails for reasons unrelated to gmail_read. */
  const readCall = ctx.calls.find((c) => c.path === '/users/me/messages/plain-1' && c.query.format === 'full');
  check('gmail_read: requests the full format', Boolean(readCall) && readCall.query.format === 'full',
    JSON.stringify(readCall && readCall.query));
  check('gmail_read: asks for the declared read permission',
    Boolean(readCall) && readCall.permission === 'read', String(readCall && readCall.permission));

  routeGmail({ 'GET /users/me/messages/nested-1?format=full': respond(NESTED_ATTACHMENT_MESSAGE) });
  const nestedRead = await runAction('gmail_read', { id: 'nested-1' }, ctx);
  check('gmail_read: an attachment does not appear in the body',
    !nestedRead.includes('PNG-BASE64-NOISE'), oneLine(nestedRead));
  check('gmail_read: the real body is still returned', nestedRead.includes('see attached'), oneLine(nestedRead));

  routeGmail({ 'GET /users/me/messages/no-body-1?format=full': respond({
    id: 'no-body-1', threadId: 't', snippet: 'only a snippet', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Attachment only' }], parts: [] },
  }) });
  const noBodyRead = await runAction('gmail_read', { id: 'no-body-1' }, ctx);
  check('gmail_read: a bodyless message says why rather than returning an empty string',
    noBodyRead.length > 60 && /no readable text body/i.test(noBodyRead), oneLine(noBodyRead));
  check('gmail_read: the bodyless case still offers the snippet',
    noBodyRead.includes('only a snippet'), oneLine(noBodyRead));

  const noId = await runAction('gmail_read', {}, ctx);
  check('gmail_read: a missing id is refused with an explanation',
    noId.startsWith('Error:') && /id/i.test(noId), oneLine(noId));

  routeGmail({ 'GET /users/me/messages/gone-1?format=full': respond({
    error: { code: 404, message: 'Requested entity was not found.', errors: [{ domain: 'global', reason: 'notFound', message: 'Requested entity was not found.' }] },
  }, 404) });
  const notFound = await runAction('gmail_read', { id: 'gone-1' }, ctx);
  check('gmail_read: a deleted message explains itself',
    notFound.startsWith('Error:') && /deleted|wrong/i.test(notFound), oneLine(notFound));
  check('gmail_read: the 404 message never reads as success',
    !/^\s*$/.test(notFound) && /404/.test(notFound), oneLine(notFound));

  /* ---------------- gmail_send ---------------- */
  routeGmail({ 'POST /users/me/messages/send': respond({ id: 'sent-1', threadId: 't-sent', labelIds: ['SENT'] }) });
  const sendOut = await runAction('gmail_send', {
    to: 'ada@example.com', subject: 'Report', body: 'Here it is.',
  }, ctx);
  const sendCall = ctx.calls.find((c) => c.path === '/users/me/messages/send');
  check('gmail_send: posts to the send endpoint', Boolean(sendCall), JSON.stringify(ctx.calls.map((c) => c.path)));
  check('gmail_send: uses POST', Boolean(sendCall) && sendCall.method === 'POST', String(sendCall && sendCall.method));
  check('gmail_send: sends a raw field', Boolean(sendCall) && sendCall.body && typeof sendCall.body.raw === 'string',
    JSON.stringify(sendCall && sendCall.body && Object.keys(sendCall.body)));
  check('gmail_send: asks for the send permission',
    Boolean(sendCall) && sendCall.permission === 'send', String(sendCall && sendCall.permission));
  check('gmail_send: the report names the recipient', /ada@example\.com/.test(sendOut), oneLine(sendOut));
  check('gmail_send: the report names the message id Gmail returned', /sent-1/.test(sendOut), oneLine(sendOut));
  check('gmail_send: does not claim the message was delivered',
    /accepted|queued/i.test(sendOut) && !/\bdelivered\b/i.test(sendOut), oneLine(sendOut));

  const sentRaw = decodeRaw(sendCall.body.raw);
  check('gmail_send: the raw field is base64url on the wire, as the reference requires',
    /^[A-Za-z0-9_-]+$/.test(sendCall.body.raw), oneLine(sendCall.body.raw));
  check('gmail_send: raw decodes to the right To header', /^To: ?ada@example\.com$/m.test(sentRaw), oneLine(sentRaw));
  check('gmail_send: raw decodes to the right Subject header', /^Subject: ?Report$/m.test(sentRaw), oneLine(sentRaw));
  check('gmail_send: raw decodes to the right body',
    Buffer.from(sentRaw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8') === 'Here it is.',
    oneLine(sentRaw));

  routeGmail({ 'POST /users/me/messages/send': respond({ id: 'sent-2' }) });
  await runAction('gmail_send', { to: 'x@example.com', subject: NON_ASCII, body: UTF8_PLAIN }, ctx);
  const secondSend = ctx.calls.find((c) => c.path === '/users/me/messages/send');
  const nonAsciiSentRaw = decodeRaw(secondSend.body.raw);
  const sentSubject = (nonAsciiSentRaw.match(/^Subject: (.*)$/m) || [])[1] || '';
  check('gmail_send: a non-ASCII subject round-trips through RFC 2047',
    Buffer.from(sentSubject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8') === NON_ASCII,
    sentSubject);
  check('gmail_send: a non-ASCII body round-trips as UTF-8',
    Buffer.from(nonAsciiSentRaw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8') === UTF8_PLAIN,
    oneLine(nonAsciiSentRaw));
  check('gmail_send: the whole raw message is still ASCII after encoding',
    /^[\x00-\x7F]*$/.test(nonAsciiSentRaw), oneLine(nonAsciiSentRaw));

  routeGmail({ 'POST /users/me/messages/send': respond({ id: 'sent-3' }) });
  await runAction('gmail_send', {
    to: 'a@example.com', cc: 'c@example.com', bcc: 'd@example.com', subject: 'With copies', body: 'B',
  }, ctx);
  const copiesRaw = decodeRaw(ctx.calls.find((c) => c.path === '/users/me/messages/send').body.raw);
  check('gmail_send: Cc reaches the built message', /^Cc: ?c@example\.com$/m.test(copiesRaw), oneLine(copiesRaw));
  check('gmail_send: Bcc reaches the built message', /^Bcc: ?d@example\.com$/m.test(copiesRaw), oneLine(copiesRaw));

  const noRecipient = await runAction('gmail_send', { subject: 'S', body: 'B' }, ctx);
  check('gmail_send: no recipient is refused with an explanation',
    noRecipient.startsWith('Error:') && /recipient/i.test(noRecipient), oneLine(noRecipient));
  check('gmail_send: the refusal makes clear nothing was sent',
    /nothing was sent/i.test(noRecipient), oneLine(noRecipient));

  /* ---------------- gmail_labels ---------------- */
  routeGmail({ 'GET /users/me/labels': respond({
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_7', name: 'Work', type: 'user' },
    ],
  }) });
  const labelsOut = await runAction('gmail_labels', {}, ctx);
  const labelsCall = ctx.calls.find((c) => c.path === '/users/me/labels');
  check('gmail_labels: lists ids and names',
    labelsOut.includes('INBOX') && labelsOut.includes('Label_7') && labelsOut.includes('Work'), oneLine(labelsOut));
  check('gmail_labels: reports the count', /2 label/.test(labelsOut), oneLine(labelsOut));
  check('gmail_labels: asks for the read permission',
    Boolean(labelsCall) && labelsCall.permission === 'read', String(labelsCall && labelsCall.permission));

  routeGmail({ 'GET /users/me/labels': respond({}) });
  const noLabels = await runAction('gmail_labels', {}, ctx);
  check('gmail_labels: an empty label list says so instead of returning an empty string',
    noLabels.length > 40 && /no labels/i.test(noLabels), oneLine(noLabels));
  check('gmail_labels: the empty case still names the system labels that do exist',
    /INBOX/.test(noLabels), oneLine(noLabels));

  /* ---------------- gmail_modify ---------------- */
  routeGmail({ 'POST /users/me/messages/plain-1/modify': respond({
    id: 'plain-1', threadId: 't1', labelIds: ['INBOX', 'STARRED'],
  }) });
  const modifyOut = await runAction('gmail_modify', { id: 'plain-1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] }, ctx);
  const modifyCall = ctx.calls.find((c) => c.path === '/users/me/messages/plain-1/modify');
  check('gmail_modify: posts to the modify endpoint', Boolean(modifyCall), JSON.stringify(ctx.calls.map((c) => c.path)));
  check('gmail_modify: asks for the write permission, not send',
    Boolean(modifyCall) && modifyCall.permission === 'write', String(modifyCall && modifyCall.permission));
  check('gmail_modify: sends addLabelIds', Boolean(modifyCall) && JSON.stringify(modifyCall.body.addLabelIds) === '["STARRED"]',
    JSON.stringify(modifyCall && modifyCall.body));
  check('gmail_modify: sends removeLabelIds', Boolean(modifyCall) && JSON.stringify(modifyCall.body.removeLabelIds) === '["UNREAD"]',
    JSON.stringify(modifyCall && modifyCall.body));
  check('gmail_modify: the report says what changed',
    /added STARRED/.test(modifyOut) && /removed UNREAD/.test(modifyOut), oneLine(modifyOut));
  check('gmail_modify: the report shows the resulting labels',
    /STARRED/.test(modifyOut) && /Labels now/.test(modifyOut), oneLine(modifyOut));

  routeGmail({ 'POST /users/me/messages/plain-1/modify': respond({ id: 'plain-1' }) });
  const stringLabels = await runAction('gmail_modify', { id: 'plain-1', add_labels: 'STARRED, IMPORTANT' }, ctx);
  const stringCall = ctx.calls.find((c) => c.path === '/users/me/messages/plain-1/modify');
  check('gmail_modify: a comma-separated string is accepted for labels',
    Boolean(stringCall) && JSON.stringify(stringCall.body.addLabelIds) === '["STARRED","IMPORTANT"]',
    JSON.stringify(stringLabels && stringCall && stringCall.body));

  const noChange = await runAction('gmail_modify', { id: 'plain-1' }, ctx);
  check('gmail_modify: a no-op is refused rather than reported as success',
    noChange.startsWith('Error:') && /change nothing/i.test(noChange), oneLine(noChange));
  check('gmail_modify: the no-op refusal says nothing was sent to Gmail',
    /nothing was sent/i.test(noChange), oneLine(noChange));

  const noModifyId = await runAction('gmail_modify', { add_labels: ['STARRED'] }, ctx);
  check('gmail_modify: a missing id is refused with an explanation',
    noModifyId.startsWith('Error:') && /id/i.test(noModifyId), oneLine(noModifyId));

  /* ---------------- error mapping ---------------- */
  const RATE_LIMIT = {
    error: {
      code: 403,
      message: 'User Rate Limit Exceeded',
      errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
    },
  };
  const RATE_LIMIT_403 = {
    error: {
      code: 403,
      message: 'Rate Limit Exceeded',
      errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
    },
  };
  const INSUFFICIENT = {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.',
      errors: [{ domain: 'global', reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
    },
  };
  const AUTH_ERROR = {
    error: {
      code: 401,
      message: 'Invalid Credentials',
      errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials', location: 'Authorization' }],
    },
  };
  const NOT_FOUND = {
    error: { code: 404, message: 'Requested entity was not found.', errors: [{ domain: 'global', reason: 'notFound', message: 'Requested entity was not found.' }] },
  };

  routeGmail({ 'GET /users/me/messages/broken-1?format=full': respond(AUTH_ERROR, 401) });
  const e401 = await runAction('gmail_read', { id: 'broken-1' }, ctx);
  check('401: reported as a failure', e401.startsWith('Error:'), oneLine(e401));
  check('401: names the status', /401/.test(e401), oneLine(e401));
  check('401: tells the user to reconnect the account', /reconnect/i.test(e401), oneLine(e401));
  check('401: explains the token expired or was revoked', /expired|revoked/i.test(e401), oneLine(e401));

  /* Checked before the read case: this records its POST on the same call list, so
   * running it afterwards would put a send call into the read route's list too. */
  routeGmail({ 'POST /users/me/messages/send': respond(INSUFFICIENT, 403) });
  const eScopeSend = await runAction('gmail_send', { to: 'a@example.com', subject: 'S', body: 'B' }, ctx);
  check('403 insufficientPermissions: names the send scope for gmail_send',
    /gmail\.send/.test(eScopeSend), oneLine(eScopeSend));

  routeGmail({ 'GET /users/me/messages/broken-2?format=full': respond(INSUFFICIENT, 403) });
  const eScope = await runAction('gmail_read', { id: 'broken-2' }, ctx);
  check('403 insufficientPermissions: reported as a failure', eScope.startsWith('Error:'), oneLine(eScope));
  check('403 insufficientPermissions: names the missing scope',
    /gmail\.readonly/.test(eScope), oneLine(eScope));
  check('403 insufficientPermissions: says the account must be reconnected',
    /reconnect/i.test(eScope), oneLine(eScope));
  check('403 insufficientPermissions: explains that an old token keeps failing',
    /token minted before|stays failing|keeps failing|reconnect/i.test(eScope), oneLine(eScope));
  check('403 insufficientPermissions: does not advise simply retrying',
    !/try again|retrying/i.test(eScope), oneLine(eScope));

  routeGmail({ 'GET /users/me/messages/broken-3?format=full': respond(RATE_LIMIT, 403) });
  const eRate = await runAction('gmail_read', { id: 'broken-3' }, ctx);
  check('403 userRateLimitExceeded: says it is a rate limit', /rate limit/i.test(eRate), oneLine(eRate));
  check('403 userRateLimitExceeded: says retrying shortly is reasonable',
    /retry|try again|backoff|wait/i.test(eRate), oneLine(eRate));
  check('403 userRateLimitExceeded: does not blame the scope',
    !/scope/i.test(eRate), oneLine(eRate));
  check('403 userRateLimitExceeded: does not tell the user to reconnect',
    !/reconnect/i.test(eRate), oneLine(eRate));

  routeGmail({ 'GET /users/me/messages/broken-4?format=full': respond(RATE_LIMIT_403, 403) });
  const eRate2 = await runAction('gmail_read', { id: 'broken-4' }, ctx);
  check('403 rateLimitExceeded: also read as a rate limit, not a scope problem',
    /rate limit/i.test(eRate2) && !/scope/i.test(eRate2), oneLine(eRate2));

  routeGmail({ 'GET /users/me/messages/broken-5?format=full': respond(NOT_FOUND, 404) });
  const e404 = await runAction('gmail_read', { id: 'broken-5' }, ctx);
  check('404: says the message may have been deleted', /deleted|moved/i.test(e404), oneLine(e404));
  check('404: suggests the id might be wrong', /id is wrong|check the id|gmail_search/i.test(e404), oneLine(e404));
  check('404: does not blame the token', !/reconnect|expired/i.test(e404), oneLine(e404));

  routeGmail({ 'GET /users/me/messages/broken-6?format=full': respond({
    error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'dailyLimitExceeded', message: 'Daily Limit Exceeded' }] },
  }, 403) });
  const eDaily = await runAction('gmail_read', { id: 'broken-6' }, ctx);
  check('403 dailyLimitExceeded: named as a quota, distinct from a rate limit',
    /quota/i.test(eDaily) && /project/i.test(eDaily), oneLine(eDaily));

  routeGmail({ 'GET /users/me/messages/broken-7?format=full': respond(RATE_LIMIT, 429) });
  const e429 = await runAction('gmail_read', { id: 'broken-7' }, ctx);
  check('429: reported as rate limiting', /rate.?limit/i.test(e429), oneLine(e429));

  routeGmail({ 'GET /users/me/messages/broken-8?format=full': respond({
    error: { code: 400, message: 'Invalid id value', errors: [{ domain: 'global', reason: 'badRequest', message: 'Invalid id value' }] },
  }, 400) });
  const e400 = await runAction('gmail_read', { id: 'broken-8' }, ctx);
  check('400: says the request was malformed and not to retry unchanged',
    /malformed|400/i.test(e400) && /not something to retry unchanged/i.test(e400), oneLine(e400));

  routeGmail({ 'GET /users/me/messages/broken-9?format=full': respond({
    error: { code: 403, message: 'Something entirely new', errors: [{ domain: 'global', reason: 'aBrandNewReason', message: 'Something entirely new' }] },
  }, 403) });
  const eUnknown = await runAction('gmail_read', { id: 'broken-9' }, ctx);
  check('an unrecognised 403 still says something useful',
    isUseful(gmail.explainGmailError(403, {
      error: { code: 403, message: 'Something entirely new', errors: [{ domain: 'global', reason: 'aBrandNewReason', message: 'Something entirely new' }] },
    })),
    // The helper is judged, not the action result: runAction prefixes its text
    // with "Error: ", which isUseful rejects by design.
    oneLine(gmail.explainGmailError(403, { error: { message: 'Something entirely new' } })));
  check('an unrecognised 403 keeps Google\'s own message',
    /Something entirely new/.test(eUnknown), oneLine(eUnknown));

  routeGmail({ 'GET /users/me/messages/broken-10?format=full': respond('<html><body>502 Bad Gateway</body></html>', 502, 'text/html') });
  const e502 = await runAction('gmail_read', { id: 'broken-10' }, ctx);
  check('502: reported as a server error worth retrying',
    /server error/i.test(e502) && /502/.test(e502), oneLine(e502));

  routeGmail({ 'GET /users/me/messages/broken-11?format=full': respond('not json at all', 200, 'text/plain') });
  const eNotJson = await runAction('gmail_read', { id: 'broken-11' }, ctx);
  check('a non-JSON 200 body is reported rather than read as an empty message',
    eNotJson.startsWith('Error:') && /not json/i.test(eNotJson), oneLine(eNotJson));

  routeGmail({ 'GET /users/me/messages/broken-12?format=full': respond({}) });
  const eEmptyJson = await runAction('gmail_read', { id: 'broken-12' }, ctx);
  check('an empty 200 body still reports honestly rather than as a blank read',
    eEmptyJson.length > 40 && /no readable text body/i.test(eEmptyJson), oneLine(eEmptyJson));

  /* ---------------- a thrown error from the framework ---------------- */
  const throwingCtx = (err) => ({ async callApi() { throw err; } });

  const networkErr = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
  const eNetwork = await runAction('gmail_read', { id: 'x' }, throwingCtx(networkErr));
  check('a network failure is reported as a failure', eNetwork.startsWith('Error:'), oneLine(eNetwork));
  check('a network failure is distinguished from an API rejection',
    /could not reach gmail/i.test(eNetwork) && !/HTTP 4|HTTP 5/.test(eNetwork), oneLine(eNetwork));
  check('a network failure says the outcome is unknown rather than claiming success',
    /nothing was changed|unknown|no response/i.test(eNetwork), oneLine(eNetwork));

  const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' });
  const eDns = await runAction('gmail_read', { id: 'x' }, throwingCtx(dnsErr));
  check('a DNS failure says the hostname did not resolve', /resolve|dns/i.test(eDns), oneLine(eDns));

  const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const eAbort = await runAction('gmail_send', { to: 'a@example.com', subject: 'S', body: 'B' }, throwingCtx(abortErr));
  check('a timeout on a send warns that the message may still have gone out',
    /timed? ?out|timeout/i.test(eAbort), oneLine(eAbort));
  check('a timeout on a send tells the user to check Gmail before resending',
    /sent folder|actually sent|check.*gmail|verify/i.test(eAbort), oneLine(eAbort));

  const frameworkErr = Object.assign(new Error('HTTP 401 from Gmail'), { status: 401, body: AUTH_ERROR });
  const eFramework = await runAction('gmail_read', { id: 'x' }, throwingCtx(frameworkErr));
  check('an error thrown by the framework is mapped like a returned one',
    /reconnect/i.test(eFramework) && /401/.test(eFramework), oneLine(eFramework));

  const noContext = await runAction('gmail_read', { id: 'x' }, {});
  check('a context without callApi is refused, naming the contract',
    noContext.startsWith('Error:') && /callApi/.test(noContext), oneLine(noContext));

  const nullResponse = await runAction('gmail_read', { id: 'x' }, { async callApi() { return undefined; } });
  check('a callApi that returns nothing is treated as unknown, not as success',
    nullResponse.startsWith('Error:') && /unknown/i.test(nullResponse), oneLine(nullResponse));

  const okFalse = await runAction('gmail_read', { id: 'x' }, { async callApi() { return { ok: false, status: 404, body: NOT_FOUND }; } });
  check('an explicit ok:false response is mapped through the error explainer',
    okFalse.startsWith('Error:') && /404/.test(okFalse), oneLine(okFalse));

  /* ---------------- the connector never reaches for a token ---------------- */
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'connectors', 'gmail.js'), 'utf8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the module makes no direct fetch call for Gmail endpoints',
    !/[^.\w]fetch\s*\(/.test(codeOnly), (codeOnly.match(/[^.\w]fetch\s*\(/) || [''])[0]);
  check('the module never reads a token itself',
    !/access_token|refresh_token|accessToken|refreshToken/.test(codeOnly), 'token read found');
  check('the module documents why it does not read tokens',
    /callApi/.test(source) && /do not add a token read|token read/i.test(source), 'no note found');
  /* Matches the *construction* of a retry, not the word "backoff": the error
   * text must be allowed to tell the user that Google suggests backoff, which is
   * advice, not an implementation. There is no timer anywhere in the module. */
  check('the module does not reimplement retries',
    !/setTimeout\s*\(|setInterval\s*\(|retryDelay|for\s*\(\s*(let|var)\s+attempt/i.test(codeOnly),
    (codeOnly.match(/setTimeout\s*\(|setInterval\s*\(|retryDelay/gi) || [''])[0] || 'timer found');

  /* ---------------- every action refuses honestly ---------------- */
  for (const action of gmail.actions) {
    const outcome = await runAction(action.name, {}, { async callApi() { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); } });
    check(`${action.name}: with no arguments and no network, it explains rather than returning an empty string`,
      typeof outcome === 'string' && outcome.trim().length > 40, JSON.stringify(outcome.slice(0, 80)));
  }

  await new Promise((resolve) => server.close(resolve));

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} Gmail connector checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} Gmail connector checks passed\x1b[0m\n`);
})().catch((err) => {
  console.error(`\n\x1b[31mThe Gmail connector suite crashed: ${err && err.stack ? err.stack : err}\x1b[0m\n`);
  process.exit(1);
});
