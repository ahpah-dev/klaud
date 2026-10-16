#!/usr/bin/env node
'use strict';

/**
 * Cloudflare credential check — run this to see exactly what is wrong.
 *
 *   npm run check-cloudflare                 # uses the saved token + account ID
 *   npm run check-cloudflare -- <account-id> # uses the saved token, your account ID
 *
 * Nothing is written to your settings unless the credentials actually work, at
 * which point Klaud is configured with them automatically. The token is never
 * printed in full.
 *
 * Why this exists: Cloudflare answers "Authentication error" (code 10000) for a
 * revoked token, a token from another account, and a token missing the Workers
 * AI permission alike — it does not say which. And when the account ID belongs
 * to a different account, it answers a misleading 401 rather than a clear 403.
 * So the only way to find out is to test each piece separately, which this does.
 */

const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { accountIdFromToken, inspectTokenClaims } = require('../src/providers');

/**
 * Where a Cloudflare credential comes from, and how each kind must be sent.
 *
 *  - An API Token (classic JWT, or a modern `cfut_…` opaque token) goes in
 *    `Authorization: Bearer`. This is the only kind Klaud supports.
 *  - A Global API Key is 37 hex characters and needs `X-Auth-Key` plus
 *    `X-Auth-Email`. Klaud does not support it, and sending it as a Bearer token
 *    is exactly what produces "Invalid format for Authorization header".
 */
