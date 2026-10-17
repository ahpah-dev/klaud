'use strict';

/**
 * Free, OpenAI-compatible endpoints.
 *
 * HONESTY RULES — these matter more than the numbers:
 *
 *   1. `baseUrl` is verified LIVE on every catalogue read where possible. The
 *      endpoint in the list is one that answered as an OpenAI-shaped API from
 *      this machine.
 *   2. `limits` is a quotation or summary of what the provider publishes, and
 *      `limitsSource` links to the page holding it. Nothing here is presented
 *      as a hard guarantee.
 *   3. Rate-limit figures are moving targets and the big providers have stopped
 *      publishing fixed free-tier numbers entirely:
 *        - Google: "rate limits depend on your usage tier and can be viewed in
 *          AI Studio"; limits are applied per project.
 *        - Groq: "the following is a high level summary and there may be
 *          exceptions... view the current, exact rate limits in your account."
 *        - Cerebras: points at its pricing page.
 *      So where a published number exists it is quoted as approximate, and
 *      where it does not, `limits` says so instead of inventing one.
 *   4. `requestsPerDay` exists only to ORDER the list roughly, and is explicitly
 *      an estimate. It is never shown as a precise figure. Cards for providers
 *      that publish nothing precise say so and link to the account page.
 *
 * Trial-credit offers are excluded. Together AI was removed when its free tier
 * ended, and SambaNova because 20 requests/day cannot complete an agent turn.
 */

/**
 * `limitBasis` says where each entry's allowance figure comes from, so the UI
 * can be honest rather than implying everything was verified:
 *   'no-quota'      — local models. There is genuinely nothing to meter.
 *   'published'     — the provider documents this exact figure.
 *   'not-published' — the provider does not publish a fixed number (Google and
 *                     Groq now explicitly tell you to read it from your own
 *                     account), or measures in tokens/credits instead.
 */

/**
 * `setup` marks a provider that cannot be configured by pasting a key at all: it
 * has to be installed and run on this machine first, so the UI offers a setup
 * button instead of an API key field.
 *   'omniroute' — a local gateway Klaud can install and start, which additionally
 *                 needs Node 22.22.2+ even though Klaud itself runs on Node 18.
 *                 The exact range lives in `requiresNode`, imported from
 *                 src/lib/omniroute.js so the catalogue and the code that
 *                 enforces it cannot disagree.
 * Entries without `setup` are configured from a key and a URL, as before.
 */

/**
 * `verifiedLive` distinguishes "the model id was confirmed against a live
 * endpoint" from "the project documents it but nobody ran it here". The card
 * styles a chip from `verifiedNote`, and OmniRoute's note is the second kind, so
 * the flag is what that chip should key on.
 */

// The engine range is enforced by src/lib/omniroute.js, so it is quoted from
// there rather than restated: a stale copy in the catalogue would tell the user
// their Node is fine when the setup path refuses it.
const { NODE_REQUIREMENT } = require('./lib/omniroute');

const CHECKED = '2026-10';

/** Ordering weight only — never rendered as a number. */
const ESTIMATE = { generous: 0, moderate: 1, tight: 2, unknown: 1.5 };

/**
 * Providers deliberately kept out of the list, with the reason and a date.
 *
 * These were in the catalogue until they stopped being free. Recording them
 * stops two failure modes: quietly re-adding an entry someone remembers seeing,
 * and a user wondering whether an app they used to see has been broken by a
 * filter. Both were verified against the provider's own documentation.
 */
const REMOVED = [
  {
    id: 'github',
    name: 'GitHub Models',
    removedOn: '2026-07-30',
    reason:
      'Retired entirely. GitHub\'s changelog states the playground, model catalog and inference API are "no longer available to any customer, including existing customers with active usage". The old hostname still answers, but it returns 200 "OK" to every path and method, which is a decommissioned stub rather than a live endpoint — a good reminder that "it responds" is not "it works".',
    source: 'https://github.blog/changelog/2026-07-30-github-models-is-now-retired/',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    removedOn: '2026-10-16',
    reason:
      'No longer has a free tier. What was free is now a one-time $5 promotional credit that expires after 30 days, and Cerebras\' own pricing footnote says to "add a valid payment method to receive" it, with API and Playground access pausing once it expires or is spent. That is a card-gated trial, so it fails the no-card bar.',
    source: 'https://www.cerebras.ai/pricing',
  },
];

