'use strict';

/**
 * The connections API: which services Klaud can act on as you, and the three
 * actions that change that.
 *
 * Kept out of server.js because that file is already the router, the SSE host and
 * the boot sequence, and this is a self-contained feature with its own failure
 * modes. Nothing here requires server.js, so there is no cycle.
 *
 * Two decisions worth knowing, because the alternatives are worse:
 *
 * 1. **Starting an authorization is not a request/response cycle.** The user has
 *    to leave for a browser, sign in, and click Allow. A request held open that
 *    long looks like a hang and dies behind a proxy. So the flow runs in the
 *    background, this endpoint returns immediately, and the panel finds out how
 *    it went by listing connections — which also means a page reload mid-flow
 *    does not lose the result.
 *
 * 2. **No credential configured is the normal first state**, not an error. Most
 *    users have no OAuth client registered yet, so the payload carries the setup
 *    hint rather than a Connect button that cannot possibly work.
 */

const oauth = require('./oauth');
const registry = require('./connectors');
const store = require('../store');

/** In-flight authorizations, keyed by connector id. */
const flows = new Map();

/**
 * Every connector, with whether it is usable and what is connected to it.
 *
 * `configured` is answered from the stored credentials rather than by attempting
 * a request, so the panel can say "you have not registered a client yet" without
 * a network round trip that would fail for that reason and be indistinguishable
 * from the service being down.
 */
async function describe({ includeSetupHint = true } = {}) {
  const settings = await store.loadSettings();
  let connections = [];
  try {
    connections = await oauth.listConnections();
  } catch (err) {
    connections = [];
    registryProblem(`Could not read stored connections: ${err.message}`);
  }

  const warnings = registry.connectorWarnings().slice();
  const globalProblems = _problems;
  _problems = [];

  const available = registry.listConnectors().map((connector) => {
    const conn = connections.find((c) => c.id === connector.id) || null;
    const keys = registry.credentialKeys(connector.id);
    const clientId = readCredential(settings, keys.clientId);
    const clientSecret = readCredential(settings, keys.clientSecret);
    const inFlight = flows.get(connector.id);

    return {
      id: connector.id,
      label: connector.label,
      configured: Boolean(clientId),
      needsSecret: Boolean(clientId) && !clientSecret && connector.requiresSecret !== false,
      connected: Boolean(conn && conn.connected),
      account: (conn && conn.account) || null,
      expired: Boolean(conn && conn.expired),
      needsReconnect: Boolean(conn && (conn.needsReconnect || conn.expired)),
      scopes: Array.isArray(connector.scopes) ? connector.scopes : [],
      // The panel shows this whenever a Connect button would be misleading.
      setupHint: includeSetupHint ? connector.setupHint || defaultSetupHint(connector) : null,
      actions: (connector.actions || []).map((a) => ({
        name: a.name,
        label: a.label || a.name,
        permission: a.permission,
      })),
      connecting: inFlight ? inFlight.status : null,
      connectError: inFlight && inFlight.error ? inFlight.error : null,
    };
  });

  /* Returns the payload, not a `{status, body}` envelope. It used to return the
   * envelope and `listHandler` wrapped it a second time, so every field the
   * client read (`available`, `connections`, `credentials`) was one level too
   * deep and the panel rendered empty from a perfectly good response. The
   * envelope belongs to the HTTP layer, and only there. */
  return {
    available,
    connections,
    warnings: warnings.concat(globalProblems),
    // What Settings must collect before Connect can work at all. Returned as
    // field descriptors rather than a hardcoded Gmail form, so a connector
    // added later gets the same treatment without touching the client.
    credentials: registry.listConnectors().map((connector) => {
      const keys = registry.credentialKeys(connector.id);
      return {
        id: connector.id,
        label: connector.label,
        keys,
        clientId: readCredential(settings, keys.clientId),
        // A boolean, never the value. The secret must not reach the browser at
        // all, which is why `/api/settings` redacts it too.
        hasClientSecret: Boolean(readCredential(settings, keys.clientSecret)),
        setupHint: connector.setupHint || defaultSetupHint(connector),
      };
    }),
  };
}

/* Registry problems surfaced through the per-request channel, because the
 * registry caches its warnings and a caller that reads them twice would report
 * the same problem twice. */
let _problems = [];
function registryProblem(message) {
  if (!_problems.includes(message)) _problems.push(message);
}

function readCredential(settings, dottedKey) {
  if (!settings || typeof settings !== 'object') return '';
  const direct = settings[dottedKey];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  // Also accept a nested object, so settings can group a connector's credentials.
  const [head, tail] = String(dottedKey).split('.');
  const nested = settings[head];
  if (nested && typeof nested === 'object' && typeof nested[tail] === 'string') {
    return nested[tail].trim();
  }
  return '';
}

function defaultSetupHint(connector) {
  return (
    `${connector.label} needs an OAuth client that belongs to you — Klaud cannot ship one, ` +
    `because a client secret in a public repository is not a secret. Create one in the ` +
    `${connector.label} developer console, then add its client ID in Settings.`
  );
}

