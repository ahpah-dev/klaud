'use strict';

/**
 * OAuth 2.0 for Klaud connectors — hand-written, Node built-ins only.
 *
 * This is the generic half of the Cowork connectors: the module knows how to
 * obtain, refresh and store a token for a third-party service; a connector
 * module knows which provider, which scopes and which endpoints. Gmail is the
 * first sibling of this file, and the descriptor it must supply is documented
 * under "Connector descriptor" below.
 *
 * Three decisions are load-bearing and are explained where they are implemented
 * rather than repeated here:
 *
 *   1. PKCE (RFC 7636) on every authorization, because a desktop app is a
 *      public client: it cannot keep a secret. See `createPkce`.
 *   2. A loopback redirect (RFC 8252 section 7.3), received by a one-shot
 *      listener on 127.0.0.1. No custom URI scheme, no copy-pasting a code.
 *   3. Access tokens live in plain JSON files in the user's own data directory.
 *      They are NOT encrypted and NOT in an OS keychain — see "Token storage".
 *
 * ---------------------------------------------------------------------------
 * Connector descriptor
 * ---------------------------------------------------------------------------
 *
 * A connector is a plain object supplied by another module. Nothing here
 * subclasses, registers or mutates it.
 *
 *   {
 *     id: 'gmail',                  // required; stable, becomes the filename.
 *                                   // Letters, digits, dash and underscore only.
 *     label: 'Gmail',               // required; shown to the user in messages
 *                                   // and status strings. Use a name a person
 *                                   // recognises, not the id.
 *
 *     authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
 *     tokenUrl: 'https://oauth2.googleapis.com/token',
 *                                   // required; absolute https URLs.
 *
 *     scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
 *                                   // required; joined by `scopeSeparator`.
 *
 *     scopeSeparator: ' ',          // optional; default ' '. Joins `scopes`
 *                                   // literally and the result is encoded as
 *                                   // one query value. Measured, not assumed:
 *                                   // Node's URLSearchParams serialises that
 *                                   // space as '+', and percent-encodes a
 *                                   // literal '+' as '%2B'. Both are correct
 *                                   // HTTP — '+' means space in a query, which
 *                                   // is the encoding every provider decodes —
 *                                   // but a '+' separator would therefore send
 *                                   // a real plus sign and NOT a space. Leave
 *                                   // this at the default unless a provider
 *                                   // documents some other literal.
 *
 *     clientId: '....apps.googleusercontent.com',
 *     clientSecret: '...',          // required / optional. A desktop client
 *                                   // cannot keep a secret, so PKCE carries the
 *                                   // proof either way — but providers that
 *                                   // hand out a secret still check it, so it is
 *                                   // sent when present (see `startAuthorization`).
 *
 *     extraAuthParams: { access_type: 'offline', prompt: 'consent' },
 *                                   // optional; merged into the authorize URL.
 *                                   // STRINGS AND NUMBERS ONLY — the values are
 *                                   // copied verbatim into the query, so any
 *                                   // other type is dropped rather than
 *                                   // stringified into something unexpected.
 *
 *     buildAuthorizeUrl(ctx)        // optional escape hatch, for a provider that
 *                                   // needs a non-standard shape. `ctx` is
 *                                   // normally { url, state, challenge,
 *                                   // redirectUri }, where `url` is the default
 *                                   // URL already assembled and `redirectUri`
 *                                   // is the loopback URI carrying the real
 *                                   // port. Mutate `ctx.url` and return nothing,
 *                                   // or return a replacement string or URL.
 *   }
 *
 * A caller may also pass a transient `redirectUri` field; it overrides the
 * loopback URI this module would otherwise build. That exists for tests and for
 * a caller that terminates the redirect itself. RFC 8252 forbids custom URI
 * schemes for native apps, so anything that is not http on 127.0.0.1 is refused.
 *
 * ---------------------------------------------------------------------------
 * Token storage
 * ---------------------------------------------------------------------------
 *
 *   <dataDir>/connections/<connector-id>.json   one file per connected account
 *   <dataDir>/connect-state.json                in-flight authorization attempts
 *
 * `dataDir()` is `KLAUD_DATA_DIR` when set, otherwise `~/.klaud`. Directories
 * are created 0o700 and files 0o600 on POSIX.
 *
 * ON WINDOWS THE MODE IS IGNORED. NTFS has no equivalent of a POSIX mode bit,
 * so `fs.chmod` and the `mode` option are accepted and do nothing. The JSON
 * files are therefore readable by any process running as the user — on Windows
 * mostly by any process at all. Nothing here should be described as protecting
 * a token on Windows.
 *
 * ON EVERY PLATFORM THE TOKENS ARE WRITTEN IN PLAIN TEXT. There is no OS
 * keychain integration, because every way to reach one on Windows, macOS and
 * Linux needs a native dependency and Klaud takes no dependencies. So these
 * files are exactly as safe as the filesystem they sit on: a backup, a synced
 * folder or a shared machine will carry the refresh token with it. A refresh
 * token is durable access to the user's mail, drive or repo, so treat that as a
 * real limitation and not a footnote. The returned warnings say so too.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { dataDir } = require('../config');

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** How long a user has to finish approving in the browser before giving up. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** How long an incomplete authorization is remembered in connect-state.json. */
const MAX_STATE_AGE_MS = 30 * 60 * 1000;

/** connect-state.json is a breadcrumb trail, not a log; keep it tiny. */
const MAX_STATE_ENTRIES = 200;

/**
 * Refresh a token this long before it actually expires, so a request made
 * immediately after the check cannot land on an expired token.
 */
const EXPIRY_SLACK_MS = 60 * 1000;

/** A token exchange is a single small POST; it must never hang a turn. */
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * After a refresh is rejected outright, do not try the same connector again for
 * this long. The credentials are known-bad, and a caller in a retry loop would
 * otherwise hammer the provider with a request that cannot succeed.
 */
const FAILED_REFRESH_COOLDOWN_MS = 60 * 1000;

/** The only connector id shape that can become a filename. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const USER_AGENT = 'Klaud/1.0 (+local coding agent; OAuth connector)';

/**
 * Loopback redirects only. RFC 8252 section 7.3: a native app receives the
 * authorization response on a loopback interface; section 8.1 forbids a private
 * URI scheme for exactly the interception reasons HANDLED_HOSTS guards against.
 */