const REGISTRY = [
  {
    id: 'ollama',
    name: 'Ollama (on this machine)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
    signupUrl: 'https://ollama.com/download',
    limitsSource: 'https://docs.ollama.com/openai',
    toolCalling: true,
    tier: 'generous',
    estimateRank: 14400,
    freeModels: true,
    headline: 'Unlimited — no key, no quota, no rate limit',
    tagline: 'The only allowance that never runs out',
    detail:
      'Runs on your own hardware, so nothing is metered and nothing leaves the machine. Pull a tool-capable model first, for example `ollama pull qwen2.5-coder:7b`. Klaud lists whatever you already have pulled.',
    limits: 'No published limit because there is no quota. Your GPU and RAM are the limit. Effectively unlimited requests.',
    limitBasis: 'no-quota',
    exact: true,
    verified: CHECKED,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (on this machine)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    signupUrl: 'https://lmstudio.ai/',
    limitsSource: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    toolCalling: true,
    tier: 'generous',
    estimateRank: 14400,
    freeModels: true,
    headline: 'Unlimited — no key, no quota, no rate limit',
    tagline: 'The only allowance that never runs out',
    detail:
      'Load any GGUF model, start the local server, and point Klaud at it. Pick a model with tool support so the agent can actually edit files.',
    limits: 'No published limit because there is no quota. Your GPU and RAM are the limit. Effectively unlimited requests.',
    limitBasis: 'no-quota',
    exact: true,
    verified: CHECKED,
  },
  {
    id: 'omniroute',
    name: 'OmniRoute (on this machine)',
    // The loopback literal, never `localhost`: on a machine that resolves
    // localhost to ::1 first, the check would miss an IPv4-only listener and
    // report "not running" for a healthy install.
    baseUrl: 'http://127.0.0.1:20128/v1',
    model: 'auto',
    signupUrl: 'https://github.com/diegosouzapw/OmniRoute',
    limitsSource: 'https://github.com/diegosouzapw/OmniRoute',
    toolCalling: true,
    tier: 'generous',
    // Ordering weight only. It is a router in front of many free tiers rather
    // than one provider's quota, so it sorts below the two local servers and
    // above any single hosted free tier.
    estimateRank: 10000,
    // Not a key to paste: this one has to be installed and run here first.
    setup: 'omniroute',
    requiresNode: NODE_REQUIREMENT,
    headline: 'Free — a local gateway over many free tiers, with its own local key',
    tagline: 'Install once, then let "auto" pick an upstream',
    detail:
      'Not a hosted API. You install OmniRoute yourself (`npm install -g omniroute`, then `omniroute`) and it serves an OpenAI-compatible API on http://127.0.0.1:20128/v1 beside a dashboard on the same port. Its README advertises a keyless `auto` alias backed by a keyless upstream, but that is not what the running build does for model listing: `/v1/models` answers `401 Authentication required`. It issues its own Bearer keys from Dashboard → Endpoints, and those are free, local tokens rather than paid credentials. It routes across many upstream free tiers, so "free" here means free tiers behind a local gateway, not a quota OmniRoute grants.',
    limits:
      'Not published, because there is nothing of its own to publish: OmniRoute puts no rate limit on local use and meters nothing. What you actually get is whatever the upstream free tiers it routes to allow — figures that differ per provider, per model and per key, and that OmniRoute does not document. Read this as "whatever they allow", not as a quota OmniRoute grants.',
    limitBasis: 'not-published',
    caveat:
      'Weigh four things first. It needs Node 22.22.2 or newer ("' + NODE_REQUIREMENT + '", so 23.x is excluded), which means it cannot run on the Node 18 host Klaud still supports — run Klaud on 22+, or put OmniRoute in Docker. It needs its own API key even on loopback, so it is not the keyless provider its README implies; Klaud links straight to the page that issues one. A first start took about two and a half minutes here before the port answered, so setup waits rather than declaring failure. And the "generous" tier here is its routing over other providers\' free tiers rather than an allowance OmniRoute provides, so it moves when an upstream changes its terms — the upstream also sees your prompts, and since Klaud reads your files, that text travels through OmniRoute to whichever provider its router picks, under that provider\'s retention terms.',
    verified: CHECKED,
    // Documents a claim, not a measurement: see verifiedNote. The card's
    // "model verified live" chip should key on this rather than on the mere
    // presence of a note.
    verifiedLive: false,
    verifiedNote:
      'Partly measured on this machine, partly from its README. Measured: OmniRoute was installed and running here, `GET /v1/models` answered `401 Authentication required` with no key and a different `401 Invalid API key` with a wrong one, and a first start took roughly 150 seconds before the port answered. Taken from its own README: the MIT licence, the npm and Docker packages, the http://localhost:20128/v1 surface, the `auto` alias, and the Node engine range. NOT observed: any successful completion, whether `auto` resolves, whether it accepts tool calls, and whether a keyless `auto` request works — an unauthenticated chat completion neither answered nor rejected within 20 seconds. So `toolCalling: true` remains a documentation claim, not a measurement.',
    verifyHint:
      'With it running and its own key in hand, `curl -H "Authorization: Bearer <key>" http://127.0.0.1:20128/v1/models` lists what it will serve. Free → OmniRoute → Set up automatically starts it if needed, then proves the key with a real request before saving anything.',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    signupUrl: 'https://console.groq.com/keys',
    limitsSource: 'https://console.groq.com/docs/rate-limits',
    limitsPageUrl: 'https://console.groq.com/settings/limits',
    toolCalling: true,
    tier: 'generous',
    // The free plan's binding figure is 1,000 requests/day, not the 14,400 that
    // the old table claimed for a small model. estimateRank drives tie-breaks
    // only, but a wrong number here still misleads.
    estimateRank: 1000,
    headline: '1,000 requests/day free, published per model',
    tagline: 'The most transparent about its limits, and the fastest',
    detail:
      'Groq publishes a full per-model table of requests and tokens per minute and per day, split into Free and Developer plans — it is the only provider here that documents its limits in that much detail. Free needs no card; the Developer plan needs one and raises the ceiling roughly five hundredfold. Tool calling is excellent and latency is very low, which suits an edit-run loop.',
    limits:
      'Free plan for openai/gpt-oss-120b: 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute. Adding a payment method moves you to the Developer plan at 1,000 requests/minute and 500,000 requests/day. Groq notes these are the base limits and your account page holds the exact figures.',
    approximate: true,
    verified: CHECKED,
    modelLimitsNote: 'Free-plan figures as published by Groq for the model Klaud defaults to. Your account may differ.',
    limitBasis: 'published',
    modelLimits: [
      { id: 'openai/gpt-oss-120b', requestsPerDay: 1000, tokensPerMinute: 8000 },
    ],
  },
  {
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    signupUrl: 'https://aistudio.google.com/apikey',
    limitsSource: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    limitsPageUrl: 'https://aistudio.google.com/rate-limit',
    toolCalling: true,
    tier: 'moderate',
    estimateRank: 1500,
    headline: 'Generous, but Google no longer publishes the numbers',
    tagline: 'Free tier is Flash-class only, limits shown in AI Studio',
    detail:
      'Google stopped publishing fixed free-tier figures. Its documentation now states that limits depend on your usage tier, are applied per project rather than per key, and can be viewed in AI Studio. The free tier also covers Flash-class and embedding models only — the Pro and top-end models are explicitly excluded — which is why Klaud defaults to a Flash model. Your real limits are one click away on the page linked here.',
    limits:
      'Not published as fixed numbers. Google states limits vary by model and usage tier, are enforced per project, and reset at midnight Pacific. View yours in AI Studio.',
    limitBasis: 'not-published',
    approximate: true,
    unknownPrecise: true,
    verified: CHECKED,
  },
  {
    id: 'mistral',
    name: 'Mistral La Plateforme',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'codestral-latest',
    signupUrl: 'https://console.mistral.ai/api-keys',
    limitsSource: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
    toolCalling: true,
    tier: 'generous',
    estimateRank: 2000,
    headline: 'By far the largest token allowance',
    tagline: 'Around a billion tokens a month on the free tier',
    detail:
      'The free tier is unusual in being measured in tokens rather than requests, and the volume is enormous — around a billion tokens a month per model with a high per-minute ceiling. Codestral, the dedicated code model, has its own separate request allowance. Needs a phone-verified account.',
    limits:
      'Mistral publishes free-tier token allowances rather than a request count: roughly 1B tokens/month and 500k tokens/min per model. Codestral adds its own request allowance.',
    limitBasis: 'not-published',
    approximate: true,
    verified: CHECKED,
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    signupUrl: 'https://dash.cloudflare.com/',
    limitsSource: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    toolCalling: true,
    tier: 'moderate',
    needsAccountId: true,
    estimateRank: 1000,
    headline: '10,000 Neurons/day — a compute allowance, not a request count',
    tagline: 'Free on any Cloudflare account, no card',
    detail:
      'Billed in "Neurons", a measure of GPU work, with 10,000 per day free on any account. That is a real allowance but it behaves differently from a request quota: cheap small models stretch it to hundreds of thousands of output tokens a day, while a large model burns it in a handful of calls. Replace {account_id} in the URL with your Cloudflare account ID. Some models require a paid plan.',
    limits:
      '10,000 Neurons/day free, resetting at 00:00 UTC. Published on Cloudflare\'s pricing page with per-model Neuron rates, so you can compute exactly what a model costs you.',
    limitBasis: 'published',
    exact: true,
    verified: CHECKED,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    signupUrl: 'https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b',
    limitsSource: 'https://docs.api.nvidia.com/nim/reference/limits',
    limitsPageUrl: 'https://build.nvidia.com/',
    toolCalling: true,
    tier: 'generous',
    // Highest of the hosted providers: ~40 requests/minute is a rate limit, not
    // a daily quota, so it does not run out the way a credit allowance does.
    estimateRank: 12000,
    recommended: true,
    headline: 'The best free tier for an agent — about 40 requests/minute, no card',
    tagline: 'Nemotron 3.5 Super VL, built for tool use',
    modelNote: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    detail:
      'A 120B mixture-of-experts model that activates 12B parameters per token, built specifically for agentic work: reasoning, instruction following and tool use in one model. NVIDIA reports it beating even Nemotron 3 Ultra on Hermes Bench (63.4% vs 56.3%) and LangChain evals (87.1% vs 84.3%). Signup is a free NVIDIA Developer Program account with no card, and the same key reaches the whole 81-model catalogue — including the top open models from other labs.',
    limits:
      'Roughly 40 requests per minute per key, shared across all models, plus about 5 concurrent requests. Community reports put the effective daily headroom near 10,000 requests, but NVIDIA does not publish that figure, and staff have said the limit is not raised on the free tier.',
    limitBasis: 'not-published',
    approximate: true,
    caveat:
      'Two things worth knowing before you point a coding agent at it. The API trial terms allow internal testing, prototyping and evaluation only — not production use. And the terms let NVIDIA collect de-identified prompts and outputs to improve its models, so anything Klaud reads out of your files travels to NVIDIA. That is fine for open-source work and less fine for private code.',
    verified: CHECKED,
    verifiedNote:
      'The model id was confirmed against the live catalogue at integrate.api.nvidia.com/v1/models, which lists 81 models and answers without a key. Tool use is stated in NVIDIA\'s own model announcement. The 40 rpm figure is community-measured, not published.',
    // Key-free endpoint, so anyone can confirm the model still exists:
    //   curl -s https://integrate.api.nvidia.com/v1/models | grep nemotron-3.5
    verifyHint: 'Run `npm run check-nvidia` to list the live catalogue and confirm the model is still served.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    signupUrl: 'https://openrouter.ai/keys',
    limitsSource: 'https://openrouter.ai/docs/api-reference/limits',
    limitsPageUrl: 'https://openrouter.ai/settings/keys',
    limitsCheckEndpoint: '/api/v1/auth/key',
    toolCalling: true,
    tier: 'tight',
    estimateRank: 50,
    freeModels: true,
    headline: 'The tightest free allowance here — but the best model variety',
    tagline: 'One key, every lab; about 50 requests/day free',
    detail:
      'One key reaches every lab, and the free models are genuinely capable — but the free allowance is small enough that an agent burns it in a few turns. A one-time credit purchase raises the daily cap permanently. Klaud reads the live list of models currently priced at zero, and OpenRouter is the one provider whose exact remaining allowance you can query with your own key at the endpoint listed below.',
    limits:
      'Roughly 50 free requests/day, rising to around 1,000/day after a one-time $10 credit purchase. A global cap also applies across all free models.',
    limitBasis: 'not-published',
    approximate: true,
    verified: CHECKED,
  },
];

