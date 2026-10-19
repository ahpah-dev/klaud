'use strict';

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Works with anything that speaks POST {baseUrl}/chat/completions:
 * OpenAI, Azure-style gateways, OpenRouter, Groq, Together, Fireworks,
 * DeepSeek, xAI, Mistral, vLLM, LM Studio, llama.cpp, Ollama, LiteLLM...
 */

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

class LLMError extends Error {
  constructor(message, { status = 0, body = '', url = '' } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new LLMError('No base URL configured. Open Settings and set your API base URL.');
  if (/[<>{}]/.test(base)) {
    throw new LLMError(
      'The base URL contains angle brackets, which are placeholders in documentation and not part of a real ' +
        'URL. Replace the bracketed part with your own account ID — or use Free → Cloudflare → Set up ' +
        'automatically and let Klaud build it. In curl, the shell also treats < and > as redirections, which ' +
        'is what produces "Bad hostname".'
    );
  }
  // Accept both "https://host/v1" and "https://host" and a full endpoint.
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/models$/.test(base)) return `${base.replace(/\/models$/, '')}/chat/completions`;
  return `${base}/chat/completions`;
}

function buildHeaders(apiKey, extraHeaders) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) headers[k] = String(v);
    }
  }
  return headers;
}

/**
 * How long to wait before retrying a throttled request, in milliseconds.
 * Returns null when the provider wants longer than we are willing to block.
 *
 * Fixed exponential backoff is wrong for the free tiers Klaud targets. A
 * per-minute limit answers "retry in 53s"; retrying after 1.5s and 3s burns
 * two of three attempts and reports a failure that would have cleared on its
 * own. Providers also send Retry-After, which was being ignored entirely.
 *
 * The cap matters as much as the wait: silently hanging for minutes looks
 * exactly like a freeze, so a request needing longer than this fails fast with
 * a message that says how long to wait.
 */
const MAX_RETRY_WAIT_MS = 60_000;

function retryDelayMs(res, bodyText) {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }

  // Some gateways put the wait in the error text: "retry in 42s",
  // "try again in 1 minute", "Please retry after 30 seconds".
  const text = String(bodyText || '');
  const patterns = [
    /retry(?:\s+again)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i,
    /try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    const multiplier = unit.startsWith('ms') || unit.startsWith('milli')
      ? 1
      : unit.startsWith('m')
        ? 60_000
        : 1_000;
    return value * multiplier;
  }
  return null;
}

