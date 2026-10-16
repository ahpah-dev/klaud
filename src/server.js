'use strict';

/**
 * Klaud HTTP server — static UI + JSON API + SSE agent stream.
 * Node built-ins only. Binds to loopback and requires a session token.
 */

const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { PUBLIC_DIR, LIMITS, defaultWorkspace } = require('./config');
const store = require('./store');
const { runAgentTurn } = require('./agent');
const { listModels, LLMError } = require('./llm');
const { TOOLS, toolCatalog, detectShell, runShell, executeTool } = require('./lib/tools');
const { resolveInside, statOrNull } = require('./lib/fsutil');
const { getFreeCatalog, setupCloudflare } = require('./providers');

/** turnId -> { resolve(callId, approved) } — bridges the two HTTP requests. */
const approvalBridge = new Map();

const PORT = Number(process.env.PORT || process.env.KLAUD_PORT || 4317);
const HOST = process.env.KLAUD_HOST || '127.0.0.1';
const OPEN_BROWSER = process.argv.includes('--open') || process.env.KLAUD_OPEN === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.maxRequestBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * A rejected token usually means the browser is holding a stale one from an
 * earlier run, and the only way out is the URL on the console. Say so, and
 * print that URL right here so it is always in front of the user.
 */
function makeUnauthorizedReporter(appUrl, token) {
  let lastPrinted = 0;
  return (pathname) => {
    const now = Date.now();
    if (now - lastPrinted < 4000) return;
    lastPrinted = now;
    console.log('');
    console.log(`  \x1b[33m! Unauthorized request\x1b[0m  ${pathname}`);
    console.log('    The browser is using an old session token. Open this exact URL:');
    console.log(`    \x1b[36m${appUrl}\x1b[0m`);
    console.log(`    \x1b[2m(token ${token.slice(0, 8)}…)\x1b[0m`);
    console.log('');
  };
}

/* ------------------------------------------------------------------ *
 * SSE writer
 * ------------------------------------------------------------------ */