/* ------------------------------------------------------------------ *
 * Live free-model lookup
 * ------------------------------------------------------------------ */

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, models: [], error: null };

/**
 * Models on OpenRouter priced at zero right now. Cached so the picker can be
 * reopened freely.
 */
async function listOpenRouterFreeModels({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS && (cache.models.length || cache.error)) {
    return cache.models;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = (json.data || [])
      .filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: m.context_length || 0,
        tools: (m.supported_parameters || []).includes('tools'),
      }))
      // Tool calling is what makes an agent work, so surface those first.
      .sort((a, b) => Number(b.tools) - Number(a.tools) || b.contextLength - a.contextLength);
    cache = { at: Date.now(), models, error: null };
    return models;
  } catch (err) {
    cache = { at: Date.now(), models: cache.models, error: err.message };
    return cache.models;
  }
}

/**
 * Sort: the recommended pick first, then most generous, then locals that are
 * actually running.
 *
 * The volume term is deliberately tiny (-rank/1e6). estimateRank is a rough
 * "requests per day" figure, so without dividing it down it would swamp the tier
 * ordering entirely and a tight-but-high-volume provider would outrank a
 * generous one. It exists only to break ties within a tier.
 */
function rank(entry) {
  const recommended = entry.recommended ? -10 : 0;
  const base = ESTIMATE[entry.tier] ?? 2;
  const localBonus = entry.localRunning ? -0.5 : 0;
  const volume = -(entry.estimateRank || 0) / 1_000_000;
  return recommended + base + localBonus + volume;
}

