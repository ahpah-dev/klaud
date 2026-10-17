'use strict';

/**
 * Chrome DevTools Protocol over a pipe.
 *
 * Driving a real browser needs a transport, and the two obvious options both
 * cost something Klaud will not pay:
 *
 *   - Puppeteer/Playwright are npm dependencies. Klaud has none, by design.
 *   - `--remote-debugging-port` speaks WebSocket. Node's global `WebSocket` only
 *     exists from Node 21; Klaud declares Node >= 18, so that transport would be
 *     a runtime landmine on every supported version below it.
 *
 * `--remote-debugging-pipe` avoids both. Chrome reads commands from **file
 * descriptor 3** and writes replies to **file descriptor 4**, each message a
 * single JSON object terminated by a NUL byte. `child_process.spawn` can hand
 * those descriptors over directly, so the whole transport is `JSON.parse`,
 * `JSON.stringify`, and a scan for NUL. No dependency, and no Node 21 API.
 *
 * Verified against Chrome 155 before this file was written, not assumed.
 *
 * Why a pipe beats a port even when WebSocket *is* available: nothing listens on
 * a TCP port, so no other process on the machine (or any page in any browser)
 * can reach the debugging endpoint while Klaud is driving it.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { killTree } = require('../tools');

const DEFAULT_TIMEOUT_MS = 30_000;
/** Navigation and screenshot are legitimately slower than a DOM query. */
const SLOW_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Finding a browser
 * ------------------------------------------------------------------ */

/**
 * Candidate executables, most-preferred first.
 *
 * Deliberately does **not** consult `$BROWSER` or the `PATH`: those are easy to
 * get wrong, and a stray wrapper script that does not understand
 * `--remote-debugging-pipe` fails in a confusing way. `KLAUD_BROWSER` is the
 * documented override, and it is trusted because the user set it.
 */
function browserCandidates() {
  const env = process.env.KLAUD_BROWSER;
  const explicit = env ? [env] : [];

  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean);
    const rels = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    const out = explicit.slice();
    for (const root of roots) for (const rel of rels) out.push(path.join(root, ...rel));
    return out;
  }

  if (process.platform === 'darwin') {
    return explicit.concat([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]);
  }

  return explicit.concat([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser',
  ]);
}

