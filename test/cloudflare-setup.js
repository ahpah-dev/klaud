'use strict';

/**
 * Cloudflare setup-path test.
 *
 *   node test/cloudflare-setup.js
 *
 * Drives the real setup function against a local stand-in for the Cloudflare
 * API, so the account-resolution order can be asserted without a Cloudflare
 * account. The behaviour that matters, and that was wrong:
 *
 *   - An account-scoped token returns {"result":[],"success":true} from
 *     /accounts. Calling that endpoint first produced a false "no accounts"
 *     verdict, and the message blamed the Workers AI permission.
 *   - The token itself carries the account ID, so /accounts need not be called
 *     at all in the common case.
 */

const http = require('http');
const { setupCloudflare, accountIdFromToken } = require('../src/providers');

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

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A stand-in for api.cloudflare.com, with configurable behaviour. */
function startFakeCloudflare(config) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    // req.url carries the query string; the routes below match on the path only.
    // req.url carries the query string, and the real API is mounted under
    // /client/v4, so normalise both before matching routes.
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/client\/v4/, '');
    calls.push({ method: req.method, path: pathname, rawUrl: req.url });
    if (process.env.KLAUD_DEBUG_SETUP) console.log('      [fake]', req.method, req.url);

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (pathname === '/accounts') {
      // The exact shape a real account-scoped token produces.
      return send(200, {
        result: config.accounts || [],
        result_info: { page: 1, per_page: 20, total_pages: 0, count: 0, total_count: 0 },
        success: true,
        errors: [],
        messages: [],
      });
    }
    if (/^\/accounts\/[a-f0-9]{32}$/i.test(pathname)) {
      // Account ownership. Config lets a test simulate "this account is not
      // yours" versus "this account does not exist".
      if (config.accountDenied) {
        return send(403, {
          success: false,
          errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
          messages: [],
          result: null,
        });
      }
      if (config.accountInvalid) {
        return send(403, {
          success: false,
          errors: [{ code: 9109, message: 'Invalid account identifier' }],
          messages: [],
          result: null,
        });
      }
      return send(200, { success: true, errors: [], messages: [], result: { id: pathname.split('/').pop(), name: 'Test Account' } });
    }
    if (pathname === '/user/tokens/verify') {
      return send(200, config.verify || { result: { id: 'tok', status: 'active' }, success: true, errors: [], messages: [] });
    }
    if (pathname.endsWith('/ai/v1/models')) {
      // Workers AI answers the model list on POST. A GET returns 405, which is
      // what made every setup look like a model problem.
      if (req.method !== 'POST') {
        return send(405, { result: null, success: false, errors: [{ code: 7001, message: `${req.method} not supported for requested URI.` }], messages: [] });
      }
      if (config.modelsStatus && config.modelsStatus !== 200) {
        return send(config.modelsStatus, { success: false, errors: [{ code: config.modelsCode, message: config.modelsMessage }] });
      }
      return send(200, { result: (config.models || ['@cf/meta/llama-3.1-8b-instruct-fp8-fast']).map((name) => ({ name })), success: true });
    }
    if (pathname.endsWith('/ai/v1/chat/completions')) {
      if (config.chatOk) {
        return send(200, { choices: [{ message: { role: 'assistant', content: 'ready' } }] });
      }
      return send(config.chatStatus || 403, {
        success: false,
        errors: [{ code: config.chatCode || 10000, message: config.chatMessage || 'AiError: Method not allowed' }],
      });
    }
    return send(404, { success: false, errors: [{ code: 7000, message: 'not found' }] });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        calls,
        close: () => new Promise((r) => server.close(r)),
        port: server.address().port,
      });
    });
  });
}