/**
 * The catalogue for the UI: curated entries, live free models where available,
 * a live check on local servers, and an honest summary of what is verifiable.
 */
async function getFreeCatalog({ probeLocal = true } = {}) {
  const entries = REGISTRY.map((entry) => ({ ...entry }));

  const openrouter = entries.find((e) => e.id === 'openrouter');
  let freeModelCount = 0;
  if (openrouter) {
    const models = await listOpenRouterFreeModels();
    openrouter.freeModelList = models.slice(0, 40);
    openrouter.freeModelCount = models.length;
    freeModelCount = models.length;
  }

  if (probeLocal) {
    await Promise.all(
      entries
        .filter((e) => /localhost|127\.0\.0\.1/.test(e.baseUrl))
        .map(async (entry) => {
          try {
            const res = await fetch(`${entry.baseUrl}/models`, { signal: AbortSignal.timeout(1_500) });
            entry.localRunning = res.ok;
            if (res.ok) {
              const json = await res.json().catch(() => null);
              // Normalise to the same shape as the OpenRouter list: the UI
              // renders these through one code path, and a bare string here
              // showed up as "undefined" in the model dropdown.
              const ids = (json?.data || json?.models || [])
                .map((m) => {
                  const id = typeof m === 'string' ? m : m.id || m.name;
                  if (!id) return null;
                  return {
                    id,
                    name: typeof m === 'string' ? m : m.name || id,
                    contextLength: (typeof m === 'object' && m.context_length) || 0,
                    tools: typeof m === 'object' && Array.isArray(m.supported_parameters)
                      ? m.supported_parameters.includes('tools')
                      : null,
                  };
                })
                .filter(Boolean);
              entry.localModels = ids.slice(0, 25);
            }
          } catch {
            entry.localRunning = false;
          }
        })
    );
  }

  entries.sort((a, b) => rank(a) - rank(b));
  // The card styles a `best` entry, and the client has always checked for it,
  // but nothing ever set it — so the intended highlight was dead code. Derive
  // it from the same `recommended` flag that drives the ordering.
  const top = entries.find((e) => e.recommended && e.localRunning !== false);
  if (top) top.best = true;
  const localUp = entries.filter((e) => e.localRunning === true).length;

  return {
    generatedAt: Date.now(),
    verifiedOn: CHECKED,
    // Counted, not asserted: only the things this process actually checked.
    liveChecks: {
      endpointsProbed: entries.length,
      localServersRunning: localUp,
      openRouterFreeModels: freeModelCount,
      openRouterError: cache.error,
    },
    note:
      'Endpoints here were probed from this machine. Rate-limit figures are NOT verified — the large ' +
      'providers have stopped publishing fixed free-tier numbers (Google and Groq both now say to check ' +
      'your own account), so those are marked approximate and every card links to the provider\'s own page. ' +
      'The OpenRouter free-model list is read live. Trial-credit offers are excluded on purpose.',
    removed: REMOVED,
    providers: entries,
  };
}