const HANDLED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** PKCE values must survive a round trip through a query string untouched. */
function isBase64url(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function firstLine(value, limit = 400) {
  const line = text(value).split(/\r?\n/)[0].trim();
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
}

function bytes(value) {
  return Buffer.byteLength(text(value), 'utf8');
}

/**
 * A connector id becomes a filename, so it is validated rather than sanitised.
 * Rewriting `../../etc/passwd` into something acceptable is how a traversal
 * bug gets shipped; refusing it is how it does not.
 */
function requireConnectorId(connectorId) {
  const id = typeof connectorId === 'string' ? connectorId : '';
  if (!ID_PATTERN.test(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(connectorId)}: use 1-64 characters from A-Z, a-z, 0-9, "-" and "_"`
    );
  }
  return id;
}

function requireConnector(connector) {
  if (!connector || typeof connector !== 'object') {
    throw new TypeError('startAuthorization needs a connector descriptor object');
  }
  const id = requireConnectorId(connector.id);
  return { id, label: text(connector.label).trim() || id };
}

/** Only http(s), and never with embedded credentials. */
function assertHttpUrl(raw, what) {
  let url;
  try {
    url = new URL(text(raw));
  } catch {
    throw new Error(`${what} is not a valid URL: ${JSON.stringify(text(raw))}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${what} must be an http or https URL, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(`${what} must not carry credentials in the URL`);
  }
  return url;
}

/** Where on disk a connector's connection lives. */
function connectionFile(connectorId) {
  return path.join(connectionsDir(), `${requireConnectorId(connectorId)}.json`);
}

function stateFilePath() {
  return path.join(ensureBaseDir(), 'connect-state.json');
}

/* ------------------------------------------------------------------ *
 * Directories and file modes
 * ------------------------------------------------------------------ */

/**
 * The data directory itself.
 *
 * `fs.mkdirSync(dir, { recursive: true })` returns without complaint when the
 * directory already exists, and it does NOT retroactively apply `mode` to a
 * directory it did not create. So a tree made by an earlier version, or by hand,
 * would stay world-readable while the code claimed 0o700. The chmod below is
 * what makes the claim true; on Windows it is a silent no-op (see the file
 * header) which is why every user-facing message about this says "on POSIX".
 */
function ensureBaseDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* A filesystem without modes (or Windows). Nothing to do. */
  }
  return dir;
}

/**
 * `<dataDir>/connections`, created 0o700.
 *
 * 0o700, not 0o600: a directory needs its execute bit to be entered at all, and
 * a directory with mode 0o600 cannot be opened.
 */
function connectionsDir() {
  const dir = path.join(ensureBaseDir(), 'connections');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows, or a filesystem without modes. Documented, not pretended. */
  }
  return dir;
}

async function chmodQuiet(file, mode) {
  try {
    await fsp.chmod(file, mode);
  } catch {
    /* Windows: accepted and ignored. */
  }
}

/**
 * Write JSON with the file created 0o600 — never world-readable, not even for
 * the instant between creation and a later chmod.
 *
 * The temp file is named `${file}.${pid}.tmp` and left in the same directory,
 * which keeps the atomic rename on one filesystem. The pid suffix is there so a
 * reader that ignores the `.tmp` extension cannot pick up a half-written file
 * from a concurrent writer.
 */
async function writeJsonFile(file, value, { pretty = true } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await chmodQuiet(tmp, 0o600);
    await fsp.rename(tmp, file);
    await chmodQuiet(file, 0o600);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * connect-state.json
 *
 * The file records authorizations that were started and may still be in the
 * browser. It exists so an interrupted attempt surfaces as something the user
 * can see rather than as an invisible half-state, and so a process that died
 * mid-flow does not leave a record forever.
 *
 * NO TOKEN, CODE OR VERIFIER IS EVER WRITTEN HERE. The PKCE verifier and the
 * client secret stay in memory for the life of one call: a verifier on disk is
 * a code-interception window that outlives the process, and it would buy
 * nothing. Losing the state file costs the user nothing either.
 * ------------------------------------------------------------------ */

function stateEntry(connector, { state, redirectUri, challenge }) {
  return {
    connectorId: connector.id,
    label: connector.label,
    state,
    redirectUri,
    challenge,
    startedAt: Date.now(),
  };
}

/**
 * Forget attempts that are past their window. Called on both read and write, so
 * an abandoned authorization ages out whether or not anything new starts.
 */
function pruneState(entries) {
  const now = Date.now();
  const live = (Array.isArray(entries) ? entries : []).filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.startedAt === 'number' &&
      now - entry.startedAt < MAX_STATE_AGE_MS
  );
  return live.slice(-MAX_STATE_ENTRIES);
}

async function writeState(entries) {
  await writeJsonFile(stateFilePath(), { updatedAt: Date.now(), attempts: pruneState(entries) });
}

/** Record the start of an authorization attempt. */
async function noteAttempt(entry) {
  const stored = await readJsonFile(stateFilePath(), null);
  const attempts = stored && Array.isArray(stored.attempts) ? stored.attempts : [];
  attempts.push(entry);
  await writeState(attempts);
  return entry;
}

/** Forget an attempt, whatever the outcome. Never throws: this is bookkeeping. */
async function clearAttempt(state) {
  try {
    const stored = await readJsonFile(stateFilePath(), null);
    const attempts = stored && Array.isArray(stored.attempts) ? stored.attempts : [];
    const kept = pruneState(attempts).filter((entry) => entry && entry.state !== state);
    if (kept.length === attempts.length) return;
    await writeState(kept);
  } catch {
    /* A state file that cannot be written must not fail the authorization. */
  }
}

/* ------------------------------------------------------------------ *
 * PKCE (RFC 7636)
 * ------------------------------------------------------------------ */

/**
 * RFC 7636 section 4.1 says the verifier needs at least 256 bits of entropy.
 * 32 random bytes is exactly that, and 43 base64url characters is exactly the
 * minimum length the spec allows, so there is no padding to strip.
 *
 * PKCE is not optional here. A desktop app is a public client: its client
 * secret ships to every user, so any flow without PKCE can be finished by
 * anyone who observes the redirect. The challenge is what makes the code
 * useless to an interceptor, and it is sent on every exchange.
 */
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: challengeFor(verifier) };
}

/** S256: base64url(SHA-256(ASCII(verifier))), with no padding. */
function challengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(String(verifier), 'ascii').digest());
}

/** 128 bits. Unguessable, and compared in full — see the callback handler. */
function createState() {
  return base64url(crypto.randomBytes(16));
}

/* ------------------------------------------------------------------ *
 * The authorization URL
 * ------------------------------------------------------------------ */

/**
 * Assemble the default authorize URL.
 *
 * `redirect_uri` is built from the port the listener actually has, not from a
 * number the user had to configure. A registered `http://127.0.0.1` client can
 * use any port (RFC 8252 section 7.3), which is the whole reason an ephemeral
 * port is usable here — and it means a missing port in the descriptor is not a
 * missing setting.
 */