/** Read a response body for the error message, tolerating a body already used. */
async function peekBody(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Turn an HTTP error response into a message a human can act on. */
async function describeHttpError(res, context = {}) {
  const raw = await res.text().catch(() => '');
  const status = res.status;
  const url = context.url || res.url || '';
  let detail = String(raw || '').slice(0, 1_200);
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message || parsed?.message || parsed?.error || detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* keep raw */ }

  const isCloudflare = /cloudflare\.com/i.test(url);
  const cfCode = (() => {
    try {
      return JSON.parse(raw)?.errors?.[0]?.code ?? null;
    } catch {
      return null;
    }
  })();

  /**
   * Provider-aware hints.
   *
   * The old text said "The API key was rejected" for every 401. For Cloudflare
   * that is actively wrong: Workers AI answers 401 "Authentication error" when
   * the key is perfectly valid but the account ID in the URL belongs to a
   * different account. Telling someone their key is bad when the token verifies
   * as active sends them off re-creating credentials that were never the problem.
   */
  let hint = '';
  if (isCloudflare) {
    // A base URL of the form /accounts/<id>/ai/run/<model> is the native
    // single-model endpoint, not the OpenAI-compatible surface Klaud talks to.
    // It must be /accounts/<id>/ai/v1, with the model named in the request body.
    const nativeRunUrl = /\/ai\/run\//i.test(url);
    if (nativeRunUrl) {
      hint =
        ' Your base URL uses the native Workers AI shape (/ai/run/<model>). Klaud needs the ' +
        'OpenAI-compatible one, which ends in /ai/v1 — the model goes in the model field, not the URL. ' +
        'Click Free, then Cloudflare, then Set up automatically, and Klaud will build it correctly.';
    } else if (cfCode === 1001 || cfCode === 6111) {
      // A hand-written curl command that omits -H produces this. Klaud always
      // sends the header, so saying where it comes from avoids a wrong turn.
      hint =
        ' Cloudflare received no usable Authorization header. From a curl command that means the -H ' +
        'flag was missing or the header was written as a bare argument instead of after -H. Klaud always ' +
        'sends it, so if this appears in the app the base URL is the more likely culprit.';
    } else if (cfCode === 9109) {
      hint =
        ' Cloudflare accepted your token but says you are not authorized for this account, which means ' +
        'the token and the account ID belong to different accounts. Copy your own account ID from the ' +
        'address bar of dash.cloudflare.com — the 32-character value right after the domain.';
    } else if (cfCode === 7001) {
      hint =
        ' Cloudflare did not recognise that URL. This usually means the account segment is wrong, or that ' +
        'angle brackets were left in the URL from an example — those are placeholders, not part of a URL, ' +
        'and Windows treats them as redirections.';
    } else if (status === 401 || status === 403 || cfCode === 10000) {
      hint =
        ' Cloudflare rejected the request, but this does not necessarily mean your key is wrong. ' +
        'Workers AI returns "Authentication error" when the account ID in the URL belongs to a ' +
        'different account than the token, or when the token lacks the Workers AI permission. ' +
        'Run `npm run check-cloudflare` to see which of the two it is — it reads your current settings.';
    } else if (status === 404) {
      hint =
        ' Cloudflare could not route that URL. The Workers AI base URL must end in /ai/v1, with your ' +
        'own 32-character account ID in place of the account segment. Click Free, then Cloudflare, then ' +
        'Set up automatically to have it built for you.';
    } else if (status === 429) {
      hint = ' Cloudflare is rate limiting. The free allowance is 10,000 Neurons per day, resetting at 00:00 UTC.';
    }
  } else if (/127\.0\.0\.1:20128|localhost:20128/i.test(url)) {
    if (status === 401) {
      hint = ' OmniRoute requires an API key. Open http://localhost:20128 in a browser, then Dashboard → Endpoints, copy your key, and paste it in Settings.';
    } else if (status === 402) {
      hint = ' The upstream provider for this model ran out of quota or credits. Switch to auto/best-free or another free model in Settings.';
    }
  } else if (status >= 500) {
    // NVIDIA's shared endpoint answers 500 {"message":"Failed to generate
    // completions"} for a minimal request as readily as a complex one, which
    // means the fault is theirs. Confirmed by probing: every variant fails at
    // once, then everything recovers. Saying so stops people rewriting working
    // configuration to chase an outage.
    hint =
      'The provider\'s model server failed, which usually means their shared endpoint is ' +
      'temporarily unhealthy rather than anything wrong with your request. This is not your key ' +
      'or your settings. Retry in a moment, or switch model.';
  } else {
    const hints = {
      401: 'The API key was rejected. Check it in Settings, and make sure the base URL matches the provider.',
      403: 'Access denied. The key may lack permission for this model.',
      404: 'Endpoint not found. Most providers need the base URL to end in /v1.',
      429: 'Rate limited or out of quota. Wait a moment, or pick a different model.',
    };
    hint = hints[status] ? ` ${hints[status]}` : '';
  }

  const parts = [`HTTP ${status} from provider.`];
  if (hint) parts.push(hint.trim());
  if (cfCode !== null) parts.push(`(Cloudflare code ${cfCode})`);
  if (detail && detail.trim()) parts.push(`\n\n${detail.trim()}`);
  if (context.model) parts.push(`\n\nModel: ${context.model}`);
  if (context.baseUrl) parts.push(`\nBase URL: ${context.baseUrl}`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Streaming tool-call assembly
 * ------------------------------------------------------------------ */

/**
 * Normalise the role layout before a request goes out.
 *
 * Klaud nudges the model mid-conversation with system messages — the wrap-up
 * when the step budget runs out, the "you ended without an answer" prompt, the
 * loop-breaker. Ollama's chat templates raise on exactly that shape
 * ("System message must be at the beginning") and fail the whole request, which
 * is what made a local model appear unable to call tools: the first tool call
 * worked, then the corrective nudge blew up the next request.
 *
 * Every OpenAI-compatible endpoint accepts a user message anywhere, so later
 * system messages are downgraded to user on the wire. The stored transcript is
 * untouched — only what the provider receives changes.
 */
function normalizeWireMessages(messages) {
  return (messages || []).map((message, index) => {
    if (index > 0 && message && message.role === 'system') {
      const { role, ...rest } = message;
      return { ...rest, role: 'user' };
    }
    return message;
  });
}

/** Tool arguments arrive as a string from most providers and as an object from some (Ollama's older OpenAI shim). Both are valid here. */
function argumentsToString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function createAccumulator() {
  const calls = new Map();
  return {
    calls,
    add(delta) {
      const index = Number.isInteger(delta.index)
        ? delta.index
        : delta.id
          ? (calls.get(delta.id)?.index ?? calls.size)
          : calls.size;
      let entry = null;
      for (const candidate of calls.values()) {
        if (candidate.index === index) {
          entry = candidate;
          break;
        }
      }
      if (!entry) {
        entry = { index, id: '', type: 'function', name: '', args: '' };
        calls.set(`${index}`, entry);
      }
      if (delta.id) entry.id = delta.id;
      const fn = delta.function || {};
      if (fn.name) entry.name = fn.name;
      if (fn.arguments) entry.args += argumentsToString(fn.arguments);
    },
    list() {
      return [...calls.values()]
        .sort((a, b) => a.index - b.index)
        .map((c, i) => ({
          id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: {
            name: c.name || '',
            arguments: c.args || '{}',
          },
        }))
        .filter((c) => c.function.name);
    },
  };
}

/**
 * Try to repair the JSON a model produced for tool arguments. Local models are
 * frequently sloppy here, and a hard failure wastes a whole round trip.
 */
function parseToolArguments(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch { /* fall through */ }

  // Strip markdown fences and trailing commas, then try again.
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through */ }

  // Last resort: grab the outermost braced object.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* give up */ }
  }
  return { __parse_error: true, raw: text.slice(0, 2_000) };
}

