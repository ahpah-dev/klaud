'use strict';

/**
 * The connector registry.
 *
 * A connector is one third-party service Klaud can act against **as the user**,
 * once they have authorized it: Gmail today, anything else that speaks OAuth 2.0
 * and has a REST API later.
 *
 * Two design choices worth stating, because they are not obvious.
 *
 * 1. **A connector is loaded, not installed.** There is no package manager here
 *    and no npm dependency is allowed, so a connector is a module in
 *    `src/lib/connectors/`. Loading is defensive per file: one connector with a
 *    syntax error or a bad descriptor must not remove the others, and it must
 *    not stop the server booting. The failure is reported as a warning on the
 *    panel instead, which is where a user can act on it.
 *
 * 2. **Credentials are not part of the descriptor.** A descriptor is static code;
 *    the client id and secret belong to the user and live in settings. Keeping
 *    them apart means the registry can be built before any account exists, and
 *    `configured` can be answered honestly rather than by attempting a request.
 */

const fs = require('fs');
const path = require('path');

/**
 * Where connector modules live.
 *
 * Overridable by environment so the test suite can point at a temporary
 * directory. Without that, testing "a broken connector is skipped" would mean
 * writing deliberately broken files into the real source tree and hoping the
 * cleanup ran — which is how a test suite ends up shipping a broken connector.
 */
const CONNECTOR_DIR = process.env.KLAUD_CONNECTOR_DIR
  ? path.resolve(process.env.KLAUD_CONNECTOR_DIR)
  : path.join(__dirname, 'connectors');

/** Everything a descriptor must provide for the framework to work with it. */
const REQUIRED_FIELDS = ['id', 'label', 'authUrl', 'tokenUrl'];

/** Action permissions, weakest first. `send` is not reversible, so it is last. */
const PERMISSIONS = ['read', 'write', 'send'];

let cached = null;

/**
 * A connector id becomes a filename and a URL segment, so it has to be a slug.
 * A descriptor with `id: '../../etc/passwd'` would otherwise escape the
 * connections directory, which is exactly the kind of thing a third-party
 * connector file could contain.
 */
function isSafeId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]{1,40}$/.test(id);
}

function validate(descriptor, file) {
  const problems = [];
  if (!descriptor || typeof descriptor !== 'object') {
    return [`${file} did not export a descriptor object`];
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof descriptor[field] !== 'string' || !descriptor[field]) {
      problems.push(`${file} is missing a string "${field}"`);
    } else if (field === 'id' && !isSafeId(descriptor[field])) {
      problems.push(`${file} has an unsafe id "${descriptor[field]}" — use lowercase letters, digits, dash or underscore`);
    }
  }
  if (!Array.isArray(descriptor.scopes) || !descriptor.scopes.length) {
    problems.push(`${file} must declare at least one scope`);
  }
  if (!Array.isArray(descriptor.actions) || !descriptor.actions.length) {
    problems.push(`${file} declares no actions, so connecting it would achieve nothing`);
  } else {
    for (const action of descriptor.actions) {
      if (!action || !action.name || typeof action.run !== 'function') {
        problems.push(`${file} has an action without a name or a run function`);
        continue;
      }
      if (!PERMISSIONS.includes(action.permission)) {
        problems.push(
          `${file} action "${action.name}" has permission "${action.permission}" — must be one of ${PERMISSIONS.join(', ')}`
        );
      }
    }
  }
  return problems;
}

/**
 * Load every connector, reporting problems rather than throwing.
 *
 * `require` is inside the try so a connector that throws on load (a bad top-level
 * expression, a missing sibling module) is contained. Without that, one broken
 * file takes the whole feature down with a stack trace the user cannot act on.
 */
function loadConnectors() {
  if (cached) return cached;

  const connectors = [];
  const warnings = [];

  let entries = [];
  try {
    entries = fs
      .readdirSync(CONNECTOR_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`Could not read the connectors directory: ${err.message}`);
    cached = { connectors, warnings };
    return cached;
  }

  for (const file of entries) {
    let descriptor = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(path.join(CONNECTOR_DIR, file));
      /* Both export shapes are accepted on purpose. A connector naturally wants
       * to export its helpers for testing alongside its descriptor, so a module
       * may either put `actions` and `scopes` inside `descriptor` or export them
       * as siblings of it. Requiring one of the two would be a trap discovered
       * only by running the thing. */
      const base = mod && mod.descriptor ? mod.descriptor : mod && mod.default ? mod.default : mod;
      descriptor = base && typeof base === 'object' ? { ...base } : base;
      if (descriptor && typeof descriptor === 'object' && mod) {
        if (!descriptor.actions && Array.isArray(mod.actions)) descriptor.actions = mod.actions;
        if (!descriptor.scopes && Array.isArray(mod.scopes)) descriptor.scopes = mod.scopes;
      }
    } catch (err) {
      warnings.push(`Could not load the ${file.replace(/\.js$/, '')} connector: ${err.message}`);
      continue;
    }

    const problems = validate(descriptor, file);
    if (problems.length) {
      warnings.push(...problems);
      continue;
    }

    const existing = connectors.find((c) => c.id === descriptor.id);
    if (existing) {
      warnings.push(`${file} declares the id "${descriptor.id}", which is already taken; ignoring it`);
      continue;
    }

    connectors.push(descriptor);
  }

  cached = { connectors, warnings };
  return cached;
}

function listConnectors() {
  return loadConnectors().connectors;
}

function getConnector(id) {
  const wanted = String(id || '').trim().toLowerCase();
  return loadConnectors().connectors.find((c) => c.id === wanted) || null;
}

function connectorWarnings() {
  return loadConnectors().warnings;
}

/** Forget the cache. For tests, and for a connector added while running. */
function resetConnectors() {
  cached = null;
  // Drop the connector modules too, or a fixture change in a test would be
  // invisible after the first load.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(CONNECTOR_DIR + path.sep)) delete require.cache[key];
  }
}

/**
 * The settings keys one connector needs, e.g. `gmail.clientId`.
 *
 * Namespaced rather than a flat `clientId` so two connectors cannot overwrite
 * each other's credentials, which would silently connect the wrong account.
 */
function credentialKeys(id) {
  return { clientId: `${id}.clientId`, clientSecret: `${id}.clientSecret` };
}

/**
 * The API root to send this connector's requests to.
 *
 * The request builder looks for a base URL in two places: on the descriptor, or
 * through one of these functions on the registry. Only the first existed, so a
 * descriptor that put its base URL anywhere else failed at request time with
 * "declares no baseUrl" and no way to find out why. These exist so the documented
 * fallback is real.
 */
function apiBaseUrlFor(id) {
  const connector = getConnector(id);
  if (!connector) return '';
  return apiBaseUrlOf(connector);
}

/** The same answer from a descriptor you already hold. */
function apiBaseUrlOf(connector) {
  if (!connector || typeof connector !== 'object') return '';
  for (const field of ['baseUrl', 'apiBaseUrl', 'baseURL', 'apiUrl', 'endpoint']) {
    const value = connector[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

module.exports = {
  listConnectors,
  getConnector,
  connectorWarnings,
  resetConnectors,
  credentialKeys,
  apiBaseUrlFor,
  apiBaseUrlOf,
  isSafeId,
  validate,
  PERMISSIONS,
  CONNECTOR_DIR,
};
