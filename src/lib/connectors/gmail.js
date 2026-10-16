'use strict';

/**
 * Gmail connector.
 *
 * ## Who makes the HTTP request
 *
 * Nothing in this file calls `fetch`, reads a token or retries a request. Every
 * network call goes through `ctx.callApi(descriptor, { method, path, query,
 * body, permission })` and the OAuth framework in `src/lib/oauth.js` owns
 * attaching the bearer token, refreshing an expired one and retrying. That split
 * is deliberate and permanent: a second code path that reads the token here
 * would bypass the refresh and the permission gate, and would then be the only
 * path that is wrong when the framework changes. If Gmail calls start failing
 * with 401s, fix the framework — do not add a token read to this module.
 *
 * ## Permissions
 *
 * `read` only reads, `write` changes the user's own mailbox and can be undone,
 * and `send` puts mail into someone else's inbox where it cannot be recalled.
 * Gmail is the reason `send` exists as a separate level: `gmail_modify` can be
 * reverted, `gmail_send` cannot.
 *
 * ## Every API detail here was checked against Google's own reference
 *
 *   - endpoint paths, parameters: https://developers.google.com/workspace/gmail/api/reference/rest
 *   - scopes per method:         https://developers.google.com/workspace/gmail/api/auth/scopes
 *   - Message / MessagePart / MessagePartBody field names and the statement
 *     that part data is a *base64url* encoded string:
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments
 *   - OAuth endpoints: https://developers.google.com/identity/protocols/oauth2/web-server
 *   - error `reason` values: https://developers.google.com/workspace/gmail/api/guides/handle-errors
 */

const { TextDecoder } = require('util');

/* ------------------------------------------------------------------ *
 * Descriptor
 * ------------------------------------------------------------------ */

/**
 * Minimum scopes, and why each one is present.
 *
 * The full-access scope `https://mail.google.com/` is deliberately absent, and
 * so are `gmail.modify` and `gmail.compose` — both of which can also send mail.
 * The consent screen lists every scope a user is asked to grant, so a wider
 * scope here is a scarier prompt in exchange for no capability we use.
 *
 * Google's per-method scope lists back each choice:
 *   users.messages.list, users.messages.get, users.labels.list ->
 *     gmail.readonly is listed as sufficient.
 *   users.messages.send -> gmail.send is listed and is the narrowest option.
 *   users.messages.modify -> gmail.modify is the narrowest option; there is no
 *     label-only write scope, and gmail.labels does not cover message modify.
 *
 * `gmail.metadata` is also rejected: it is narrower than the above but cannot be
 * used with the `q` search parameter this connector relies on.
 */
const scopes = [
  // gmail_search, gmail_read, gmail_labels
  'https://www.googleapis.com/auth/gmail.readonly',
  // gmail_send
  'https://www.googleapis.com/auth/gmail.send',
  // gmail_modify
  'https://www.googleapis.com/auth/gmail.modify',
];