/* ------------------------------------------------------------------ *
 * Reasoning effort
 * ------------------------------------------------------------------ */

const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * A known level, or '' for anything else.
 *
 * Not a clamp: turning "banana" into "medium" would put a parameter on the wire
 * that nobody selected, and the unset state has to stay reachable.
 */
function knownReasoningEffort(effort) {
  const level = String(effort || '').trim().toLowerCase();
  return REASONING_EFFORT_LEVELS.includes(level) ? level : '';
}

/**
 * How to say "reason more" to the endpoint at `baseUrl`.
 *
 * There is no single standard field for this, so this maps a host to the one
 * field that host documents and returns an empty object for everyone else. That
 * is the whole point: a provider that does not know a field answers 400 and the
 * turn is dead, so a wrong guess is worse than silence. Only add an entry here
 * after reading the provider's own API reference — "it is OpenAI-compatible"
 * does not imply it tolerates unknown body parameters the way OpenAI does.
 *
 *   api.openai.com            reasoning_effort: "low" | "medium" | "high"
 *                             (the OpenAI reasoning-model parameter)
 *   openrouter.ai             reasoning: { effort: ... }
 *                             (OpenRouter's normalised form; it translates the
 *                             effort into whatever the routed model speaks, so
 *                             this covers Anthropic and Gemini models reached
 *                             through OpenRouter)
 *   integrate.api.nvidia.com  nothing. NVIDIA's own NIM reference documents no
 *                             effort parameter, and a strict validator rejects
 *                             the whole request over one unknown key.
 *   everything else           nothing.
 *
 * The returned object is spread straight into the request body, so the keys
 * here are the wire format.
 */
function reasoningEffortFields(baseUrl, effort) {
  const level = knownReasoningEffort(effort);
  if (!level) return {};

  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return {};
  }

  if (host === 'api.openai.com') return { reasoning_effort: level };
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return { reasoning: { effort: level } };
  return {};
}

/**
 * Fallback level, used only when a caller does not pass one.
 *
 * The agent loop forwards `settings.reasoningEffort` on every request, which is
 * the path that matters. This exists for the callers that do not — the model
 * list, and any direct call — so the server can still make the setting take
 * effect everywhere without threading it through by hand. The value is replaced,
 * never merged, so clearing the slider really does stop the field being sent.
 */
let activeReasoningEffort = '';

function configureReasoningEffort(effort) {
  activeReasoningEffort = knownReasoningEffort(effort);
  return activeReasoningEffort;
}

/* ------------------------------------------------------------------ *
 * Streaming request
 * ------------------------------------------------------------------ */

/**
 * Stream one completion.
 *
 * `onEvent({type, ...})` receives:
 *   {type:'text', value}
 *   {type:'reasoning', value}
 *   {type:'usage', usage}
 *   {type:'finish', reason}
 *
 * Resolves with { text, reasoning, toolCalls, finishReason, usage, model }.
 */
