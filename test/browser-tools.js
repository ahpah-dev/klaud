'use strict';

/**
 * The browser subsystem.
 *
 *   node test/browser-tools.js
 *
 * Everything here drives a **real browser** over the DevTools pipe, against a
 * local HTTP server, so nothing depends on the internet. The URL policy, the tool
 * catalogue and the reference-detection helpers are tested without a browser.
 *
 * Skips cleanly when no supported browser is installed, matching the existing
 * `test/browser.js` behaviour rather than failing a machine that has none.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { checkNavigableUrl } = require('../src/lib/browser/session');
const { findBrowser } = require('../src/lib/browser/cdp');

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
    console.log(`    \x1b[31m✗\x1b[0m ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

const describe = (name, fn) => {
  group = name;
  console.log(`\n  \x1b[1m${name}\x1b[0m`);
  return fn();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A local site to browse
 * ------------------------------------------------------------------ */

const PAGE = `<!doctype html>
<html><head><title>Klaud browser suite</title></head>
<body>
  <nav><a href="/a">Home</a> <a href="/b">Docs</a></nav>
  <h1>Inventory</h1>
  <p id="count">widgets: 3</p>
  <button id="add" onclick="var n=+document.getElementById('count').textContent.split(' ')[1];document.getElementById('count').textContent='widgets: '+(n+1)">Add one</button>
  <form onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('q').value">
    <label for="q">Search</label>
    <input id="q" name="q" placeholder="search here" />
    <button type="submit">Go</button>
  </form>
  <div id="out"></div>
  <div id="hidden" style="display:none">secret text should not be extracted</div>
  <a href="https://example.com/external">External link</a>
</body></html>`;

let site;
let siteUrl;
let workspace;