const descriptor = {
  id: 'gmail',
  label: 'Gmail',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  // The token host changed from accounts.google.com to oauth2.googleapis.com;
  // the current web-server flow doc names this one.
  tokenUrl: 'https://oauth2.googleapis.com/token',
  /*
   * The API root every action's `path` is appended to. Not part of the
   * descriptor shape in the connector brief, but required in practice: the
   * framework's request builder resolves a base URL from the descriptor (or from
   * a registry `apiBaseUrlFor(id)`, which the registry does not implement) and
   * refuses to build a request without one. Without this field every Gmail call
   * fails with "Gmail declares no baseUrl" before any HTTP happens.
   *
   * This is the host in the reference's own request URLs —
   * `GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages` — so the
   * paths below stay host-free and readable.
   */
  baseUrl: 'https://gmail.googleapis.com/gmail/v1',
  scopes,
  // Google takes the scope list space-delimited in one `scope` parameter.
  scopeSeparator: ' ',
  /*
   * `access_type=offline` is what makes Google return a refresh token at all.
   * `prompt=consent` is needed alongside it because Google only issues a refresh
   * token on the *first* consent for a client; without the forced prompt, a user
   * who reconnects the account gets an access token and no refresh token, and
   * the connection then dies silently about an hour later. The cost is that the
   * user sees the consent screen on every reconnect, which is a fair trade for a
   * connection that keeps working.
   */
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  setupHint:
    'Gmail needs your own OAuth client — Klaud cannot ship one, and Google would not ' +
    'let an app pass its verification review on your behalf.\n' +
    '\n' +
    '1. Create a project at https://console.cloud.google.com/ and enable the Gmail API ' +
    'under "APIs & Services" > "Library".\n' +
    '2. Under "APIs & Services" > "Credentials", create an OAuth client ID of type ' +
    '"Web application" (or "Desktop app"), then copy the client ID and client secret here.\n' +
    '3. Add the loopback redirect URI shown in this dialog to that client\'s authorised ' +
    'redirect URIs. It must match character for character, including the port — Google ' +
    'answers "redirect_uri_mismatch" otherwise.\n' +
    '4. Leave the app in "Testing" and add your own Google account under "OAuth consent ' +
    'screen" > "Test users". An app in Testing expires its refresh tokens after 7 days; ' +
    'publishing it (verification is not required for personal use) removes that.\n' +
    '\n' +
    'Google will warn that the app is unverified, and offer "Advanced" > "Go to ... ' +
    '(unsafe)". That warning is expected: it appears for any personal OAuth client for ' +
    'these scopes and it is not a Klaud bug. If you do not want to keep clicking through ' +
    'it, either publish the app or complete Google\'s verification review.',
  /*
   * Credentials are not stored here. The framework reads clientId/clientSecret
   * from settings at call time and merges them into the descriptor, so a
   * descriptor held in memory never carries a secret.
   */
  clientId: undefined,
  clientSecret: undefined,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function toText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Decode Gmail's base64url.
 *
 * The reference is explicit that part bodies are base64url, and it is also
 * explicit that padding is not guaranteed — `Buffer.from(s, 'base64')` tolerates
 * both `-`/`_` and a missing pad, but accepting the URL-safe alphabet by hand
 * means a future Node change to the lenient path cannot silently corrupt a body.
 */
function decodeBase64Url(input) {
  const raw = toText(input);
  if (!raw) return '';
  const normalised = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** Locate a header case-insensitively — Gmail's casing is not guaranteed. */
function headerValue(payload, name) {
  const wanted = name.toLowerCase();
  for (const header of (payload && Array.isArray(payload.headers) && payload.headers) || []) {
    if (header && String(header.name || '').toLowerCase() === wanted) {
      return toText(header.value);
    }
  }
  return '';
}

/** Strip HTML down to readable text. Not a renderer — a fallback. */
function stripHtml(html) {
  return toText(html)
    // `<\/style\s*>` rather than a backreference: real mail carries
    // `<script src="...">` and `<style type="text/css">`, and a strict
    // backreference silently fails to strip those, dumping CSS and JavaScript
    // into the body the model reads.
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode an RFC 2047 encoded-word, e.g. `=?UTF-8?B?...?=`. */
function decodeEncodedWords(value) {
  const text = toText(value);
  if (!/=\?/.test(text)) return text;
  return text.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset, encoding, data) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          // Encoded words that are not base64url still decode with the base64
          // path, so this is the same helper.
          return decodeBase64Url(data);
        }
        // Q encoding: `_` is a space, and `=XX` is a byte.
        const bytes = [];
        const source = data.replace(/_/g, ' ');
        for (let i = 0; i < source.length; i++) {
          if (source[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
            bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(source.charCodeAt(i));
          }
        }
        return new TextDecoder(charset || 'utf-8').decode(Buffer.from(bytes));
      } catch {
        /* An unknown charset must not lose the rest of the subject line. */
        return whole;
      }
    }
  );
}