/* ------------------------------------------------------------------ *
 * Cloudflare Workers AI — one-field setup
 * ------------------------------------------------------------------ */

/**
 * The only awkward part of using Cloudflare is the account ID required in the
 * URL. It does not have to be typed:
 *
 *   1. A Cloudflare API token is a JWT, and its claims carry the account id it
 *      was scoped to. Reading that costs no network call.
 *   2. Failing that, `GET /accounts` returns the accounts the token can reach.
 *
 * Either way the user pastes one thing — the token — and this fills in the rest.
 */
/** A Cloudflare account ID is always 32 hex characters. */
const ACCOUNT_ID_RE = /[a-f0-9]{32}/gi;

/** Every 32-hex string anywhere in a value, keys included, lowercased. */
function collectAccountIdCandidates(value, depth = 0, found = new Set()) {
  if (depth > 5 || typeof value === 'string' || value === null || value === undefined) {
    if (typeof value === 'string') {
      for (const hit of value.match(ACCOUNT_ID_RE) || []) found.add(hit.toLowerCase());
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAccountIdCandidates(item, depth + 1, found);
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      // Cloudflare policies use the account ID inside the permission key, e.g.
      // "com.cloudflare.api.account.<id>": "*", so keys matter as much as values.
      for (const hit of key.match(ACCOUNT_ID_RE) || []) found.add(hit.toLowerCase());
      collectAccountIdCandidates(item, depth + 1, found);
    }
  }
  return found;
}

/** Token fields that must never be shown back to the browser. */
const SECRET_CLAIM_KEYS = /^(jwk|nonce|id|token|secret|signature|signing|key_id|jti|sid)$/i;

/**
 * Decode a token's payload and describe what is in it — claim names and any
 * account-sized identifiers, never secret material. This is what lets the UI say
 * "your token scopes are X, Y, Z" instead of asking the user to guess.
 */
function inspectTokenClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;

    const describe = (value, depth = 0) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') {
        if (SECRET_CLAIM_KEYS.test(value)) return '(hidden)';
        return ACCOUNT_ID_RE.test(value) ? value : String(value).slice(0, 120);
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (depth > 2) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
      if (Array.isArray(value)) return value.slice(0, 12).map((v) => describe(v, depth + 1));
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 20)) {
        if (SECRET_CLAIM_KEYS.test(k)) {
          out[k] = '(hidden)';
        } else {
          out[k] = describe(v, depth + 1);
        }
      }
      return out;
    };

    return {
      claimNames: Object.keys(payload),
      claimCount: Object.keys(payload).length,
      claims: describe(payload),
      accountIdsFound: [...collectAccountIdCandidates(payload)],
    };
  } catch {
    return null;
  }
}

/**
 * Pull the account ID out of a Cloudflare API token (a JWT).
 *
 * Order matters. A realistic token carries the account in an explicit claim AND
 * inside policy resource keys, so "the only 32-hex string present" is a bad
 * rule — it returns nothing for the very tokens people actually have, which then
 * falls through to /accounts, which returns an empty list for account-scoped
 * tokens, which produces a nonsense error. So: prefer explicit claims, in order,
 * and only fall back to a whole-payload scan when a single unambiguous candidate
 * exists.
 */
function accountIdFromToken(token) {
  let payload;
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
  } catch {
    return null;
  }

  const normalise = (value) => {
    if (typeof value !== 'string') return null;
    const hit = value.match(/[a-f0-9]{32}/i);
    return hit ? hit[0].toLowerCase() : null;
  };

  // 1. Explicit dedicated claims.
  for (const claim of [payload.account_id, payload.account?.id, payload.acc, payload.accountId]) {
    const id = normalise(claim);
    if (id) return id;
  }

  // 2. The subject, which Cloudflare writes as "account:<id>" for API tokens.
  const sub = normalise(payload.sub);
  if (sub) return sub;

  // 3. Scopes, which sometimes carry the account inline.
  const scopeList = Array.isArray(payload.scope)
    ? payload.scope
    : typeof payload.scope === 'string'
      ? [payload.scope]
      : [];
  for (const scope of scopeList) {
    const id = normalise(scope);
    if (id) return id;
  }

  // 4. Last resort: a whole-payload scan, accepted only when unambiguous.
  const candidates = collectAccountIdCandidates(payload);
  return candidates.size === 1 ? [...candidates][0] : null;
}