function buildAuthUrl(connector, state, challenge, redirectUri) {
  const authUrl = assertHttpUrl(connector.authUrl, 'authUrl');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', text(connector.clientId));
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const scopes = Array.isArray(connector.scopes) ? connector.scopes.map(text).filter(Boolean) : [];
  /* Joined literally, then encoded as one query value. There is deliberately no
   * "turn the separator into a space" behaviour: a '+' in a query string is sent
   * as %2B and means a plus sign, so a provider wanting space-separated scopes
   * must be given a literal space. See the descriptor documentation above. */
  const separator = typeof connector.scopeSeparator === 'string' ? connector.scopeSeparator : ' ';
  if (scopes.length) authUrl.searchParams.set('scope', scopes.join(separator));

  for (const [key, value] of Object.entries(connector.extraAuthParams || {})) {
    if (key === 'undefined') continue;
    /* `searchParams.set` stringifies anything, so an object would be sent as
     * "[object Object]" and an array as "a,b" without anyone noticing. Values
     * that are not a string or a finite number are dropped loudly instead. */
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      authUrl.searchParams.set(key, String(value));
    } else if (value !== undefined && value !== null) {
      throw new Error(
        `extraAuthParams.${key} must be a string or a number — it is copied into the authorize URL verbatim`
      );
    }
  }

  /* The escape hatch comes last, and it is handed the URL that has already been
   * assembled. A connector that only needs to tweak one parameter can mutate
   * ctx.url and keep every guarantee below intact, rather than rebuilding the
   * PKCE and state parameters itself and getting one of them wrong. */
  if (typeof connector.buildAuthorizeUrl === 'function') {
    const ctx = { url: authUrl, state, challenge, redirectUri };
    const built = connector.buildAuthorizeUrl(ctx);
    if (typeof built === 'string' || built instanceof URL) return assertHttpUrl(built, 'buildAuthorizeUrl');
    if (ctx.url) return assertHttpUrl(ctx.url, 'buildAuthorizeUrl');
  }
  return authUrl;
}

/* ------------------------------------------------------------------ *
 * The loopback listener (RFC 8252 section 7.3)
 * ------------------------------------------------------------------ */

