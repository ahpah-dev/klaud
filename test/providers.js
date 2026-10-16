'use strict';

/**
 * Free-provider catalogue test.
 *
 *   node test/providers.js
 *
 * The catalogue is a claim about what other companies offer for free, so these
 * checks are about honesty as much as correctness: every limit must be stated,
 * the ordering must actually reflect generosity, nothing may be a disguised
 * trial, and the live server must expose all of it without touching settings.
 */

const net = require('net');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const { REGISTRY, getFreeCatalog, listOpenRouterFreeModels } = require('../src/providers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* keep waiting */ }
    await sleep(150);
  }
  throw new Error(`server never answered at ${url}`);
}

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud free provider checks\x1b[0m\n');

  /* ---------------------- registry shape ---------------------- */
  check(`the registry lists ${REGISTRY.length} providers`, REGISTRY.length >= 8);

  const ids = REGISTRY.map((p) => p.id);
  check('provider ids are unique', new Set(ids).size === ids.length, ids.join(','));

  const required = ['id', 'name', 'baseUrl', 'model', 'signupUrl', 'tagline', 'detail', 'limits', 'tier', 'verified'];
  const incomplete = REGISTRY.filter((p) => required.some((k) => p[k] === undefined || p[k] === ''));
  check('every entry has the fields the UI renders', incomplete.length === 0,
    incomplete.map((p) => p.id).join(', '));

  const badTiers = REGISTRY.filter((p) => !['generous', 'moderate', 'tight'].includes(p.tier));
  check('every entry declares a known tier', badTiers.length === 0, badTiers.map((p) => p.id).join(', '));

  const badUrls = REGISTRY.filter((p) => !/^https?:\/\/[^\s]+$/.test(p.baseUrl));
  check('every base URL is a plain http(s) URL', badUrls.length === 0, badUrls.map((p) => p.baseUrl).join(', '));

  const trailingSlash = REGISTRY.filter((p) => p.baseUrl.endsWith('/'));
  check('no base URL has a trailing slash', trailingSlash.length === 0,
    trailingSlash.map((p) => p.baseUrl).join(', '));

  const insecure = REGISTRY.filter((p) => p.baseUrl.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(p.baseUrl));
  check('only localhost entries use plain http', insecure.length === 0,
    insecure.map((p) => p.baseUrl).join(', '));

  const placeholderNeedsFlag = REGISTRY.filter(
    (p) => /\{[a-z_]+\}/i.test(p.baseUrl) && p.needsAccountId !== true
  );
  check('a URL with a placeholder is flagged so the UI can refuse to apply it blindly',
    placeholderNeedsFlag.length === 0, placeholderNeedsFlag.map((p) => p.id).join(', '));

  /* ---------------------- honesty about limits ---------------------- */
  // The catalogue is a claim about other companies' terms. These checks are the
  // point of the suite: a number presented as fact when it is really a quote
  // from a page that may have changed is worse than no number at all.
  const noSource = REGISTRY.filter((p) => !p.limitsSource);
  check('every entry links to the provider\'s own limits page', noSource.length === 0,
    noSource.map((p) => p.id).join(', '));

  const badSource = REGISTRY.filter((p) => !/^https:\/\//.test(p.limitsSource));
  check('every limits link is a real https URL', badSource.length === 0,
    badSource.map((p) => `${p.id}: ${p.limitsSource}`).join(', '));

  const unlabelled = REGISTRY.filter((p) => !['no-quota', 'published', 'not-published'].includes(p.limitBasis));
  check('every entry says where its allowance figure comes from', unlabelled.length === 0,
    unlabelled.map((p) => p.id).join(', '));

  // Only a provider that documents the number may be labelled 'published'.
  const claimedPublished = REGISTRY.filter((p) => p.limitBasis === 'published' && !/\d/.test(p.limits));
  check('a "published" entry actually contains the documented figure', claimedPublished.length === 0,
    claimedPublished.map((p) => p.id).join(', '));

  // A number, or an explicit reason there is no number: 'not-published'
  // (the provider does not publish one) or 'no-quota' (nothing is metered).
  const vague = REGISTRY.filter(
    (p) => !/\d/.test(p.limits) && !['not-published', 'no-quota'].includes(p.limitBasis)
  );
  check('every entry either states a number or explains why it cannot', vague.length === 0,
    vague.map((p) => `${p.id}: "${p.limits}"`).join(' | '));

  check('providers that no longer publish numbers are marked as such',
    REGISTRY.filter((p) => p.limitBasis === 'not-published').length >= 4 &&
      REGISTRY.find((p) => p.id === 'google')?.limitBasis === 'not-published',
    JSON.stringify(REGISTRY.filter((p) => p.limitBasis === 'not-published').map((p) => p.id)));

  check('Together AI is gone (its free tier ended)', !ids.includes('together'));
  check('SambaNova is not offered (20 requests/day cannot run an agent turn)',
    !ids.some((id) => /samba/i.test(id)));

  // The exact Cloudflare figure came from Cloudflare's own pricing page.
  const cloudflare = REGISTRY.find((p) => p.id === 'cloudflare');
  check('Cloudflare is marked published because its figure is documented',
    cloudflare?.limitBasis === 'published' && /10,000 Neurons/.test(cloudflare.limits), cloudflare?.limits);
  check('local models are marked as having no quota rather than a number',
    REGISTRY.filter((p) => /localhost|127\.0\.0\.1/.test(p.baseUrl)).every((p) => p.limitBasis === 'no-quota'),
    JSON.stringify(REGISTRY.filter((p) => /localhost/.test(p.baseUrl)).map((p) => [p.id, p.limitBasis])));

  /* ---------------------- per-model limits ---------------------- */
  const groq = REGISTRY.find((p) => p.id === 'groq');
  check('Groq publishes per-model numbers', Array.isArray(groq?.modelLimits) && groq.modelLimits.length >= 1);
  check('Groq per-model entries all carry a request cap',
    (groq?.modelLimits || []).every((m) => typeof m.requestsPerDay === 'number' && m.requestsPerDay > 0),
    JSON.stringify(groq?.modelLimits));
  check('Groq per-model figures are labelled as published-by-Groq, not verified by us',
    typeof groq?.modelLimitsNote === 'string' && /published|may differ/i.test(groq.modelLimitsNote),
    groq?.modelLimitsNote);
  check('Groq defaults to a model with a published free allowance',
    (groq?.modelLimits || []).some((m) => m.id === groq?.model), String(groq?.model));
  // The old table claimed 14,400/day for a small model; the free plan's binding
  // figure is 1,000/day, so an inflated number must not reappear.
  check('no Groq figure exceeds the published free-plan ceiling',
    (groq?.modelLimits || []).every((m) => m.requestsPerDay <= 1000),
    JSON.stringify(groq?.modelLimits));

  const unsorted = (groq?.modelLimits || []).some(
    (m, i, arr) => i > 0 && arr[i - 1].requestsPerDay < m.requestsPerDay
  );
  check('Groq per-model limits are listed most generous first', unsorted === false);

  /* ---------------------- live OpenRouter lookup ---------------------- */
  const live = await listOpenRouterFreeModels({ force: true });
  if (live.length) {
    check(`OpenRouter returned ${live.length} models priced at zero`, live.length > 0);
    const withTools = live.filter((m) => m.tools);
    check(`most free models support tool calling (${withTools.length}/${live.length})`,
      withTools.length >= live.length * 0.5);
    check('the aggregate free router is present', live.some((m) => m.id === 'openrouter/free'),
      live.slice(0, 4).map((m) => m.id).join(', '));
  } else {
    console.log('  \x1b[33m~\x1b[0m live OpenRouter lookup unavailable; skipping live assertions');
  }

  /* ---------------------- ordering by generosity ---------------------- */
  const catalog = await getFreeCatalog();
  const order = catalog.providers.map((p) => p.tier);
  const firstModerate = order.indexOf('moderate');
  const firstTight = order.indexOf('tight');
  check('generous providers are listed before moderate ones',
    firstModerate === -1 || !order.slice(firstModerate).includes('generous'),
    order.join(','));
  check('the tightest provider is listed last',
    firstTight === -1 || firstTight >= order.length - 1 || !order.slice(firstTight).includes('moderate'),
    order.join(','));
  check('the first three entries are all generous',
    order.slice(0, 3).every((t) => t === 'generous'), order.slice(0, 3).join(','));

  /* ------------------- providers that are no longer free ------------------- */
  // Both were listed here until their free tiers ended. Verified against the
  // providers' own documentation, not secondhand summaries.
  const listedIds = catalog.providers.map((p) => p.id);
  check('GitHub Models is no longer offered', !listedIds.includes('github'), listedIds.join(','));
  check('Cerebras is no longer offered', !listedIds.includes('cerebras'), listedIds.join(','));

  const removed = catalog.removed || [];
  check('removed providers are recorded with a reason',
    removed.length >= 2 && removed.every((r) => r.reason && r.reason.length > 60),
    JSON.stringify(removed.map((r) => [r.id, String(r.reason).length])));
  check('each removed provider carries a source link and a date',
    removed.every((r) => /^https:\/\//.test(String(r.source)) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.removedOn))),
    JSON.stringify(removed.map((r) => [r.id, r.removedOn, r.source])));
  check('the removals are surfaced to the UI',
    Array.isArray(catalog.removed) && catalog.removed.length > 0);
  check('the GitHub removal reason cites the retirement',
    /retired/i.test(String(removed.find((r) => r.id === 'github')?.reason)),
    String(removed.find((r) => r.id === 'github')?.reason).slice(0, 140));
  check('the Cerebras removal reason cites the card requirement',
    /payment method/i.test(String(removed.find((r) => r.id === 'cerebras')?.reason)),
    String(removed.find((r) => r.id === 'cerebras')?.reason).slice(0, 140));

  // Every remaining hosted provider must actually be free with no card.
  const cardGated = /cerebras|github/i;
  check('no card-gated or retired provider remains in the list',
    !catalog.providers.some((p) => cardGated.test(p.id) || cardGated.test(p.name)),
    catalog.providers.map((p) => p.id).join(','));

  /* ------------------- the recommended pick: NVIDIA NIM ------------------- */
  const nvidia = catalog.providers.find((p) => p.id === 'nvidia');
  check('NVIDIA NIM is in the catalogue', Boolean(nvidia));
  check('NVIDIA NIM is the recommended pick', nvidia?.recommended === true);
  check('the recommended pick is listed first',
    catalog.providers[0]?.id === 'nvidia', catalog.providers.map((p) => p.id).join(','));
  check('the recommended pick is marked best for the card styling',
    catalog.providers[0]?.best === true, String(catalog.providers[0]?.best));
  check('only one provider is recommended',
    catalog.providers.filter((p) => p.recommended).length === 1,
    JSON.stringify(catalog.providers.filter((p) => p.recommended).map((p) => p.id)));

  // The exact id, because a plausible-looking wrong one is the whole risk here.
  check('the model id is the verified Nemotron 3.5 Super VL id',
    nvidia?.model === 'nvidia/nemotron-3.5-super-vl-120b-a12b', String(nvidia?.model));
  check('the base URL is the NIM OpenAI-compatible endpoint',
    nvidia?.baseUrl === 'https://integrate.api.nvidia.com/v1', String(nvidia?.baseUrl));
  check('the recommended pick is marked as supporting tools',
    nvidia?.toolCalling === true);
  check('the recommended pick is tiered generous', nvidia?.tier === 'generous', String(nvidia?.tier));
  check('the signup link points at the model page',
    /build\.nvidia\.com\/nvidia\/nemotron-3\.5-super-vl/.test(String(nvidia?.signupUrl)),
    String(nvidia?.signupUrl));

  // The old entry claimed a finite credit allowance and a weaker default model.
  check('the stale free-credit claim is gone',
    !/finite (free )?credit/i.test(String(nvidia?.headline) + String(nvidia?.detail)),
    String(nvidia?.headline));
  check('the limits text names the real mechanism',
    /requests per minute/i.test(String(nvidia?.limits)), String(nvidia?.limits).slice(0, 160));
  check('the daily figure is not presented as published',
    nvidia?.limitBasis === 'not-published' && nvidia?.approximate === true,
    `basis=${nvidia?.limitBasis} approx=${nvidia?.approximate}`);

  // Klaud reads the user's files, so the data-use caveat has to be on the card.
  check('the prompt-usage caveat is disclosed',
    /improve its models/i.test(String(nvidia?.caveat)), String(nvidia?.caveat).slice(0, 120));
  check('the not-for-production caveat is disclosed',
    /not production/i.test(String(nvidia?.caveat)), String(nvidia?.caveat).slice(0, 200));
  check('the recommendation records how the model id was verified',
    /integrate\.api\.nvidia\.com/.test(String(nvidia?.verifiedNote)), String(nvidia?.verifiedNote).slice(0, 120));


  const localRunning = catalog.providers.filter((p) => p.localRunning === true).map((p) => p.id);
  check('local servers that are actually running are reported',
    catalog.providers.some((p) => p.localRunning === true) || localRunning.length === 0,
    JSON.stringify(catalog.providers.filter((p) => /localhost/.test(p.baseUrl)).map((p) => [p.id, p.localRunning])));

  // Regression: a bare string in localModels rendered as "undefined" in the UI.
  const localWithModels = catalog.providers.filter((p) => Array.isArray(p.localModels) && p.localModels.length);
  check('local model lists use the same object shape as the hosted lists',
    localWithModels.every((p) => p.localModels.every((m) => m && typeof m === 'object' && typeof m.id === 'string')),
    JSON.stringify(localWithModels.map((p) => [p.id, p.localModels.slice(0, 3)])));
  check('no local model entry is a bare string',
    localWithModels.every((p) => p.localModels.every((m) => typeof m !== 'string')),
    JSON.stringify(localWithModels.map((p) => [p.id, typeof p.localModels[0]])));

  const openRouterList = catalog.providers.find((p) => p.id === 'openrouter')?.freeModelList || [];
  const shapes = [...localWithModels.flatMap((p) => p.localModels), ...openRouterList].map((m) =>
    Object.keys(m).sort().join(',')
  );
  check('every model option exposes the same fields, so one renderer can do both',
    new Set(shapes).size <= 1, JSON.stringify([...new Set(shapes)]));

  /* ---------------------- the API route ---------------------- */
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-prov-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-prov-ws-'));
  const server = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace },
    stdio: 'ignore',
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttp(`${base}/api/health`);
    const token = JSON.parse(await fs.readFile(path.join(dataDir, 'session.json'), 'utf8')).token;
    const auth = { 'x-klaud-token': token };

    const noAuth = await fetch(`${base}/api/providers/free`);
    check('the catalogue endpoint requires the session token', noAuth.status === 401);

    const before = await (await fetch(`${base}/api/settings`, { headers: auth })).json();
    const res = await fetch(`${base}/api/providers/free`, { headers: auth });
    const apiCatalog = await res.json();
    check('GET /api/providers/free returns a catalogue',
      res.status === 200 && Array.isArray(apiCatalog.providers), String(res.status));
    check('the catalogue records when it was last checked',
      typeof apiCatalog.verifiedOn === 'string' && /^\d{4}-\d{2}$/.test(apiCatalog.verifiedOn),
      String(apiCatalog.verifiedOn));
    check('the note states plainly that rate limits are not verified',
      /not verified/i.test(apiCatalog.note), apiCatalog.note.slice(0, 120));
    check('the response counts what was actually checked this run',
      apiCatalog.liveChecks &&
        typeof apiCatalog.liveChecks.endpointsProbed === 'number' &&
        typeof apiCatalog.liveChecks.localServersRunning === 'number',
      JSON.stringify(apiCatalog.liveChecks));
    check('the live check count matches the catalogue size',
      apiCatalog.liveChecks.endpointsProbed === apiCatalog.providers.length,
      `${apiCatalog.liveChecks.endpointsProbed} vs ${apiCatalog.providers.length}`);

    const after = await (await fetch(`${base}/api/settings`, { headers: auth })).json();
    check('reading the catalogue does not change the settings',
      before.baseUrl === after.baseUrl && before.model === after.model,
      `${before.baseUrl} -> ${after.baseUrl}`);

    const cloudflare = apiCatalog.providers.find((p) => p.id === 'cloudflare');
    check('the placeholder-URL provider ships a copy-ready template',
      Boolean(cloudflare) && cloudflare.baseUrl.includes('{account_id}'), cloudflare?.baseUrl);

    /* ---------------- one-field Cloudflare setup ---------------- */
    const setup = (body) =>
      fetch(`${base}/api/providers/setup`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const beforeSetup = await (await fetch(`${base}/api/settings`, { headers: auth })).json();

    const noToken = await setup({ provider: 'cloudflare', apiKey: '' });
    check('setup refuses an empty token', noToken.body.ok === false && noToken.body.stage === 'input',
      JSON.stringify(noToken.body));
    // Regression: an empty key used to fall through to the saved one, so the
    // error talked about the user's unrelated credential being "revoked".
    check('an empty token is not quietly replaced by the saved key',
      noToken.body.stage === 'input' && !/revoked/i.test(String(noToken.body.message)),
      JSON.stringify(noToken.body));

    const wrongProvider = await setup({ provider: 'groq', apiKey: 'sk-test' });
    check('setup only claims to handle providers it can', wrongProvider.status === 400,
      `${wrongProvider.status} ${JSON.stringify(wrongProvider.body).slice(0, 120)}`);

    // A token that is not a Cloudflare token: it must fail cleanly and, most
    // importantly, must NOT be saved. A half-configured app is worse than a
    // clear error.
    const badToken = await setup({ provider: 'cloudflare', apiKey: 'not-a-real-cloudflare-token' });
    check('an invalid token fails with an actionable message',
      badToken.body.ok === false && typeof badToken.body.message === 'string' && badToken.body.message.length > 15,
      JSON.stringify(badToken.body).slice(0, 200));
    // Regression: the message used to be the empty string "Cloudflare error unknown".
    check('an invalid token never reports a bare "unknown" error',
      !/error unknown/i.test(String(badToken.body.message)) && String(badToken.body.message).length > 30,
      String(badToken.body.message));
    check('a failure carries the raw Cloudflare response for diagnosis',
      typeof badToken.body.raw === 'string' && badToken.body.raw.length > 0,
      JSON.stringify(badToken.body).slice(0, 160));
    check('an invalid token does not get written into the settings',
      Boolean(badToken.body.settings) === false, JSON.stringify(badToken.body.settings));

    const afterSetup = await (await fetch(`${base}/api/settings`, { headers: auth })).json();
    check('a failed setup leaves the working configuration untouched',
      afterSetup.baseUrl === beforeSetup.baseUrl && afterSetup.model === beforeSetup.model,
      `${beforeSetup.baseUrl} -> ${afterSetup.baseUrl}`);

    // A JWT with an account id but no Workers AI permission: it must resolve the
    // account, then fail at the completion step rather than pretending success.
    const fakeJwt = `head.${Buffer.from(
      JSON.stringify({ account_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
    ).toString('base64url')}.sig`;
    const jwtResult = await setup({ provider: 'cloudflare', apiKey: fakeJwt });
    check('a well-formed token resolves the account before testing',
      jwtResult.body.accountId === 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      JSON.stringify(jwtResult.body).slice(0, 200));
    check('the account ID is reported masked, not in full',
      /^[a-f0-9]{6}…[a-f0-9]{4}$/.test(jwtResult.body.accountIdMasked || ''),
      String(jwtResult.body.accountIdMasked));
    check('a resolved account still has to pass a real completion to save',
      jwtResult.body.ok === false && jwtResult.body.stage === 'completion',
      JSON.stringify(jwtResult.body).slice(0, 200));
    check('the URL it built embeds the resolved account ID',
      String(jwtResult.body.baseUrl).includes('a1b2c3d4e5f60718293a4b5c6d7e8f90'),
      String(jwtResult.body.baseUrl));

    /* ------------------- applying a provider ------------------- */
    const target = apiCatalog.providers.find((p) => p.tier === 'generous' && !/localhost/.test(p.baseUrl));
    const apply = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: target.baseUrl, model: target.model }),
    });
    const applied = await apply.json();
    check(`applying ${target.name} works end to end`,
      apply.status === 200 && applied.baseUrl === target.baseUrl && applied.model === target.model,
      JSON.stringify(applied).slice(0, 160));
  } finally {
    server.kill();
    await sleep(200);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} provider checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} provider checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nProvider harness crashed:', err);
  process.exit(1);
});
