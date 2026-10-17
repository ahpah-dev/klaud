'use strict';

/**
 * OmniRoute — automatic setup for a local gateway that answers without a key.
 *
 * OmniRoute (github.com/diegosouzapw/OmniRoute, MIT, npm `omniroute`, Docker
 * `diegosouzapw/omniroute`) is a self-hosted gateway, not a hosted API: the user
 * installs it, runs it, and it serves an OpenAI-compatible surface on
 * http://127.0.0.1:20128/v1 next to a dashboard on the same port. A fresh
 * install answers `model: "auto"` with no credentials at all, because a keyless
 * upstream is pre-wired into its auto combo. That keyless property is the only
 * reason it belongs in Klaud's free catalogue — the generosity it appears to
 * have is its routing over many upstream free tiers, not an allowance it grants.
 *
 * Five rules this module keeps, because getting any of them wrong changes the
 * user's machine or lies to them:
 *
 *   1. `probe` is read-only. One GET to `/models`; nothing started, nothing
 *      written. A refused connection is the normal "not running" state, not an
 *      error.
 *   2. `install` never runs without `allowInstall === true`. A global npm
 *      install is slow, network-heavy and permanent, so the default answer is
 *      the exact command for the user to run instead. OmniRoute is never added
 *      to Klaud's own package.json: a global install or an explicit npx call,
 *      and nothing else.
 *   3. `ensureRunning` checks the Node version before it starts anything.
 *      OmniRoute declares engines ">=22.22.2 <23 || >=24.0.0 <27" while Klaud
 *      still supports Node 18, so a Node 18 host is a real, reportable refusal
 *      rather than a process that dies two seconds later.
 *   4. Starting is detached and bounded: the child does not hold Klaud's pipes,
 *      the port is polled for at most a minute, and the result says what
 *      actually happened.
 *   5. Setup decides what to do about a stored API key rather than leaving it
 *      to chance. `src/llm.js` sends `Authorization: Bearer <key>` whenever
 *      settings hold a key, so someone switching from NVIDIA to OmniRoute would
 *      send `nvapi-...` to their own local gateway. A key that is accepted, or
 *      not needed, stays; a key the gateway rejects is flagged for clearing
 *      (`clearApiKey: true`) instead of being silently kept or silently wiped.
 *
 * The listener is addressed as 127.0.0.1, never `localhost`: on a machine that
 * resolves `localhost` to ::1 first, the check would miss an IPv4-only listener
 * and report "not running" for a healthy install.
 *
 * Everything here uses Node builtins. `npm` is run through `spawn`, not a
 * library, and every dependency can be injected (`fetch`, `spawn`, `pathEnv`,
 * `nodeVersion`, `platform`) so tests describe what they actually ran.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* ------------------------------------------------------------------ *
 * Known facts and defaults
 * ------------------------------------------------------------------ */

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1';
const DEFAULT_MODEL = 'auto';
const DEFAULT_PORT = 20128;

/** OmniRoute's own declared runtime range, quoted rather than reinterpreted. */
const NODE_REQUIREMENT = '>=22.22.2 <23 || >=24.0.0 <27';
const NODE_REQUIREMENT_TEXT = 'Node 22.22.2 or newer within 22.x, or 24.x through 26.x (23.x is excluded)';

const INSTALL_COMMAND = 'npm install -g omniroute';
const INSTALL_ARGS = ['install', '-g', 'omniroute'];

const PROBE_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 750;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Statuses that mean "your credentials are the problem", not "the server is". */
const AUTH_STATUSES = [401, 403];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function seconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function snippet(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A lenient version tuple: `24`, `24.1`, `v24.1.2` all parse. */
function parseVersion(value) {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluate a tiny range grammar: `||` alternatives, each an AND of `>=`, `>`,
 * `<=`, `<` and `=` comparators. That is the whole of what OmniRoute's engines
 * field declares, and parsing it here keeps a zero-dependency project free of a
 * semver package.
 */
function satisfiesNodeRange(version, range = NODE_REQUIREMENT) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const groupRe = /(>=|<=|>|<|=)\s*v?(\d+(?:\.\d+){0,2})/g;
  return String(range)
    .split('||')
    .some((group) => {
      const comparators = [...group.matchAll(groupRe)].map(([, op, target]) => [op, parseVersion(target)]);
      if (!comparators.length) return false;
      return comparators.every(([op, target]) => {
        const cmp = compareVersions(parsed, target);
        if (op === '>=') return cmp >= 0;
        if (op === '>') return cmp > 0;
        if (op === '<=') return cmp <= 0;
        if (op === '<') return cmp < 0;
        return cmp === 0;
      });
    });
}

function reportedNodeVersion(nodeVersion) {
  return String(nodeVersion || process.versions.node || '').replace(/^v/i, '');
}

/** OpenAI-shaped model ids out of whatever a server called its list. */
function normaliseModels(json) {
  const list = Array.isArray(json) ? json : json?.data || json?.models || [];
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry?.id || entry?.name || null;
    })
    .filter(Boolean);
}