/** A one-line HTML answer, so the browser tab does not look broken. */
function callbackPage(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; line-height: 1.5">
<h1 style="font-size: 1.25rem">${title}</h1>
<p>${message}</p>
</body></html>`;
}

function sendPage(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': bytes(body),
      'cache-control': 'no-store',
      connection: 'close',
    });
    res.end(body);
  } catch {
    /* The browser may already be gone. The authorization still stands. */
  }
}

/**
 * Listen on the loopback interface for exactly one callback.
 *
 * 127.0.0.1 and not 0.0.0.0: binding the wildcard would expose an authorization
 * code — and the response to it — to every machine on the network, which is the
 * failure RFC 8252 exists to prevent.
 *
 * A favicon request (wrong path), a stray request from another page (wrong
 * path) or anything with an Origin header (a browser cross-origin request, which
 * can never be the provider's redirect) is answered and ignored; only the
 * matching callback settles the promise, and the listener closes either way.
 */
function startLoopbackListener({ port, expectedPath, shouldStop }) {
  return new Promise((resolve) => {
    const server = http.createServer();

    /* Two promises, deliberately.
     *
     * The outer one answers when the socket is up (or when it cannot be), and
     * carries a `callback` promise that answers when the browser arrives. The
     * caller races the callback against its own timeout, so it needs both facts
     * separately: "listening on this port" and "the provider answered". Folding
     * them into one promise is how a redirect URI gets handed out before there is
     * a socket behind it. */
    let releaseCallback = null;
    const callback = new Promise((settleCallback) => {
      releaseCallback = settleCallback;
    });

    const fail = (err) => {
      resolve({ kind: 'error', callback, ...err });
    };

    server.on('request', (req, res) => {
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return sendPage(res, 400, callbackPage('Bad request', 'Klaud could not read that callback URL.'));
      }

      if (req.headers.origin) {
        return sendPage(
          res,
          403,
          callbackPage('Request ignored', 'This address only accepts the redirect from the provider.')
        );
      }

      if (req.method !== 'GET' || url.pathname !== expectedPath) {
        return sendPage(res, 404, callbackPage('Not found', 'Nothing to see here.'));
      }

      const read = (key) => {
        const value = url.searchParams.get(key);
        return value === null ? null : value;
      };
      const host = String(req.headers.host || '').toLowerCase();
      const hostname = host.startsWith('[')
        ? host.slice(0, host.indexOf(']') + 1)
        : host.split(':')[0];
      if (!HANDLED_HOSTS.has(hostname)) {
        // The code is in the URL; a Host the provider does not use means this
        // is not the provider's redirect, so it is not read at all.
        return sendPage(
          res,
          403,
          callbackPage('Request ignored', 'That callback arrived with an unexpected Host header.')
        );
      }

      const params = {
        code: read('code'),
        error: read('error'),
        errorDescription: read('error_description'),
        state: read('state'),
      };
      // The page is sent before the promise settles: some browsers show a
      // connection error if the socket closes with the response still queued.
      sendPage(
        res,
        200,
        callbackPage(
          params.error ? 'Authorization was not completed' : 'Klaud is connected',
          params.error
            ? 'You can close this tab and return to Klaud for the details.'
            : 'You can close this tab and return to Klaud.'
        )
      );
      releaseCallback({ kind: 'callback', params });
    });

    server.on('error', (err) => {
      fail({
        error:
          err && err.code === 'EADDRINUSE'
            ? `Port ${port === 0 ? '' : port} is already in use on 127.0.0.1, so Klaud cannot receive the OAuth callback there.`
            : `Could not listen on 127.0.0.1: ${(err && err.message) || String(err)}`,
        hint:
          'Pick a free port for the redirect, or let Klaud choose one: omit redirectPort and the listener takes an ephemeral port, which a provider registered at http://127.0.0.1 accepts.',
      });
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const redirectUri = `http://127.0.0.1:${actualPort}${expectedPath}`;

      if (shouldStop && shouldStop()) {
        releaseCallback({ kind: 'cancelled' });
        return resolve({ kind: 'cancelled' });
      }

      /* The timeout lives in the caller, not here. Two timers for one deadline
       * would mean two places that can settle the flow, and the loser of that
       * race is a socket nobody closed. One deadline, one owner. */
      resolve({
        kind: 'listen',
        redirectUri,
        port: actualPort,
        callback,
        /**
         * Stop listening, and resolve only once the socket is actually gone.
         *
         * `server.close()` is asynchronous: it stops accepting immediately but
         * fires its callback (and releases the port) later. Resolving the
         * authorization before that callback would mean the caller is told it is
         * finished while the port is still bound — which is how a reconnect
         * fails with EADDRINUSE for a second or two, and how a test that checks
         * the port is free gets a false pass or a false failure.
         *
         * Idempotent, and safe to call before the socket ever opens.
         */
        close: () =>
          new Promise((settle) => {
            try {
              server.close(() => settle());
            } catch {
              return settle(); // never listening, or already closed
            }
            /* Waiters must not be held open by a browser that is keeping the
             * callback connection alive; the response has already been sent by
             * the time this is called. */
            try {
              server.closeAllConnections?.();
            } catch {
              /* Node without that helper */
            }
            /* A close callback can be missed in edge cases. Never block the flow
             * on it. */
            const guard = setTimeout(settle, 1_000);
            guard.unref?.();
          }),
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Token endpoint
 * ------------------------------------------------------------------ */

/** Errors from the token endpoint carry whether another attempt could help. */
function tokenError(message, hint, { retryable = false, needsReconnect = false } = {}) {
  return { ok: false, error: message, hint, retryable, needsReconnect };
}

/**
 * Read one field out of a token response body.
 *
 * The body is not trusted to be JSON, or an object, or to use the expected key
 * spelling: providers have shipped all three variants, and a 200 with an HTML
 * login page is the classic "your app is not published yet" answer from Google.
 */
function pickField(body, ...names) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  for (const name of names) {
    const value = body[name];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** `expires_in` is a duration and is useless on disk; store the absolute time. */
function expiresAtFrom(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Date.now() + Math.round(seconds * 1000);
}

/**
 * An actionable hint for a token endpoint rejection.
 *
 * Written the way a person would say it out loud, because this text lands in a
 * terminal or a transcript next to a stack of tool output, and "error: 400"
 * gives them nothing to do next.
 */
function describeTokenError(status, providerError, providerDescription) {
  const said = firstLine(providerDescription);
  switch (providerError) {
    case 'invalid_grant':
      return tokenError(
        'The provider rejected the authorization code or refresh token' + (said ? `: ${said}` : ' (invalid_grant).'),
        'The code may have expired (they are usually valid for under a minute) or already been used, or the refresh token may have been revoked or expired. Run the connection again to get a fresh one.',
        { needsReconnect: true }
      );
    case 'invalid_client':
      return tokenError(
        `The provider did not accept this OAuth client${said ? `: ${said}` : ' (invalid_client).'}`,
        'Check the client ID and secret against the values in your provider app registration. For Google, a "Desktop app" client needs no secret; a "Web application" client rejects a loopback redirect, so register a Desktop app one instead.',
        { needsReconnect: true }
      );
    case 'redirect_uri_mismatch':
      return tokenError(
        `The provider rejected the redirect URI${said ? `: ${said}` : '.'}`,
        'The redirect in the provider registration must allow http://127.0.0.1 with any port. For Google, use a "Desktop app" client: it accepts the loopback redirect Klaud sends automatically.',
        { needsReconnect: true }
      );
    case 'unsupported_grant_type':
      return tokenError(
        `The provider does not accept this exchange${said ? `: ${said}` : ' (unsupported_grant_type).'}`,
        'The token URL may belong to a different provider than the authorize URL, or the provider needs a different flow. Check authUrl and tokenUrl in the connector.'
      );
    case 'invalid_scope':
      return tokenError(
        `The provider rejected the requested scopes${said ? `: ${said}` : ' (invalid_scope).'}`,
        'Remove a scope the provider does not offer, or enable the corresponding API in the provider console. An API that is not enabled for the project answers 403 or invalid_scope rather than an empty result.'
      );
    default:
      break;
  }

  if (status === 401 || status === 403) {
    return tokenError(
      `The token endpoint refused the request (HTTP ${status})${said ? `: ${said}` : '.'}`,
      'The client credentials were not accepted. Re-check the client ID and secret, and make sure the OAuth client belongs to the same provider project as the enabled APIs.',
      { needsReconnect: true }
    );
  }
  if (status === 429) {
    return tokenError(
      `The token endpoint is rate limiting Klaud (HTTP 429)${said ? `: ${said}` : '.'}`,
      'This is temporary. Wait a minute and try the connection again.',
      { retryable: true }
    );
  }
  if (status >= 500) {
    return tokenError(
      `The provider answered HTTP ${status}${said ? `: ${said}` : ' with no explanation.'}`,
      'That is a provider-side failure, not a problem with your setup. Try again in a moment.',
      { retryable: true }
    );
  }
  return tokenError(
    `The token endpoint answered HTTP ${status}${said ? `: ${said}` : '.'}`,
    'This was not a recognised OAuth error. The provider\'s own words are above; if they are not enough, check the token URL in the connector.',
    { retryable: status >= 500 }
  );
}

/**
 * Turn a token response into the record that goes on disk.
 *
 * `expires_in` arrives as a number of seconds and is converted to an absolute
 * epoch-millisecond `expires_at` HERE, at exchange time. A duration on disk is
 * wrong the moment the process restarts: "expires in 3600 seconds" written at
 * 09:00 still reads as an hour away at midnight.
 */
function buildTokens(connector, body, previous = null) {
  const accessToken = pickField(body, 'access_token', 'accessToken');
  if (!accessToken) {
    return tokenError(
      'The provider answered without an access token.',
      `The response was: ${firstLine(JSON.stringify(body ?? null), 300)}. If that is an HTML page, the OAuth client is probably not fully configured or the consent screen is not published, so the provider showed a login page instead of a token.`
    );
  }

  const obtainedAt = Date.now();
  const expiresAt = expiresAtFrom(pickField(body, 'expires_in', 'expiresIn'));
  const scope = pickField(body, 'scope');

  /* A refresh response often omits the refresh token. Losing the previous one
   * there would silently downgrade the connection to "reconnect every hour", so
   * it is carried forward. Same for an expiry the provider did not restate. */
  const refreshToken = pickField(body, 'refresh_token', 'refreshToken');
  const previousExpiry = previous && Number.isFinite(previous.expires_at) ? previous.expires_at : null;

  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken || (previous && previous.refresh_token) || '',
      expires_at: expiresAt === null ? previousExpiry : expiresAt,
      // A provider that omits `scope` has not narrowed anything; keeping the
      // requested list beats recording an empty one.
      scope: scope || (previous && previous.scope) || (Array.isArray(connector.scopes) ? connector.scopes.join(' ') : ''),
      token_type: pickField(body, 'token_type', 'tokenType') || 'Bearer',
      obtained_at: obtainedAt,
    },
  };
}

/**
 * POST to the token endpoint.
 *
 * No dependency, so this is the whole client: form-encoded body, `Accept:
 * application/json`, and a hard timeout so a hung provider cannot wedge a turn.
 * Client credentials go in the body unless `tokenAuthStyle` says `basic` — in
 * the body is what RFC 6749 section 3.2.1 documents for a public client with
 * PKCE, and Google accepts it. Keep it identical between the exchange and every
 * refresh: a provider that accepts a secret one way and not the other would
 * produce a connection that works once and then fails an hour later.
 */
async function postTokenRequest(connector, params, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let tokenUrl;
  try {
    tokenUrl = assertHttpUrl(connector.tokenUrl, 'tokenUrl');
  } catch (err) {
    return tokenError(err.message, 'Set tokenUrl in the connector to the provider\'s token endpoint.');
  }

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') form.set(key, String(value));
  }
  if (connector.clientId) form.set('client_id', text(connector.clientId));

  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (connector.clientSecret) {
    if (connector.tokenAuthStyle === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${text(connector.clientId)}:${text(connector.clientSecret)}`).toString('base64')}`;
    } else {
      form.set('client_secret', text(connector.clientSecret));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: controller.signal,
      redirect: 'error',
    });
    const raw = await res.text();

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }

    if (!res.ok) {
      const said = body && typeof body === 'object' ? firstLine(pickField(body, 'error_description', 'error_message', 'message')) : '';
      return describeTokenError(res.status, pickField(body, 'error'), said || firstLine(raw, 300));
    }
    if (!body) {
      return tokenError(
        `The token endpoint answered HTTP ${res.status} with something that is not JSON.`,
        `What came back: ${firstLine(raw, 300)}. A provider that redirects to a login page usually means the OAuth client is misconfigured or the account has not accepted the API terms.`
      );
    }
    return { ok: true, body };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return tokenError(
        `The token endpoint did not answer within ${Math.round(TOKEN_REQUEST_TIMEOUT_MS / 1000)} seconds.`,
        'Check the network connection, then try again.',
        { retryable: true }
      );
    }
    return tokenError(
      `Could not reach the token endpoint: ${(err && err.message) || String(err)}`,
      'Check tokenUrl in the connector and the network connection. A proxy that intercepts TLS shows up here as a certificate error.',
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Opening the browser
 * ------------------------------------------------------------------ */

/**
 * Open the user's browser at `url`.
 *
 * `start` on Windows goes through `cmd /c` with an empty title argument: `start`
 * takes the first quoted argument as the window title, so `start "https://..."
 * would try to run a program named after the URL. `windowsHide` is left off on
 * purpose — the new console flash is how the user knows something happened, and
 * hiding it is how "nothing opened" reports get filed.
 *
 * A failure here is not fatal. The caller is handed the URL, and the usual
 * failure is a headless or remote session where the only way in is to paste it.
 */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
    return true;
  } catch {
    /* spawn itself threw, which means no command was started. */
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * startAuthorization
 * ------------------------------------------------------------------ */

/**
 * Run the whole authorization-code + PKCE flow and store the result.
 *
 * Resolves to `{ ok: true, tokens, authorizeUrl, redirectUri }`, or to
 * `{ ok: false, error, hint, authorizeUrl, needsReconnect }`. It never rejects,
 * because every failure here is something the user has to be told about: a
 * rejected promise with a message is how that information gets lost.
 *
 * The one-shot listener is closed on EVERY path — success, provider error, state
 * mismatch, exchange failure, timeout, cancellation — because a loopback port
 * left listening is an open door on the user's machine. Nothing here is allowed
 * to settle the promise before that close.
 *
 * @param {object}   options.connector      the descriptor (see the file header)
 * @param {number}   [options.redirectPort] loopback port; omit for an ephemeral
 *                                          one, which is read back and used in
 *                                          the redirect URI
 * @param {AbortSignal} [options.signal]    cancel the flow
 * @param {(message: string) => void} [options.onStatus]  progress strings
 * @param {number}   [options.timeoutMs]    default 5 minutes
 * @param {boolean}  [options.launchBrowser] false skips launching one and just
 *                                          reports the URL, for a headless host
 *                                          or a caller that shows it itself
 * @param {Function} [options.fetch]        test seam; defaults to global fetch
 */
async function startAuthorization({
  connector,
  redirectPort,
  signal,
  onStatus,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  launchBrowser = true,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const say = typeof onStatus === 'function' ? onStatus : () => {};
  const status = (message) => {
    try {
      say(message);
    } catch {
      /* A reporter that throws must not take the authorization with it. */
    }
  };

  const { id, label } = requireConnector(connector);

  /* ---- the setup cost is the user's, and saying so is the point ---- */
  // Klaud cannot ship an OAuth client. A client secret in a public repository is
  // not a secret, and each user's consent screen, quotas and audit trail are
  // their own. So a missing client ID is a configuration error, reported with
  // the place to fix it, and NOT a browser tab opened onto a provider error page
  // that says "invalid client" and names nothing.
  if (!text(connector.clientId).trim()) {
    return {
      ok: false,
      error: `${label} has no OAuth client ID, so Klaud cannot start the sign-in.`,
      hint:
        `Register a desktop OAuth client with ${label} yourself — Klaud cannot ship one, because a client secret ` +
        `published in a repository is not a secret, and the consent screen has to belong to you. For Google: ` +
        `open console.cloud.google.com, then APIs and Services, then Credentials, then Create credentials, then ` +
        `OAuth client ID, and choose Desktop app. Paste the client ID into the connector (and the client secret ` +
        `too, if the provider issues one).`,
      needsReconnect: false,
    };
  }
  if (
    connector.tokenAuthStyle === 'basic' &&
    !text(connector.clientSecret).trim()
  ) {
    // Sending `Basic base64("id:")` is a malformed request in most
    // implementations, so this is worth catching before the round trip.
    return {
      ok: false,
      error: `${label} is configured to send its client credentials as HTTP Basic auth but has no client secret.`,
      hint: 'Either add the client secret to the connector, or drop tokenAuthStyle so the public-client body style is used.',
      needsReconnect: false,
    };
  }

  const port = Number.isFinite(redirectPort) && redirectPort !== null && redirectPort !== undefined
    ? Number(redirectPort)
    : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return {
      ok: false,
      error: `redirectPort must be a whole number from 0 to 65535; got ${JSON.stringify(redirectPort)}.`,
      hint: 'Omit redirectPort entirely and Klaud picks a free ephemeral port, then uses it in the redirect URI.',
      needsReconnect: false,
    };
  }

  if (signal && signal.aborted) {
    return {
      ok: false,
      error: 'The authorization was cancelled before it started.',
      hint: 'Run the connection again when you are ready.',
      needsReconnect: false,
    };
  }

  // A fixed path, so a provider honouring a registered redirect URI with a path
  // still lands somewhere Klaud is listening.
  const callbackPath = '/oauth/callback';
  let pkce;
  let state;
  let listener;
  let timeoutTimer = null;
  let finished = false;
  let redirectUri = '';
  let authorizeUrl = '';
  let detachAbort = null;

  /** Stop listening and forget the attempt. Awaited by `finish`. */
  const stopListening = async () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (signal && detachAbort) signal.removeEventListener('abort', detachAbort);
    if (listener && typeof listener.close === 'function') await listener.close();
  };

  /**
   * Close the socket, forget the attempt, hand back one answer.
   *
   * Async, and awaited on every path, because the whole contract of this module
   * is "no listening socket is left behind". Returning before the close is
   * complete would make that a hope rather than a fact — the port would still be
   * bound for a moment after the caller was told the flow had failed.
   * `finished` makes the double-call impossible: only the first caller does the
   * work, and a later one gets the same answer back.
   */
  let settled = null;
  const finish = async (result) => {
    if (settled) return settled;
    settled = result;
    finished = true;
    await stopListening();
    await clearAttempt(state).catch(() => {});
    return result;
  };

  try {
    pkce = createPkce();
    state = createState();
    status(`Preparing the ${label} sign-in...`);

    /* Bind first, then build the redirect URI from the port that actually
     * exists. Doing it the other way round means promising a port the OS may
     * refuse, and it is why the user never has to pick one. */
    listener = await startLoopbackListener({
      port,
      expectedPath: callbackPath,
      shouldStop: () => Boolean(finished || (signal && signal.aborted)),
    });

    if (listener.kind !== 'listen') {
      if (listener.kind === 'cancelled') {
        return await finish({
          ok: false,
          error: 'The authorization was cancelled before the browser opened.',
          hint: 'Run the connection again when you are ready.',
          needsReconnect: false,
        });
      }
      return await finish({
        ok: false,
        error: listener.error,
        hint: listener.hint,
        needsReconnect: false,
      });
    }

    redirectUri = text(connector.redirectUri).trim() || listener.redirectUri;
    {
      /* A caller-supplied redirectUri is only allowed if it is a loopback
       * http:// URL. RFC 8252 section 8.1: a custom scheme can be claimed by any
       * other application on the machine, which is interception by another name. */
      let parsed = null;
      try {
        parsed = new URL(redirectUri);
      } catch {
        parsed = null;
      }
      const host = parsed ? parsed.hostname.toLowerCase() : '';
      if (!parsed || parsed.protocol !== 'http:' || !(host === '127.0.0.1' || host === '::1' || host === 'localhost')) {
        return await finish({
          ok: false,
          error: `The redirect URI ${JSON.stringify(redirectUri)} is not an http loopback address.`,
          hint:
            'Klaud receives the callback on http://127.0.0.1, which is what RFC 8252 requires for a desktop app. ' +
            'A custom URI scheme can be registered by any other program on the machine, so it is refused rather than used.',
          needsReconnect: false,
        });
      }
    }

    let built;
    try {
      built = buildAuthUrl(connector, state, pkce.challenge, redirectUri);
    } catch (err) {
      return await finish({
        ok: false,
        error: err.message,
        hint: 'Check authUrl, scopes and extraAuthParams in the connector descriptor.',
        needsReconnect: false,
      });
    }
    authorizeUrl = built.toString();

    await noteAttempt(stateEntry({ id, label }, { state, redirectUri, challenge: pkce.challenge }))
      .catch(() => { /* bookkeeping only; the flow does not depend on it */ });

    if (signal && signal.aborted) {
      return await finish({
        ok: false,
        error: 'The authorization was cancelled before the browser opened.',
        hint: 'Run the connection again when you are ready.',
        needsReconnect: false,
      });
    }

    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        status('That took longer than expected. Cancelling.');
        resolve({
          kind: 'timeout',
          error: `No answer from the browser within ${Math.round(timeoutMs / 1000)} seconds.`,
          hint:
            'Nothing was stored for this connector. Run the connection again when you are ready to approve in ' +
            'the browser tab, or open the authorize URL by hand if the tab never appeared.',
        });
      }, timeoutMs);
    });

    const abortPromise = new Promise((resolve) => {
      detachAbort = () =>
        resolve({
          kind: 'cancelled',
          error: 'The authorization was cancelled.',
          hint: 'Run the connection again when you are ready.',
        });
      if (signal) signal.addEventListener('abort', detachAbort, { once: true });
    });

    const opened = launchBrowser ? openBrowser(authorizeUrl) : false;
    status(
      opened
        ? `Waiting for you to approve ${label} in the browser...`
        : `Open this URL to approve ${label}: ${authorizeUrl}`
    );

    const outcome = await Promise.race([listener.callback, timeoutPromise, abortPromise]);

    if (outcome.kind !== 'callback') {
      return await finish({
        ok: false,
        error: outcome.error,
        hint: outcome.hint,
        authorizeUrl,
        redirectUri,
        needsReconnect: false,
      });
    }
    status('The provider answered. Checking the request, then swapping the code for a token...');

    /* ---- the provider said no ---- */
    if (outcome.params.error) {
      const said = firstLine(outcome.params.errorDescription);
      // A denial is the provider declining, which is not the same as a broken
      // setup, so the hint separates the two.
      const denied = outcome.params.error === 'access_denied';
      return await finish({
        ok: false,
        error: `The provider refused the authorization request: ${outcome.params.error}${said ? ` — ${said}` : ''}`,
        hint: denied
          ? 'That is the provider saying the request was declined, by you or by a policy on the account (a Workspace admin can block an app, and an unverified app shows a "Klaud is not verified" warning that must be dismissed). Nothing was stored, so nothing is half-connected.'
          : 'The provider\'s own words are above. Nothing was stored for this connector, so there is no half-connected state to clean up.',
        authorizeUrl,
        redirectUri,
        needsReconnect: false,
      });
    }

    /* ---- CSRF: the state check is mandatory and is not skippable ---- */
    /* An authorization response that arrives on the loopback port is not proof
     * that the user started it. Without this comparison, any page on the machine
     * could send a code to this listener and have Klaud bind an attacker's
     * account to the connector — the whole reason `state` exists. It is compared
     * after the error branch: an error response is useful information for the
     * user even when the state does not match, and it never reaches an exchange. */
    if (outcome.params.state !== state) {
      return await finish({
        ok: false,
        error:
          `The OAuth callback arrived with a state value that does not match this authorization ` +
          `(expected ${state}, received ${outcome.params.state === null ? 'nothing' : JSON.stringify(outcome.params.state)}).`,
        hint:
          'The request was refused and no token was exchanged, which is what stops another page on this machine ' +
          'from connecting an account of its choosing. Run the connection again; if it repeats, something else on the ' +
          'machine is racing for the same loopback port.',
        authorizeUrl,
        redirectUri,
        needsReconnect: false,
      });
    }
    if (!outcome.params.code) {
      return await finish({
        ok: false,
        error: 'The provider sent a callback with no authorization code in it.',
        hint: `The callback was: ${outcome.params.state ? 'state only' : 'empty'}. Run the connection again.`,
        authorizeUrl,
        redirectUri,
        needsReconnect: false,
      });
    }

    /* ---- swap the code for tokens ---- */
    status('Exchanging the code for an access token...');
    const exchanged = await postTokenRequest(
      connector,
      {
        grant_type: 'authorization_code',
        code: outcome.params.code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      },
      { fetch: fetchImpl }
    );

    if (!exchanged.ok) {
      return await finish({
        ok: false,
        error: exchanged.error,
        hint: exchanged.hint,
        authorizeUrl,
        redirectUri,
        needsReconnect: exchanged.needsReconnect,
      });
    }

    const shaped = buildTokens(connector, exchanged.body);
    if (!shaped.ok) {
      return await finish({
        ok: false,
        error: shaped.error,
        hint: shaped.hint,
        authorizeUrl,
        redirectUri,
        needsReconnect: false,
      });
    }

    let saved = null;
    let warning = '';
    try {
      saved = await saveConnection(id, {
        label,
        scopes: connector.scopes || [],
        tokens: shaped.tokens,
      });
    } catch (err) {
      // The tokens are in hand but not on disk, so saying "connected" would be a
      // lie the next call discovers. Hand them back anyway: the caller can retry
      // the save, or keep them for this process.
      warning = `The tokens could not be written to disk (${(err && err.message) || String(err)}), so they will not survive a restart.`;
    }

    status(`${label} is connected.`);
    return await finish({
      ok: true,
      tokens: shaped.tokens,
      connection: saved,
      connectorId: id,
      authorizeUrl,
      redirectUri,
      warnings: tokenStorageWarnings(warning),
    });
  } catch (err) {
    return await finish({
      ok: false,
      error: (err && err.message) || String(err),
      hint: 'That is an unexpected failure inside the authorization flow. The listener has been closed and no token was stored.',
      authorizeUrl,
      redirectUri,
      needsReconnect: false,
    });
  }
}