function describeCredential(token) {
  const t = String(token || '');
  const dots = (t.match(/\./g) || []).length;
  const isJwt = dots === 2 && t.split('.').every((p) => p.length > 0);
  const looksGlobal = /^[a-f0-9]{37}$/i.test(t);
  const cfPrefixed = /^cfut_|^cf_|^cloudflare_/i.test(t);
  const otherService = /^sk-or-/.test(t) ? 'OpenRouter'
    : /^sk-ant-/.test(t) ? 'Anthropic'
    : /^gsk_/.test(t) ? 'Groq'
    : /^sk-/.test(t) ? 'an OpenAI-style provider'
    : /^xai-/.test(t) ? 'xAI'
    : /^hf_/.test(t) ? 'Hugging Face'
    : null;

  let kind = 'unrecognised';
  if (isJwt) kind = 'api-token (JWT)';
  else if (looksGlobal) kind = 'global-api-key';
  else if (cfPrefixed) kind = 'api-token (prefixed)';

  return { kind, isJwt, looksGlobal, cfPrefixed, otherService, length: t.length, dots };
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  head: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

function ask(question, { secret = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) {
      // Hide the token as it is typed so it does not sit on screen.
      const original = rl._writeToOutput;
      rl._writeToOutput = function (chunk) {
        if (chunk.includes(question)) original.call(rl, chunk);
        else original.call(rl, '*');
      };
    }
    rl.question(question, (answer) => {
      if (secret) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cf(pathname, token) {
  const url = `https://api.cloudflare.com/client/v4${pathname}`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch { /* keep raw */ }
    return { status: res.status, ok: res.ok, json, raw };
  } catch (err) {
    return { status: 0, ok: false, json: null, raw: `request failed: ${err.message}`, networkError: true };
  }
}

function report(label, result) {
  const mark = result.ok && result.json?.success !== false ? C.ok('  OK  ') : C.bad(' FAIL ');
  console.log(`${mark} ${C.bold(label)}  ${C.dim(`HTTP ${result.status || '—'}`)}`);
  const body = (result.raw || '').replace(/\s+/g, ' ').trim();
  console.log(`       ${C.dim(body.slice(0, 400))}`);
  console.log('');
  return result.ok && result.json?.success !== false;
}

(async () => {
  console.log(`\n${C.head('◆ Klaud — Cloudflare Workers AI credential check')}\n`);

  // Read what the app is actually configured with, so this can run without
  // pasting anything. The key is never printed in full and never written out.
  const settingsPath = path.join(os.homedir(), '.klaud', 'settings.json');
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch { /* fall back to prompting */ }

  const fromSettings = Boolean(settings && /cloudflare\.com/i.test(settings.baseUrl || ''));
  // If the app is currently pointed at a different provider, fall back to the
  // Cloudflare profile saved earlier rather than making the user paste a token
  // they have already given the app once.
  const savedCf = settings?.savedProfiles?.cloudflare || null;
  const savedCfAccount = (savedCf?.baseUrl || '').match(/accounts\/([a-f0-9]{32})/i)?.[1] || '';
  const accountFromUrl = (settings?.baseUrl || '').match(/accounts\/([a-f0-9]{32})/i)?.[1] || savedCfAccount;

  // Argument handling, kept forgiving on purpose:
  //   (nothing)                -> the saved token and account ID
  //   <account-id>             -> the saved token with this account ID
  //   <token> [account-id]     -> use these
  const args = process.argv.slice(2).filter((a) => a !== '');
  let token = fromSettings ? settings.apiKey : savedCf?.apiKey || null;
  let accountId = accountFromUrl || '';
  let tokenFromSettings = Boolean(token);

  for (const arg of args) {
    if (/^[a-f0-9]{32}$/i.test(arg)) {
      accountId = arg;
    } else if (arg.includes('.')) {
      // A token argument: JWTs contain dots, and so do Cloudflare API tokens.
      token = arg;
      tokenFromSettings = false;
    } else if (/^cfut_|^cf_/i.test(arg)) {
      token = arg;
      tokenFromSettings = false;
    } else if (/^[a-f0-9]{37}$/i.test(arg)) {
      token = arg;
      tokenFromSettings = false;
    } else {
      // Anything else is probably an account ID the user mistyped.
      accountId = arg;
    }
  }

  if (!token) {
    console.log(C.dim('  Create a token at https://dash.cloudflare.com/profile/api-tokens'));
    console.log(C.dim('  with the "Workers AI" permission.\n'));
    token = await ask('  API token: ', { secret: true });
  }
  if (!accountId) accountId = await ask('  Account ID (optional, Enter to skip): ');

  if (!token) {
    console.log(C.bad('\n  No token given. Nothing to check.\n'));
    process.exit(1);
  }

  const shape = describeCredential(token);
  const sourceLabel = tokenFromSettings
    ? C.ok(fromSettings ? settingsPath : `${settingsPath} (saved Cloudflare profile)`)
    : 'typed in';
  console.log(`  source:  ${sourceLabel}`);
  console.log(`  token:   ${token.slice(0, 6)}${'*'.repeat(Math.max(0, Math.min(16, token.length - 10)))}${token.slice(-4)}  ${C.dim(`(${token.length} chars, ${shape.dots} dots)`)}`);
  console.log(`  account: ${accountId || C.dim('(not given)')}`);
  console.log(`  url:     ${settings?.baseUrl || C.dim('(none)')}\n`);
  console.log(C.dim('  ────────────────────────────────────────────────────────────────\n'));

  /* 0. Is this even a Cloudflare credential, and of the right kind? */
  console.log(C.bold('  0. Credential shape\n'));
  console.log(`     recognised as: ${shape.kind === 'unrecognised' ? C.bad(shape.kind) : C.ok(shape.kind)}`);
  let fatalShape = false;
  if (shape.otherService) {
    console.log(`     ${C.bad(`This looks like ${shape.otherService}'s key, not Cloudflare's.`)}`);
    console.log(C.dim('     Keys starting that way belong to another service, and Cloudflare will'));
    console.log(C.dim('     always answer "Authentication error" for them.'));
    fatalShape = true;
  }
  if (shape.looksGlobal) {
    console.log(`     ${C.bad('This is a Global API Key, not an API Token.')}`);
    console.log(C.dim('     A global key must be sent as X-Auth-Key plus X-Auth-Email, which Klaud'));
    console.log(C.dim('     does not do. Sending it as a Bearer token is exactly what produces'));
    console.log(C.dim('     "Invalid format for Authorization header".'));
    console.log(C.dim('     Fix: create an API *Token* (not a Global key) at'));
    console.log(C.dim('     https://dash.cloudflare.com/profile/api-tokens'));
    fatalShape = true;
  }
  if (shape.kind === 'api-token (prefixed)') {
    console.log(`     ${C.warn('A prefixed token carries no readable claims, so the account ID')}`);
    console.log(C.dim('     cannot be read from it. Paste the account ID from your dashboard URL.'));
  }
  console.log('');

  /* 1. What does the token itself contain? */
  console.log(C.bold('  1. Token contents (read locally, no network)\n'));
  const claims = inspectTokenClaims(token);
  if (!claims) {
    if (shape.cfPrefixed) {
      console.log(`     ${C.ok('A modern prefixed token.')} ${C.dim('This is a valid Cloudflare token format.')}`);
      console.log(C.dim('     It carries no readable claims, so the account ID must come from'));
      console.log(C.dim('     somewhere else — your dashboard URL, or the API.'));
    } else if (shape.looksGlobal) {
      console.log(`     ${C.bad('A Global API Key.')} ${C.dim('Not an API token; Klaud cannot use it.')}`);
    } else {
      console.log(`     ${C.warn('An unrecognised token format.')} ${C.dim(`(${token.length} chars, ${shape.dots} dots)`)}`);
      console.log(C.dim('     Classic Cloudflare API tokens are JWTs with two dots. Modern ones'));
      console.log(C.dim('     start with cfut_. Both work. A 37-character hex value is a Global'));
      console.log(C.dim('     API Key, which does not.'));
    }
    console.log('');
  } else {
    console.log(`     ${C.dim('claims present:')} ${claims.claimNames.join(', ')}`);
    console.log(`     ${C.dim('account-sized values found:')} ${claims.accountIdsFound.length ? claims.accountIdsFound.join(', ') : C.warn('none')}`);
    const fromClaims = accountIdFromToken(token);
    console.log(`     ${C.dim('account ID Klaud would use:')} ${fromClaims ? C.ok(fromClaims) : C.warn('none in the token claims')}`);
    console.log('');
  }

  /* 2. Is the token accepted at all? */
  console.log(C.bold('  2. Is the token valid?\n'));
  const verify = await cf('/user/tokens/verify', token);
  const verified = report('GET /user/tokens/verify', verify);

  /* 3. Which accounts can it see? */
  console.log(C.bold('  3. Which accounts can it see?\n'));
  const accounts = await cf('/accounts', token);
  report('GET /accounts', accounts);
  const list = Array.isArray(accounts.json?.result) ? accounts.json.result : [];
  if (accounts.json?.success === true && list.length === 0) {
    console.log(`     ${C.warn('Empty list, but the request succeeded.')}`);
    console.log(C.dim('     This is normal for an Account-scoped API token: /accounts only lists'));
    console.log(C.dim('     accounts a *user* token may manage. It is not an error.\n'));
  }
  if (list.length) {
    console.log(`     ${C.dim('accounts visible:')} ${list.map((a) => `${a.name} (${a.id})`).join(', ')}\n`);
  }

  /* 4. Settle on an account ID. */
  let resolved = accountId || accountIdFromToken(token) || list[0]?.id || null;
  console.log(C.bold('  4. Account ID\n'));
  if (resolved) {
    const source = accountId ? 'you supplied it' : accountIdFromToken(token) ? 'from the token claims' : 'the only account listed';
    console.log(`     ${C.ok(resolved)}  ${C.dim(`(${source})`)}\n`);
  } else {
    console.log(`     ${C.bad('Could not determine an account ID.')}`);
    console.log(C.dim('     Open dash.cloudflare.com and copy the 32-character value from the URL:'));
    console.log(C.dim('     dash.cloudflare.com/<account-id>'));
    console.log(C.dim(`     Then re-run:  npm run check-cloudflare -- "${token.slice(0, 4)}…" "<account-id>"\n`));
  }

  /* 4b. The check that identifies a mismatched account, and the one that matters
         when the user has supplied the ID themselves. */
  let accountOk = false;
  if (resolved) {
    const accountRes = await cf(`/accounts/${resolved}`, token);
    const mark = accountRes.status === 403 ? C.bad('DENIED') : accountRes.ok ? C.ok('  OK  ') : C.bad(' FAIL ');
    console.log(`  ${mark} ${C.bold('GET /accounts/<id>')}  ${C.dim(`HTTP ${accountRes.status}`)}`);
    console.log(`       ${C.dim((accountRes.raw || '').replace(/\s+/g, ' ').trim().slice(0, 300))}\n`);

    if (accountRes.status === 403) {
      // Cloudflare uses 9109 with two different messages, and they mean very
      // different things:
      //   "Invalid account identifier"    -> the account does not exist
      //   "Unauthorized to access..."     -> the account exists, but this token
      //                                      cannot READ it. That is expected
      //                                      for a Workers-AI-only token, because
      //                                      /accounts/<id> needs
      //                                      "Account Settings: Read".
      // So a 403 here does NOT prove the account is wrong, and saying so is how
      // someone gets sent off re-creating a token that was fine.
      const body = String(accountRes.raw || '');
      const invalidIdentifier = /invalid account identifier/i.test(body);
      if (invalidIdentifier) {
        console.log(`     ${C.bad('That account ID does not exist.')}`);
        console.log(C.dim('     Cloudflare answers "Invalid account identifier" only when the value'));
        console.log(C.dim('     cannot correspond to an account. Copy the 32-character value from the'));
        console.log(C.dim('     address bar of dash.cloudflare.com — right after the domain.'));
        console.log(`\n     ${C.bold('Fix:')} re-run with the correct account ID:\n`);
        console.log(`       ${C.bold('npm run check-cloudflare -- <account-id>')}\n`);
      } else {
        console.log(`     ${C.warn('The token cannot read this account — which is often normal.')}`);
        console.log(C.dim('     Reading /accounts/<id> requires the "Account Settings: Read"'));
        console.log(C.dim('     permission. A token scoped to only Workers AI — which is what the'));
        console.log(C.dim('     setup instructions ask for — always gets this, and still works fine.'));
        console.log(C.dim('     Cloudflare also returns it when the account belongs to a different'));
        console.log(C.dim('     account than the token, so on its own this proves neither.'));
        console.log(C.dim('     The Workers AI test below is the one that decides.'));
        console.log(C.dim('     To tell the two apart for certain, create a fresh token inside THIS'));
        console.log(C.dim('     account with the Workers AI permission and run this again.'));
      }
      console.log('');
    }
    accountOk = accountRes.ok;
  }

  /* 5. The two calls that actually matter. */
  if (resolved) {
    console.log(C.bold('  5. Can Workers AI answer?\n'));
    // Workers AI answers the model list on POST, not GET. Using GET returns 405
    // "not supported for requested URI", which looks like a broken account.
    let models = { status: 0, ok: false, raw: '' };
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${resolved}/ai/v1/models`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20_000),
      });
      const raw = await res.text();
      models = { status: res.status, ok: res.ok, raw, json: (() => { try { return JSON.parse(raw); } catch { return null; } })() };
    } catch (err) {
      models = { status: 0, ok: false, raw: `request failed: ${err.message}` };
    }
    report('POST .../ai/v1/models', models);

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${resolved}/ai/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          max_tokens: 12,
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );
    const raw = await res.text();
    const ok = res.ok;
    console.log(`${ok ? C.ok('  OK  ') : C.bad(' FAIL ')} ${C.bold('POST .../ai/v1/chat/completions')}  ${C.dim(`HTTP ${res.status}`)}`);
    console.log(`       ${C.dim(raw.replace(/\s+/g, ' ').slice(0, 400))}\n`);

    console.log(C.dim('  ────────────────────────────────────────────────────────────────\n'));
    if (ok) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${resolved}/ai/v1`;
      console.log(`  ${C.ok('Workers AI works.')} The base URL to paste into Klaud Settings is:\n`);
      console.log(`    ${C.bold(url)}`);
      console.log(`    ${C.bold('@cf/meta/llama-3.1-8b-instruct-fp8-fast')}\n`);

      // If the app is pointing somewhere else, offer to fix it outright. The
      // working values are known at this point, so making the user retype them
      // into a form is unnecessary.
      const wrongUrl = (settings?.baseUrl || '') !== url;
      const wrongKey = (settings?.apiKey || '') !== token;
      if (fromSettings || settings) {
        if (wrongUrl || wrongKey) {
          fs.writeFileSync(
            settingsPath,
            JSON.stringify(
              { ...settings, baseUrl: url, apiKey: token, model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' },
              null,
              2
            ),
            'utf8'
          );
          console.log(`  ${C.ok('Klaud is now configured.')} Wrote the working URL, key and model to:`);
          console.log(C.dim(`    ${settingsPath}\n`));
          console.log('  Restart the app (or reload the page) and it will work.\n');
        } else {
          console.log(C.dim('  Klaud is already configured with these values.\n'));
        }
      }
    } else {
      console.log(`  ${C.bad('Workers AI did not answer.')} Cloudflare's own words are above.\n`);
      console.log(C.dim('  A 401 "Authentication error" here with a token that verified as valid means'));
      console.log(C.dim('  one of exactly two things, and this check cannot tell them apart:\n'));
      console.log(C.dim('    a) the account ID belongs to a different Cloudflare account than the token'));
      console.log(C.dim('    b) the token has no Workers AI permission on this account\n'));
      console.log(`  ${C.bold('To decide:')} create a brand-new API token from inside this account with the`);
      console.log('  "Workers AI" permission, then run this again with it:\n');
      console.log(`    ${C.bold(`npm run check-cloudflare -- ${resolved}`)}\n`);
      console.log(C.dim('    • If the new token works, the old token was the problem.'));
      console.log(C.dim('    • If it still fails, the account ID is not the one you are signed in to.'));
      console.log(C.dim('      Copy it from the address bar of dash.cloudflare.com.\n'));
    }
  }

  console.log('');
  if (!verified && !resolved) {
    console.log(`  ${C.bad('Neither check passed.')} The report above says which value is at fault.\n`);
    process.exit(1);
  }
  console.log('');
})().catch((err) => {
  console.error(`\n  Check crashed: ${err.message}\n`);
  process.exit(1);
});