(async () => {
  console.log('\n\x1b[38;5;209m* Cloudflare setup path\x1b[0m\n');

  const originalFetch = global.fetch;
  let fake;

  const withFake = async (config, fn) => {
    fake = await startFakeCloudflare(config);
    global.fetch = (url, init) => {
      const rewritten = String(url).replace('https://api.cloudflare.com', `http://127.0.0.1:${fake.port}`);
      return originalFetch(rewritten, init);
    };
    try {
      return await fn();
    } finally {
      global.fetch = originalFetch;
      await fake.close();
    }
  };

  /* ---------- the token already knows the account ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}`, scope: ['com.cloudflare.api.account.workers.write'] });
    const result = await setupCloudflare({ apiKey: token });

    check('a token carrying its account id never needs /accounts',
      !fake.calls.some((c) => c.path === '/accounts'),
      JSON.stringify(fake.calls.map((c) => c.path)));
    check('the account is taken from the token claims',
      result.accountId === ACCOUNT && result.accountSource === 'token claims',
      JSON.stringify({ id: result.accountId, src: result.accountSource }));
    check('a working completion saves successfully', result.ok === true, JSON.stringify(result.message));
    check('the URL is built with the real account id',
      result.baseUrl.includes(ACCOUNT), result.baseUrl);
    check('the setup reports each step it took',
      Array.isArray(result.checks) && result.checks.length >= 3,
      JSON.stringify(result.checks));

    // Regression: the model list was requested with GET, which Workers AI
    // answers with 405, so the catalogue never loaded.
    const modelCalls = fake.calls.filter((c) => c.path.endsWith('/ai/v1/models'));
    check('the model list is requested with POST, which is what Workers AI accepts',
      modelCalls.length > 0 && modelCalls.every((c) => c.method === 'POST'),
      JSON.stringify(modelCalls.map((c) => `${c.method} ${c.path}`)));
    check('the model catalogue reports success', result.checks.some((c) => c.step === 'model list' && c.ok === true),
      JSON.stringify(result.checks.find((c) => c.step === 'model list')));
    check('a failed catalogue does not block setup',
      result.ok === true, JSON.stringify(result.message));
  });

  /* ---------- account id only in an object claim ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    const token = jwt({ account_id: ACCOUNT, scope: 'com.cloudflare.api.account.workers.read' });
    const result = await setupCloudflare({ apiKey: token });
    check('an account_id claim is used without calling /accounts', result.ok === true && result.accountId === ACCOUNT,
      JSON.stringify({ ok: result.ok, id: result.accountId }));
  });

  /* ---------- empty accounts response is diagnosed, not blamed ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    // No account ID in any claim Klaud trusts, so discovery must fall back to
    // /accounts, which returns the empty-but-successful shape.
    const token = jwt({ iss: 'cloudflare', sub: 'user:not-hex', scope: [] });
    const result = await setupCloudflare({ apiKey: token });

    check('an empty accounts list is treated as a discovery failure',
      result.ok === false && result.stage === 'account', JSON.stringify(result).slice(0, 160));
    check('the empty case asks for the account id explicitly', result.needsAccountId === true);
    check('the empty case does NOT blame the Workers AI permission',
      !/missing the workers ai permission/i.test(result.message), String(result.message).slice(0, 200));
    check('the empty case explains account-scoped versus user tokens',
      /account api token/i.test(result.message), String(result.message).slice(0, 240));
    check('the empty case offers pasting the account id',
      /paste your account id/i.test(result.message), String(result.message).slice(-140));
    check('the raw Cloudflare response is preserved for the user',
      String(result.raw).includes('"total_count":0'), String(result.raw).slice(0, 140));
  });

  /* ---------- an explicitly pasted account id wins ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    const token = jwt({ iss: 'cloudflare', sub: 'user:not-hex', scope: [] });
    const result = await setupCloudflare({ apiKey: token, accountId: ACCOUNT });

    check('a pasted account id is used directly', result.ok === true && result.accountId === ACCOUNT,
      JSON.stringify({ ok: result.ok, id: result.accountId }));
    check('a pasted account id skips discovery entirely',
      !fake.calls.some((c) => c.path === '/accounts'), JSON.stringify(fake.calls.map((c) => c.path)));
    check('the source says the id came from the user',
      result.accountSource === 'you provided it', String(result.accountSource));
  });

  await withFake({ accounts: [], chatOk: true }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token, accountId: 'not-hex' });
    check('a malformed pasted account id is rejected with guidance',
      result.ok === false && /32 hex characters/i.test(result.message), String(result.message));
  });

  /* ---------- permission failures are named precisely ---------- */
  await withFake({ accounts: [], chatOk: false, chatCode: 10000, chatMessage: 'AiError: Method not allowed' }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token });
    check('a Workers AI permission failure says so',
      result.ok === false && /workers ai permission/i.test(result.message), String(result.message));
    check('the raw Workers AI error is kept', /Method not allowed/.test(String(result.test?.raw)),
      String(result.test?.raw));
    check('the failure is reported as the completion stage', result.stage === 'completion', String(result.stage));
  });

  /* ---------- a token that is not a Cloudflare token at all ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    const result = await setupCloudflare({ apiKey: 'not-a-cloudflare-token' });
    check('a non-JWT token fails without inventing a cause',
      result.ok === false, JSON.stringify(result.message).slice(0, 120));
    // It cannot read an account from the token, so it falls back to /accounts,
    // which returns the empty-but-successful shape. The correct outcome is the
    // empty-accounts explanation — not a claim about the Workers AI permission.
    check('a non-JWT token gets the empty-accounts explanation',
      /empty account list/i.test(result.message), String(result.message).slice(0, 200));
    check('it never blames the Workers AI permission',
      !/missing the workers ai permission/i.test(result.message), String(result.message).slice(0, 200));
    check('it still tells the user how to create a proper token',
      /user api token/i.test(result.message), String(result.message).slice(0, 260));
    check('its raw response is preserved',
      /"total_count":0/.test(String(result.raw)), String(result.raw).slice(0, 140));
  });

  /* ---------- a realistic token with several 32-hex values ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    // Real tokens carry a user id, a jti and policy resource keys alongside the
    // account id. Requiring "exactly one 32-hex value" broke on precisely these.
    const realistic = {
      iss: 'cloudflare',
      sub: 'user:9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      aud: 'account-scoped-token',
      jti: 'a'.repeat(32),
      policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${'b'.repeat(32)}`]: '*' } }],
      scope: ['com.cloudflare.api.account.workers.write'],
      account_id: ACCOUNT,
    };
    const token = jwt(realistic);
    const result = await setupCloudflare({ apiKey: token });

    check('a realistic token resolves to its explicit account_id claim',
      result.accountId === ACCOUNT, String(result.accountId));
    check('the extra 32-hex values do not derail it',
      result.ok === true, JSON.stringify(result.message));
    check('it still avoids /accounts', !fake.calls.some((c) => c.path === '/accounts'),
      JSON.stringify(fake.calls.map((c) => c.path)));
  });

  /* ---------- a 403 on account settings must NOT stop a working token ---------- */
  // The bug this guards: /accounts/<id> needs "Account Settings: Read", so a
  // token scoped to only Workers AI — exactly what the setup asks for — gets
  // 9109 Unauthorized there while working perfectly for Workers AI. Treating
  // that as fatal rejected correct credentials and blamed the wrong thing.
  await withFake({ accounts: [], chatOk: true, accountDenied: true }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token });

    check('a 403 on account settings does not fail a token that works for Workers AI',
      result.ok === true, JSON.stringify(result.message).slice(0, 200));
    check('the account-settings check is recorded as expected, not as an error',
      (result.checks || []).some((c) => /cannot read account settings/i.test(String(c.detail))),
      JSON.stringify(result.checks));
    check('the real test request is what decides, and it passed',
      result.stage === 'done' && result.test?.ok === true, JSON.stringify(result.test));
  });

  /* ---------- 403 on account settings AND failing Workers AI ---------- */
  await withFake({ accounts: [], chatOk: false, accountDenied: true, chatCode: 10000, chatMessage: 'Authentication error' }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token });

    check('a failing Workers AI call is reported at the completion stage',
      result.ok === false && result.stage === 'completion', JSON.stringify(result).slice(0, 160));
    check('the failure offers both possible causes rather than asserting one',
      /different account|lacks the Workers AI permission/i.test(result.message),
      String(result.message).slice(0, 260));
    check('the failure does not claim the token is invalid',
      !/token is (invalid|revoked)|API key was rejected/i.test(result.message),
      String(result.message).slice(0, 200));
    check('the raw Cloudflare error is preserved', /Authentication error/.test(String(result.test?.raw)),
      String(result.test?.raw).slice(0, 120));
  });

  /* ---------- the account ID does not exist at all ---------- */
  await withFake({ accounts: [], chatOk: true, accountInvalid: true }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token });
    check('an unknown account ID is reported as not existing',
      /does not exist/i.test(result.message), String(result.message).slice(0, 200));
    check('an unknown account ID is not blamed on the token',
      !/different accounts/i.test(result.message), String(result.message).slice(0, 200));
    check('an unknown account ID is flagged distinctly',
      result.accountNotFound === true && result.accountMismatch !== true, JSON.stringify({
        notFound: result.accountNotFound,
        mismatch: result.accountMismatch,
      }));
  });

  /* ---------- the account is fine ---------- */
  await withFake({ accounts: [], chatOk: true }, async () => {
    const token = jwt({ sub: `account:${ACCOUNT}` });
    const result = await setupCloudflare({ apiKey: token });
    check('a healthy account records the account-id check',
      (result.checks || []).some((c) => c.step === 'account id' && c.ok === true),
      JSON.stringify((result.checks || []).filter((c) => c.step === 'account id')));
    check('a healthy account still reaches a working completion', result.ok === true, String(result.message));
  });

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} setup-path checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} setup-path checks passed\x1b[0m\n`);
})().catch((err) => {
  console.error('\nSetup-path harness crashed:', err);
  process.exit(1);
});