/** The one honest paragraph about where tokens end up, on every success. */
function tokenStorageWarnings(extra = '') {
  const warnings = [
    'Tokens are stored as plain JSON under the Klaud data directory and are not encrypted. There is no keychain integration, because every route to one needs a native dependency and Klaud has none, so the file is only as safe as the folder it sits in.',
    process.platform === 'win32'
      ? 'On Windows the 0600 file mode is not enforced, because NTFS has no POSIX mode bits: the file is readable by any process running as you.'
      : 'The files are created with mode 0600 and the connections directory with 0700.',
    'A refresh token grants durable access to the connected account. Anyone who can read the file, or a backup or synced folder that contains it, has that access until it is revoked in the provider console.',
  ];
  if (extra) warnings.unshift(extra);
  return warnings;
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

/** connectorId -> when the last terminal refresh failure happened. */
const failedRefresh = new Map();

/**
 * Refresh an expired access token.
 *
 * Resolves to `{ ok: true, tokens }` with the new record already persisted, or
 * to `{ ok: false, error, hint, needsReconnect, retryable }`.
 *
 * `needsReconnect: true` means the refresh token is gone or the provider said it
 * cannot be used — only the user can fix that, by running the connection again.
 * It is NOT set for a network blip or a 5xx: those are worth another attempt,
 * and reporting them as "reconnect" would train the user to ignore the message.
 */
async function refreshTokens(connector, tokens, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let id;
  let label;
  try {
    ({ id, label } = requireConnector(connector || {}));
  } catch (err) {
    return tokenError(err.message, 'Pass the connector descriptor whose tokens are being refreshed.', {
      needsReconnect: false,
    });
  }

  const refreshToken = text(tokens && tokens.refresh_token).trim();
  if (!refreshToken) {
    return tokenError(
      `${label} has no refresh token stored, so the access token cannot be renewed.`,
      'That usually means the provider never issued one: Google only returns a refresh token when the authorization is made with access_type=offline and prompt=consent, and only on the first consent for a client. Run the connection again to get one.',
      { needsReconnect: true }
    );
  }

  /* A rejected refresh is terminal until the user acts. Remember it briefly so a
   * caller retrying in a loop gets the same answer without a request per try. */
  const cooldown = failedRefresh.get(id);
  if (cooldown && Date.now() - cooldown.at < FAILED_REFRESH_COOLDOWN_MS) {
    return tokenError(
      `${label} still needs to be reconnected.`,
      'The last refresh was rejected a moment ago, so Klaud is not asking the provider again yet. Reconnect the connector to replace the refresh token.',
      { needsReconnect: true }
    );
  }

  const exchanged = await postTokenRequest(
    connector,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    { fetch: fetchImpl }
  );

  if (!exchanged.ok) {
    if (exchanged.needsReconnect) failedRefresh.set(id, { at: Date.now() });
    else failedRefresh.delete(id);
    return tokenError(exchanged.error, exchanged.hint, {
      needsReconnect: Boolean(exchanged.needsReconnect),
      retryable: Boolean(exchanged.retryable),
    });
  }

  const shaped = buildTokens(connector, exchanged.body, tokens);
  if (!shaped.ok) {
    return tokenError(shaped.error, shaped.hint, { needsReconnect: false });
  }

  failedRefresh.delete(id);
  try {
    await saveConnection(id, { tokens: shaped.tokens });
  } catch (err) {
    return tokenError(
      `The refreshed token could not be written to disk: ${(err && err.message) || String(err)}.`,
      'The provider did refresh it, but a restart will lose the new token and the old one may already be invalid. Check that the Klaud data directory is writable.',
      { retryable: true }
    );
  }
  return { ok: true, tokens: shaped.tokens };
}

/* ------------------------------------------------------------------ *
 * Connections on disk
 * ------------------------------------------------------------------ */

/** All connected accounts, newest first. Corrupt files are skipped, not fatal. */
async function listConnections() {
  let entries;
  try {
    entries = await fsp.readdir(connectionsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(id)) continue;
    const data = await readJsonFile(path.join(connectionsDir(), file), null);
    if (!data || typeof data !== 'object' || !data.tokens) continue;
    out.push(connectionSummary(id, data));
  }
  out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return out;
}

async function loadConnection(connectorId) {
  const id = requireConnectorId(connectorId);
  const data = await readJsonFile(connectionFile(id), null);
  if (!data || typeof data !== 'object' || !data.tokens || typeof data.tokens !== 'object') return null;
  return { ...data, connectorId: id, tokens: normalizeStoredTokens(data.tokens) };
}

/**
 * Write a connection.
 *
 * `tokens` is normalised on the way in, so a duration cannot reach the disk —
 * the one mistake this store exists to prevent. Omitting `tokens` entirely keeps
 * the stored ones, which is how a caller relabels a connection without
 * disturbing its credentials.
 */
async function saveConnection(connectorId, data = {}) {
  const id = requireConnectorId(connectorId);
  /* A write means the credentials are being replaced — a fresh authorization, or
   * a caller supplying new tokens — so a remembered "this refresh was rejected"
   * is stale by definition. Leaving it would make a user who just reconnected
   * wait out the cooldown for a token that is now perfectly good. */
  failedRefresh.delete(id);
  const hasTokens = data.tokens && typeof data.tokens === 'object';
  const existing = hasTokens ? null : await loadConnection(id);
  const tokens = normalizeStoredTokens(hasTokens ? data.tokens : existing ? existing.tokens : {});
  if (!tokens.access_token) {
    throw new Error(`refusing to save a ${id} connection with no access token`);
  }
  const record = {
    connectorId: id,
    label: text(data.label || (existing && existing.label) || id),
    scopes: Array.isArray(data.scopes)
      ? data.scopes
      : (existing && existing.scopes) || [],
    connected_at: (existing && existing.connected_at) || Date.now(),
    updated_at: Date.now(),
    tokens,
  };
  await writeJsonFile(connectionFile(id), record);
  return record;
}

/**
 * Remove a connection. Safe to call twice, and safe to call for a connector that
 * was never connected: "it is not there" is the outcome the caller wanted.
 * Returns whether a file was actually removed, which is what the UI reports.
 */
async function deleteConnection(connectorId) {
  const id = requireConnectorId(connectorId);
  failedRefresh.delete(id);
  try {
    await fsp.unlink(connectionFile(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring a token record into the documented shape.
 *
 * `expires_in` is a duration and is NOT converted here, because a duration has
 * no reference point: the absolute time is already computed at exchange time, by
 * `buildTokens`, which is the only place that knows when the exchange happened.
 * A duration arriving here therefore became an unknown expiry, and unknown means
 * "refresh before use" rather than "valid forever".
 *
 * That asymmetry is deliberate. Converting a duration against the wrong
 * reference point — the moment the token was first stored, say — can produce an
 * expiry an hour or a day out from the truth, and a token believed valid is
 * worse than a token re-fetched needlessly. The record's `expires_in` and
 * `obtained_at` are read for one purpose only: recovering an absolute time from
 * a file written by an older version that kept them together.
 */
function normalizeStoredTokens(raw) {
  const tokens = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let expiresAt = Number.isFinite(tokens.expires_at) ? Number(tokens.expires_at) : null;
  if (expiresAt === null && Number.isFinite(tokens.obtained_at) && Number.isFinite(tokens.expires_in)) {
    expiresAt = Number(tokens.obtained_at) + Number(tokens.expires_in) * 1000;
  }
  return {
    access_token: text(tokens.access_token),
    refresh_token: text(tokens.refresh_token),
    expires_at: expiresAt,
    scope: text(tokens.scope),
    token_type: text(tokens.token_type) || 'Bearer',
    /* Only ever stamped with the truth that exists: an exchange or a refresh
     * sets this to the moment it happened, and this function is told that by
     * receiving a record that already carries it. */
    obtained_at: Number.isFinite(tokens.obtained_at) ? Number(tokens.obtained_at) : Date.now(),
  };
}

/** The shape `listConnections` reports — no token material at all. */
function connectionSummary(id, data) {
  const tokens = normalizeStoredTokens(data.tokens);
  return {
    connectorId: id,
    label: text(data.label || id),
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    connected_at: data.connected_at || null,
    updated_at: data.updated_at || null,
    expires_at: tokens.expires_at,
    has_refresh_token: Boolean(tokens.refresh_token),
  };
}

/* ------------------------------------------------------------------ *
 * accessTokenFor
 * ------------------------------------------------------------------ */

/** Null expiry means unknown, and unknown is refreshed rather than trusted. */
function isExpired(expiresAt) {
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - Date.now() <= EXPIRY_SLACK_MS;
}

/**
 * A usable access token, refreshed first if it is expired or about to be.
 *
 * `{ ok: true, token, connection, refreshed }`, or
 * `{ ok: false, error, hint, needsReconnect }`. Nothing that reads mail should
 * have to know what a refresh token is.
 */
async function accessTokenFor(connectorId, { connector = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  let id;
  try {
    id = requireConnectorId(connectorId);
  } catch (err) {
    return { ok: false, error: err.message, hint: 'Pass the connector id used for the connection.', needsReconnect: false };
  }

  const stored = await loadConnection(id);
  if (!stored) {
    return {
      ok: false,
      error: `No ${id} connection is stored.`,
      hint: `Nothing has been connected under that id yet, or the connection file is unreadable. Run the ${id} connection first.`,
      needsReconnect: true,
    };
  }

  const tokens = stored.tokens;
  if (!tokens.access_token) {
    return {
      ok: false,
      error: `The stored ${id} connection has no access token.`,
      hint: 'The file exists but carries no usable token. Reconnect the connector.',
      needsReconnect: true,
    };
  }

  if (!isExpired(tokens.expires_at)) {
    return { ok: true, token: tokens.access_token, connection: stored, refreshed: false };
  }

  // Refreshing needs the descriptor: tokenUrl, clientId and the secret all come
  // from it and none of them are stored with the tokens. Requiring it here is
  // deliberate — the alternative is caching a copy of the credentials on disk.
  if (!connector) {
    return {
      ok: false,
      error: `The ${id} access token has expired and no connector descriptor was supplied to refresh it.`,
      hint: 'Pass the connector to accessTokenFor so Klaud can refresh the token, or reconnect the account.',
      needsReconnect: false,
    };
  }

  const connectorIdOfDescriptor = text(connector.id || id);
  if (connectorIdOfDescriptor !== id) {
    return {
      ok: false,
      error: `The descriptor is for "${connectorIdOfDescriptor}" but the connection is "${id}".`,
      hint: 'A refresh would be sent with the wrong client credentials and the wrong token URL. Pass the matching connector.',
      needsReconnect: false,
    };
  }

  const refreshed = await refreshTokens(connector, tokens, { fetch: fetchImpl });
  if (!refreshed.ok) {
    return {
      ok: false,
      error: refreshed.error,
      hint: refreshed.hint,
      needsReconnect: Boolean(refreshed.needsReconnect),
      retryable: Boolean(refreshed.retryable),
    };
  }

  const updated = await loadConnection(id);
  return { ok: true, token: refreshed.tokens.access_token, connection: updated, refreshed: true };
}

/* ------------------------------------------------------------------ *
 * Test seam
 *
 * The suite has to reach the same code the flow runs — deriving the PKCE
 * challenge and assembling the authorize URL twice, once in the module and once
 * in the test, would prove only that two implementations agree with themselves.
 * Namespaced under `__internals` so it is obvious nothing in the public
 * interface depends on it.
 * ------------------------------------------------------------------ */

const __internals = {
  DEFAULT_TIMEOUT_MS,
  EXPIRY_SLACK_MS,
  MAX_STATE_AGE_MS,
  HANDLED_HOSTS,
  createPkce,
  challengeFor,
  createState,
  buildAuthUrl,
  isExpired,
  openBrowser,
  expiresAtFrom,
  normalizeStoredTokens,
  connectionFile,
  connectionsDir,
  ensureBaseDir,
  stateFilePath,
  readState: async () => readJsonFile(stateFilePath(), null),
  /** Forget in-memory refresh cooldowns so one test cannot affect the next. */
  resetState: () => failedRefresh.clear(),
};

module.exports = {
  startAuthorization,
  refreshTokens,
  loadConnection,
  saveConnection,
  deleteConnection,
  listConnections,
  accessTokenFor,
  __internals,
};