async function streamChat({
  baseUrl,
  apiKey,
  extraHeaders,
  model,
  messages,
  tools,
  toolChoice,
  temperature = 0.2,
  maxTokens,
  reasoningEffort,
  signal,
  onEvent = () => {},
}) {
  if (!model) throw new LLMError('No model selected. Open Settings and choose a model.');

  const url = chatCompletionsUrl(baseUrl);
  const body = {
    model,
    // Roles normalised for chat templates that reject a mid-conversation
    // system message — see normalizeWireMessages. Only the wire is touched.
    messages: normalizeWireMessages(messages),
    stream: true,
    temperature,
    // Only present when the provider is known to accept it. See
    // reasoningEffortFields: an unknown provider gets no field at all.
    ...reasoningEffortFields(baseUrl, reasoningEffort === undefined ? activeReasoningEffort : reasoningEffort),
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new LLMError('Cancelled.');
      lastError = new LLMError(
        `Could not reach ${url} — ${err.message}. Check the base URL, your network, and whether the local server is running.`,
        { url }
      );
      if (attempt < 2) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      if (RETRY_STATUS.has(res.status) && attempt < 2) {
        const bodyText = await peekBody(res);
        const wait = retryDelayMs(res, bodyText);
        const backoff = res.status === 429 ? 1_500 * (attempt + 1) : 700 * (attempt + 1);
        const delay = wait === null ? backoff : wait;

        // A throttle that outlasts the cap is reported now, with the provider's
        // own words, rather than blocking for minutes or failing silently.
        if (delay > MAX_RETRY_WAIT_MS) {
          const secs = Math.ceil(delay / 1_000);
          throw new LLMError(
            `Rate limited. The provider asked for a ${secs}s wait, which is longer than Klaud will ` +
              `block a turn for. Wait it out, or switch model or provider.\n\n${bodyText.slice(0, 400).trim()}`,
            { status: res.status, url, body: bodyText.slice(0, 800) }
          );
        }

        if (typeof onEvent === 'function') {
          onEvent({
            type: 'notice',
            level: 'info',
            message: `Rate limited — waiting ${Math.round(delay / 1_000)}s before retrying (attempt ${attempt + 2} of 3).`,
          });
        }
        await sleep(delay);
        continue;
      }
      throw new LLMError(await describeHttpError(res, { url, model, baseUrl }), { status: res.status, url });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('event-stream') && !contentType.includes('stream')) {
      // Some gateways ignore stream:true and return a single JSON body.
      const raw = await res.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new LLMError(`Provider returned a non-JSON response (${contentType}).`, { body: raw.slice(0, 800), url });
      }
      if (payload.error) {
        throw new LLMError(payload.error.message || JSON.stringify(payload.error), { status: res.status, url });
      }
      return fromNonStreaming(payload, onEvent);
    }

    return await consumeStream(res, onEvent);
  }

  throw lastError || new LLMError('Request failed after retries.', { url });
}

function fromNonStreaming(payload, onEvent) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const text = message.content || '';
  const reasoning = message.reasoning_content || message.reasoning || '';
  if (reasoning) onEvent({ type: 'reasoning', value: reasoning });
  if (text) onEvent({ type: 'text', value: text });
  if (payload.usage) onEvent({ type: 'usage', usage: payload.usage });
  const finishReason = choice.finish_reason || 'stop';
  onEvent({ type: 'finish', reason: finishReason });

  const toolCalls = (message.tool_calls || [])
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      type: 'function',
      function: { name: c.function.name, arguments: argumentsToString(c.function.arguments) || '{}' },
    }));

  return {
    text,
    reasoning,
    toolCalls,
    finishReason,
    usage: payload.usage || null,
    model: payload.model || '',
  };
}

async function consumeStream(res, onEvent) {
  const decoder = new TextDecoder('utf-8');
  const accumulator = createAccumulator();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let responseModel = '';
  let sawAnyChunk = false;

  const handleData = (data) => {
    if (data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    sawAnyChunk = true;
    if (chunk.error) {
      throw new LLMError(chunk.error.message || JSON.stringify(chunk.error));
    }
    if (chunk.model && chunk.model !== 'keepalive') responseModel = chunk.model;
    if (chunk.usage) {
      usage = chunk.usage;
      onEvent({ type: 'usage', usage: chunk.usage });
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta) {
      reasoning += reasoningDelta;
      onEvent({ type: 'reasoning', value: reasoningDelta });
    }

    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onEvent({ type: 'text', value: delta.content });
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (typeof part?.text === 'string' && part.text) {
          text += part.text;
          onEvent({ type: 'text', value: part.text });
        }
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) accumulator.add(call);
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith('data:')) handleData(buffer.trim().slice(5).trim());
  } catch (err) {
    if (err instanceof LLMError) throw err;
    throw new LLMError(`Stream interrupted: ${err.message}`);
  }

  const toolCalls = accumulator.list();
  if (!sawAnyChunk && !text && !toolCalls.length) {
    throw new LLMError(
      'The provider returned an empty stream. Check that the base URL points at an OpenAI-compatible /v1 endpoint and that the model name is valid.'
    );
  }

  const finalReason = finishReason || (toolCalls.length ? 'tool_calls' : 'stop');
  onEvent({ type: 'finish', reason: finalReason });

  return { text, reasoning, toolCalls, finishReason: finalReason, usage, model: responseModel };
}