/**
 * Explain an empty-but-successful /accounts response.
 *
 * A Cloudflare token scoped to a single account returns
 * `{"result":[],"success":true}` from /accounts, because the endpoint lists the
 * accounts the token may *manage*, not the one it is scoped to. Telling that user
 * to check their Workers AI permission is wrong and sends them off fixing
 * something that was never broken.
 */
function explainEmptyAccounts(inspection) {
  const scopes = (() => {
    const raw = inspection?.claims?.scope;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') return [raw];
    return [];
  })();
  const accountScoped = scopes.filter((s) => /com\.cloudflare\.api\.account/i.test(s));
  const userScoped = scopes.filter((s) => /com\.cloudflare\.api\.user/i.test(s));

  const parts = [
    'Cloudflare accepted the token, but it returned an empty account list. That normally means one of these:',
  ];
  parts.push(
    '1. The token was created as an "Account API token" (from inside a specific account) rather than a "User API token". Account-scoped tokens always return an empty list here — that is expected, not a problem.'
  );
  parts.push(
    '2. The token has no account-level permission, so Cloudflare has nothing to list.'
  );
  if (accountScoped.length) {
    parts.push(`Your token does carry account scopes (${accountScoped.slice(0, 3).join(', ')}), which supports case 1.`);
  }
  if (userScoped.length) {
    parts.push(`It also carries user scopes (${userScoped.slice(0, 3).join(', ')}).`);
  }
  if (!scopes.length) {
    parts.push('The token payload carried no scope list at all, which is unusual.');
  }
  parts.push(
    'Fix: create a User API token with the "Workers AI" permission, or paste your Account ID alongside the token.'
  );
  return parts.join('\n');
}

async function cfGet(path, token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* not json — the raw text is kept so errors can still say something real */
  }
  return { status: res.status, ok: res.ok, json, raw };
}

/** Cloudflare error codes worth explaining rather than repeating. */
const CF_HINTS = {
  6003: 'That does not look like a Cloudflare API token. Create one on the API tokens page — do not use your Global API Key or your account password.',
  6111: 'Cloudflare could not read the Authorization header. This normally means a Global API Key was sent where an API Token is required, or the header was left out.',
  1001: 'Cloudflare received no Authorization header at all. In curl that means the -H flag was missing or the header was written as a bare argument instead of after -H. Klaud always sends it, so seeing this from the app would be a bug — from a hand-written curl command it means the header is missing.',
  9109: 'Cloudflare accepted the token but says you are not authorized for this account, which means the token and the account ID belong to different accounts. Copy your own account ID from the address bar of dash.cloudflare.com — it is the 32-character value right after the domain.',
  10000: 'Cloudflare rejected the request. If your token already verifies as valid at /user/tokens/verify, this means the account ID and the token do not belong to the same account, or the token lacks the Workers AI permission.',
  7003: 'The token cannot see any account. Check it was created under the right Cloudflare account.',
  1000: 'Cloudflare rejected the request.',
  7001: 'Cloudflare did not recognise the request URL. This usually means the account ID in the URL is wrong, or that angle brackets were left in the URL from an example.',
  7000: 'Cloudflare could not find that resource. This usually means the account ID in the URL is wrong.',
  971: 'Workers AI is not enabled for this account yet. Open the Workers AI page once in the Cloudflare dashboard to activate it.',
};

/**
 * Build a message that always contains the real reason.
 *
 * The previous version fell back to "Cloudflare error unknown" whenever the
 * code was not in the hint table and the message was missing — the one case
 * where the user most needs the raw detail. Now the raw response is always
 * included, and a known code adds a plain-English hint on top rather than
 * replacing it.
 */
function explainCfError(code, message, raw) {
  const hasCode = code !== undefined && code !== null && String(code).trim() !== '';
  const hint = hasCode ? CF_HINTS[code] || CF_HINTS[String(code)] : null;
  const detail = typeof message === 'string' ? message.trim() : typeof message === 'number' ? String(message) : '';
  const fallback = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';

  const parts = [];
  if (hint) parts.push(hint);
  if (detail && detail !== hint) parts.push(detail);
  if (!hint && !detail && fallback) parts.push(fallback);

  // Guarantee advice. An unrecognised code with no message must still tell the
  // user what to try, otherwise the message is a dead end however accurate it is.
  if (!hint) {
    parts.push('Klaud does not recognise this Cloudflare error, so check that the token has the Workers AI permission and that Workers AI is enabled for the account.');
  }

  const clean = parts.filter((p) => p && p.trim());
  const body = clean.length ? clean.join(' ') : 'Cloudflare rejected the request without explaining why.';
  return hasCode ? `${body} (Cloudflare code ${String(code).trim()})` : body;
}

/**
 * Configure Workers AI from a single token.
 *
 * Returns a result describing exactly what it found and whether a real
 * completion succeeded, so the UI can tell the user the truth rather than
 * "saved" and hope.
 */