function summariseModels(state) {
  const models = (state && state.models) || [];
  if (!models.length) return 'it reported no models';
  return `it listed ${models.length} model${models.length === 1 ? '' : 's'}${
    models.includes(DEFAULT_MODEL) ? `, including "${DEFAULT_MODEL}"` : `, without "${DEFAULT_MODEL}"`
  }`;
}

/* ------------------------------------------------------------------ *
 * probe — the only read-only entry point
 * ------------------------------------------------------------------ */

/**
 * Is an OpenAI-compatible API answering at `baseUrl`?
 *
 * One GET, nothing else. `apiKey` exists because Klaud's own requests always
 * carry whatever key is saved; setup needs to ask the same question the chat
 * request will ask, rather than one it knows will differ.
 *
 * The result never throws for an expected state:
 *   running    — `/models` answered with an OpenAI-shaped list
 *   reachable  — something answered, but not as that API (wrong port, half-up)
 *   refused    — nothing is listening; the normal state on a fresh machine
 *   error      — a sentence naming what happened, or null when it worked
 */
async function probe({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = PROBE_TIMEOUT_MS,
  apiKey = '',
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const root = trimTrailingSlash(baseUrl);
  const empty = { running: false, reachable: false, refused: false, status: null, models: [], version: null };

  if (typeof fetchImpl !== 'function') {
    return {
      ...empty,
      error:
        'This Node has no global fetch, which probing an endpoint needs. Klaud runs on Node 18 and newer, where it exists — the Node running it here is older.',
    };
  }

  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_MS;
  const headers = { accept: 'application/json' };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key) headers.authorization = `Bearer ${key}`;

  let res;
  try {
    res = await fetchImpl(`${root}/models`, { headers, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const codes = [
      err?.code,
      err?.cause?.code,
      ...((err?.cause?.errors || []).map((inner) => inner?.code)),
    ].filter(Boolean);

    // A closed port is a normal answer, not a failure: this is what "OmniRoute
    // is not running yet" looks like from the outside.
    if (codes.includes('ECONNREFUSED')) {
      return { ...empty, refused: true, error: null };
    }
    const timedOut =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      /abort|timed?\s*out/i.test(String(err?.message || ''));
    if (timedOut) {
      return {
        ...empty,
        error: `nothing answered within ${ms}ms at ${root}/models — a listener that never replies looks like this.`,
      };
    }
    const reason = snippet(err?.message || String(err), 140) || 'the connection failed without a reason';
    return { ...empty, error: `could not reach ${root}/models: ${reason}` };
  }

  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    text = '';
    if (!res.ok) {
      return {
        ...empty,
        reachable: true,
        status: res.status,
        error: `HTTP ${res.status} from ${root}/models, and the body could not be read (${snippet(err?.message)}).`,
      };
    }
  }

  if (!res.ok) {
    const detail = snippet(text, 200);
    return {
      ...empty,
      reachable: true,
      status: res.status,
      error: `HTTP ${res.status} from ${root}/models${detail ? ` — ${detail}` : ''}`,
    };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ...empty,
      reachable: true,
      status: res.status,
      error:
        `HTTP ${res.status} at ${root}/models, but the body was not JSON` +
        `${text.trim() ? ` (it starts "${snippet(text, 80)}")` : ' (it was empty)'}. ` +
        'Something other than an OpenAI-compatible API is answering on that port.',
    };
  }

  const looksShaped = Array.isArray(json) || Array.isArray(json?.data) || Array.isArray(json?.models);
  if (!looksShaped) {
    return {
      ...empty,
      reachable: true,
      status: res.status,
      error:
        `HTTP ${res.status} at ${root}/models, but the JSON carries no model list ` +
        `(${snippet(text, 120) || 'empty object'}). That is not an OpenAI-compatible /models response.`,
    };
  }

  const models = normaliseModels(json);
  // OmniRoute's README does not document a version field here, so this is best
  // effort: when it is absent the field is null and no version is ever claimed.
  const version =
    (typeof json?.version === 'string' && json.version) ||
    (typeof json?.omnirouteVersion === 'string' && json.omnirouteVersion) ||
    res.headers?.get?.('x-omniroute-version') ||
    null;

  return {
    running: true,
    reachable: true,
    refused: false,
    status: res.status,
    baseUrl: root,
    models,
    version,
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * Locating the command
 * ------------------------------------------------------------------ */

function windowsExtensions() {
  // npm puts `.cmd` shims on PATH on Windows; the extension-less file it also
  // writes is a shell script that Windows cannot execute, so it is tried last.
  const fromEnv = String(process.env.PATHEXT || '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const exts = ['.cmd', '.exe', '.bat'];
  for (const ext of fromEnv) if (!exts.includes(ext)) exts.push(ext);
  exts.push('');
  return exts;
}

function defaultExists(target) {
  try {
    fs.accessSync(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a command on a PATH string, without a shell and without `which`.
 *
 * Returns the full path, or null. On POSIX the executable bit is checked, because
 * a directory entry that cannot run is not an installed program.
 */
function resolveBinary({
  command,
  pathEnv = process.env.PATH,
  platform = process.platform,
  exists = defaultExists,
} = {}) {
  const raw = pathEnv === undefined || pathEnv === null ? process.env.PATH || '' : String(pathEnv);
  const dirs = raw
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = platform === 'win32' ? windowsExtensions() : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!exists(candidate)) continue;
      if (platform !== 'win32' && ext === '') {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

/**
 * How to spawn a given executable.
 *
 * Windows cannot execute a `.cmd` or `.bat` without a command processor, and an
 * npm global install leaves exactly those shims. The path is quoted because the
 * npm prefix normally sits under a user profile that can contain a space, and
 * unquoted it would split there.
 */
function spawnSpec(file, args = [], platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: `"${file}"`, args, shell: true, label: `${file} ${args.join(' ')}`.trim() };
  }
  return { file, args, shell: false, label: `${file} ${args.join(' ')}`.trim() };
}

/* ------------------------------------------------------------------ *
 * ensureRunning — start it, or explain why not
 * ------------------------------------------------------------------ */

function startDetached({ binary, spawnFn, platform = process.platform }) {
  const spec = spawnSpec(binary, [], platform);
  const options = { detached: true, windowsHide: true, stdio: 'ignore' };
  if (spec.shell) options.shell = true;

  try {
    const child = spawnFn(spec.file, spec.args, options);
    // Detached and unref'd on purpose: OmniRoute must outlive this HTTP request,
    // Klaud must not wait for it, and closing Klaud must not take it down.
    // `stdio: 'ignore'` rather than pipes — a detached process writing into
    // pipes we stop reading would block on a full buffer, and closing our end
    // would kill its logging.
    if (typeof child?.unref === 'function') child.unref();
    return { child, spec };
  } catch (err) {
    return { error: err, spec };
  }
}

/**
 * Make sure OmniRoute is answering, starting it only when allowed to.
 *
 * Order, and why:
 *   1. probe. If it is already answering there is nothing to start, and nothing
 *      to refuse: the version gate below guards *starting*, not *using*. A
 *      running OmniRoute is already running under a Node that satisfies its
 *      requirement (or in Docker, where this machine's Node is irrelevant).
 *   2. Node version. Refused with the real range before anything is spawned, so
 *      the failure is a sentence rather than a crash two seconds later.
 *   3. Is `omniroute` on PATH? If not, this function cannot start anything, and
 *      installing is not its job — `install` owns that decision.
 *   4. Start detached, then poll the port for a bounded time.
 */
async function ensureRunning({
  allowStart = false,
  baseUrl = DEFAULT_BASE_URL,
  nodeVersion = process.versions.node,
  timeoutMs = PROBE_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  pollMs = POLL_MS,
  fetch: fetchImpl,
  spawn: spawnFn = spawn,
  pathEnv = process.env.PATH,
  platform = process.platform,
} = {}) {
  const root = trimTrailingSlash(baseUrl);
  const current = await probe({ baseUrl: root, timeoutMs, fetch: fetchImpl });

  if (current.running) {
    return {
      ok: true,
      started: false,
      alreadyRunning: true,
      stage: 'running',
      baseUrl: root,
      probe: current,
      message: `OmniRoute is already answering on ${root} — ${summariseModels(current)}. Nothing was started.`,
      hint: `Klaud can point at ${root} with model "${DEFAULT_MODEL}". No key is needed for local use.`,
    };
  }

  const version = reportedNodeVersion(nodeVersion);
  if (!satisfiesNodeRange(nodeVersion)) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'node',
      baseUrl: root,
      probe: current,
      message:
        `OmniRoute cannot run on Node ${version}: it declares engines "${NODE_REQUIREMENT}" ` +
        `(${NODE_REQUIREMENT_TEXT}). Klaud itself still supports Node 18, so a Node 18 host is below ` +
        'OmniRoute\'s floor, not merely untested against it.',
      hint:
        `Run Klaud on ${NODE_REQUIREMENT_TEXT}, or run OmniRoute in Docker (diegosouzapw/omniroute) ` +
        `on port ${DEFAULT_PORT} and let Klaud use it from there.`,
    };
  }

  if (current.reachable) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'blocked',
      baseUrl: root,
      probe: current,
      message:
        `Something is answering on ${originOf(root)} but not as an OpenAI-compatible API: ${current.error}`,
      hint:
        'Do not start a second copy on the same port. Close whatever is holding it, or start OmniRoute ' +
        `on another port and point Klaud's base URL at it.`,
    };
  }

  const binary = resolveBinary({ command: 'omniroute', pathEnv, platform });
  if (!binary) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'not-installed',
      baseUrl: root,
      probe: current,
      message:
        'OmniRoute is not installed: there is no `omniroute` command on PATH, so there is nothing to start.' +
        (current.refused
          ? ' A connection to port 20128 was refused, which is what a machine without it looks like.'
          : ''),
      hint:
        `Install it with \`${INSTALL_COMMAND}\` — a global install, never into Klaud's package.json — ` +
        'then run this again. OmniRoute needs ' + NODE_REQUIREMENT_TEXT + '.',
    };
  }

  if (allowStart !== true) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'needs-start-consent',
      baseUrl: root,
      binary,
      probe: current,
      message:
        `OmniRoute is installed at ${binary} but is not running, and this call is not allowed to start ` +
        'processes on your machine.',
      hint: 'Run `omniroute` in a terminal and try again, or approve starting it from Klaud.',
    };
  }

  const launched = startDetached({ binary, spawnFn, platform });
  if (launched.error) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'start-failed',
      baseUrl: root,
      probe: current,
      message: `Could not start ${binary}: ${snippet(launched.error?.message || String(launched.error))}`,
      hint:
        `Run \`${binary}\` yourself in a terminal to see why. The usual causes are the Node version ` +
        `requirement (${NODE_REQUIREMENT_TEXT}) and a native build that did not compile during install.`,
    };
  }

  const child = launched.child;
  let exit = null;
  let spawnError = null;
  if (typeof child?.once === 'function') {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
    });
    child.once('error', (err) => {
      spawnError = err;
    });
  }

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, startTimeoutMs);
  const wait = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : POLL_MS;
  let latest = current;

  while (Date.now() < deadline) {
    await sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
    latest = await probe({ baseUrl: root, timeoutMs, fetch: fetchImpl });
    if (latest.running) {
      return {
        ok: true,
        started: true,
        alreadyRunning: false,
        stage: 'started',
        baseUrl: root,
        pid: child?.pid,
        elapsedMs: Date.now() - startedAt,
        probe: latest,
        message:
          `Started OmniRoute${child?.pid ? ` (pid ${child.pid})` : ''} and it answered on ${root} after ` +
          `${seconds(Date.now() - startedAt)} — ${summariseModels(latest)}.`,
        hint:
          `Klaud can point at ${root} with model "${DEFAULT_MODEL}" and no key at all. It runs ` +
          'detached, so it keeps answering after Klaud exits; start it again at any time with `omniroute`.',
      };
    }
    if (spawnError) break;
    if (exit) break;
  }

  if (spawnError) {
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'start-failed',
      baseUrl: root,
      probe: latest,
      message: `OmniRoute could not be started: ${snippet(spawnError?.message || String(spawnError))}`,
      hint:
        `Run \`${binary}\` yourself in a terminal. If the PATH entry is a broken shim, reinstall it with ` +
        `\`${INSTALL_COMMAND}\`.`,
    };
  }

  if (exit) {
    const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
    return {
      ok: false,
      started: false,
      alreadyRunning: false,
      stage: 'start-failed',
      baseUrl: root,
      probe: latest,
      exit,
      message:
        `OmniRoute ${how} before it answered on ${originOf(root)}. Nothing is listening there now.`,
      hint:
        `Run \`${binary}\` in a terminal to see its output. An exit this early is normally the Node ` +
        `version requirement (${NODE_REQUIREMENT_TEXT}) or an install whose native dependency did not ` +
        'build.',
    };
  }

  const lastState = latest?.refused
    ? 'Nothing is listening on the port yet.'
    : latest?.error
      ? `Last probe: ${latest.error}`
      : '';

  return {
    ok: false,
    started: true,
    alreadyRunning: false,
    stage: 'start-timeout',
    baseUrl: root,
    pid: child?.pid,
    elapsedMs: Date.now() - startedAt,
    probe: latest,
    message:
      `OmniRoute was started${child?.pid ? ` (pid ${child.pid})` : ''} but did not answer on ${root} ` +
      `within ${seconds(startTimeoutMs)}. ${lastState}`.trim(),
    hint:
      'It may still be starting: a first run has more to set up than later ones. Wait a moment and run ' +
      `setup again, or run \`omniroute\` in a terminal to watch its output.`,
  };
}