function isCloudflareBase(base) {
  return /(^|\.)cloudflare\.com/i.test(String(base || ''));
}

/**
 * Clean up a base URL that was pasted from documentation.
 *
 * People copy example URLs verbatim, placeholders included. Angle brackets are
 * especially treacherous: on Windows `curl` treats < and > as redirections, so
 * the shell eats the hostname and curl reports "URL rejected: Bad hostname".
 * Stripping the brackets and placeholder words turns a confusing failure into a
 * working request, or at worst into a clear one.
 */
function normalizeBaseUrl(input, accountId) {
  let base = String(input || '').trim().replace(/^['"]|['"]$/g, '');
  // Drop angle/curly brackets but keep whatever was inside them, so a pasted
  // "accounts/<0264a5ba…>/ai/v1" becomes usable rather than mangled.
  base = base.replace(/[<>{}]/g, '');
  base = base.replace(/\b(your[-_]?account[-_]?id|account[-_]?id|account_id)\b/gi, accountId || '');
  if (accountId) {
    // A leftover placeholder segment becomes the real account ID.
    base = base.replace(/accounts\/(?=\/|$)/i, `accounts/${accountId}/`);
  }
  return base.replace(/\/+$/, '');
}

/**
 * List models from {baseUrl}/models — used by the Settings UI.
 *
 * Almost every provider serves this as a GET. Cloudflare Workers AI does not:
 * its OpenAI-compatible surface answers the model list on POST and returns
 * `405 GET not supported for requested URI` for a GET. So the method is chosen
 * per provider rather than assumed.
 */
async function listModels({ baseUrl, apiKey, extraHeaders, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new LLMError('No base URL configured.');
  if (/[<>{}]/.test(String(baseUrl || ''))) {
    throw new LLMError(
      'That base URL still contains angle brackets, which are placeholders in documentation rather than ' +
        'part of the URL. On Windows the shell also treats < and > as redirections, which is why curl ' +
        'reports "Bad hostname" for one. Replace the bracketed part with your real account ID, or let ' +
        'Klaud build the URL for you via Free → Cloudflare → Set up automatically.'
    );
  }
  const url = /\/models$/.test(base) ? base : `${base}/models`;
  const needsPost = isCloudflareBase(base);

  let res;
  try {
    res = await fetch(url, {
      method: needsPost ? 'POST' : 'GET',
      headers: buildHeaders(apiKey, {
        accept: 'application/json',
        ...(needsPost ? { 'content-type': 'application/json' } : {}),
        ...(extraHeaders || {}),
      }),
      ...(needsPost ? { body: '{}' } : {}),
      signal,
    });
  } catch (err) {
    throw new LLMError(`Could not reach ${url} — ${err.message}`);
  }
  if (!res.ok) throw new LLMError(await describeHttpError(res, { url, baseUrl }), { status: res.status, url });

  const payload = await res.json().catch(() => null);
  // Shapes seen in the wild: OpenAI's {data:[{id}]}, OpenRouter's {data:[…]},
  // Cloudflare's {result:[{name}]}, and a bare array. Reading only `data`
  // returned an empty list for Cloudflare even after the method was right.
  const raw = Array.isArray(payload)
    ? payload
    : payload?.data || payload?.models || payload?.result || [];
  const models = (Array.isArray(raw) ? raw : [])
    .map((m) => {
      if (typeof m === 'string') return { id: m };
      const id = m?.id || m?.name || m?.model || m?.slug;
      return id ? { id, owned_by: m.owned_by || m.ownedBy || m?.provider } : null;
    })
    .filter(Boolean)
    // A model object may be nested one level down, as Cloudflare does.
    .map((m) => (typeof m.id === 'object' && m.id?.name ? { ...m, id: m.id.name } : m))
    .filter((m) => typeof m.id === 'string' && m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

module.exports = {
  LLMError,
  streamChat,
  listModels,
  parseToolArguments,
  chatCompletionsUrl,
  createAccumulator,
  normalizeBaseUrl,
  reasoningEffortFields,
  configureReasoningEffort,
  REASONING_EFFORT_LEVELS,
  describeHttpErrorForTest: describeHttpError,
  retryDelayMs,
  MAX_RETRY_WAIT_MS,
};