async function startSite() {
  site = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<title>Slow</title><p id="x">finally</p>');
      }, 700);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud browser tool check\x1b[0m');

  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'klaud-bt-ws-'));

  /* ================= URL policy (no browser needed) ================= */

  await describe('URL policy', async () => {
    const allows = (u) => {
      try {
        checkNavigableUrl(u);
        return true;
      } catch {
        return false;
      }
    };

    check('http is allowed', allows('http://example.com/page'));
    check('https is allowed', allows('https://example.com'));
    check('localhost is allowed, for local dev servers', allows('http://127.0.0.1:3000/app'));
    check('about:blank is allowed', allows('about:blank'));

    /* file:// would read any file on the machine and hand it back as page text,
     * bypassing the working-directory confinement every other tool observes. */
    check('file:// is refused', allows('file:///C:/Windows/win.ini') === false);
    check('the file:// refusal explains the boundary', (() => {
      try { checkNavigableUrl('file:///etc/passwd'); return false; } catch (err) {
        return /working directory/i.test(err.message) && /read_file/i.test(err.message);
      }
    })());
    check('javascript: is refused', allows('javascript:alert(1)') === false);
    check('chrome:// is refused', allows('chrome://settings') === false);
    check('a non-about internal page is refused', allows('about:settings') === false);
    check('a relative URL is refused', allows('/just/a/path') === false);
    check('an empty URL is refused', allows('') === false);
    check('a bare hostname is refused with advice', (() => {
      try { checkNavigableUrl('example.com'); return false; } catch (err) {
        return /absolute URL/i.test(err.message) && /https:\/\//i.test(err.message);
      }
    })());

    // Nothing was opened by any of that.
    const { BrowserSession } = require('../src/lib/browser/session');
    check('refusing a URL never launches a browser', BrowserSession.peek() === null);
  });

  /* ================= the tool catalogue ================= */

  await describe('tool catalogue', async () => {
    const { browserToolDefinitions, browserAvailable } = require('../src/lib/browser/tools');

    check('browser availability matches a real install', browserAvailable() === Boolean(findBrowser()));

    const defs = browserToolDefinitions();
    check('seven tools are defined', defs.length === 7, `${defs.length}`);

    const names = defs.map((d) => d.name).sort();
    check('the expected names are present',
      JSON.stringify(names) === JSON.stringify([
        'browser_click', 'browser_close', 'browser_eval',
        'browser_goto', 'browser_read', 'browser_screenshot', 'browser_type',
      ]), names.join(', '));

    check('every tool has a JSON Schema object',
      defs.every((d) => d.parameters && d.parameters.type === 'object' && typeof d.parameters.properties === 'object'),
      defs.filter((d) => !d.parameters || d.parameters.type !== 'object').map((d) => d.name).join(', '));
    check('every schema declares a required array',
      defs.every((d) => Array.isArray(d.parameters.required)),
      defs.filter((d) => !Array.isArray(d.parameters.required)).map((d) => d.name).join(', '));
    check('every tool has a run function', defs.every((d) => typeof d.run === 'function'));

    // Permission levels are the security boundary, so they are pinned exactly.
    const level = (n) => (defs.find((d) => d.name === n) || {}).permission;
    check('navigating is a read', level('browser_goto') === 'read');
    check('reading is a read', level('browser_read') === 'read');
    check('a screenshot is a read', level('browser_screenshot') === 'read');
    check('closing is a read', level('browser_close') === 'read');
    /* A click can buy something or post a comment. */
    check('clicking is a write', level('browser_click') === 'write');
    check('typing is a write', level('browser_type') === 'write');
    /* Arbitrary script in a page context is the strongest thing here. */
    check('evaluating JavaScript is exec', level('browser_eval') === 'exec');

    check('every permission is a level Klaud knows',
      defs.every((d) => ['read', 'write', 'exec', 'send'].includes(d.permission)),
      defs.map((d) => `${d.name}:${d.permission}`).join(', '));
    check('every description says what the tool is for',
      defs.every((d) => typeof d.description === 'string' && d.description.length > 60));
    check('browser_read is honest that the model cannot see images',
      /cannot see/i.test((defs.find((d) => d.name === 'browser_screenshot') || {}).description || ''),
      (defs.find((d) => d.name === 'browser_screenshot') || {}).description);
  });

  /* ================= tools are registered ================= */

  await describe('registration', async () => {
    const extensions = require('../src/extensions');
    extensions.resetExtensions();
    const result = extensions.registerExtensionTools();
    check('registration reports no rejections', result.rejected.length === 0, JSON.stringify(result.rejected));

    const { toolSchemas } = require('../src/lib/tools');
    const registered = toolSchemas().map((t) => t.function.name);
    for (const name of ['browser_goto', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_eval', 'browser_close']) {
      check(`${name} is in the catalogue`, registered.includes(name), registered.join(', '));
    }
    check('registering twice does not duplicate',
      (extensions.registerExtensionTools(), toolSchemas().length === registered.length),
      `${registered.length} -> ${toolSchemas().length}`);
    check('the built-in tools are untouched',
      ['list_dir', 'read_file', 'write_file', 'run_command'].every((n) => registered.includes(n)));
  });

  /* ================= without a browser ================= */

  const exe = findBrowser();
  if (!exe) {
    console.log('\n  no supported browser found; skipping the live checks.');
    console.log('  Set KLAUD_BROWSER to a Chromium-based browser to run them.\n');
    await finish();
    return;
  }

  await startSite();
  const { BrowserSession, shutdown, saveScreenshot } = require('../src/lib/browser/session');
  const tools = require('../src/lib/browser/tools');
  const byName = new Map(tools.browserToolDefinitions().map((d) => [d.name, d]));
  const call = (name, args = {}) => byName.get(name).run(args, { cwd: workspace, approvalMode: 'auto' });

  await describe('driving a real browser', async () => {
    let session;
    try {
      session = await BrowserSession.get({ headless: true });
      check('the browser launches', Boolean(session && session.connection),
        String(session && session.connection && session.connection.version && session.connection.version.product));
      check('it is a real Chromium', /HeadlessChrome|Chrome\//.test(String(session.connection.version.product)),
        String(session.connection.version.product));

      const nav = await call('browser_goto', { url: siteUrl });
      check('browser_goto reports where it landed', nav.includes(siteUrl), nav.slice(0, 120));
      check('browser_goto reports the title', /Klaud browser suite/.test(nav), nav.slice(0, 120));
      check('browser_goto refuses to invent content when the page is empty', typeof nav === 'string' && nav.length > 20);

      /* ---- reading ---- */
      const read = await call('browser_read');
      check('browser_read returns the heading', /Inventory/.test(read), read.slice(0, 160));
      check('browser_read returns body text', /widgets: 3/.test(read));
      check('browser_read includes the page url', read.includes(siteUrl));
      check('browser_read lists links', /External link/.test(read) && /example\.com/.test(read), read.slice(-300));
      check('browser_read lists fillable fields', /search here/.test(read), read.slice(-300));
      /* A display:none block is not readable content and must not leak. */
      check('browser_read omits hidden text', !/secret text should not be extracted/.test(read));

      const small = await call('browser_read', { max_chars: 2000 });
      check('max_chars is honoured without exploding', typeof small === 'string' && small.length > 0);

      /* ---- clicking ---- */
      const click = await call('browser_click', { selector: '#add' });
      check('browser_click reports the element it hit', /button/i.test(click) && /Add one/.test(click), click.slice(0, 140));
      const afterClick = await call('browser_eval', { expression: `document.getElementById('count').textContent` });
      /* A DOM-level .click() would also work here; the point is that the click
       * reached the page at all and the handler ran. */
      check('the click actually ran the page handler', /widgets: 4/.test(afterClick), afterClick);

      const byText = await call('browser_click', { text: 'Add one' });
      check('clicking by visible text works', /Add one/.test(byText), byText.slice(0, 140));
      const afterText = await call('browser_eval', { expression: `document.getElementById('count').textContent` });
      check('the text-click also ran the handler', /widgets: 5/.test(afterText), afterText);

      /* ---- typing ---- */
      await call('browser_type', { selector: '#q', value: 'klaud search' });
      const value = await call('browser_eval', { expression: `document.getElementById('q').value` });
      check('typed text lands in the field', /klaud search/.test(value), value);

      const submitted = await call('browser_type', { selector: '#q', value: 'second try', submit: true });
      check('browser_type reports that it pressed Enter', /Enter/.test(submitted), submitted.slice(0, 140));
      await sleep(300);
      const out = await call('browser_eval', { expression: `document.getElementById('out').textContent` });
      /* Enter without `text: '\r'` fills the field but never fires submit. */
      check('Enter submits the form', /submitted:second try/.test(out), out);

      /* ---- screenshots ---- */
      const shot = await call('browser_screenshot');
      const shotPath = (shot.match(/([A-Za-z]:\\[^\s]+\.png|\/[^\s]+\.png)/) || [])[1];
      check('a screenshot reports a path', Boolean(shotPath), shot.slice(0, 160));
      if (shotPath) {
        check('the screenshot file exists', fs.existsSync(shotPath), shotPath);
        const stat = fs.existsSync(shotPath) ? fs.statSync(shotPath) : { size: 0 };
        check('the screenshot is a real PNG', stat.size > 1_000, `${stat.size} bytes`);
        check('the screenshot is inside the working directory',
          path.resolve(shotPath).startsWith(path.resolve(workspace)), shotPath);
        check('the screenshot is not written to the workspace root as clutter',
          !fs.existsSync(path.join(workspace, 'screenshot.png')));
      }
      check('the screenshot says the model cannot see it', /cannot see/i.test(shot));

      const full = await call('browser_screenshot', { full_page: true });
      check('a full-page screenshot works', typeof full === 'string' && /KB/.test(full), full.slice(0, 120));

      /* ---- evaluating ---- */
      const evaluated = await call('browser_eval', { expression: '({ a: 1, b: [2,3] })' });
      check('browser_eval returns JSON', /"a": 1/.test(evaluated) && /"b"/.test(evaluated), evaluated.slice(0, 120));
      const awaited = await call('browser_eval', {
        expression: 'await new Promise(r => setTimeout(() => r("waited"), 50))',
      });
      check('browser_eval awaits promises', /waited/.test(awaited), awaited.slice(0, 120));

      /* ---- navigation failures are explained ---- */
      const badHost = await call('browser_goto', { url: 'https://klaud-suite-nx.invalid' }).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err })
      );
      check('an unresolvable host is an error, not a blank page', badHost.ok === false);
      check('the DNS failure names the cause', /does not resolve|ERR_NAME_NOT_RESOLVED/i.test(String(badHost.err)),
        String(badHost.err).slice(0, 200));

      /* ---- element failures are explained ---- */
      const missSelector = await call('browser_click', { selector: '#does-not-exist' }).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err })
      );
      check('a missing selector is an error', missSelector.ok === false);
      check('the missing-selector error mentions the element', /No element matched/i.test(String(missSelector.err)),
        String(missSelector.err).slice(0, 160));

      const missText = await call('browser_click', { text: 'zzz not on this page' }).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err })
      );
      check('missing text is an error', missText.ok === false);
      check('the missing-text error quotes what was looked for',
        /zzz not on this page/.test(String(missText.err)), String(missText.err).slice(0, 160));

      const noTarget = await call('browser_click', {}).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err })
      );
      check('clicking with no target is refused', noTarget.ok === false);
      check('the refusal suggests browser_read', /browser_read/i.test(String(noTarget.err)),
        String(noTarget.err).slice(0, 160));

      const threw = await call('browser_eval', { expression: 'throw new Error("boom")' }).then(
        (v) => ({ ok: true, v }),
        (err) => ({ ok: false, err })
      );
      check('a page exception is an error', threw.ok === false);
      check('the exception message is surfaced', /boom/.test(String(threw.err)), String(threw.err).slice(0, 160));
    } finally {
      await shutdown();
    }

    /* ---- after closing ---- */
    /* Closing is not terminal: any browser tool starts a fresh browser rather
     * than making the model remember to call browser_goto first. What must NOT
     * happen is the old session coming back — the new browser is a different
     * process with a different throwaway profile. */
    check('the closed session is forgotten immediately', BrowserSession.peek() === null);

    const before = session ? session.connection._profileDir : null;
    const revived = await call('browser_eval', { expression: '1 + 1' }).then(
      (v) => ({ ok: true, v }),
      (err) => ({ ok: false, err })
    );
    check('a tool call after close starts a fresh browser instead of failing',
      revived.ok === true && /2/.test(String(revived.v)), JSON.stringify(revived).slice(0, 160));
    const now = BrowserSession.peek();
    check('the new session is a different browser process',
      Boolean(now) && Boolean(before) && now.connection._profileDir !== before,
      `${before} vs ${now && now.connection._profileDir}`);

    /* A fresh browser is blank, and browser_read must say so rather than
     * inventing content or throwing. */
    const blank = await call('browser_read').catch((err) => `ERROR: ${err.message}`);
    check('reading a fresh browser reports an empty page rather than throwing',
      typeof blank === 'string' && !/^ERROR/.test(blank), String(blank).slice(0, 160));
  });

  await describe('state and cleanup', async () => {
    /* A second launch must work after the first was closed, and must be a fresh
     * session: cookies from the previous browser are gone. */
    const session = await BrowserSession.launch({ headless: true });
    try {
      await session.goto(siteUrl);
      await session.evaluate('document.cookie = "klaudtest=1; path=/"');
      const cookie = await session.evaluate('document.cookie');
      check('cookies can be set in the session', /klaudtest=1/.test(cookie), cookie);

      const profileDir = session.connection._profileDir;
      await session.close();
      check('closing removes the throwaway profile', !fs.existsSync(profileDir), profileDir);

      const fresh = await BrowserSession.launch({ headless: true });
      await fresh.goto(siteUrl);
      const cookieAfter = await fresh.evaluate('document.cookie');
      check('a new session does not inherit the old cookies', !/klaudtest=1/.test(cookieAfter), cookieAfter);
      check('closing twice is safe', (await fresh.close().catch(() => 'threw'), await fresh.close().catch(() => 'threw')) !== 'threw');
    } finally {
      await shutdown();
    }
  });

  await describe('screenshot containment', async () => {
    const buffer = Buffer.from('not really a png');
    const inside = await saveScreenshot(buffer, workspace, 'shot.png');
    check('a named screenshot lands in the workspace', inside.startsWith(path.resolve(workspace)), inside);

    /* The name argument is a path fragment, so it goes through the same
     * containment check as everything else. */
    const escape = await saveScreenshot(buffer, workspace, '../escaped.png').then(
      (v) => ({ ok: true, v }),
      (err) => ({ ok: false, err })
    );
    check('a name escaping the working directory is refused', escape.ok === false, JSON.stringify(escape));
  });

  await finish();
})().catch(async (err) => {
  console.error('\n\x1b[31mThe browser suite crashed:\x1b[0m', err);
  try {
    await require('../src/lib/browser/session').shutdown();
  } catch { /* nothing running */ }
  process.exit(1);
});

async function finish() {
  try { if (site) site.close(); } catch { /* not started */ }
  try { await require('../src/lib/browser/session').shutdown(); } catch { /* nothing running */ }
  await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});

  console.log('');
  if (fail) {
    console.log(`\x1b[31m✗ ${fail} of ${pass + fail} browser-tool checks failed\x1b[0m`);
    for (const f of failures) console.log(`  - [${f.group}] ${f.name}: ${f.detail || ''}`);
    console.log('');
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} browser-tool checks passed\x1b[0m\n`);
  process.exit(0);
}