/* ------------------------------------------------------------------ *
 * install — a global npm install, and only with consent
 * ------------------------------------------------------------------ */

/**
 * Run a command and collect a bounded amount of its output.
 *
 * Not exported: this exists so `install` can say what npm actually printed rather
 * than "npm failed".
 */
function runCapture(spawnFn, spec, timeoutMs, limit = 4_000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...outcome });
    };

    let timer = null;
    try {
      const options = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
      if (spec.shell) options.shell = true;
      child = spawnFn(spec.file, spec.args, options);
    } catch (err) {
      return finish({ code: null, signal: null, timedOut: false, spawnError: err });
    }

    timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        /* nothing left to kill */
      }
      finish({ code: null, signal: null, timedOut: true });
    }, Math.max(1_000, timeoutMs));

    child?.stdout?.on?.('data', (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString('utf8');
    });
    child?.stderr?.on?.('data', (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString('utf8');
    });
    child?.once?.('error', (err) => finish({ code: null, signal: null, timedOut: false, spawnError: err }));
    child?.once?.('close', (code, signal) => finish({ code, signal, timedOut: false, spawnError: null }));
  });
}

/**
 * Install OmniRoute globally — only when explicitly allowed.
 *
 * Without `allowInstall === true` this returns the command and changes nothing,
 * which is the whole point: a global npm install is slow, network-heavy and a
 * permanent change to the user's machine. Klaud's own package.json is never
 * touched, so this is either this global install or an explicit `npx omniroute`.
 */