/** The first candidate that exists, or null. */
function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (!candidate) continue;
    try {
      const st = fs.statSync(candidate);
      // A directory would stat fine and fail at spawn with a confusing error.
      if (st.isFile()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

/**
 * One browser process, spoken to over its debug pipe.
 *
 * Owns exactly one thing: framing, request/reply correlation, events, and
 * teardown. It knows nothing about pages or DOM — `session.js` does that, so the
 * risky part (process lifecycle) stays small and testable on its own.
 */
class CdpConnection {
  constructor(child, { executablePath }) {
    this.executablePath = executablePath;
    this._child = child;
    this._in = child.stdio[3];
    this._out = child.stdio[4];
    this._pending = new Map();
    this._listeners = new Map();
    this._nextId = 1;
    this._buffer = Buffer.alloc(0);
    this._stderr = '';
    this._closed = false;
    this._closing = null;
    this._exited = false;

    this._out.on('data', (chunk) => this._onData(chunk));
    this._out.on('error', () => { /* handled via 'close' */ });
    this._child.stderr.on('data', (d) => {
      // Keep the tail only. Chrome is chatty at startup and this is diagnostics,
      // not a log.
      this._stderr = (this._stderr + d.toString('utf8')).slice(-8_000);
    });
    this._child.on('exit', (code, signal) => {
      this._exited = true;
      this._failAll(
        new Error(
          `The browser exited (${signal || code}) before replying.` +
            (this._stderr ? `\n\nBrowser stderr:\n${this._stderr.trim().slice(-1_200)}` : '')
        )
      );
    });
    this._out.on('close', () => this._failAll(new Error('The browser closed its debug pipe.')));
  }

  /** Launch a browser and connect to it. */
  static async launch({ headless = true, userDataDir = null, args = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const executablePath = findBrowser();
    if (!executablePath) {
      throw new Error(
        'No supported browser was found. Klaud drives Chrome, Edge, Chromium or Brave.\n' +
          'Looked in: ' +
          browserCandidates()
            .filter(Boolean)
            .slice(0, 6)
            .join(', ') +
          '\n\nInstall one, or set KLAUD_BROWSER to the full path of a Chromium-based browser.'
      );
    }

    const profile = userDataDir || path.join(os.tmpdir(), `klaud-browser-${process.pid}-${Date.now()}`);
    const flags = [
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      // Headless is the default because an agent navigating a window the user
      // did not ask for is worse than one that works invisibly. Pass
      // headless:false to watch it work.
      ...(headless ? ['--headless=new'] : []),
      // Cuts the startup noise and several classes of flakiness in containers.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // A single blank tab up front; the session attaches to it rather than
      // racing to create one.
      'about:blank',
      ...args,
    ];

    const child = spawn(executablePath, flags, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // A spawn failure arrives asynchronously, so it has to be caught here or the
    // first command just times out with no explanation.
    const spawned = await new Promise((resolve) => {
      const onError = (err) => resolve(err);
      child.once('error', onError);
      child.once('spawn', () => {
        child.off('error', onError);
        resolve(null);
      });
    });
    if (spawned) {
      throw new Error(`Could not start ${executablePath}: ${spawned.message}`);
    }

    const connection = new CdpConnection(child, { executablePath, userDataDir: profile });
    connection._ownsProfile = !userDataDir;
    connection._profileDir = profile;

    // Round-trip once so a browser that starts but does not answer the protocol
    // fails here, with a clear message, rather than on the first real command.
    try {
      const version = await connection.send('Browser.getVersion', {}, undefined, timeoutMs);
      connection.version = version;
    } catch (err) {
      await connection.close();
      throw new Error(
        `The browser started but did not answer the DevTools protocol: ${err.message}\n` +
          `Executable: ${executablePath}`
      );
    }

    return connection;
  }

  /* ---------------- framing ---------------- */

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    let nul;
    while ((nul = this._buffer.indexOf(0)) !== -1) {
      const raw = this._buffer.slice(0, nul).toString('utf8');
      this._buffer = this._buffer.slice(nul + 1);
      if (!raw.trim()) continue;
      this._dispatch(raw);
    }
  }

  _dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      // A truncated or interleaved message would poison every later reply, so it
      // is reported rather than skipped silently.
      this._emit('protocol-error', { raw: raw.slice(0, 500) });
      return;
    }

    if (message.id !== undefined && this._pending.has(message.id)) {
      const entry = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const err = new Error(message.error.message || 'CDP error');
        err.code = message.error.code;
        err.data = message.error.data;
        err.method = entry.method;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method) this._emit(message.method, message.params, message.sessionId);
  }

  _failAll(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  /* ---------------- events ---------------- */

  on(method, handler) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(handler);
    return () => this._listeners.get(method)?.delete(handler);
  }

  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, sessionId) => {
        off();
        clearTimeout(timer);
        resolve({ params, sessionId });
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
    });
  }

  _emit(method, params, sessionId) {
    const handlers = this._listeners.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params, sessionId);
      } catch {
        /* A listener must not be able to break the transport. */
      }
    }
  }

  /* ---------------- commands ---------------- */

  /**
   * Send one CDP command and resolve with its result.
   *
   * Never leaves a promise hanging: every path either resolves, rejects, or
   * times out.
   */
  send(method, params = {}, sessionId = undefined, timeoutMs = null) {
    if (this._closed || this._exited) {
      return Promise.reject(new Error('The browser is not running. Call browser_goto to start a new one.'));
    }
    const id = this._nextId++;
    const limit = timeoutMs || (/^(Page\.navigate|Page\.screenshot|Page\.captureScreenshot)$/.test(method) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`The browser did not answer ${method} within ${limit}ms.`));
      }, limit);
      this._pending.set(id, { resolve, reject, timer, method });

      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this._in.write(`${JSON.stringify(payload)}\0`);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`Could not send ${method} to the browser: ${err.message}`));
      }
    });
  }

  /* ---------------- teardown ---------------- */

  /** Close the browser and remove the throwaway profile. Safe to call twice. */
  close() {
    if (this._closing) return this._closing;
    this._closing = (async () => {
      this._closed = true;
      if (!this._exited) {
        // Ask nicely first so Chrome flushes its profile, then take the tree.
        try {
          this._in.end();
        } catch {
          /* already gone */
        }
        try {
          await this.send('Browser.close', {}, undefined, 2_000);
        } catch {
          /* expected: the close command kills the thing answering it */
        }
        const deadline = Date.now() + 1_500;
        while (!this._exited && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!this._exited) killTree(this._child.pid);
      }
      this._failAll(new Error('The browser was closed.'));

      if (this._ownsProfile && this._profileDir) {
        // Windows keeps a lock briefly after exit; retry rather than leaving
        // hundreds of megabytes of profile behind in the temp directory.
        for (let i = 0; i < 6; i++) {
          try {
            fs.rmSync(this._profileDir, { recursive: true, force: true });
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
      }
    })();
    return this._closing;
  }

  get stderrTail() {
    return this._stderr.trim().slice(-2_000);
  }
}

module.exports = {
  CdpConnection,
  findBrowser,
  browserCandidates,
  DEFAULT_TIMEOUT_MS,
  SLOW_TIMEOUT_MS,
};
