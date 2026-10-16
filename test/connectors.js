'use strict';

/**
 * The connector registry.
 *
 *   node test/connectors.js
 *
 * A connector can arrive from anywhere and is loaded by filename, so most of
 * what matters here is refusal: an unsafe id, a missing action, a file that
 * throws on load, two connectors claiming the same id. None of those may take
 * the others down, and none may escape the connections directory.
 *
 * Fixtures are written to a temporary directory pointed at by
 * KLAUD_CONNECTOR_DIR, so nothing is ever written into the real source tree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const REGISTRY_PATH = require.resolve('../src/lib/connectors.js');

let pass = 0;
let fail = 0;
const failures = [];
let group = '';

const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`    \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push({ group, name, detail });
    console.log(`    \x1b[31mx\x1b[0m ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

const describe = (name, fn) => {
  group = name;
  console.log(`\n  \x1b[1m${name}\x1b[0m`);
  return fn();
};

/* ------------------------------------------------------------------ *
 * A registry instance bound to a given directory
 * ------------------------------------------------------------------ */

let tmpDir;

/**
 * Load a fresh copy of the registry against `dir`.
 *
 * The module reads KLAUD_CONNECTOR_DIR once at load time, so a fresh require is
 * needed per fixture set. Deleting the cache entry is what makes that honest,
 * rather than a shared module the tests mutate behind each other's backs.
 */
function freshRegistry(dir) {
  process.env.KLAUD_CONNECTOR_DIR = dir;
  for (const key of Object.keys(require.cache)) {
    if (key === REGISTRY_PATH || key.startsWith(path.join(dir, path.sep))) delete require.cache[key];
  }
  // eslint-disable-next-line global-require
  return require(REGISTRY_PATH);
}

/** Write connector modules into the current fixture directory. */
function writeConnector(file, source) {
  fs.writeFileSync(path.join(tmpDir, file), source, 'utf8');
}

const VALID = `
exports.descriptor = {
  id: 'demo',
  label: 'Demo',
  authUrl: 'https://example.com/auth',
  tokenUrl: 'https://example.com/token',
  scopes: ['demo.read'],
  actions: [{ name: 'look', label: 'Look', permission: 'read', run: async () => 'ok' }],
};
`;

/* ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud connector registry check\x1b[0m');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-connectors-'));

  await describe('loading', async () => {
    writeConnector('demo.js', VALID);
    const reg = freshRegistry(tmpDir);
    const list = reg.listConnectors();

    check('a well-formed connector is loaded', list.length === 1, JSON.stringify(list.map((c) => c.id)));
    check('its id is available', list[0] && list[0].id === 'demo');
    check('getConnector finds it by id', reg.getConnector('demo') !== null);
    check('getConnector is case-insensitive on the id', reg.getConnector('DEMO') !== null);
    check('an unknown id returns null rather than throwing', reg.getConnector('nope') === null);
    check('a clean directory reports no warnings', reg.connectorWarnings().length === 0,
      JSON.stringify(reg.connectorWarnings()));
  });

  await describe('refusing bad connectors', async () => {
    // Each of these is a separate reason to skip a file, and each must skip only
    // that file.
    writeConnector('broken-syntax.js', 'this is not valid javascript {{{');
    writeConnector('throws-on-load.js', 'throw new Error("boom at load time");');
    writeConnector('no-actions.js', `
      exports.descriptor = {
        id: 'noact', label: 'No actions',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
        scopes: ['x'], actions: [],
      };
    `);
    writeConnector('bad-permission.js', `
      exports.descriptor = {
        id: 'badperm', label: 'Bad perm',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
        scopes: ['x'],
        actions: [{ name: 'go', permission: 'destroy', run: async () => 'x' }],
      };
    `);
    writeConnector('no-scopes.js', `
      exports.descriptor = {
        id: 'noscopes', label: 'No scopes',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
        scopes: [], actions: [{ name: 'go', permission: 'read', run: async () => 'x' }],
      };
    `);
    writeConnector('traversal-id.js', `
      exports.descriptor = {
        id: '../../escape', label: 'Escape',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
        scopes: ['x'], actions: [{ name: 'go', permission: 'read', run: async () => 'x' }],
      };
    `);
    // A descriptor exported as the module itself rather than under .descriptor.
    writeConnector('bare-export.js', `
      module.exports = {
        id: 'bare', label: 'Bare',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
        scopes: ['x'], actions: [{ name: 'go', permission: 'read', run: async () => 'x' }],
      };
    `);
    // A non-module file that still ends in .js and should simply be ignored.
    writeConnector('_private.js', 'this file starts with an underscore and must be skipped {{{');

    const reg = freshRegistry(tmpDir);
    const ids = reg.listConnectors().map((c) => c.id);
    const warnings = reg.connectorWarnings().join('\n');

    check('the good connector still loads alongside seven bad files',
      ids.includes('demo'), ids.join(', '));
    check('a file that throws on load does not take the registry down',
      /boom at load time/.test(warnings), warnings);
    check('a syntax error is reported, not thrown',
      /broken-syntax/.test(warnings), warnings);
    check('a connector with no actions is refused',
      !ids.includes('noact') && /declares no actions/.test(warnings), warnings);
    check('an unknown permission is refused',
      !ids.includes('badperm') && /must be one of read, write, send/.test(warnings), warnings);
    check('a connector with no scopes is refused',
      !ids.includes('noscopes') && /at least one scope/.test(warnings), warnings);
    check('a traversal id is refused', !ids.includes('../../escape'), ids.join(', '));
    check('a bare module export is accepted', ids.includes('bare'), ids.join(', '));
    check('a leading-underscore file is skipped silently',
      !/_private/.test(warnings) && !ids.includes('_private'), warnings);
    check('warnings name the file so the problem is findable',
      /broken-syntax/.test(warnings) && /throws-on-load/.test(warnings), warnings);

    // A connector exporting its helpers alongside its descriptor must still load,
    // because that is the natural shape for a module that wants to be testable.
    writeConnector('split-export.js', `
      const descriptor = {
        id: 'split', label: 'Split',
        authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
      };
      const scopes = ['split.read'];
      const actions = [{ name: 'go', permission: 'read', run: async () => 'x' }];
      module.exports = { descriptor, scopes, actions, helper: () => 1 };
    `);
    const reg2 = freshRegistry(tmpDir);
    const ids2 = reg2.listConnectors().map((c) => c.id);
    check('a descriptor with sibling scopes and actions is assembled',
      ids2.includes('split'), ids2.join(', '));
    const split = reg2.getConnector('split');
    check('its scopes arrive', split && Array.isArray(split.scopes) && split.scopes.length === 1,
      JSON.stringify(split && split.scopes));
    check('its actions arrive', split && Array.isArray(split.actions) && split.actions.length === 1,
      JSON.stringify(split && split.actions && split.actions.length));
  });

  await describe('duplicate ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-connectors-dup-'));
    fs.writeFileSync(path.join(dir, 'a-demo.js'), VALID, 'utf8');
    fs.writeFileSync(path.join(dir, 'b-demo.js'), VALID.replace("'demo'", "'demo'"), 'utf8');
    const reg = freshRegistry(dir);
    const list = reg.listConnectors();
    check('only one connector survives a duplicate id', list.length === 1, JSON.stringify(list.map((c) => c.id)));
    check('the duplicate is reported', /already taken/.test(reg.connectorWarnings().join(' ')),
      reg.connectorWarnings().join(' '));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await describe('a missing directory', async () => {
    const missing = path.join(os.tmpdir(), `klaud-no-such-dir-${Date.now()}`);
    const reg = freshRegistry(missing);
    check('no connectors', reg.listConnectors().length === 0);
    check('and no error, because having no connectors is normal',
      reg.connectorWarnings().length === 0, JSON.stringify(reg.connectorWarnings()));
  });

  await describe('id safety', async () => {
    const reg = freshRegistry(tmpDir);
    // The id becomes a filename and a URL path segment, so this matters.
    check('a plain slug is safe', reg.isSafeId('gmail'));
    check('digits and dashes are safe', reg.isSafeId('google-workspace2'));
    check('an underscore is safe', reg.isSafeId('my_service'));
    check('uppercase is refused', reg.isSafeId('Gmail') === false);
    check('a slash is refused', reg.isSafeId('a/b') === false);
    check('a traversal is refused', reg.isSafeId('../../etc/passwd') === false);
    check('a leading dot is refused', reg.isSafeId('.hidden') === false);
    check('a leading digit is refused', reg.isSafeId('9lives') === false);
    check('an empty string is refused', reg.isSafeId('') === false);
    check('a non-string is refused', reg.isSafeId(null) === false && reg.isSafeId(42) === false);
    check('an over-long id is refused', reg.isSafeId('x'.repeat(64)) === false);
  });

  await describe('credential keys are namespaced', async () => {
    const reg = freshRegistry(tmpDir);
    const keys = reg.credentialKeys('gmail');
    check('the client id key is namespaced by connector',
      keys.clientId === 'gmail.clientId', JSON.stringify(keys));
    // Two connectors sharing a flat "clientId" key would silently overwrite each
    // other's credentials, which is the failure mode this prevents.
    check('two connectors cannot collide',
      reg.credentialKeys('gmail').clientId !== reg.credentialKeys('calendar').clientId);
  });

  await describe('the API root', async () => {
    writeConnector('rooted.js', `
      module.exports = {
        descriptor: {
          id: 'rooted', label: 'Rooted',
          authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
          baseUrl: 'https://api.example.com/v1',
          scopes: ['x'], actions: [{ name: 'go', permission: 'read', run: async () => 'x' }],
        },
      };
    `);
    writeConnector('rootless.js', `
      module.exports = {
        descriptor: {
          id: 'rootless', label: 'Rootless',
          authUrl: 'https://example.com/a', tokenUrl: 'https://example.com/t',
          scopes: ['x'], actions: [{ name: 'go', permission: 'read', run: async () => 'x' }],
        },
      };
    `);
    const reg = freshRegistry(tmpDir);

    check('a declared base URL is reported', reg.apiBaseUrlFor('rooted') === 'https://api.example.com/v1',
      reg.apiBaseUrlFor('rooted'));
    /* The request builder looks up a base URL on the descriptor OR through this
     * registry function. With only the first implemented, a connector declaring
     * its root elsewhere failed at request time with no route to the cause, so
     * the documented fallback has to actually exist. */
    check('a connector with no root reports empty rather than throwing',
      reg.apiBaseUrlFor('rootless') === '', JSON.stringify(reg.apiBaseUrlFor('rootless')));
    check('an unknown connector reports empty', reg.apiBaseUrlFor('nope') === '');
    check('the answer can be derived from a descriptor directly',
      reg.apiBaseUrlOf({ apiBaseUrl: 'https://other.example.com' }) === 'https://other.example.com');
    check('a non-object descriptor is handled', reg.apiBaseUrlOf(null) === '');
  });

  await describe('the real connectors directory', async () => {
    // The shipped connectors must satisfy the same validation as the fixtures.
    delete process.env.KLAUD_CONNECTOR_DIR;
    for (const key of Object.keys(require.cache)) {
      if (key === REGISTRY_PATH) delete require.cache[key];
    }
    // eslint-disable-next-line global-require
    const real = require(REGISTRY_PATH);
    const ids = real.listConnectors().map((c) => c.id);
    check('any shipped connector has a safe id',
      ids.every((id) => real.isSafeId(id)), ids.join(', '));
    check('shipped connectors report no problems',
      real.connectorWarnings().length === 0, real.connectorWarnings().join(' | '));
    for (const id of ids) {
      // Without an API root the request builder fails before any HTTP, with a
      // message that names neither the connector's file nor the fix.
      check(`the shipped ${id} connector resolves an API root`,
        Boolean(real.apiBaseUrlFor(id)), JSON.stringify(real.apiBaseUrlFor(id)));
    }
    console.log(`      loaded: ${ids.length ? ids.join(', ') : '(none yet)'}`);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} connector registry checks failed\x1b[0m`);
    for (const f of failures) console.log(`  - [${f.group}] ${f.name}: ${f.detail}`);
    console.log('');
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} connector registry checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nThe connector registry suite crashed:', err);
  process.exit(1);
});