async function install({
  allowInstall = false,
  nodeVersion = process.versions.node,
  spawn: spawnFn = spawn,
  pathEnv = process.env.PATH,
  platform = process.platform,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  const command = INSTALL_COMMAND;

  if (allowInstall !== true) {
    return {
      ok: false,
      installed: false,
      stage: 'needs-consent',
      command,
      args: [...INSTALL_ARGS],
      message:
        `Installing OmniRoute is a global npm install (${command}): slow, network-heavy, and a permanent ` +
        'change to this machine. Klaud will not run that unless you ask it to.',
      hint:
        `Run \`${command}\` yourself and then run setup again — or approve the install and Klaud will do ` +
        'it for you. Either way it goes in globally; Klaud never adds it to its own package.json.',
    };
  }

  const version = reportedNodeVersion(nodeVersion);
  if (!satisfiesNodeRange(nodeVersion)) {
    return {
      ok: false,
      installed: false,
      stage: 'node',
      command,
      message:
        `npm would install OmniRoute on any Node, but OmniRoute declares engines "${NODE_REQUIREMENT}" ` +
        `(${NODE_REQUIREMENT_TEXT}) and this process is Node ${version}, so the install would produce ` +
        'something that cannot run.',
      hint: `Install and run Klaud on ${NODE_REQUIREMENT_TEXT}, then install OmniRoute from there.`,
    };
  }

  const existing = resolveBinary({ command: 'omniroute', pathEnv, platform });
  if (existing) {
    return {
      ok: true,
      installed: true,
      alreadyInstalled: true,
      stage: 'installed',
      command,
      path: existing,
      message: `OmniRoute is already installed at ${existing}, so there was nothing to install.`,
      hint: 'Start it with `omniroute`, or let setup start it for you.',
    };
  }

  const npm = resolveBinary({ command: 'npm', pathEnv, platform });
  if (!npm) {
    return {
      ok: false,
      installed: false,
      stage: 'npm-missing',
      command,
      message:
        'npm is not on PATH, so Klaud cannot install OmniRoute. npm ships with Node.js, so this machine ' +
        'either has no Node installed for this process or has a PATH that does not reach it.',
      hint:
        `Install Node ${NODE_REQUIREMENT_TEXT} from nodejs.org (npm comes with it), then run ` +
        `\`${command}\` yourself or run setup again.`,
    };
  }

  const spec = spawnSpec(npm, INSTALL_ARGS, platform);
  const run = await runCapture(spawnFn, spec, timeoutMs);

  if (run.spawnError) {
    const code = run.spawnError?.code || run.spawnError?.cause?.code;
    return {
      ok: false,
      installed: false,
      stage: 'npm-missing',
      command,
      message:
        `Klaud could not run npm (${npm}): ${snippet(run.spawnError?.message || String(run.spawnError))}` +
        (code ? ` [${code}]` : ''),
      hint:
        `Check that npm works in a terminal (\`${npm} --version\`), then either fix the PATH or run ` +
        `\`${command}\` yourself.`,
    };
  }

  if (run.timedOut) {
    return {
      ok: false,
      installed: false,
      stage: 'install-failed',
      command,
      message: `npm did not finish installing OmniRoute within ${Math.round(timeoutMs / 60_000)} minutes.`,
      hint:
        `Run \`${command}\` in a terminal so you can watch it. A first install pulls a large dependency ` +
        'tree, so it is slow on a poor connection — but a hang usually means a registry problem.',
    };
  }

  if (run.code !== 0) {
    const words = snippet(run.stderr, 400) || snippet(run.stdout, 400) || 'npm printed nothing';
    return {
      ok: false,
      installed: false,
      stage: 'install-failed',
      command,
      exitCode: run.code,
      message: `npm exited with code ${run.code}: ${words}`,
      hint:
        `Run \`${command}\` in a terminal to see the full log. The usual failures are the Node version ` +
        `requirement (${NODE_REQUIREMENT_TEXT}) and a native build of better-sqlite3 that had no ` +
        'prebuilt binary for this platform.',
    };
  }

  const found = resolveBinary({ command: 'omniroute', pathEnv, platform });
  if (!found) {
    return {
      ok: false,
      installed: true,
      stage: 'install-failed',
      command,
      message:
        'npm reported success, but `omniroute` is still not on this process\'s PATH, so Klaud cannot ' +
        'start it. That is a PATH problem, not an install failure.',
      hint:
        'Open a new terminal (or restart Klaud) so the npm global bin directory is picked up — on ' +
        `Windows that is %APPDATA%\\npm, elsewhere \`npm prefix -g\` plus /bin — then run setup again.`,
    };
  }

  return {
    ok: true,
    installed: true,
    alreadyInstalled: false,
    stage: 'installed',
    command,
    path: found,
    message: `npm reported success and \`omniroute\` is now at ${found}.`,
    hint: 'Start it with `omniroute`, or let setup start it for you.',
  };
}

/* ------------------------------------------------------------------ *
 * The stored-key question
 * ------------------------------------------------------------------ */

/**
 * Probe once with the stored key, and once without it if the key was rejected.
 *
 * `src/llm.js` sends `Authorization: Bearer <key>` whenever settings hold a key,
 * so a user who configured NVIDIA and then picks OmniRoute still sends
 * `nvapi-...` to their own local gateway. OmniRoute's zero-config path needs no
 * auth, so a foreign bearer may be refused — and that failure would look like
 * OmniRoute being broken rather than a stale key being sent.
 */
async function inspectStoredKey({ baseUrl, apiKey, timeoutMs, fetch: fetchImpl }) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const withKey = await probe({ baseUrl, timeoutMs, apiKey: key, fetch: fetchImpl });
  const result = { key, withKey, withoutKey: null, rejected: false };

  if (!key || withKey.running) return result;
  // Only an auth status justifies a second probe. Anything else (refused,
  // timeout, HTML on the port) has nothing to do with the key.
  if (!AUTH_STATUSES.includes(withKey.status)) return result;

  result.rejected = true;
  result.withoutKey = await probe({ baseUrl, timeoutMs, fetch: fetchImpl });
  return result;
}