/** `Ada Lovelace <ada@example.com>` -> `ada@example.com`. */
function addressOf(value) {
  const text = decodeEncodedWords(value);
  const angled = /<([^>]+)>/.exec(text);
  return angled ? angled[1].trim() : text.replace(/^["']|["']$/g, '').trim();
}

/* ------------------------------------------------------------------ *
 * Message parsing
 * ------------------------------------------------------------------ */

/**
 * Walk a MIME tree and pick the body.
 *
 * Preference order is text/plain, then stripped text/html. Attachments are
 * skipped *before* their content is read, and that ordering is the whole point:
 * an attached PDF or image is a base64 blob, and dumping it into the body would
 * push tens of thousands of characters of noise into the model's context — the
 * worst case being a screenshot, which is exactly the sort of message a user
 * asks Klaud to read. `filename` is what marks a part as an attachment; a plain
 * text part carrying a filename is still readable, so only non-text parts with a
 * filename are dropped.
 */
function walkParts(part, out, depth = 0) {
  if (!part || typeof part !== 'object' || depth > 20) return;

  const nested = Array.isArray(part.parts) ? part.parts : [];
  if (nested.length) {
    for (const child of nested) walkParts(child, out, depth + 1);
    return;
  }

  const mime = String(part.mimeType || '').toLowerCase();
  const isText = mime === 'text/plain' || mime === 'text/html';
  if (part.filename && !isText) return;
  if (!isText) return;

  const data = part.body && part.body.data;
  // An attachment over ~2MB lives behind `body.attachmentId` instead of `data`,
  // so there is simply nothing inline to read. That is a skip, not an error.
  if (typeof data !== 'string' || !data) return;

  const decoded = decodeBase64Url(data);
  if (!decoded) return;
  if (mime === 'text/html') out.html.push(decoded);
  else out.plain.push(decoded);
}

function collectBody(json) {
  const payload = json && json.payload;
  if (!payload || typeof payload !== 'object') return '';
  const out = { plain: [], html: [] };
  walkParts(payload, out);
  if (out.plain.length) return out.plain.join('\n\n');
  if (out.html.length) return stripHtml(out.html.join('\n\n'));
  return '';
}

/**
 * Normalise one Gmail `Message` into the six fields the rest of the app uses.
 *
 * Exported so it can be tested without a network: Google does change shapes, and
 * this is the function that would break first when it does. It never throws —
 * a message with no `payload` at all returns empty strings rather than an
 * exception, because a parser crash inside an action reads to the user as a
 * broken connector rather than an oddly shaped email.
 */
function parseGmailMessage(json) {
  const message = json && typeof json === 'object' ? json : {};
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : null;

  return {
    id: toText(message.id),
    threadId: toText(message.threadId),
    from: addressOf(headerValue(payload, 'From')),
    to: addressOf(headerValue(payload, 'To')),
    subject: decodeEncodedWords(headerValue(payload, 'Subject')) || '(no subject)',
    date: headerValue(payload, 'Date'),
    body: collectBody(message),
    snippet: toText(message.snippet),
    labels: Array.isArray(message.labelIds) ? message.labelIds.slice() : [],
  };
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

const encodedWord = (text) => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

/**
 * RFC 2047-encode a header only when it needs it.
 *
 * An all-ASCII subject is left exactly as the user typed it: encoding it would
 * be legal but would show up as `=?UTF-8?B?...?=` in any client that displays
 * the raw header, and it makes the tests harder to read for no benefit. A
 * non-ASCII subject *must* be encoded — sent raw it arrives as mojibake, which
 * is a real and very visible failure.
 */
function encodeHeaderValue(value) {
  const text = toText(value).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(text) ? text : encodedWord(text);
}

/** Fold a comma-separated recipient list onto continuation lines. */
function formatAddressList(value) {
  const list = String(value == null ? '' : value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(', ');
  if (!list) return '';
  if (list.length <= 72) return ` ${list}`;
  const parts = list.split(', ');
  const lines = [];
  let current = '';
  for (const part of parts) {
    const candidate = current ? `${current}, ${part}` : part;
    if (candidate.length > 70 && current) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return ` ${lines.join(',\r\n ')}`;
}

/**
 * Build the `raw` message Gmail's `users.messages.send` expects.
 *
 * The reference says the request body is a `Message` whose `raw` is "the entire
 * email message in an RFC 2822 formatted and base64url encoded string". Base64
 * *URL* specifically: `+` and `/` have to become `-` and `_`, and the trailing
 * padding is dropped, which Node's `'base64url'` encoding does.
 *
 * CRLF line endings are not cosmetic. RFC 5322 requires them, and a lone LF
 * before the blank line separating headers from body is a common cause of a
 * message arriving with its headers shown as body text.
 */
function buildRawMessage({ to, cc, bcc, subject, body }) {
  let lines = [`To:${formatAddressList(to)}`];
  if (cc) lines.push(`Cc:${formatAddressList(cc)}`);
  if (bcc) lines.push(`Bcc:${formatAddressList(bcc)}`);
  if (subject) lines.push(`Subject: ${encodeHeaderValue(subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  // A base64 body sidesteps every 8-bit and line-length rule at once: the bytes
  // above are UTF-8 whatever the user typed, and the transfer encoding makes the
  // UTF-8 declaration in Content-Type true rather than aspirational.
  lines.push(Buffer.from(toText(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').trimEnd());
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The `raw` field itself.
 *
 * `buildRawMessage` returns the message as readable text, which keeps it
 * testable and reviewable; the wire format is that text base64url-encoded, and
 * that step must not be forgotten — Gmail would reject or garble a raw field
 * carrying an unencoded message.
 */
const encodeRawMessage = (message) => Buffer.from(message, 'utf8').toString('base64url');

/* ------------------------------------------------------------------ *
 * Results formatting
 * ------------------------------------------------------------------ */

const truncate = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max)}... (${text.length - max} more characters)`;

/** Sender, date, subject and id — the four things needed to choose a message. */
function formatSearchResults(records, estimate) {
  if (!records.length) {
    return 'No messages matched. Gmail search syntax: from:, to:, subject:, is:unread, has:attachment, ' +
      'newer_than:7d, in:inbox, label:. Operators combine with spaces (all must match) or OR.';
  }
  const lines = records.map((record, index) => {
    const meta = record.meta || null;
    const from = meta ? addressOf(headerValue(meta.payload, 'From')) : '';
    const date = meta ? headerValue(meta.payload, 'Date') : '';
    const subject = meta ? decodeEncodedWords(headerValue(meta.payload, 'Subject')) : '';
    return [
      `${index + 1}. ${subject || '(no subject)'}`,
      `   from: ${from || '(unknown)'}   date: ${date || '(unknown)'}`,
      `   id: ${record.id}`,
    ].join('\n');
  });
  const header = `Found ${records.length} message(s)` +
    (typeof estimate === 'number' && estimate > records.length ? ` (about ${estimate} match in total)` : '') +
    ':';
  return `${header}\n\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * Scope help
 * ------------------------------------------------------------------ */

/** What each scope buys, said in the user's terms rather than Google's. */
const SCOPE_LABELS = {
  'https://www.googleapis.com/auth/gmail.readonly': 'reading mail',
  'https://www.googleapis.com/auth/gmail.send': 'sending mail',
  'https://www.googleapis.com/auth/gmail.modify': 'changing labels',
  'https://mail.google.com/': 'full mailbox access',
};

/** Which scope an action needs, so a 403 can name the one that is missing. */
const ACTION_SCOPES = {
  gmail_search: 'https://www.googleapis.com/auth/gmail.readonly',
  gmail_read: 'https://www.googleapis.com/auth/gmail.readonly',
  gmail_labels: 'https://www.googleapis.com/auth/gmail.readonly',
  gmail_send: 'https://www.googleapis.com/auth/gmail.send',
  gmail_modify: 'https://www.googleapis.com/auth/gmail.modify',
};

const describeScope = (scope) => `${scope} (${SCOPE_LABELS[scope] || 'no description'})`;

function requiredScopesFrom(message) {
  const found = String(message || '').match(/https:\/\/[^\s,'")\]]+/g) || [];
  return [...new Set(found)];
}

/* ------------------------------------------------------------------ *
 * Error mapping
 * ------------------------------------------------------------------ */

/**
 * Turn Google's error into something the user can act on.
 *
 * Exported for tests. Google's 403 covers four unrelated situations — a missing
 * scope, a per-user rate limit, a per-project daily quota and a domain policy —
 * and the only thing that separates them is the `reason` field inside the JSON
 * body. Showing the raw body to a user produces "Forbidden", which is not
 * actionable, so each reason gets its own sentence.
 *
 * `actionName` is optional and only sharpens the scope message.
 */
function explainGmailError(status, body, headers, actionName) {
  const code = Number(status);
  const text = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);

  let parsed = null;
  if (typeof body === 'object' && body !== null) parsed = body;
  else if (typeof body === 'string' && body.trim()) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }

  const error = (parsed && (parsed.error || parsed)) || {};
  const list = Array.isArray(error.errors) ? error.errors : [];
  const reasons = list.map((entry) => String((entry && (entry.reason || entry.message)) || '').toLowerCase());
  const message = toText(error.message) || toText(parsed && parsed.message) || '';
  /* Both sides are lowercased. Google's reasons are camelCase — dailyLimitExceeded,
   * userRateLimitExceeded — so lowercasing only the haystack would leave every
   * needle unmatchable and this whole branch of the mapper dead. */
  const hasReason = (...needles) =>
    needles.some((needle) => reasons.some((reason) => reason.includes(needle.toLowerCase())));
  const retryAfter = (headers && typeof headers.get === 'function' && headers.get('retry-after')) || '';
  const needsMore = hasReason('insufficientpermission', 'insufficient_permission', 'scop') ||
    /insufficient permission|insufficient authentication scopes|required scope|scope/i.test(message);

  if (code === 401) {
    return 'Gmail rejected the stored credentials (HTTP 401' + (message ? `: ${message}` : '') + '). ' +
      'The access token has expired or been revoked and could not be refreshed. ' +
      'Reconnect the Gmail account to sign in again.' +
      (ACTION_SCOPES[actionName] ? ' If reconnecting does not clear it, check that the OAuth client in ' +
        'Google Cloud Console still exists and that ' + describeScope(ACTION_SCOPES[actionName]) +
        ' is present under "OAuth consent screen" > "Data access".' : '');
  }

  if (code === 403 || code === 401) {
    if (needsMore) {
      const wanted = requiredScopesFrom(message);
      const needed = wanted.length ? wanted.join(', ') : (ACTION_SCOPES[actionName] ? describeScope(ACTION_SCOPES[actionName]) : '');
      return 'Gmail refused this request because the account was not granted the required scope' +
        (message ? ` (Google said: ${message})` : '') + '. ' +
        (needed ? `The scope needed is ${needed}. ` : '') +
        'A token minted before a scope was added keeps failing until the account is reconnected — ' +
        'reconnect the Gmail account and approve the new permission when Google asks. ' +
        'Nothing was changed in the mailbox.';
    }

    if (hasReason('ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded')) {
      return 'Gmail rate-limited this request' + (message ? ` (${message})` : '') + '. ' +
        'This is a per-user or per-project limit on how fast requests arrive, not a problem with the ' +
        'account or the settings. Waiting a few seconds and trying again is reasonable' +
        (retryAfter ? `; Google asked for a ${retryAfter} second wait.` : '; Google suggests exponential backoff.');
    }

    if (hasReason('dailylimitexceeded')) {
      return 'The Google Cloud project has used up its Gmail API quota for the day' +
        (message ? ` (${message})` : '') + '. This is a project-wide quota rather than a per-second rate ' +
        'limit. Raise it under "APIs & Services" > "Quotas" in Google Cloud Console, or try again after the ' +
        'quota resets at midnight Pacific time.';
    }

    if (hasReason('domainpolicy')) {
      return 'The Google Workspace domain administrator has blocked this app from accessing Gmail' +
        (message ? ` (${message})` : '') + '. Only a domain administrator can allow it; retrying will not help.';
    }

    return 'Gmail refused this request (HTTP 403' + (message ? `: ${message}` : '') + '). ' +
      'The token is valid but is not allowed to do this. ' + (text ? `Google's response was: ${truncate(text, 500)}` : '');
  }

  if (code === 404) {
    return 'Gmail returned 404 Not Found, so no request reached a message' +
      (message ? ` (${message})` : '') + '. The message may have been deleted or moved, or the id is wrong. ' +
      'Run gmail_search again to get current ids.';
  }

  if (code === 429) {
    return 'Gmail is rate-limiting this account (HTTP 429' + (message ? `: ${message}` : '') + '). ' +
      'Waiting briefly and retrying is reasonable' + (retryAfter ? `; Google asked for ${retryAfter} seconds.` : '; Google suggests exponential backoff.') +
      ' The mailbox was not changed.';
  }

  if (code === 400) {
    return 'Gmail rejected the request as malformed (HTTP 400' + (message ? `: ${message}` : '') + '). ' +
      `This is a bug in how the request was built, not something to retry unchanged.` +
      (text ? ` Google's response was: ${truncate(text, 500)}` : '');
  }

  if (code >= 500) {
    return `Gmail returned a server error (HTTP ${code}${message ? `: ${message}` : ''}). ` +
      'That is on Google\'s side and usually clears; retrying shortly is reasonable.';
  }

  return `Gmail request failed with HTTP ${Number.isFinite(code) ? code : 'unknown'}` +
    (message ? `: ${message}` : '') + (text ? `. Google's response was: ${truncate(text, 500)}` : '') +
    '. This was not recognised as one of the documented failure modes, so the raw response above is all there is.';
}

/** A transport failure, described as a transport failure. */
function explainNetworkError(err) {
  const name = (err && err.name) || '';
  const message = (err && err.message) || String(err) || 'no details';
  if (/abort/i.test(name) || /timeout/i.test(message)) {
    return `Could not reach Gmail: the request timed out (${message}). ` +
      'No response came back, so the mailbox state is unknown — check your connection and try again. ' +
      'If a gmail_send timed out, verify in Gmail whether the message was actually sent before resending.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `Could not reach Gmail: the hostname did not resolve (${message}). ` +
      'Check network access and DNS, then try again.';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Could not reach Gmail: the connection was refused (${message}). ` +
      'A proxy or firewall is most likely blocking the request; no API call was made.';
  }
  return `Could not reach Gmail: the request failed before a response arrived (${name || 'error'}: ${message}). ` +
    'This is a network failure, not a rejection by Gmail. Nothing was changed; retrying is safe.';
}

/* ------------------------------------------------------------------ *
 * callApi plumbing
 * ------------------------------------------------------------------ */

function networkMessage(err) {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|socket hang up|aborted|timeout/i
    .test(String((err && err.message) || err));
}

/**
 * One authenticated request, with a single error path.
 *
 * `ctx.callApi` may either throw on a non-2xx response or return one (the
 * framework is written separately), so both are handled and both end in the same
 * message. A response with no `ok` and no `status` is treated as an error rather
 * than as success: returning "done" for a body we could not read would be the
 * one failure a user cannot detect.
 */
async function callApi(ctx, actionName, { method, path, query, body, permission }) {
  if (!ctx || typeof ctx.callApi !== 'function') {
    throw new Error(
      'The Gmail connector needs ctx.callApi, which the OAuth framework provides. ' +
        'It was not passed in, so no request was made.'
    );
  }
  const options = { method, path };
  if (query) options.query = query;
  if (body !== undefined) options.body = body;
  if (permission) options.permission = permission;

  let response;
  try {
    response = await ctx.callApi(descriptor, options);
  } catch (err) {
    /* A refusal decided before any request was built — "writes are disabled in
     * readonly mode" and friends — is already a complete sentence written for
     * the user. Re-wrapping it as a Gmail failure would bury the actual reason
     * behind a page about Google. `klaudRefusal` is the framework's marker. */
    if (err && err.klaudRefusal) throw err;
    if (err && typeof err.status === 'number') {
      throw new Error(explainGmailError(err.status, err.body != null ? err.body : err.message, err.headers, actionName));
    }
    if (networkMessage(err)) throw new Error(explainNetworkError(err));
    throw err;
  }

  if (!response || typeof response !== 'object') {
    throw new Error(
      `The Gmail request for ${actionName} returned no response object, so its outcome is unknown. ` +
        'Nothing may be reported as done.'
    );
  }
  const status = Number(response.status);
  if (response.ok === false || (!response.ok && Number.isFinite(status) && (status < 200 || status >= 300))) {
    throw new Error(
      explainGmailError(Number.isFinite(status) ? status : 'unknown', response.body, response.headers, actionName)
    );
  }
  return response;
}

/** Normalise the several shapes a JSON body can arrive in. */
function responseJson(response) {
  const body = response && response.body;
  if (body == null) return {};
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(
        'Gmail returned a response that is not JSON, so the result could not be read. ' +
          `The first 200 characters were: ${truncate(body, 200)}`
      );
    }
  }
  throw new Error(`Gmail returned an unexpected response body of type ${typeof body}.`);
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

const asLabelList = (value) => {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
};

const actions = [
  {
    name: 'gmail_search',
    label: 'Search mail',
    description:
      'Search the Gmail mailbox and return sender, date, subject and message id for each match. ' +
      'Uses Gmail search syntax in `query`. Each result costs one extra request to read its headers, ' +
      'so keep max_results modest.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Gmail search query, e.g. "from:ada@example.com", "subject:invoice newer_than:30d", ' +
            '"is:unread in:inbox", "has:attachment". Spaces mean AND; use OR between terms to widen.',
        },
        max_results: {
          type: 'integer',
          description: 'How many messages to return (default 10, maximum 50).',
        },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = toText(args && args.query).trim();
      if (!query) {
        throw new Error('gmail_search needs a non-empty `query`. To list everything, pass "in:anywhere".');
      }
      // Capped well below the API's 500: the tool returns a readable list and
      // then fetches headers for each hit, so a large page is a slow call and a
      // burst of requests that Gmail rate-limits.
      const maxResults = Math.max(1, Math.min(Number(args.max_results) || 10, 50));

      const response = await callApi(ctx, 'gmail_search', {
        method: 'GET',
        path: '/users/me/messages',
        query: { q: query, maxResults },
        permission: 'read',
      });
      const json = responseJson(response);
      const ids = (Array.isArray(json.messages) ? json.messages : [])
        .map((message) => toText(message && message.id))
        .filter(Boolean);

      if (!ids.length) return formatSearchResults([], json.resultSizeEstimate);

      /* The list method returns ids and threadIds only, so headers have to be
       * fetched per message. Sequential rather than parallel on purpose: Gmail
       * enforces a per-user *concurrent* request limit, and firing 50 at once is
       * a documented way to get a 429. */
      const records = [];
      for (const id of ids) {
        try {
          const detail = await callApi(ctx, 'gmail_search', {
            method: 'GET',
            path: `/users/me/messages/${encodeURIComponent(id)}`,
            query: { format: 'metadata', metadataHeaders: ['From', 'Date', 'Subject'] },
            permission: 'read',
          });
          records.push({ id, meta: responseJson(detail) });
        } catch (err) {
          // One unreadable message must not lose the rest of the results.
          records.push({ id, meta: null, error: err.message });
        }
      }
      const failed = records.filter((record) => record.meta === null).length;
      const text = formatSearchResults(records, json.resultSizeEstimate);
      return failed
        ? `${text}\n\n(${failed} of ${records.length} message(s) could not be read, so their sender, date and ` +
          'subject are missing above. The ids are still valid.)'
        : text;
    },
  },

  {
    name: 'gmail_read',
    label: 'Read a message',
    description:
      'Read one Gmail message by id and return its headers and plain-text body. Multipart messages are ' +
      'walked and text/plain is preferred over HTML; attachments are not downloaded.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The message id, as returned by gmail_search.',
        },
      },
      required: ['id'],
    },
    async run(args, ctx) {
      const id = toText(args && args.id).trim();
      if (!id) throw new Error('gmail_read needs a message `id`. Use gmail_search to find one first.');

      const response = await callApi(ctx, 'gmail_read', {
        method: 'GET',
        // format=full is the default, but naming it means a framework default
        // cannot silently change what this action parses.
        path: `/users/me/messages/${encodeURIComponent(id)}`,
        query: { format: 'full' },
        permission: 'read',
      });
      const message = parseGmailMessage(responseJson(response));

      const header = [
        `Subject: ${message.subject}`,
        `From:    ${message.from || '(unknown)'}`,
        `To:      ${message.to || '(unknown)'}`,
        `Date:    ${message.date || '(unknown)'}`,
        `Id:      ${message.id || id}`,
        message.labels.length ? `Labels:  ${message.labels.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      if (!message.body.trim()) {
        /* Not a silent success. An empty string here would read as "this email
         * says nothing", when the likely truth is an HTML-only or attachment-only
         * message whose body this parser deliberately did not inline. */
        return `${header}\n\n(No readable text body. This message has no text/plain or text/html part ` +
          `available inline — it may be HTML-only, attachment-only, or its body is stored as a separate ` +
          `attachment. The snippet below is the only text Gmail returned.)\n\nSnippet: ${message.snippet || '(none)'}`;
      }
      return `${header}\n\n--- body ---\n${truncate(message.body, 50_000)}`;
    },
  },

  {
    name: 'gmail_send',
    label: 'Send a message',
    description:
      'Send an email as the signed-in user. This is visible to the recipients and cannot be unsent, ' +
      'so confirm the recipients and the body before calling it.',
    permission: 'send',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address, or several separated by commas.' },
        subject: { type: 'string', description: 'Subject line. Non-ASCII is encoded automatically.' },
        body: { type: 'string', description: 'Plain-text body of the message.' },
        cc: { type: 'string', description: 'Optional Cc recipients, comma separated.' },
        bcc: { type: 'string', description: 'Optional Bcc recipients, comma separated.' },
      },
      required: ['to', 'subject', 'body'],
    },
    async run(args, ctx) {
      const to = toText(args && args.to).trim();
      if (!to) throw new Error('gmail_send needs at least one recipient in `to`; nothing was sent.');
      const raw = encodeRawMessage(buildRawMessage({
        to,
        cc: toText(args && args.cc).trim(),
        bcc: toText(args && args.bcc).trim(),
        subject: toText(args && args.subject),
        body: toText(args && args.body),
      }));

      const response = await callApi(ctx, 'gmail_send', {
        method: 'POST',
        path: '/users/me/messages/send',
        // The body is a Message resource whose `raw` holds the encoded message.
        body: { raw },
        permission: 'send',
      });
      const json = responseJson(response);

      const recipients = [
        `To: ${to}`,
        args && args.cc ? `Cc: ${args.cc}` : '',
        args && args.bcc ? `Bcc: ${args.bcc}` : '',
      ].filter(Boolean).join('\n');
      /* "Accepted by Gmail" rather than "delivered". Google's own error guide
       * says a 200 does not prove delivery — the sending pipeline can report a
       * quota breach minutes later — so claiming delivery would be a lie the
       * user could only discover from the recipient. */
      return `Gmail accepted the message for sending.\n${recipients}\nSubject: ${toText(args && args.subject) || '(no subject)'}` +
        `\nId: ${toText(json.id) || '(not returned)'}\n\n` +
        'Note: a 200 response means Gmail queued the message, not that the recipient received it. ' +
        'Check Gmail\'s Sent folder if it matters.';
    },
  },

  {
    name: 'gmail_labels',
    label: 'List labels',
    description: 'List the labels in the mailbox, with their ids, so they can be used with gmail_modify.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async run(args, ctx) {
      const response = await callApi(ctx, 'gmail_labels', {
        method: 'GET',
        path: '/users/me/labels',
        permission: 'read',
      });
      const json = responseJson(response);
      const labels = Array.isArray(json.labels) ? json.labels : [];
      if (!labels.length) {
        return 'Gmail returned no labels, which usually means the account has no custom labels yet. ' +
          'System labels such as INBOX, UNREAD and STARRED exist regardless and can still be used with gmail_modify.';
      }
      const lines = labels.map((label) => {
        const type = toText(label && label.type);
        return `${toText(label && label.id)}  ${toText(label && label.name)}` + (type ? `  [${type}]` : '');
      });
      return `${labels.length} label(s):\n${lines.join('\n')}`;
    },
  },

  {
    name: 'gmail_modify',
    label: 'Change labels',
    description:
      'Add or remove labels on a message. This changes the user\'s own mailbox and can be undone by ' +
      'reversing the change, so it is a write rather than a send.',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The message id.' },
        add_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label ids to add, e.g. ["STARRED"]. Use gmail_labels for the ids.',
        },
        remove_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label ids to remove, e.g. ["UNREAD"]. Use gmail_labels for the ids.',
        },
      },
      required: ['id'],
    },
    async run(args, ctx) {
      const id = toText(args && args.id).trim();
      if (!id) throw new Error('gmail_modify needs a message `id`. Use gmail_search to find one first.');
      const add = asLabelList(args && args.add_labels);
      const remove = asLabelList(args && args.remove_labels);
      // Zero changes would otherwise be an API call that reports success while
      // doing nothing, which reads to the user as a label change that happened.
      if (!add.length && !remove.length) {
        throw new Error(
          'gmail_modify was asked to change nothing: give at least one label id in `add_labels` or ' +
            '`remove_labels`. Nothing was sent to Gmail.'
        );
      }

      const response = await callApi(ctx, 'gmail_modify', {
        method: 'POST',
        path: `/users/me/messages/${encodeURIComponent(id)}/modify`,
        /* Both keys are always sent: the reference documents addLabelIds and
         * removeLabelIds as separate lists, and omitting one is less predictable
         * across Google's transcoding than sending an empty list. */
        body: { addLabelIds: add, removeLabelIds: remove },
        permission: 'write',
      });
      const json = responseJson(response);
      const parts = [];
      if (add.length) parts.push(`added ${add.join(', ')}`);
      if (remove.length) parts.push(`removed ${remove.join(', ')}`);
      const applied = Array.isArray(json.labelIds) ? `\nLabels now: ${json.labelIds.join(', ')}` : '';
      return `Message ${toText(json.id) || id}: ${parts.join('; ')}.${applied}`;
    },
  },
];

module.exports = {
  descriptor,
  scopes,
  actions,
  parseGmailMessage,
  // Exported for tests and for the OAuth framework's error surface. Not part of
  // the documented connector contract, but harmless and worth not duplicating.
  explainGmailError,
  explainNetworkError,
  buildRawMessage,
  encodeRawMessage,
  decodeBase64Url,
  encodeHeaderValue,
  stripHtml,
};
