'use strict';

/**
 * The proxied API tool: the seam between a connected service and the agent loop.
 *
 * Nothing about OAuth or any provider's API lives here. `./oauth` owns
 * authorization and the stored credential, `./connectors/<service>` owns one
 * service each, and this module is the only place that knows how a *call*
 * through them is shaped.
 *
 * WHY ONE TOOL PER SERVICE, not one per action:
 *
 *   - the schema stays small. Twenty near-identical names
 *     (`gmail_send`, `gmail_create_draft`, ...) crowd out the file and shell
 *     tools the agent needs on every step, and a small free-tier model picks
 *     badly between them;
 *   - the action travels as data — `{"action": "...", "args": {...}}` — so a new
 *     action in a connector needs no change here and no re-registration;
 *   - the per-action permission is enforced inside `run`, because `tools.js`
 *     gates a whole tool and one service spans several levels: searching is
 *     `read`, labelling is `write`, sending mail is `send`. So the umbrella's
 *     declared permission is the strongest action it can reach (which is what
 *     the UI catalogue must show — the tool really can send), while
 *     `resolvePermission(args)` answers for the call in hand, which is what the
 *     read-only guard in tools.js and the approval gate in agent.js consult.
 *
 * `send` is the reason this module exists rather than another REST helper: an
 * email leaves the machine as the user, is visible to other people, and cannot
 * be taken back, so it gets its own permission level and its own refusal.
 *
 * TWO THINGS ABOUT THIS FILE ARE WORTH KNOWING BEFORE READING IT:
 *
 * 1. Both siblings are loaded defensively and lazily, and everything they are
 *    asked for is treated as a shape to be verified rather than trusted. The
 *    connector registry may not exist at all, the authorization store is
 *    asynchronous, and `accessTokenFor` reports failure as a value rather than
 *    an exception. All of that is normalised here.
 * 2. `ctx.callApi` accepts two shapes, because the connector contract in this
 *    repo is not settled: the documented one for this module
 *    (`ctx.callApi(actionName, args)` → readable text) and the one
 *    `connectors/gmail.js` was written against
 *    (`ctx.callApi(descriptor, { method, path, query, body, permission })` →
 *    a response object it maps its own errors from). See `frameworkCall`.
 */

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

// Only for `registerTools`. tools.js does not require this module, so there is
// no cycle: by the time this file is evaluated, the registry it writes into is
// already built.
const { registerTools } = require('./tools');

const MAX_RESULT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LEVELS = new Set(['read', 'write', 'send']);