/** The connector descriptor plus the user's credentials, ready for the framework. */
async function configuredConnector(id) {
  const connector = registry.getConnector(id);
  if (!connector) return { ok: false, error: `There is no "${id}" connector.` };
  const settings = await store.loadSettings();
  const keys = registry.credentialKeys(connector.id);
  const clientId = readCredential(settings, keys.clientId);
  if (!clientId) {
    return {
      ok: false,
      error: `${connector.label} has no OAuth client configured yet.`,
      hint: connector.setupHint || defaultSetupHint(connector),
    };
  }
  return {
    ok: true,
    connector: {
      ...connector,
      clientId,
      clientSecret: readCredential(settings, keys.clientSecret),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function listHandler() {
  const described = await describe();
  return { status: 200, body: described };
}

/**
 * Begin an authorization. Returns as soon as the flow has started, with the URL
 * the user should be sent to; the outcome arrives through the listing.
 */
async function connectHandler(id) {
  const ready = await configuredConnector(id);
  if (!ready.ok) {
    // 400, and the hint travels with it: this is the state every first-time user
    // is in, and it has to be actionable rather than a generic failure.
    return { status: 400, body: { error: ready.error, hint: ready.hint || null } };
  }

  const existing = flows.get(ready.connector.id);
  if (existing && existing.status !== 'failed' && existing.status !== 'done') {
    return { status: 409, body: { error: `An authorization for ${ready.connector.label} is already in progress.` } };
  }

  const flow = { status: 'starting', url: null, error: null, startedAt: Date.now(), messages: [] };
  flows.set(ready.connector.id, flow);

  /* Deliberately not awaited. The user is about to spend a minute in a browser,
   * and holding the response open for that is how a request becomes a timeout. */
  oauth
    .startAuthorization({
      connector: ready.connector,
      onStatus: (message) => {
        flow.status = 'waiting';
        flow.messages.push(String(message));
        // The URL is reported so the panel can show a link for anyone whose
        // browser did not open, rather than leaving them with a spinner.
        const found = String(message).match(/https?:\/\/\S+/);
        if (found && !flow.url) flow.url = found[0];
      },
    })
    .then((result) => {
      if (result && result.ok) {
        flow.status = 'done';
        flow.messages.push('Connected.');
      } else {
        flow.status = 'failed';
        flow.error = (result && result.error) || 'The authorization did not complete.';
        flow.hint = (result && result.hint) || null;
      }
    })
    .catch((err) => {
      flow.status = 'failed';
      flow.error = err && err.message ? err.message : String(err);
    });

  return {
    status: 202,
    body: {
      started: true,
      id: ready.connector.id,
      // Answered immediately; the listing carries the real progress.
      status: flow.status,
      hint: 'A browser window should have opened. Approve access there, then come back — this panel updates itself.',
    },
  };
}

async function disconnectHandler(id) {
  const connector = registry.getConnector(id);
  if (!connector) return { status: 404, body: { error: `There is no "${id}" connector.` } };

  // Stop any flow still waiting, or a callback arriving afterwards would write a
  // credential the user just asked to remove.
  flows.delete(connector.id);

  try {
    const removed = await oauth.deleteConnection(connector.id);
    return {
      status: 200,
      body: {
        id: connector.id,
        disconnected: true,
        // Honest about the no-op case: "disconnected" when nothing was connected
        // reads as though something was removed.
        wasConnected: Boolean(removed),
        message: removed
          ? `${connector.label} has been disconnected and its stored credential deleted.`
          : `${connector.label} was not connected, so there was nothing to remove.`,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: `Could not disconnect ${connector.label}: ${err.message}` } };
  }
}

/** Per-connector progress, for a panel that wants finer detail than the list. */
async function statusHandler(id) {
  const connector = registry.getConnector(id);
  if (!connector) return { status: 404, body: { error: `There is no "${id}" connector.` } };
  const flow = flows.get(connector.id);
  return {
    status: 200,
    body: {
      id: connector.id,
      connecting: flow ? flow.status : null,
      url: flow ? flow.url : null,
      error: flow && flow.error ? flow.error : null,
      hint: flow && flow.hint ? flow.hint : null,
      messages: flow ? flow.messages.slice(-5) : [],
    },
  };
}

/**
 * Handle a connections request, or return null so the caller can keep routing.
 *
 * Matching `null` rather than a boolean keeps server.js's existing
 * `if (handled) return true` chain working without a special case.
 */
async function handle(method, pathname) {
  if (!pathname.startsWith('/api/connections')) return null;

  if (pathname === '/api/connections' && method === 'GET') return listHandler();

  const rest = pathname.slice('/api/connections/'.length);
  const match = rest.match(/^([a-z0-9_-]+)(?:\/(connect|status))?$/);
  if (!match) return { status: 404, body: { error: 'Unknown connections endpoint.' } };

  const [, id, action] = match;

  if (action === 'connect' && method === 'POST') return connectHandler(id);
  if (action === 'status' && method === 'GET') return statusHandler(id);
  if (!action && method === 'DELETE') return disconnectHandler(id);

  return {
    status: 405,
    body: { error: `${method} is not allowed on ${pathname}.` },
  };
}

/** For tests: forget in-flight flows. */
function _resetFlows() {
  flows.clear();
  _problems = [];
}

module.exports = { handle, describe, _resetFlows, flows };