function createSseStream(res) {
  let closed = false;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': klaud stream open\n\n');

  let counter = 0;
  const keepAlive = setInterval(() => {
    if (!closed) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* ignore */
      }
    }
  }, 15_000);

  return {
    send(event) {
      if (closed) return;
      counter++;
      try {
        res.write(`id: ${counter}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      try {
        res.write('event: end\ndata: {}\n\n');
        res.end();
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return closed;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'forbidden');

  let st = await statOrNull(target);
  if (st && st.isDirectory()) {
    st = await statOrNull(path.join(target, 'index.html'));
    if (st) return sendFile(res, path.join(target, 'index.html'), st, req);
  }
  if (!st) {
    // SPA fallback for unknown paths without an extension.
    if (!path.extname(rel)) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      const indexStat = await statOrNull(index);
      if (indexStat) return sendFile(res, index, indexStat, req);
    }
    return sendError(res, 404, 'not found');
  }
  return sendFile(res, target, st, req);
}

function sendFile(res, file, st, req) {
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size}-${Number(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    etag,
    'cache-control': ext === '.html' ? 'no-cache' : 'no-cache',
  });
  fsSync.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

async function main() {
  const token = await store.loadOrCreateSessionToken();
  const startedAt = Date.now();
  const activeTurns = new Map();
  const appUrl = `http://${HOST}:${PORT}/?token=${token}`;
  const reportUnauthorized = makeUnauthorizedReporter(appUrl, token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    // CORS: only ever for our own origin-less local tooling, never with credentials.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-headers': 'content-type, x-klaud-token',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-headers', 'content-type, x-klaud-token');
    }

    if (pathname === '/api/health') {
      // Unauthenticated on purpose: used by the launcher to wait for readiness.
      return sendJson(res, 200, { ok: true, app: 'klaud', uptimeMs: Date.now() - startedAt });
    }

    // ---- re-authorizing the browser ----
    // Deliberately available without a token. It only ever acts on the machine
    // it is running on, and it hands the browser nothing the user could not do
    // by hand: open this very URL. Its job is to remove the "find the terminal
    // and copy a URL" step that otherwise locks people out.
    if (pathname === '/api/authorize' && req.method === 'POST') {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const remote = forwarded || req.socket.remoteAddress || '';
      const isLoopback =
        remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
      if (!isLoopback) {
        return sendError(res, 403, 'Re-authorizing is only allowed from this machine.'), true;
      }
      const opened = openBrowser(appUrl);
      console.log(`  \x1b[36mre-authorized\x1b[0m the browser (opened ${appUrl})`);
      return sendJson(res, 200, {
        ok: true,
        opened,
        url: appUrl,
        message: opened
          ? 'Opened a fresh tab with a valid session. If you do not see it, switch to your browser window.'
          : `Open this URL to re-authorize: ${appUrl}`,
      });
    }

    // ---- everything else under /api requires the session token ----
    if (pathname.startsWith('/api/')) {
      const supplied = req.headers['x-klaud-token'] || url.searchParams.get('token') || '';
      if (supplied !== token) {
        reportUnauthorized(pathname);
        return sendError(res, 401, 'Unauthorized. Open Klaud using the URL printed in the terminal (it carries a session token).');
      }

      try {
        const handled = await handleApi(req, res, url, pathname, { token, activeTurns });
        if (handled !== false) return;
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err?.message || String(err));
        else res.end();
        return;
      }
    }

    return serveStatic(req, res, pathname);
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(PORT, HOST, async () => {
    const settings = await store.loadSettings();
    const shell = detectShell();

    console.log('');
    console.log('  \x1b[38;5;209m◆ Klaud\x1b[0m  local coding agent');
    console.log('  ────────────────────────────────────────────────');
    console.log(`  url        http://${HOST}:${PORT}`);
    console.log(`  token      ${token.slice(0, 8)}…  (required for /api/*)`);
    console.log(`  workspace  ${settings.workspace}`);
    console.log(`  data       ${store.dirs().base}`);
    console.log(`  shell      ${shell.label}   node ${process.version}`);
    console.log(`  model      ${settings.model || '(not set)'}  ${settings.apiKey ? '' : '\x1b[33m← add an API key in Settings\x1b[0m'}`);
    console.log('');
    console.log(`  Open:      \x1b[36m${appUrl}\x1b[0m`);
    console.log('');

    if (OPEN_BROWSER) openBrowser(appUrl);
  });

  const shutdown = () => {
    for (const controller of activeTurns.values()) {
      try {
        controller.abort();
      } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * API routes
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url, pathname, { token, activeTurns }) {
  const method = req.method;

  /* ---------------------------- health/info --------------------------- */
  if (pathname === '/api/info' && method === 'GET') {
    const settings = await store.loadSettings();
    const shell = detectShell();
    sendJson(res, 200, {
      app: 'klaud',
      version: require('../package.json').version,
      node: process.version,
      platform: process.platform,
      shell: shell.label,
      homedir: os.homedir(),
      workspace: settings.workspace,
      dataDir: store.dirs().base,
      tools: toolCatalog(),
      engine: { streaming: true, toolCalls: true },
    });
    return true;
  }

  /* ------------------------------ settings ---------------------------- */
  if (pathname === '/api/settings' && method === 'GET') {
    sendJson(res, 200, store.publicSettings(await store.loadSettings()));
    return true;
  }

  if (pathname === '/api/settings' && (method === 'PATCH' || method === 'POST')) {
    const body = await readBody(req);
    if (typeof body.workspace === 'string' && body.workspace.trim()) {
      const resolved = path.resolve(body.workspace.trim());
      const st = await statOrNull(resolved);
      if (!st) return sendError(res, 400, `Workspace "${resolved}" does not exist.`), true;
      if (!st.isDirectory()) return sendError(res, 400, `Workspace "${resolved}" is not a directory.`), true;
      body.workspace = resolved;
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim() === '') {
      // Empty string means "clear the key"; undefined means "leave it alone".
      body.apiKey = '';
    }
    const next = await store.saveSettings(body);
    sendJson(res, 200, store.publicSettings(next));
    return true;
  }

  /* ------------------------------- models ----------------------------- */
  // One-field setup for providers that need more than a key and a URL.
  // Cloudflare is the case that matters: it needs an account ID in the URL, and
  // the token already knows which account it belongs to.
  if (pathname === '/api/providers/setup' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();
    const provider = String(body.provider || '');
    // Distinguish "no key supplied" from "an explicitly empty key": a bare `||`
    // falls through to the saved key, which then validates the user's unrelated
    // credential and reports a confusing error about it.
    const supplied = typeof body.apiKey === 'string' ? body.apiKey.trim() : null;
    const apiKey = supplied === null ? settings.apiKey : supplied;

    if (provider !== 'cloudflare') {
      return sendError(res, 400, `No automatic setup for "${provider || 'that provider'}". Paste its key in Settings instead.`), true;
    }

    let result;
    try {
      result = await setupCloudflare({ apiKey, model: body.model });
    } catch (err) {
      return sendError(res, 500, err?.message || String(err)), true;
    }

    if (result.ok) {
      // Only persist once a real completion has succeeded, so the user is never
      // left with settings that look configured but cannot answer.
      const saved = await store.saveSettings({
        baseUrl: result.baseUrl,
        apiKey,
        model: result.model,
      });
      result.settings = store.publicSettings(saved);
      console.log(`  \x1b[36mconfigured\x1b[0m Cloudflare Workers AI (account ${result.accountIdMasked}, model ${result.model})`);
    }
    result.provider = 'cloudflare';
    return sendJson(res, 200, result), true;
  }

  if (pathname === '/api/providers/free' && method === 'GET') {    const force = url.searchParams.get('refresh') === '1';
    try {
      const catalog = await getFreeCatalog();
      if (force) await require('./providers').listOpenRouterFreeModels({ force: true });
      sendJson(res, 200, catalog);
    } catch (err) {
      sendError(res, 500, err?.message || String(err));
    }
    return true;
  }

  if (pathname === '/api/models' && (method === 'GET' || method === 'POST')) {
    const body = method === 'POST' ? await readBody(req) : {};
    const settings = await store.loadSettings();
    const baseUrl = body.baseUrl || url.searchParams.get('baseUrl') || settings.baseUrl;
    const apiKey = body.apiKey || url.searchParams.get('apiKey') || settings.apiKey;
    try {
      const models = await listModels({ baseUrl, apiKey });
      sendJson(res, 200, { models, baseUrl });
    } catch (err) {
      sendError(res, 400, err instanceof LLMError ? err.message : String(err?.message || err));
    }
    return true;
  }

  if (pathname === '/api/models/test' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();
    const baseUrl = body.baseUrl || settings.baseUrl;
    const apiKey = body.apiKey || settings.apiKey;
    const model = body.model || settings.model;
    try {
      const models = await listModels({ baseUrl, apiKey });
      const known = models.some((m) => m.id === model);
      sendJson(res, 200, {
        ok: true,
        count: models.length,
        modelKnown: known,
        message: known
          ? `Connected. ${models.length} models available; "${model}" is listed.`
          : `Connected. ${models.length} models available. "${model}" was not in the list — it may still work.`,
      });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        message: err instanceof LLMError ? err.message : String(err?.message || err),
      });
    }
    return true;
  }

  /* -------------------------------- chats ----------------------------- */
  if (pathname === '/api/chats' && method === 'GET') {
    sendJson(res, 200, { chats: await store.listChats() });
    return true;
  }

  if (pathname === '/api/chats' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();
    const chat = await store.createChat({
      title: body.title || 'New chat',
      model: settings.model,
      workspace: settings.workspace,
      messages: [],
    });
    sendJson(res, 201, { chat });
    return true;
  }

  if (pathname === '/api/chats' && method === 'DELETE') {
    const removed = await store.deleteAllChats();
    sendJson(res, 200, { removed });
    return true;
  }

  const chatMatch = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{6,64})$/);
  if (chatMatch) {
    const id = chatMatch[1];
    if (method === 'GET') {
      const chat = await store.readChat(id);
      if (!chat) return sendError(res, 404, 'chat not found'), true;
      sendJson(res, 200, { chat });
      return true;
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      const existing = (await store.readChat(id)) || { id, messages: [] };
      const merged = {
        ...existing,
        ...body,
        id,
        messages: Array.isArray(body.messages) ? body.messages : existing.messages,
      };
      if (!body.title) merged.title = store.deriveTitle(merged.messages, existing.title || 'New chat');
      const saved = await store.saveChat(merged);
      sendJson(res, 200, { chat: saved });
      return true;
    }
    if (method === 'DELETE') {
      await store.deleteChat(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  /* ------------------------------- cancel ----------------------------- */
  const cancelMatch = pathname.match(/^\/api\/chat\/([A-Za-z0-9_-]{6,80})\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const controller = activeTurns.get(cancelMatch[1]);
    if (controller) controller.abort();
    sendJson(res, 200, { ok: true, cancelled: Boolean(controller) });
    return true;
  }

  /* -------------------------------- tool ------------------------------ */
  if (pathname === '/api/tool' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();
    const tool = TOOLS.find((t) => t.name === body.name);
    if (!tool) return sendError(res, 404, `unknown tool "${body.name}"`), true;
    const outcome = await executeTool(body.name, body.args || {}, {
      cwd: settings.workspace,
      approvalMode: body.approvalMode || settings.approvalMode,
    });
    sendJson(res, 200, outcome);
    return true;
  }

  /* ------------------------------- shell ------------------------------ */
  if (pathname === '/api/shell' && method === 'GET') {
    sendJson(res, 200, detectShell());
    return true;
  }

  if (pathname === '/api/sh' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();
    if (settings.approvalMode === 'readonly') return sendError(res, 403, 'command execution is disabled'), true;
    const result = await runShell(String(body.command || ''), settings.workspace, 60_000);
    sendJson(res, 200, {
      exit: result.code,
      stdout: result.stdout.slice(0, LIMITS.maxToolOutputToClient),
      stderr: result.stderr.slice(0, LIMITS.maxToolOutputToClient),
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    return true;
  }

  /* --------------------------------- fs ------------------------------- */
  // Create a directory. Without this the folder picker can only walk to
  // directories that already exist, which makes "start a new project" the one
  // thing you cannot do from the UI.
  if (pathname === '/api/fs/mkdir' && method === 'POST') {
    const body = await readBody(req);
    const parent = String(body.parent || '').trim();
    const name = String(body.name || '').trim();

    if (!parent) return sendError(res, 400, 'A parent folder is required.'), true;
    if (!name) return sendError(res, 400, 'Type a folder name.'), true;
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
      return sendError(res, 400, 'That name contains characters a folder cannot use: < > : " / \\ | ? *'), true;
    }
    if (name.length > 120) return sendError(res, 400, 'That folder name is too long.'), true;

    const target = path.resolve(parent, name);
    const parentResolved = path.resolve(parent);
    const driveRoot = path.parse(parentResolved).root;
    if (!parentResolved.startsWith(driveRoot)) {
      return sendError(res, 400, 'That location is not on an accessible drive.'), true;
    }

    const parentStat = await statOrNull(parentResolved);
    if (!parentStat || !parentStat.isDirectory()) {
      return sendError(res, 400, `The parent folder does not exist: ${parentResolved}`), true;
    }

    const existing = await statOrNull(target);
    if (existing) {
      if (existing.isDirectory()) {
        // Already there is a success for this purpose, not an error.
        return sendJson(res, 200, { ok: true, created: false, path: target }), true;
      }
      return sendError(res, 400, `"${name}" already exists as a file.`), true;
    }

    try {
      await fs.mkdir(target, { recursive: false });
    } catch (err) {
      return sendError(res, 400, `Could not create the folder: ${err.message}`), true;
    }
    return sendJson(res, 201, { ok: true, created: true, path: target }), true;
  }

  if (pathname === '/api/fs' && method === 'GET') {
    const settings = await store.loadSettings();
    const settingsRoot = path.parse(settings.workspace).root;
    const requested = url.searchParams.get('path') || settings.workspace;
    const resolved = path.resolve(requested);
    if (!resolved.startsWith(settingsRoot)) return sendError(res, 403, 'path outside the drive root'), true;

    const st = await statOrNull(resolved);
    if (!st) return sendError(res, 404, 'path not found'), true;

    if (st.isFile()) {
      const rel = resolveInside(settings.workspace, resolved).rel;
      const text = await fs.readFile(resolved, 'utf8').catch(() => null);
      if (text === null) return sendError(res, 415, 'file is not readable as UTF-8 text'), true;
      sendJson(res, 200, { type: 'file', path: resolved, rel, content: text.slice(0, 400_000), size: st.size });
      return true;
    }

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const listing = [];
    for (const entry of entries) {
      let size = 0;
      let mtime = 0;
      try {
        const s = await fs.stat(path.join(resolved, entry.name));
        size = s.size;
        mtime = s.mtimeMs;
      } catch { /* ignore */ }
      listing.push({
        name: entry.name,
        dir: entry.isDirectory(),
        size,
        mtime,
        hidden: entry.name.startsWith('.'),
      });
    }
    listing.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    sendJson(res, 200, { type: 'dir', path: resolved, entries: listing.slice(0, 2_000) });
    return true;
  }

  /* --------------------------------- chat ----------------------------- */
  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    const settings = await store.loadSettings();

    if (!settings.apiKey && !body.allowNoKey) {
      return sendError(res, 400, 'No API key configured. Open Settings and add your OpenAI-compatible key.'), true;
    }

    const turnId = body.turnId || store.newId();
    const controller = new AbortController();
    activeTurns.set(turnId, controller);

    const sse = createSseStream(res);
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      activeTurns.delete(turnId);
      sse.close();
    };

    req.on('close', () => {
      if (!finished) {
        controller.abort();
        activeTurns.delete(turnId);
        finished = true;
      }
    });

    sse.send({ type: 'turn_start', turnId, model: settings.model, workspace: settings.workspace });

    // The browser answers approval requests over a second SSE channel-free endpoint.
    const pendingApprovals = new Map();
    approvalBridge.set(turnId, {
      resolve(id, approved) {
        const entry = pendingApprovals.get(id);
        if (entry) {
          pendingApprovals.delete(id);
          entry(approved);
        }
      },
    });

    try {
      const result = await runAgentTurn({
        settings: { ...settings, ...(body.settings || {}) },
        messages: body.messages || [],
        cwd: settings.workspace,
        approvalMode: body.approvalMode || settings.approvalMode,
        maxSteps: body.maxSteps || settings.maxSteps,
        signal: controller.signal,
        onEvent: (event) => sse.send(event),
        requestApproval: ({ id, name, args }) =>
          new Promise((resolve) => {
            pendingApprovals.set(id, resolve);
            sse.send({ type: 'approval_request', id, name, args });
            // Never hang forever waiting on a UI that went away.
            setTimeout(() => {
              if (pendingApprovals.has(id)) {
                pendingApprovals.delete(id);
                resolve(false);
              }
            }, 300_000);
          }),
      });

      if (body.chatId) {
        const existing = (await store.readChat(body.chatId)) || null;
        const newMessages = result.messages || [];
        if (existing) {
          const chat = await store.saveChat({
            ...existing,
            messages: [...(existing.messages || []), ...newMessages],
            model: settings.model,
            workspace: settings.workspace,
          });
          sse.send({ type: 'saved', chatId: chat.id, title: chat.title });
        }
      }

      if (!finished) {
        // The client needs the assistant/tool messages the loop produced: they
        // are the only record of the turn it can persist and replay next time.
        // Dropping them makes every turn start from scratch.
        const { messages, ...summary } = result;
        sse.send({ type: 'turn_end', ...summary, messages: messages || [] });
      }
    } catch (err) {
      sse.send({ type: 'error', message: err?.message || String(err) });
    } finally {
      approvalBridge.delete(turnId);
      finish();
    }
    return true;
  }

  /* ------------------------------ approval ---------------------------- */
  const approvalMatch = pathname.match(/^\/api\/chat\/([A-Za-z0-9_-]{6,80})\/approval$/);
  if (approvalMatch && method === 'POST') {
    const body = await readBody(req);
    const bridge = approvalBridge.get(approvalMatch[1]);
    if (bridge) bridge.resolve(String(body.id || ''), Boolean(body.approved));
    sendJson(res, 200, { ok: Boolean(bridge) });
    return true;
  }

  return false;
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  Klaud failed to start:', err?.message || err);
    if (/EADDRINUSE/.test(String(err?.code))) {
      console.error(`  Port ${PORT} is already in use. Start with PORT=4318 npm start to pick another.\n`);
    }
    process.exit(1);
  });
}