async function setupCloudflare({ apiKey, model, accountId: suppliedAccountId }) {
  const token = String(apiKey || '').trim();
  if (!token) {
    return { ok: false, stage: 'input', message: 'Paste a Cloudflare API token first.' };
  }

  const inspection = inspectTokenClaims(token);
  const checks = [];

  // 0. An account ID pasted by the user wins outright: it lets someone skip all
  //    of the discovery below, which matters because Cloudflare's account-scoped
  //    tokens cannot be discovered at all.
  let accountId = null;
  let accountSource = null;
  const supplied = String(suppliedAccountId || '').trim();
  if (supplied) {
    if (!/^[a-f0-9]{32}$/i.test(supplied)) {
      return {
        ok: false,
        stage: 'account',
        message: 'That does not look like a Cloudflare account ID. It should be 32 hex characters, like a1b2c3d4e5f60718293a4b5c6d7e8f90.',
        suppliedAccountIdLength: supplied.length,
      };
    }
    accountId = supplied.toLowerCase();
    accountSource = 'you provided it';
    checks.push({ step: 'account id', ok: true, detail: 'used the ID you pasted' });
  }

  // 1. The token's own claims are free, and are authoritative about which
  //    account the token was scoped to. Prefer them unconditionally: an
  //    account-scoped Cloudflare token returns an empty list from /accounts, so
  //    calling that first produces a false "no accounts" verdict for the very
  //    tokens most people create.
  if (!accountId) {
    accountId = accountIdFromToken(token);
    if (accountId) {
      accountSource = 'token claims';
      checks.push({ step: 'account id', ok: true, detail: 'read from the token itself' });
    } else {
      const idsInToken = inspection?.accountIdsFound || [];
      checks.push({
        step: 'account id',
        ok: false,
        detail: idsInToken.length
          ? 'the token carries account-sized identifiers but none in a claim Klaud trusts'
          : 'no account ID in the token claims',
      });
    }
  }

  // 2. Ask Cloudflare which accounts the token can reach.
  let accountsResult = null;
  if (!accountId) {
    const res = await cfGet('/accounts', token);
    accountsResult = res;
    const list = Array.isArray(res.json?.result) ? res.json.result : [];

    if (list.length && list[0]?.id) {
      accountId = list[0].id;
      accountSource = 'accounts API';
      checks.push({
        step: 'accounts API',
        ok: true,
        detail: `token can see ${list.length} account${list.length === 1 ? '' : 's'}`,
      });
    } else if (res.json?.success === true && list.length === 0) {
      // Empty but successful. This is the case that produced the nonsense
      // "check the Workers AI permission" message: there is no error to explain.
      checks.push({
        step: 'accounts API',
        ok: false,
        detail: 'Cloudflare returned an empty (but successful) account list',
      });
      return {
        ok: false,
        stage: 'account',
        needsAccountId: true,
        message: explainEmptyAccounts(inspection),
        raw: res.raw.slice(0, 400),
        httpStatus: res.status,
        claimNames: inspection?.claimNames,
        claims: inspection?.claims,
        accountIdsInToken: inspection?.accountIdsFound || [],
        checks,
      };
    } else {
      const err0 = res.json?.errors?.[0];
      checks.push({ step: 'accounts API', ok: false, detail: err0?.message || `HTTP ${res.status}` });
      return {
        ok: false,
        stage: 'account',
        message: explainCfError(err0?.code, err0?.message, res.raw),
        raw: res.raw.slice(0, 400),
        httpStatus: res.status,
        claimNames: inspection?.claimNames,
        claims: inspection?.claims,
        checks,
      };
    }
  }

  // 3. Verify the token. Treat a failure as fatal only when we could not read
  //    the account ID from anywhere else — otherwise the completion below is the
  //    authoritative test, and /user/tokens/verify rejects some tokens that work
  //    perfectly well for Workers AI.
  const verify = await cfGet('/user/tokens/verify', token);
  const verifyFailed = verify.json && verify.json.success === false;
  const verifyCode = verifyFailed ? verify.json.errors?.[0]?.code : null;
  checks.push({
    step: 'token verify',
    ok: !verifyFailed,
    detail: verifyFailed ? `Cloudflare code ${verifyCode ?? 'unknown'}` : 'token accepted',
  });
  if (verifyFailed && !accountId && verifyCode && verifyCode !== 9109) {
    return {
      ok: false,
      stage: 'verify',
      message: explainCfError(verifyCode, verify.json.errors?.[0]?.message, verify.raw),
      raw: (verify.raw || '').slice(0, 400),
      httpStatus: verify.status,
      accountId,
      accountSource,
      claimNames: inspection?.claimNames,
      claims: inspection?.claims,
      checks,
    };
  }

  // 4b. Ask whether this token can read this account.
  //
  //     IMPORTANT: a 403 here does NOT mean the account is wrong. `GET
  //     /accounts/<id>` requires the "Account Settings: Read" permission, so a
  //     token scoped to only Workers AI — which is exactly what the setup
  //     instructions ask for — gets 9109 Unauthorized here even when it is
  //     perfectly correct for Workers AI. This check is therefore recorded for
  //     context and never used to abort. Only the real Workers AI call below
  //     decides whether the credentials work.
  let accountReadDenied = false;
  if (accountId) {
    const accountCheck = await cfGet(`/accounts/${accountId}`, token);
    const invalidIdentifier = /invalid account identifier/i.test(accountCheck.raw || '');
    accountReadDenied = accountCheck.status === 403;

    if (invalidIdentifier) {
      // This one IS decisive: Cloudflare only says this when the identifier
      // cannot correspond to an account.
      checks.push({
        step: 'account id',
        ok: false,
        detail: 'Cloudflare says this account ID does not exist',
      });
      return {
        ok: false,
        stage: 'account',
        accountNotFound: true,
        needsAccountId: true,
        accountId,
        accountIdMasked: `${accountId.slice(0, 6)}…${accountId.slice(-4)}`,
        accountSource,
        message:
          `Cloudflare says account ${accountId.slice(0, 6)}…${accountId.slice(-4)} does not exist. ` +
          'Open dash.cloudflare.com and copy your own account ID — the 32-character value right after ' +
          'the domain in the address bar — then paste it in the Account ID field below.',
        raw: (accountCheck.raw || '').slice(0, 400),
        httpStatus: accountCheck.status,
        claimNames: inspection?.claimNames,
        claims: inspection?.claims,
        checks,
      };
    }

    checks.push({
      step: 'account id',
      ok: !accountReadDenied,
      detail: accountReadDenied
        ? 'the token cannot read account settings (normal for a Workers-AI-only token) — the test request below is what decides'
        : 'the token can read this account',
    });
  }

  // 5. Confirm Workers AI is actually reachable for this account. Note the
  //    method: Workers AI's OpenAI surface answers the model list on POST, not
  //    GET (GET returns 405 "not supported for requested URI"), so a GET here
  //    would silently make every setup look like a model problem.
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  let chosenModel = model || '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
  let modelFound = false;
  let available = [];
  let catalogError = null;

  try {
    const catalogRes = await fetch(`${baseUrl}/models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (catalogRes.ok) {
      const json = await catalogRes.json().catch(() => null);
      available = (json?.result || json?.data || [])
        .map((m) => (typeof m === 'string' ? m : m.name || m.id))
        .filter(Boolean);
      modelFound = available.includes(chosenModel);
      checks.push({
        step: 'model list',
        ok: true,
        detail: modelFound
          ? `${available.length} models available, including ${chosenModel}`
          : `${available.length} models available, but not ${chosenModel}`,
      });
    } else {
      const text = await catalogRes.text().catch(() => '');
      catalogError = text.slice(0, 200);
      checks.push({
        step: 'model list',
        ok: false,
        detail: `HTTP ${catalogRes.status} — the test request below is what decides`,
      });
    }
  } catch (err) {
    catalogError = err.message;
    checks.push({ step: 'model list', ok: false, detail: `could not list models: ${err.message}` });
  }

  // 4. The only test that proves anything: run a real completion. The timeout is
  //    generous because the first Workers AI call on a cold model can take a
  //    while, and a premature give-up would look like a configuration failure.
  let test = { attempted: false };
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chosenModel,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 12,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch { /* keep raw */ }

    const reply = String(body?.choices?.[0]?.message?.content || '').trim();
    // Some gateways answer 200 with an empty result; an empty reply is not a
    // working setup, so it counts as a failure with the raw body attached.
    if (res.ok && reply) {
      test = { attempted: true, ok: true, reply: reply.slice(0, 60), elapsedMs: Date.now() - startedAt };
    } else if (res.ok) {
      test = {
        attempted: true,
        ok: false,
        status: res.status,
        message:
          'The request was accepted but the model returned no text. The raw response is below, and the model may need a different name.',
        raw: text.slice(0, 400),
        elapsedMs: Date.now() - startedAt,
      };
    } else {
      const code = body?.errors?.[0]?.code ?? body?.error?.code;
      test = {
        attempted: true,
        ok: false,
        status: res.status,
        code,
        message: explainCfError(code, body?.errors?.[0]?.message || body?.error?.message, text),
        raw: text.slice(0, 400),
        elapsedMs: Date.now() - startedAt,
      };
    }
  } catch (err) {
    const timedOut = /abort|timeout/i.test(err.message);
    test = {
      attempted: true,
      ok: false,
      message: timedOut
        ? 'Workers AI did not answer within 60 seconds. The account resolved correctly, so this is likely a cold model or a temporary Cloudflare problem — try again, or pick a smaller model.'
        : `Could not reach Workers AI: ${err.message}`,
      raw: err.message,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    ok: test.ok === true,
    stage: test.ok ? 'done' : 'completion',
    accountId,
    accountSource,
    accountIdMasked: `${accountId.slice(0, 6)}…${accountId.slice(-4)}`,
    baseUrl,
    model: chosenModel,
    modelFound,
    availableModels: available.slice(0, 40),
    catalogError,
    claimNames: inspection?.claimNames,
    claims: inspection?.claims,
    checks: [...checks, { step: 'test completion', ok: test.ok === true, detail: test.ok ? `model replied "${test.reply}"` : test.message }],
    verify: verifyFailed ? 'not-verified' : 'verified',
    verifyNote: verifyFailed
      ? 'Cloudflare\'s /user/tokens/verify did not accept this token, but the setup was decided by a real completion request instead.'
      : '',
    test,
    message: test.ok
      ? `Workers AI is working on account ${accountId.slice(0, 6)}…${accountId.slice(-4)}. Your free daily allowance applies automatically.`
      : test.message,
  };
}

module.exports = {
  REGISTRY,
  getFreeCatalog,
  listOpenRouterFreeModels,
  setupCloudflare,
  accountIdFromToken,
  inspectTokenClaims,
  explainEmptyAccounts,
  explainCloudflareError: explainCfError,
};