/* ------------------------------------------------------------------ *
 * setupOmniRoute — the orchestration
 * ------------------------------------------------------------------ */

/**
 * Get OmniRoute from whatever state it is in to "answering, with the right
 * auth", without inventing steps it was not allowed to take.
 *
 * Stages on the result:
 *   'running'             it was already answering; nothing was touched
 *   'started'             it was installed but not running, and was started
 *   'node'                this Node is below OmniRoute's requirement
 *   'needs-consent'       not installed, and installing was not allowed
 *   'needs-start-consent' installed but not running, and starting was not allowed
 *   'install-failed'      npm ran and failed (or installed it somewhere PATH sees not)
 *   'start-failed'        the spawn failed, exited early, or never answered
 *   'auth'               it answered but refused both the stored key and no key
 *   'blocked'             the port is held by something that is not this API
 *
 * The key decision, in the order it is made:
 *   - answers with the stored key (or there is no key) → `clearApiKey: false`
 *   - refuses the key with 401/403 but answers without one → `clearApiKey: true`
 *   - refuses both → no `clearApiKey` guess; both outcomes are reported
 */
async function setupOmniRoute({
  allowInstall = false,
  allowStart = false,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  storedApiKey = '',
  nodeVersion = process.versions.node,
  timeoutMs = PROBE_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  pollMs = POLL_MS,
  fetch: fetchImpl,
  spawn: spawnFn = spawn,
  pathEnv = process.env.PATH,
  platform = process.platform,
} = {}) {
  const root = trimTrailingSlash(baseUrl);
  const checks = [];
  const auth = await inspectStoredKey({ baseUrl: root, apiKey: storedApiKey, timeoutMs, fetch: fetchImpl });

  checks.push({
    step: 'probe',
    ok: auth.withKey.running,
    detail: auth.withKey.running
      ? `${root} answered /models — ${summariseModels(auth.withKey)}`
      : auth.withKey.refused
        ? `starting state: nothing is listening on ${originOf(root)}; the connection was refused`
        : `starting state: ${auth.withKey.error || `no OpenAI-compatible answer from ${root}`}`,
  });

  const keyNote = auth.key ? ' (asked with your saved API key, as Klaud\'s chat request would)' : '';
  const authChecks = () => {
    if (!auth.key) return [];
    if (auth.withKey.running) {
      return [{ step: 'stored key', ok: true, detail: 'the saved key was accepted, so it is left in place' }];
    }
    if (auth.rejected) {
      const second = auth.withoutKey;
      return [
        {
          step: 'stored key',
          ok: false,
          detail:
            `the saved key was refused with HTTP ${auth.withKey.status} — it belongs to a different ` +
            'provider, and Klaud sends whatever is saved as a Bearer token',
        },
        {
          step: 'probe without key',
          ok: Boolean(second?.running),
          detail: second?.running
            ? 'answered without any Authorization header'
            : second?.refused
              ? 'the connection was refused when no key was sent'
              : second?.error || 'no answer without a key',
        },
      ];
    }
    return [
      {
        step: 'stored key',
        ok: true,
        detail: 'the saved key is not the reason it is not running — the probe failed before a key mattered',
      },
    ];
  };

  /* ---------- already answering ---------- */

  if (auth.withKey.running) {
    checks.push(...authChecks());
    const models = auth.withKey.models;
    const autoPresent = models.includes(model);
    checks.push({
      step: 'model',
      ok: autoPresent,
      detail: autoPresent
        ? `the model list includes "${model}"`
        : `the model list does not include "${model}" — pick one of: ${models.slice(0, 8).join(', ') || '(none listed)'}`,
    });
    return {
      ok: true,
      stage: 'running',
      baseUrl: root,
      model,
      clearApiKey: false,
      alreadyRunning: true,
      started: false,
      models,
      message:
        `OmniRoute is already answering on ${root}${keyNote} — ${summariseModels(auth.withKey)}.` +
        (autoPresent ? '' : ` Its list does not include "${model}", so choose a model from it.`),
      hint: `Point Klaud at ${root} with model "${model}". No key is needed for local use.`,
      checks,
    };
  }

  /* ---------- it answered, but it does not like the credentials ---------- */

  if (auth.rejected && auth.withoutKey?.running) {
    checks.push(...authChecks());
    const models = auth.withoutKey.models;
    checks.push({
      step: 'model',
      ok: models.includes(model),
      detail: models.includes(model)
        ? `the model list includes "${model}"`
        : `the model list does not include "${model}" — pick one of: ${models.slice(0, 8).join(', ') || '(none listed)'}`,
    });
    return {
      ok: true,
      stage: 'running',
      baseUrl: root,
      model,
      // The stored key belongs to another provider. Clear it so Klaud sends no
      // Authorization header at all, rather than a Bearer token OmniRoute refuses.
      clearApiKey: true,
      alreadyRunning: true,
      started: false,
      models,
      message:
        `OmniRoute answers on ${root}, but it refused the API key supplied for setup (HTTP ` +
        `${auth.withKey.status}). If that key came from another provider — the one already in your ` +
        'settings — Klaud was sending it to your own local gateway. Local use needs no credentials, ' +
        'so it is no longer used for OmniRoute.',
      hint:
        `Save nothing in the API key field for OmniRoute (it is keyless locally), or, if you created one ` +
        'in its dashboard under Endpoints, paste that key instead.',
      checks,
    };
  }

  /* ---------- it objects to both ---------- */

  if (auth.rejected) {
    checks.push(...authChecks());
    const second = auth.withoutKey;
    return {
      ok: false,
      stage: 'auth',
      baseUrl: root,
      model,
      // Neither arrangement worked, so there is nothing to clear and nothing to
      // keep: guessing which of the two is wrong would be a lie.
      clearApiKey: false,
      alreadyRunning: false,
      started: false,
      checks,
      message:
        `OmniRoute answered on ${root} but rejected both requests. With your saved key: HTTP ` +
        `${auth.withKey.status}. Without any key: ` +
        `${second?.status ? `HTTP ${second.status}` : 'no usable answer'}` +
        `${second?.error ? ` (${second.error})` : ''}. Neither is a connection problem, so something is ` +
        'refusing the credentials themselves.',
      hint:
        'If you created an API key in OmniRoute\'s dashboard (Endpoints), paste that key in Settings — ' +
        'otherwise check the request in its dashboard or log to see why it is refusing, and note that ' +
        'Klaud has not been changed either way.',
    };
  }

  /* ---------- not running: recover ---------- */

  checks.push(...authChecks());

  const version = reportedNodeVersion(nodeVersion);
  const nodeOk = satisfiesNodeRange(nodeVersion);
  checks.push({
    step: 'node',
    ok: nodeOk,
    detail: nodeOk
      ? `Node ${version} satisfies "${NODE_REQUIREMENT}"`
      : `Node ${version} does not satisfy "${NODE_REQUIREMENT}" — OmniRoute cannot run on it`,
  });

  if (!nodeOk) {
    return {
      ok: false,
      stage: 'node',
      baseUrl: root,
      model,
      clearApiKey: false,
      started: false,
      alreadyRunning: false,
      checks,
      message:
        `OmniRoute cannot run on Node ${version}: it declares engines "${NODE_REQUIREMENT}" ` +
        `(${NODE_REQUIREMENT_TEXT}). Klaud still supports Node 18, so a Node 18 host cannot run ` +
        'OmniRoute at all.',
      hint:
        `Run Klaud on ${NODE_REQUIREMENT_TEXT}, or run OmniRoute in Docker (diegosouzapw/omniroute) ` +
        `on port ${DEFAULT_PORT} and let Klaud use it from there.`,
    };
  }

  let binary = resolveBinary({ command: 'omniroute', pathEnv, platform });
  checks.push({
    step: 'installed',
    ok: Boolean(binary),
    detail: binary ? `found at ${binary}` : 'starting state: there is no `omniroute` command on PATH',
  });

  if (!binary) {
    if (allowInstall !== true) {
      return {
        ok: false,
        stage: 'needs-consent',
        baseUrl: root,
        model,
        clearApiKey: false,
        started: false,
        alreadyRunning: false,
        command: INSTALL_COMMAND,
        checks,
        message:
          'OmniRoute is not installed, and installing it is a global npm install — slow, network-heavy ' +
          `and permanent — so Klaud will not run it unasked.`,
        hint:
          `Run \`${INSTALL_COMMAND}\` yourself (it needs ${NODE_REQUIREMENT_TEXT}), then run setup ` +
          'again — or approve the install and Klaud will do it for you.',
      };
    }

    const installed = await install({ allowInstall: true, nodeVersion, spawn: spawnFn, pathEnv, platform });
    checks.push({ step: 'install', ok: installed.ok, detail: installed.message });
    if (!installed.ok) {
      return {
        ok: false,
        stage: 'install-failed',
        baseUrl: root,
        model,
        clearApiKey: false,
        started: false,
        alreadyRunning: false,
        command: INSTALL_COMMAND,
        exitCode: installed.exitCode,
        checks,
        message: installed.message,
        hint: installed.hint,
      };
    }
    binary = resolveBinary({ command: 'omniroute', pathEnv, platform });
  }

  const start = await ensureRunning({
    allowStart,
    baseUrl: root,
    nodeVersion,
    timeoutMs,
    startTimeoutMs,
    pollMs,
    fetch: fetchImpl,
    spawn: spawnFn,
    pathEnv,
    platform,
  });

  checks.push({ step: 'start', ok: start.ok, detail: start.message });

  if (!start.ok) {
    // Setup reports the start failure in its own vocabulary: consent is a
    // different answer from "it tried and failed", and the caller shows them
    // differently.
    const stage =
      start.stage === 'needs-start-consent'
        ? 'needs-start-consent'
        : start.stage === 'blocked'
          ? 'blocked'
          : 'start-failed';
    return {
      ok: false,
      stage,
      baseUrl: root,
      model,
      clearApiKey: false,
      started: start.started,
      alreadyRunning: false,
      command: start.stage === 'needs-start-consent' ? 'omniroute' : undefined,
      checks,
      message: start.message,
      hint: start.hint,
    };
  }

  /* ---------- started: the key question again, against the fresh instance ---------- */

  const afterStart = auth.key
    ? await probe({ baseUrl: root, timeoutMs, apiKey: auth.key, fetch: fetchImpl })
    : null;
  const keyAccepted = !auth.key || Boolean(afterStart?.running);
  if (auth.key) {
    checks.push({
      step: 'stored key',
      ok: keyAccepted,
      detail: keyAccepted
        ? 'the saved key was accepted, so it is left in place'
        : afterStart?.status
          ? `the key was refused with HTTP ${afterStart.status}. If you pasted an OmniRoute key, check it in its dashboard under Endpoints; if settings still holds another provider's key, replace it.`
          : `the key was not accepted: ${afterStart?.error || 'no answer'}`,
    });
  }

  const models = start.probe?.models || [];
  const autoPresent = models.includes(model);
  checks.push({
    step: 'model',
    ok: autoPresent,
    detail: autoPresent
      ? `the model list includes "${model}"`
      : `the model list does not include "${model}" — pick one of: ${models.slice(0, 8).join(', ') || '(none listed)'}`,
  });

  const keyClause = auth.key
    ? keyAccepted
      ? ' Your saved key was accepted, so it is left in place.'
      : ` Your saved key was refused (HTTP ${afterStart?.status ?? 'no status'}) and the instance ` +
        'answers without it, so it is no longer used for OmniRoute.'
    : '';

  return {
    ok: true,
    stage: 'started',
    baseUrl: root,
    model,
    clearApiKey: Boolean(auth.key) && !keyAccepted,
    alreadyRunning: false,
    started: true,
    models,
    checks,
    message:
      `${start.message}${keyClause}` +
      (autoPresent ? '' : ` Its list does not include "${model}", so choose a model from it.`),
    hint: start.hint,
  };
}

module.exports = {
  probe,
  ensureRunning,
  install,
  setupOmniRoute,
  // Exported so the catalogue and the tests share one source of truth instead of
  // restating OmniRoute's engine range in two places that can drift apart.
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  NODE_REQUIREMENT,
  NODE_REQUIREMENT_TEXT,
  INSTALL_COMMAND,
  satisfiesNodeRange,
  resolveBinary,
};