function text(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clip(value, max) {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [${s.length - max} characters omitted]`;
}

function reasonOf(err) {
  return err && err.message ? String(err.message) : String(err);
}

/* ------------------------------------------------------------------ *
 * Dependencies
 *
 * The registry and the authorization store are the two things this file calls
 * into, and both are loaded *defensively and lazily*, deliberately:
 *
 *   - a throw at require time here would take the agent down before a single
 *     tool could explain itself, and both siblings are separate modules that can
 *     be missing, half-written, or broken by a third-party connector;
 *   - `require` caches, so resolving per call costs a lookup, and it means a
 *     module that lands while Klaud is running is picked up on the next turn
 *     rather than needing a restart.
 *
 * `require('./connectors')` may genuinely not exist: the registry is a separate
 * deliverable, and its absence must degrade to "no services are available" —
 * never to a crash. Same for `./oauth`, where absence degrades to "nothing is
 * connected, and nothing can be connected yet".
 *
 * The exported functions take an optional last argument of the shape
 * `{ registry, oauth }` so a test can drive the real code path against a mock
 * service and a mock credential store, with no fixture module having to live in
 * `src/lib/connectors` (that directory belongs to the connectors, not to this
 * test) and no network. The app never passes it.
 * ------------------------------------------------------------------ */

function loadSibling(relative) {
  try {
    return require(relative);
  } catch {
    return null;
  }
}

function depsOf(overrides) {
  const given = overrides && typeof overrides === 'object' ? overrides : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(given, key);
  return {
    registry: has('registry') ? given.registry : loadSibling('./connectors'),
    oauth: has('oauth') ? given.oauth : loadSibling('./oauth'),
  };
}

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

function connectorsOf(registry) {
  if (!registry || typeof registry.listConnectors !== 'function') return [];
  try {
    const list = registry.listConnectors();
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && c.id) : [];
  } catch {
    // A registry that throws is treated as one with nothing in it: the agent
    // still has to work when someone's connector file is broken.
    return [];
  }
}

function connectorById(registry, id) {
  const wanted = text(id).toLowerCase();
  if (!wanted) return null;
  if (registry && typeof registry.getConnector === 'function') {
    try {
      const found = registry.getConnector(wanted);
      if (found && typeof found.id === 'string') return found;
    } catch {
      /* fall through to the listing */
    }
  }
  const list = connectorsOf(registry);
  return (
    list.find((c) => c.id.toLowerCase() === wanted) ||
    list.find((c) => text(c.label).toLowerCase() === wanted) ||
    null
  );
}

/**
 * The usable actions of a connector.
 *
 * An action is usable when it either carries its own `run` or describes a
 * request declaratively (`method` plus `path`), which is what makes a trivial
 * endpoint cost three lines in a connector file.
 *
 * A missing or unrecognised permission is treated as `send`, not as `read`.
 * That is deliberately the paranoid direction: reading a level as weaker than it
 * is would be the one bug that lets an irreversible action leave the machine
 * unprompted. The registry already refuses to load a connector whose
 * permissions are not `read`, `write` or `send`.
 */
function actionsOf(connector) {
  const list = Array.isArray(connector && connector.actions) ? connector.actions : [];
  return list
    .filter(
      (action) =>
        action &&
        typeof action.name === 'string' &&
        action.name &&
        (typeof action.run === 'function' || typeof action.path === 'string' || typeof action.path === 'function')
    )
    .map((action) => ({ ...action, permission: LEVELS.has(action.permission) ? action.permission : 'send' }));
}

function strongestLevel(actions) {
  if (actions.some((a) => a.permission === 'send')) return 'send';
  if (actions.some((a) => a.permission === 'write')) return 'write';
  return 'read';
}

function actionNameFrom(args) {
  return args && typeof args === 'object' && typeof args.action === 'string' ? args.action.trim() : '';
}

function callArgsFrom(args) {
  if (!args || typeof args !== 'object') return {};
  const inner = args.args;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
}

/** The action a call names, or the request description it hands over directly. */
function resolveAction(connector, action) {
  if (action && typeof action === 'object') {
    // A request description built inside a connector's own `run`. It carries no
    // declared level of its own, so the permission must have been attached by
    // the caller (see `requestLike`); one that still has none fails closed.
    return {
      name: text(action.name) || 'request',
      permission: LEVELS.has(action.permission) ? action.permission : 'send',
      method: action.method,
      path: action.path,
      query: action.query,
      body: action.body,
      headers: action.headers,
      run: null,
    };
  }
  const wanted = text(action);
  if (!wanted) return null;
  return actionsOf(connector).find((a) => a.name === wanted) || null;
}

function unknownAction(connector, wanted, actions) {
  const label = (connector && (connector.label || connector.id)) || 'this service';
  const available = actions.length
    ? actions.map((a) => `${a.name} (${a.permission})`).join(', ')
    : 'none — this connector declares no usable actions';
  return (
    `Unknown action${wanted ? ` "${wanted}"` : ''} for ${label}, so nothing was sent. ` +
    `Available actions: ${available}. ` +
    `Call use_${(connector && connector.id) || '<service>'} again with one of those names in "action".`
  );
}

/** A compact one-line argument summary for the tool description. */
function parameterSummary(spec) {
  const params = spec && spec.parameters;
  const props = params && typeof params === 'object' && params.properties ? params.properties : null;
  if (!props) return '';
  const required = Array.isArray(params.required) ? params.required : [];
  const fields = Object.keys(props).map((key) => {
    const type = (props[key] && props[key].type) || 'any';
    return `${key}: ${type}${required.includes(key) ? ' (required)' : ''}`;
  });
  if (!fields.length) return '';
  return ` — args: { ${fields.join(', ')} }`;
}

/* ------------------------------------------------------------------ *
 * Connections
 *
 * The authorization store is asynchronous and reports failure as a value, so
 * every read of it here is awaited and every shape is verified rather than
 * assumed. What matters most: only the account label and the expiry ever leave
 * these functions. A token is never read from a stored record — this module asks
 * `accessTokenFor(id)` for one at request time, which is the interface that
 * knows how to refresh it — and a token that never enters a result string cannot
 * be printed into a transcript, a prompt or a chat file.
 * ------------------------------------------------------------------ */

async function connectionsOf(oauth) {
  if (!oauth || typeof oauth.listConnections !== 'function') return [];
  try {
    const list = await oauth.listConnections();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * One stored connection, normalised to the few fields anything here may use.
 *
 * The store owns the shape, so the plausible field names are all accepted. Note
 * what is deliberately *not* accepted as an account: the store's `label` field,
 * which is the connector's display name ("Gmail"), not the account. Reporting
 * "connected as Gmail" would be worse than admitting the account is unknown.
 */
function normaliseConnection(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    // `listConnections()` may hand back bare ids; treat the id as the service
    // too, which is the only reading that keeps the listing useful.
    return { id: raw.trim(), connectorId: raw.trim(), account: '', expiresAt: null, expired: null };
  }
  if (!raw || typeof raw !== 'object') return null;

  const id = firstText(raw, ['id', 'connectionId', 'key']);
  const connectorId = firstText(raw, ['connector', 'connectorId', 'service', 'provider']) || id;
  const account = firstText(raw, ['account', 'email', 'username', 'user', 'account_label']);
  const value = raw.expiresAt ?? raw.expires_at ?? raw.expiry ?? raw.expires ?? null;

  let expiresAt = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds: a number this small cannot be a millisecond
    // timestamp, so it is read as seconds rather than as a date in 1970.
    expiresAt = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) expiresAt = parsed;
  }

  const expired =
    typeof raw.expired === 'boolean' ? raw.expired : expiresAt === null ? null : expiresAt <= Date.now();

  return { id: id || connectorId, connectorId, account, expiresAt, expired };
}

async function connectionFor(oauth, connectorId) {
  const wanted = text(connectorId).toLowerCase();
  if (!wanted) return null;

  for (const raw of await connectionsOf(oauth)) {
    const connection = normaliseConnection(raw);
    if (!connection) continue;
    if (connection.connectorId.toLowerCase() === wanted || connection.id.toLowerCase() === wanted) {
      return connection;
    }
  }

  // A store that lists nothing but can load one by id is still asked: a listing
  // is a summary of what is on disk, and a summary can lag or skip a record.
  if (oauth && typeof oauth.loadConnection === 'function') {
    try {
      const found = normaliseConnection(await oauth.loadConnection(wanted));
      if (found) return found;
    } catch {
      /* not connected, or unreadable — both mean the same thing here */
    }
  }
  return null;
}

function expiryLabel(connection) {
  if (connection.expired === true) return 'the access token is expired — reconnect with connect_service';
  if (connection.expired === false && connection.expiresAt) {
    return `the access token is valid until ${new Date(connection.expiresAt).toISOString()}`;
  }
  if (connection.expired === false) return 'the access token is present and not marked expired';
  return 'the expiry is not recorded';
}

/** Every connection, joined to the connector that explains it. */
async function connectionRows(deps) {
  const rows = [];
  for (const raw of await connectionsOf(deps.oauth)) {
    const connection = normaliseConnection(raw);
    if (!connection) continue;
    const connector = connectorById(deps.registry, connection.connectorId);
    rows.push({
      connection,
      connector,
      label: (connector && (connector.label || connector.id)) || connection.connectorId || 'unknown service',
      actions: connector ? actionsOf(connector) : [],
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The tool description and the prompt block
 * ------------------------------------------------------------------ */

function serviceDescription(connector, actions) {
  const lines = [
    `${connector.label || connector.id}. Call this tool with {"action": "...", "args": {...}} — one of the actions below.`,
    `If the user has not connected ${connector.label || connector.id} yet, connect_service has to run first; list_connections reports the account and whether the token is still valid.`,
    'Actions:',
  ];
  for (const action of actions) {
    const label = action.label ? `${action.label} — ` : '';
    const description = action.description ? `${label}${action.description}` : label.replace(/ — $/, '');
    lines.push(
      `  - ${action.name} (${action.permission})${description ? `: ${description}` : ''}${parameterSummary(action)}`
    );
  }
  return lines.join('\n');
}

/**
 * A compact block for the system prompt, and the empty string when nothing is
 * connected.
 *
 * Empty matters as much as the content: a session with no connections must send
 * a byte-identical prompt to the one it sent before this feature existed, so
 * nobody who does not use it pays for it in tokens or in behaviour.
 *
 * Asynchronous, because the authorization store is: `listConnections` reads the
 * connection files. It resolves to a string, and caller code must `await` it —
 * a forgotten await would put "[object Promise]" in the prompt, which is why
 * the only caller (agent.js) awaits it at the point the prompt is assembled.
 */
async function describeConnectionsForPrompt(overrides) {
  const deps = depsOf(overrides);
  const rows = await connectionRows(deps);
  if (!rows.length) return '';

  const lines = ['Connected services (Klaud reaches these through one tool each, as the user):'];
  for (const row of rows) {
    const who = row.connection.account ? ` as ${row.connection.account}` : '';
    if (!row.connector) {
      // Honest about a credential with nothing to use it: the store keeps records
      // for connectors this build does not have, and claiming a tool for it would
      // send the model looking for one that was never registered.
      lines.push(`- ${row.label}${who}: connected, but no connector is installed to act on it.`);
      continue;
    }
    const actions = row.actions.length
      ? row.actions.map((a) => `${a.name} (${a.permission})`).join(', ')
      : 'no actions';
    lines.push(`- ${row.label}${who} — tool use_${row.connector.id}: ${actions}.`);
  }
  lines.push(
    'Actions with permission "send" go out as the user, other people will see them, and they cannot',
    'be taken back. Confirm the exact recipient and the content with the user before you send',
    'anything, and never send to a recipient the user did not name. `read` needs no confirmation;',
    '`write` changes something at the service and is worth saying out loud before you do it.'
  );
  return lines.join('\n');
}

async function connectionListing(deps) {
  const rows = await connectionRows(deps);
  const available = connectorsOf(deps.registry);

  if (!rows.length) {
    const offer = available.length
      ? `Services that can be connected: ${available
          .map((c) => `${c.id} (${c.label || c.id})`)
          .join(', ')}. Use connect_service with one of those ids.`
      : 'No connectors are installed in this build, so there is nothing to connect yet.';
    return `No services are connected, so Klaud cannot act on any third party service for you yet.\n${offer}`;
  }

  const lines = [`${rows.length} connected service(s):`];
  for (const row of rows) {
    const account = row.connection.account
      ? ` as ${row.connection.account}`
      : '; the account is not recorded by the authorization store';
    const actions = row.actions.length
      ? `Actions: ${row.actions.map((a) => `${a.name} (${a.permission})`).join(', ')}.`
      : 'No actions are available for it, so it cannot be used.';
    lines.push(`- ${row.label}${account}: ${expiryLabel(row.connection)}. ${actions}`);
  }
  // Said out loud because the natural next question is "can I see the token?".
  lines.push('Stored tokens are never shown here or anywhere else; Klaud reads one only to make a request.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

function baseUrlOf(connector, registry) {
  const direct = text(connector.baseUrl || connector.apiBaseUrl || connector.baseURL || connector.apiUrl);
  if (direct) return direct.replace(/\/+$/, '');

  // A registry may keep the API roots centrally so a connector does not have to
  // repeat one. Checked as a fallback rather than preferred: the descriptor is
  // what travels with the connector, and only it is guaranteed to be present.
  for (const name of ['apiBaseUrlFor', 'baseUrlFor']) {
    const resolve = registry && registry[name];
    if (typeof resolve !== 'function') continue;
    try {
      const value = text(resolve.call(registry, connector.id));
      if (value) return value.replace(/\/+$/, '');
    } catch {
      /* try the next one */
    }
  }
  return '';
}

/**
 * Turn a connector action into a request.
 *
 * `path`, `query` and `body` may each be a value or a function of the action's
 * arguments, so a connector can describe a plain endpoint in three lines and
 * compute a search query when it has to. A `{name}` placeholder in the path is
 * filled from the arguments, which is the shape most REST ids take.
 */
function buildRequest(connector, spec, args, registry) {
  const label = connector.label || connector.id;
  const base = baseUrlOf(connector, registry);
  if (!base) {
    // Named precisely, because this is a connector author's omission and the
    // only way to fix it: requests are built against the connector's own API
    // root, and neither the descriptor nor the registry supplies one.
    throw new Error(
      `${label} declares no baseUrl, so Klaud has nowhere to send this request. ` +
        `Add the API root to the connector (or a apiBaseUrlFor(id) to the registry).`
    );
  }

  const rawPath = typeof spec.path === 'function' ? spec.path(args) : spec.path;
  const pathText = text(rawPath).replace(/^\/+/, '');
  const url = new URL(pathText ? `${base}/${pathText}` : `${base}/`);

  for (const placeholder of url.pathname.match(/\{[A-Za-z0-9_]+\}/g) || []) {
    const key = placeholder.slice(1, -1);
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`"${key}" is required by the path ${pathText || '/'} and was not given`);
    }
    url.pathname = url.pathname.replace(placeholder, encodeURIComponent(String(value)));
  }

  const query = typeof spec.query === 'function' ? spec.query(args) : spec.query;
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    accept: 'application/json',
    'user-agent': 'Klaud/1.0 (+local coding agent)',
    ...(connector.headers && typeof connector.headers === 'object' ? connector.headers : {}),
    ...(spec.headers && typeof spec.headers === 'object' ? spec.headers : {}),
  };

  const raw = typeof spec.body === 'function' ? spec.body(args) : spec.body;
  let body;
  if (typeof raw === 'string' && raw) {
    // The connector owns its own encoding here (form bodies, multipart, a raw
    // JSON template), so it is passed through untouched.
    body = raw;
  } else if (raw && typeof raw === 'object') {
    body = JSON.stringify(raw);
    headers['content-type'] = 'application/json';
  }

  return {
    url: url.toString(),
    method: text(spec.method).toUpperCase() || (body ? 'POST' : 'GET'),
    headers,
    body,
    path: pathText || '/',
  };
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The service's own words for a failure, wherever that service puts them. */
function serviceMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const error = parsed.error;
  if (typeof error === 'string') return error.trim();
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message.trim();
  if (typeof parsed.message === 'string') return parsed.message.trim();
  if (typeof parsed.error_description === 'string') return parsed.error_description.trim();
  return '';
}

function shapeOf(parsed) {
  if (Array.isArray(parsed)) return `${parsed.length} item(s)`;
  if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed).slice(0, 8);
    return keys.length ? `fields: ${keys.join(', ')}` : 'an empty object';
  }
  return '';
}

/**
 * Why a failure happened and what to do instead — never only the status code.
 * A model that gets a bare "403" retries it unchanged, which is the loop this
 * whole codebase spends its comments avoiding.
 */
function failureHint(status, label, spec) {
  if (status === 401) {
    return `[Klaud] ${label} rejected the access token. Reconnect the account with connect_service and try again; repeating this call unchanged will fail the same way.`;
  }
  if (status === 403) {
    return `[Klaud] The account is connected but not allowed to do this. It usually means the authorization is missing the scope for "${spec.name}": reconnect with connect_service and grant it.`;
  }
  if (status === 404) {
    return `[Klaud] ${label} has nothing at that path or id. Check the arguments — an id from a search result is usually required.`;
  }
  if (status === 429) {
    return `[Klaud] ${label} is rate limiting this account. Wait before trying again, and ask for fewer, larger results rather than repeating the call.`;
  }
  if (status >= 500) {
    return `[Klaud] That is a failure inside ${label}, not in Klaud. One retry is reasonable; a loop on it is not.`;
  }
  return `[Klaud] Check the arguments against the description of "${spec.name}" before calling it again.`;
}

function formatResponse(label, spec, res, body) {
  const type = res.headers.get('content-type') || 'unknown type';
  const bytes = Buffer.byteLength(body, 'utf8');
  const statusText = res.statusText ? ` ${res.statusText}` : '';

  if (res.ok) {
    const parsed = parseJson(body);
    const shape = shapeOf(parsed);
    const shown = parsed && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : body;
    if (!shown.trim()) {
      // An empty success is the shape that reads as a failure, so it is spelled
      // out instead: the service really did accept it and really did say nothing.
      return `HTTP ${res.status}${statusText} — ${label} accepted "${spec.name}" and returned an empty body. The request went through.`;
    }
    const header = `HTTP ${res.status}${statusText} — ${label} "${spec.name}" succeeded (${sizeLabel(bytes)}, ${type})${shape ? `, ${shape}` : ''}:`;
    return `${header}\n${clip(shown, MAX_RESULT_CHARS)}`;
  }

  const parsed = parseJson(body);
  const said = serviceMessage(parsed) || clip(body.trim(), 600) || '(the service sent no explanation)';
  return [
    `HTTP ${res.status}${statusText} — ${label} refused "${spec.name}", so nothing was done.`,
    `The service said: ${said}`,
    failureHint(res.status, label, spec),
  ].join('\n');
}

/**
 * A usable access token, or the sentence that says why there is none.
 *
 * The store's documented answer is `{ ok, token }` / `{ ok: false, error, hint,
 * needsReconnect }`, but a bare token string and an `{ accessToken }` object are
 * accepted too: the shape was in flux while this module was written, and reading
 * only one of them would turn "the token is fine" into "reconnect" — the one
 * failure mode a user cannot debug.
 */
function tokenFrom(result) {
  if (typeof result === 'string') return result.trim() ? result.trim() : null;
  if (!result || typeof result !== 'object') return null;
  const value = result.token || result.accessToken || result.access_token;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tokenFailure(storeLabel, result, why) {
  const detail =
    (result && typeof result === 'object' && text(result.error)) ||
    (result && typeof result === 'object' && text(result.hint)) ||
    why;
  // Returned, not thrown: the model needs to be told to reconnect, and a thrown
  // error would arrive as `Error: ...` with no way for it to act.
  return (
    `Could not authenticate: Klaud has no usable access token for ${storeLabel}, so nothing was sent` +
    (detail ? ` (${detail})` : '') +
    `. Reconnect the account with connect_service, then try again.`
  );
}

/**
 * One request, from the permission check to a readable outcome.
 *
 * Resolves to `{ ok, stage, text, status, headers, body }`. `ok:false` carries
 * the stage that stopped it — `permission`, `token`, `build`, `transport` or
 * `http` — because the two callers of this function need different things from a
 * failure: the text convention shows `text`, and the framework convention lets a
 * connector map its own HTTP errors from `status`/`body`/`headers`.
 */
async function performRequest(connector, spec, args, ctx) {
  const label = connector.label || connector.id;
  const mode = (ctx && ctx.approvalMode) || 'auto';
  const { permission } = spec;

  /* Permissions are checked before anything else happens, and that ordering is
   * the point: a refused send must not already be on its way. "Refused after the
   * request went out" is not a refusal. */
  if (mode === 'readonly' && permission === 'send') {
    return {
      ok: false,
      stage: 'permission',
      text:
        `Permission denied: external actions are disabled (approval mode "readonly"). ` +
        `"${spec.name}" would go out to ${label} as the user, other people would see it, and it ` +
        `could not be taken back, so nothing was sent. Switch to "Ask first" to approve it case by case.`,
    };
  }
  if (mode === 'readonly' && permission === 'write') {
    return {
      ok: false,
      stage: 'permission',
      text:
        `Permission denied: write actions are disabled (approval mode "readonly"). ` +
        `"${spec.name}" would change something at ${label}, so it was not performed. ` +
        `Read actions such as a search still work in this mode.`,
    };
  }

  const oauth = (ctx && ctx.oauth) || depsOf(null).oauth;
  if (!oauth || typeof oauth.accessTokenFor !== 'function') {
    return {
      ok: false,
      stage: 'token',
      text: `Could not authenticate: the authorization module is not installed, so Klaud has no access token for ${label} and nothing was sent.`,
    };
  }

  let result = null;
  let why = '';
  try {
    // The descriptor is passed so the store can refresh an expired token: a
    // refresh needs the token URL and the client credentials, and both live on
    // the connector rather than in the stored record.
    result = await oauth.accessTokenFor(connector.id, { connector });
  } catch (err) {
    why = reasonOf(err);
  }

  const token = tokenFrom(result);
  if (!token) return { ok: false, stage: 'token', text: tokenFailure(label, result, why) };

  let request;
  try {
    request = buildRequest(connector, spec, args, ctx && ctx.registry);
  } catch (err) {
    return {
      ok: false,
      stage: 'build',
      text: `Could not build the request for "${spec.name}": ${reasonOf(err)}. Nothing was sent.`,
    };
  }

  // The token goes on last, into the request only. Nothing below copies a header
  // into a result string, so a token cannot reach the transcript, the model or
  // the user through this path.
  const headers = { ...request.headers, authorization: `Bearer ${token.replace(/^Bearer\s+/i, '').trim()}` };
  const timeoutMs = Number(connector.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text();
    return {
      ok: res.ok,
      stage: res.ok ? 'done' : 'http',
      text: formatResponse(label, spec, res, body),
      status: res.status,
      headers: res.headers,
      body,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return {
      ok: false,
      stage: 'transport',
      text:
        `The request to ${label} for "${spec.name}" did not complete: ` +
        `${aborted ? `no answer within ${timeoutMs}ms` : reasonOf(err)}. ` +
        // Honest about the one case that matters: a send that timed out may still
        // have arrived, and telling the model "nothing happened" would make it
        // send again.
        `The service may still have received it, so check ${label} before repeating "${spec.name}".`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * callConnector
 * ------------------------------------------------------------------ */

/**
 * Perform one authenticated request and return a readable result.
 *
 * This is what each action's `run(args, ctx)` calls through `ctx.callApi`, and
 * it never throws: an agent loop that has to catch a tool is a loop that reports
 * a stack trace where the model needed a sentence it could act on.
 *
 * `ctx` is the tool context (`cwd`, `approvalMode`) plus an optional `oauth`
 * override for tests.
 */
async function callConnector(connector, action, args, ctx) {
  if (!connector || typeof connector.id !== 'string') {
    return 'No service was given, so nothing was sent. Pick the service tool first.';
  }

  const spec = resolveAction(connector, action);
  if (!spec) return unknownAction(connector, typeof action === 'string' ? action : '', actionsOf(connector));

  const callArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const outcome = await performRequest(connector, spec, callArgs, ctx && typeof ctx === 'object' ? ctx : {});
  return outcome.text;
}

/* ------------------------------------------------------------------ *
 * Service tools
 * ------------------------------------------------------------------ */

function requestLike(action, spec) {
  // A connector action may name another action, or hand over a request
  // description built from its arguments. A description carries no permission,
  // so the one already decided for this action is attached; an explicit
  // permission on the description wins.
  if (!action || typeof action !== 'object') return action;
  return { permission: spec.permission, ...action };
}

/**
 * A connector descriptor, as opposed to a request description.
 *
 * Deliberately not keyed on `actions`: the registry merges a module's `actions`
 * into the descriptor it hands out, while a connector's own `run` passes its
 * module-level descriptor — which carries `id`, `authUrl` and `scopes` but no
 * `actions`. Both are descriptors, and both have to be recognised.
 */
function isConnectorDescriptor(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return false;
  if ('path' in value || 'method' in value || 'query' in value) return false;
  return Array.isArray(value.actions) || typeof value.authUrl === 'string' || Array.isArray(value.scopes);
}

/**
 * The second `ctx.callApi` shape: `(descriptor, { method, path, query, body,
 * permission })` returning a response object.
 *
 * WHY this exists at all: `connectors/gmail.js` is written against it — it hands
 * over its own descriptor plus a request description and expects back
 * `{ ok, status, headers, body }`, with a non-2xx mapped through its own
 * `explainGmailError`. The documented shape for this module is the other one
 * (`ctx.callApi(actionName, args)` → readable text), and a connector written
 * against either must work unchanged. The two are trivially distinguishable: a
 * descriptor has an `id` and an `actions` array, a request description does not.
 *
 * If the two conventions are ever reconciled, this function is the one to
 * delete.
 */
async function frameworkCall(connector, options, ctx, enclosingAction) {
  const opts = options && typeof options === 'object' ? options : {};
  const spec = {
    // The request description carries no action name, so the action whose `run`
    // is calling is used: a refusal that cannot name what it refused would send
    // the model looking for the wrong thing.
    name: text(opts.action) || text(enclosingAction) || 'request',
    permission: LEVELS.has(opts.permission) ? opts.permission : 'send',
    method: opts.method,
    path: opts.path,
    query: opts.query,
    body: opts.body,
    headers: opts.headers,
  };

  const outcome = await performRequest(connector, spec, {}, ctx);
  if (outcome.ok) {
    const parsed = parseJson(outcome.body);
    return {
      ok: true,
      status: outcome.status,
      headers: outcome.headers,
      body: parsed === null ? outcome.body : parsed,
    };
  }
  if (outcome.stage === 'http') {
    // Handed back rather than thrown so the connector's own error mapping runs:
    // it knows the service's `reason` field and names the missing scope.
    return { ok: false, status: outcome.status, headers: outcome.headers, body: outcome.body };
  }

  // A refusal or a local failure has no HTTP status to report, and passing one
  // would make the connector describe it as a service error. The message is the
  // whole story, so it is thrown as-is and the caller does not re-wrap it.
  const err = new Error(outcome.text);
  err.klaudRefusal = true;
  throw err;
}

function serviceTool(connector, deps) {
  const actions = actionsOf(connector);
  const byName = new Map(actions.map((a) => [a.name, a]));

  return {
    name: `use_${connector.id}`,
    // Declared as the strongest action it can reach, because that is the truth
    // about the tool and the catalogue must not understate it. What is *checked*
    // for a given call comes from `resolvePermission` below, through
    // `permissionForCall` in tools.js.
    permission: strongestLevel(actions),
    description: serviceDescription(connector, actions),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: actions.length
            ? `The action to perform: one of ${actions.map((a) => a.name).join(', ')}.`
            : 'The action to perform. This connector declares no actions.',
        },
        args: {
          type: 'object',
          properties: {},
          description: 'Arguments for the action, as the action list above describes them.',
        },
      },
      required: ['action'],
    },

    /**
     * The level of *this* call. An action the connector does not declare gets
     * `read`, which is not a loophole: `run` refuses an unknown action before it
     * can build a request, so no external effect is reachable, and answering
     * `send` would replace a useful "here are the real action names" with a
     * refusal in the one mode where the model most needs to be told.
     */
    resolvePermission(args) {
      const spec = byName.get(actionNameFrom(args));
      return spec ? spec.permission : strongestLevel([]);
    },

    async run(args, ctx) {
      const wanted = actionNameFrom(args);
      const callArgs = callArgsFrom(args);
      const spec = byName.get(wanted);
      if (!spec) return unknownAction(connector, wanted, actions);

      // `ctx.callApi` is how a connector action performs its request: it closes
      // over this connector, this action's arguments and, through the context,
      // the mode the session is in.
      const bound = { ...(ctx && typeof ctx === 'object' ? ctx : {}) };
      bound.oauth = deps.oauth || bound.oauth;
      // Carried through so a request can still be built when the API root lives
      // on the registry rather than on the descriptor.
      bound.registry = deps.registry || bound.registry;
      bound.callApi = (action, requestArgs) => {
        if (isConnectorDescriptor(action)) return frameworkCall(connector, requestArgs, bound, spec.name);
        return callConnector(
          connector,
          requestLike(action, spec),
          requestArgs === undefined ? callArgs : requestArgs,
          bound
        );
      };

      if (typeof spec.run === 'function') {
        try {
          return await spec.run(callArgs, bound);
        } catch (err) {
          // A refusal already reads as a full sentence; anything else is a
          // connector that threw, and it still has to leave the model with
          // something to read — and must not read as a success.
          if (err && err.klaudRefusal) return reasonOf(err);
          const detail = reasonOf(err).replace(/\s*\.*\s*$/, '.');
          return `The ${connector.label || connector.id} action "${spec.name}" failed: ${detail} Nothing was confirmed as sent.`;
        }
      }
      return callConnector(connector, spec, callArgs, bound);
    },
  };
}

/**
 * One umbrella tool per connector the registry exposes.
 *
 * Every connector is offered, connected or not: a tool that is absent tells the
 * model nothing, while a tool whose description says to run connect_service
 * first lets it hand the user the connector's own setup instructions. The call
 * itself refuses to send anything without a credential.
 */
function listServiceTools(overrides) {
  const deps = depsOf(overrides);
  return connectorsOf(deps.registry).map((connector) => serviceTool(connector, deps));
}

/* ------------------------------------------------------------------ *
 * Authorization tools
 * ------------------------------------------------------------------ */

function serviceNotFound(registry, wanted) {
  const available = connectorsOf(registry);
  const list = available.length
    ? `Available services: ${available.map((c) => `${c.id} (${c.label || c.id})`).join(', ')}.`
    : 'No connectors are installed in this build, so there is nothing to connect.';
  return `Unknown service "${wanted}". ${list}`;
}

function serviceIds(registry) {
  const available = connectorsOf(registry);
  return available.length ? ` One of: ${available.map((c) => c.id).join(', ')}.` : '';
}

/** The setup instructions a user needs, and the reason it failed, in one line. */
function connectFailure(connector, why, statuses) {
  return [
    `Could not connect ${connector.label || connector.id}, so no credential was stored.`,
    why ? `Reason: ${why}` : '',
    text(connector.setupHint) ? `Setup: ${text(connector.setupHint)}` : '',
    statuses.length ? `Progress: ${statuses.slice(-4).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function authToolDefinitions(overrides) {
  const deps = depsOf(overrides);

  return [
    {
      name: 'list_connections',
      permission: 'read',
      description:
        'List the services Klaud is connected to, the account for each, and whether the access token is still valid. Never returns a token value.',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        return connectionListing(deps);
      },
    },

    {
      name: 'connect_service',
      // It stores a credential on this machine, so it is a write, not a read.
      permission: 'write',
      description:
        'Connect a service account, so Klaud can act on that service as the user. Opens the authorization flow in the browser; the credential is stored on this machine only. If the service needs an OAuth client that does not exist yet, the failure explains what to create.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: `The service id to connect.${serviceIds(deps.registry)}` },
        },
        required: ['service'],
      },
      async run(args) {
        const wanted = text(args && args.service).toLowerCase();
        const connector = connectorById(deps.registry, wanted);
        if (!connector) throw new Error(serviceNotFound(deps.registry, wanted || '(none given)'));

        if (!deps.oauth || typeof deps.oauth.startAuthorization !== 'function') {
          throw new Error(
            `Connecting ${connector.label || connector.id} needs the authorization module, which is not installed in ` +
              `this build, so no credential was stored.` +
              (text(connector.setupHint) ? ` Setup: ${text(connector.setupHint)}` : '')
          );
        }

        // A flow that opens a browser is slow and reports progress. Those lines
        // are the only channel back to the user, so they are kept and shown if
        // it fails.
        const statuses = [];
        const onStatus = (status) => {
          const line = text(status);
          if (line) statuses.push(line);
        };

        let result = null;
        try {
          result = await deps.oauth.startAuthorization({ connector, onStatus });
        } catch (err) {
          throw new Error(connectFailure(connector, reasonOf(err), statuses));
        }

        if (result && result.ok === false) {
          // The flow reports its failures as values, with a hint that is often
          // the difference between "create an OAuth client" and "grant a scope".
          const why = [text(result.error), text(result.hint)].filter(Boolean).join(' — ');
          throw new Error(connectFailure(connector, why || 'the authorization was refused', statuses));
        }

        // Success is judged by the stored credential, not by the return value:
        // flows answer with a connection, with `{ok, connection}` or with a
        // status line, and "a credential is now stored" is the only claim that is
        // true regardless of which. A store that cannot be written is reported as
        // what it is — connected for this session, not for the next one.
        const stored = await connectionFor(deps.oauth, connector.id);
        if (!stored && !(result && result.ok === true)) {
          throw new Error(
            connectFailure(connector, 'the authorization flow finished but no credential was stored', statuses)
          );
        }

        const who = stored && stored.account ? ` as ${stored.account}` : '';
        const actions = actionsOf(connector);
        const available = actions.length
          ? actions.map((a) => `${a.name} (${a.permission})`).join(', ')
          : 'none — this connector declares no actions';
        const warnings = result && Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
        return [
          `Connected ${connector.label || connector.id}${who}. The credential is stored on this machine only.`,
          `Actions now available through use_${connector.id}: ${available}.`,
          'Ask the user before any action with permission "send" — it goes out as them.',
          warnings.length ? `\nWhat the user should know about where the token is kept:\n- ${warnings.join('\n- ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      },
    },

    {
      name: 'disconnect_service',
      permission: 'write',
      description:
        'Delete the stored credential for a service, so Klaud can no longer act on it as the user. Say so plainly: this is the way to undo a connection.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'The service id to disconnect, as shown by list_connections.' },
        },
        required: ['service'],
      },
      async run(args) {
        const wanted = text(args && args.service).toLowerCase();
        const connector = connectorById(deps.registry, wanted);
        if (!connector) throw new Error(serviceNotFound(deps.registry, wanted || '(none given)'));

        if (!deps.oauth || typeof deps.oauth.deleteConnection !== 'function') {
          throw new Error(
            `Disconnecting ${connector.label || connector.id} needs the authorization module, which is not installed in this build.`
          );
        }

        const stored = await connectionFor(deps.oauth, connector.id);
        if (!stored) {
          return `${connector.label || connector.id} is not connected, so there was no stored credential to delete. Nothing changed.`;
        }

        // The store keys connections by connector id; the record's own id is only
        // used when it is the more specific of the two.
        const key = stored.connectorId || stored.id || connector.id;
        let removed = true;
        try {
          removed = await deps.oauth.deleteConnection(key);
        } catch (err) {
          throw new Error(
            `Could not delete the stored credential for ${connector.label || connector.id}: ${reasonOf(err)}. ` +
              `It is still on this machine, so the connection still works.`
          );
        }
        if (removed === false) {
          return `${connector.label || connector.id} was listed as connected but had no stored credential to delete. Nothing changed.`;
        }

        const who = stored.account ? ` (${stored.account})` : '';
        return (
          `Disconnected ${connector.label || connector.id}${who}: the stored credential was deleted. ` +
          `Klaud can no longer act on ${connector.label || connector.id} as that account until it is connected again.`
        );
      },
    },
  ];
}

module.exports = {
  listServiceTools,
  authToolDefinitions,
  describeConnectionsForPrompt,
  callConnector,
};

/* Registered here as well as on every turn, and both are needed.
 *
 * `agent.js` re-registers per turn, which is idempotent and is what picks up a
 * connector that appears while Klaud is running. This call exists for the other
 * half of the promise: the server answers GET /api/info with the tool catalogue
 * before any turn has run, and a session that cannot see `connect_service` in
 * that list looks like a build with no way to connect a service at all. Loading
 * this module is enough, because the agent loop requires it.
 *
 * Nothing here can throw: the registry is read defensively and a missing one
 * simply registers the three credential tools. */
registerTools([...authToolDefinitions(), ...listServiceTools()]);
