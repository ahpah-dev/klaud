'use strict';

/**
 * Cloudflare error-message test.
 *
 *   node test/cloudflare-errors.js
 *
 * Plain-text output — run with `node test/cloudflare-errors.js`.
 *
 * The bug this exists to prevent: an unrecognised Cloudflare error code produced
 * exactly the string "Cloudflare error unknown", with the real reason thrown
 * away. Every branch must now carry enough for the user to act on, and a bare
 * "unknown" must be impossible.
 */

const { explainCloudflareError, explainEmptyAccounts, inspectTokenClaims, accountIdFromToken } = require('../src/providers');

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

const isUseful = (text) =>
  typeof text === 'string' &&
  text.length > 25 &&
  !/error unknown$/i.test(text.trim()) &&
  !/^error:/i.test(text.trim());

console.log('\n\x1b[38;5;209m* Cloudflare error reporting\x1b[0m\n');

/* ---------------- known codes ---------------- */
const known = [
  [6003, 'Malformed token'],
  [9109, 'Revoked token'],
  [10000, 'Missing permission'],
  [7003, 'No account visible'],
  [7001, 'Wrong URL'],
  [971, 'Workers AI not enabled'],
];

for (const [code, label] of known) {
  const msg = explainCloudflareError(code, '', '');
  check(`${label} (${code}) explains what to do`, isUseful(msg), msg);
  check(`${label} (${code}) still names the code`, msg.includes(String(code)), msg);
}

/* ---------------- the regression ---------------- */
// This is the exact input that used to produce "Cloudflare error unknown".
const unknownCode = explainCloudflareError(99999, '', '');
check('an unrecognised code with no message still says something useful',
  isUseful(unknownCode), unknownCode);
check('an unrecognised code is named, not hidden', unknownCode.includes('99999'), unknownCode);

const noCodeNoMessage = explainCloudflareError(undefined, undefined, '');
check('no code and no message still says something useful',
  isUseful(noCodeNoMessage), noCodeNoMessage);
check('the no-information case never says "unknown"',
  !/unknown/i.test(noCodeNoMessage), noCodeNoMessage);

/* ---------------- the message is never discarded ---------------- */
const withMessage = explainCloudflareError(99999, 'Workers AI is not enabled for this account');
check('an unknown code keeps the raw message', withMessage.includes('Workers AI is not enabled'), withMessage);

const knownPlusMessage = explainCloudflareError(9109, 'Invalid API Token');
check('a known code keeps the raw message too',
  knownPlusMessage.includes('Invalid API Token'), knownPlusMessage);
check('a known code still gives its hint',
  /not authorized|different accounts/i.test(knownPlusMessage), knownPlusMessage);
check('a known code does not claim the token is invalid when the account is the problem',
  !/token is not valid|has been revoked/i.test(knownPlusMessage), knownPlusMessage);
check('a known code does not repeat itself if message equals hint',
  (() => {
    const hint = explainCloudflareError(9109, '', '');
    const both = explainCloudflareError(9109, hint.replace(/ \(Cloudflare code \d+\)$/, ''), '');
    return both.split('The token is not valid').length - 1 <= 1;
  })());

/* ---------------- raw body fallback ---------------- */
const rawOnly = explainCloudflareError(undefined, '', '{"success":false,"errors":[{"code":1234,"message":"Some new failure"}]}');
check('an unknown code with only a raw body shows the body',
  rawOnly.includes('Some new failure') || rawOnly.includes('1234'), rawOnly);

const htmlRaw = explainCloudflareError(undefined, '', '<html><body>502 Bad Gateway</body></html>');
check('a non-JSON body is surfaced rather than swallowed', /502 Bad Gateway/.test(htmlRaw), htmlRaw);

/* ---------------- shapes that must not crash ---------------- */
for (const [label, args] of [
  ['null code', [null, null, null]],
  ['empty strings', ['', '', '']],
  ['numbers as message', [1234, 5678, '']],
  ['huge raw body', [undefined, undefined, 'x'.repeat(5000)]],
]) {
  let out;
  try {
    out = explainCloudflareError(...args);
  } catch (err) {
    out = `threw: ${err.message}`;
  }
  check(`${label} does not throw and still returns a useful string`, isUseful(out), String(out).slice(0, 120));
}

const huge = explainCloudflareError(undefined, undefined, 'y'.repeat(5000));
check('a huge raw body is truncated', huge.length < 600, `${huge.length} chars`);

/* ---------------- the empty-but-successful /accounts case ---------------- */
// This is the real failure the user hit:
//   {"result":[],"result_info":{...},"success":true,"errors":[],"messages":[]}
// There is no error to explain, so blaming the Workers AI permission is wrong
// and sends people off fixing something that was never broken.
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const accountScopedInfo = inspectTokenClaims(
  jwt({
    iss: 'cloudflare',
    sub: 'user:9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    scope: ['com.cloudflare.api.account.workers.write', 'com.cloudflare.api.account.workers.read'],
  })
);

const emptyMsg = explainEmptyAccounts(accountScopedInfo);
check('an empty accounts list is explained, not blamed on the wrong thing',
  isUseful(emptyMsg), emptyMsg.slice(0, 90));
check('it never mentions the Workers AI permission being missing',
  !/missing the Workers AI permission/i.test(emptyMsg), emptyMsg.slice(0, 200));
check('it names the account-vs-user token distinction',
  /account api token/i.test(emptyMsg) && /user api token/i.test(emptyMsg), emptyMsg.slice(0, 200));
check('it points out the scopes the token does carry',
  /com\.cloudflare\.api\.account\.workers/.test(emptyMsg), emptyMsg.slice(0, 260));
check('it offers a concrete way forward',
  /paste your account id/i.test(emptyMsg), emptyMsg.slice(-120));

const noScopeInfo = inspectTokenClaims(jwt({ iss: 'cloudflare', sub: 'user:someone' }));
const noScopeMsg = explainEmptyAccounts(noScopeInfo);
check('a token with no scopes at all is still explained usefully',
  isUseful(noScopeMsg) && /no scope list/i.test(noScopeMsg), noScopeMsg.slice(0, 160));

/* ---------------- token claim inspection ---------------- */
const info = inspectTokenClaims(
  jwt({
    iss: 'cloudflare',
    sub: 'user:9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    scope: ['com.cloudflare.api.account.workers.write'],
    jwk: { kty: 'EC', crv: 'P-256', x: 'SECRETMATERIAL', y: 'MORESECRET' },
    id: 'token-id-should-be-hidden',
  })
);
check('claim inspection lists the claim names', Array.isArray(info.claimNames) && info.claimNames.includes('scope'),
  JSON.stringify(info.claimNames));
check('claim inspection finds the account-sized ID', info.accountIdsFound.length === 1,
  JSON.stringify(info.accountIdsFound));
check('claim inspection never exposes key material',
  !JSON.stringify(info).includes('SECRETMATERIAL') && !JSON.stringify(info).includes('MORESECRET'),
  JSON.stringify(info.claims).slice(0, 200));
check('claim inspection hides the token id',
  !JSON.stringify(info).includes('token-id-should-be-hidden'), JSON.stringify(info.claims).slice(0, 200));

check('a non-JWT is rejected by claim inspection', inspectTokenClaims('plain-key') === null);
check('a malformed JWT is rejected by claim inspection', inspectTokenClaims('a.b.c') === null);

/* a real-shaped token: the account id only in the sub claim */
const subOnly = jwt({ iss: 'cloudflare', sub: 'account:abcdef0123456789abcdef0123456789' });
check('the account id is still read when it lives only in sub',
  accountIdFromToken(subOnly) === 'abcdef0123456789abcdef0123456789', String(accountIdFromToken(subOnly)));

/* ---------------- the 403 that identifies a mismatched account ---------------- */
// The real-world case: a valid token used with an account ID from a different
// account. Cloudflare answers 9109 "Unauthorized to access requested resource",
// and blaming the token or the Workers AI permission sends the user in circles.
const denied = explainCloudflareError(9109, 'Unauthorized to access requested resource', '');
check('9109 explains that the token and account are from different accounts',
  /different accounts/i.test(denied), denied);
check('9109 does not tell the user their token is bad',
  !/not valid|revoked/i.test(denied), denied);
check('9109 tells them where to find the right account ID',
  /address bar/i.test(denied) && /32-character/i.test(denied), denied);
// Regression: the hint used to contain "dash.cloudflare.com/<account-id>", and
// people pasted it literally. Windows treats < and > as redirections, so curl
// answered "URL rejected: Bad hostname". No angle-bracket placeholders in any
// user-facing message.
check('9109 does not hand the user an angle-bracket placeholder to paste',
  !/[<>]/.test(denied), denied);
check('9109 still names the code', denied.includes('9109'), denied);

const authError = explainCloudflareError(10000, 'Authentication error', '');
check('10000 mentions the account/token mismatch possibility',
  /account/i.test(authError), authError);
check('10000 still names the code', authError.includes('10000'), authError);

check('6111 explains the Global-API-Key case',
  /global api key/i.test(explainCloudflareError(6111, 'Invalid format for Authorization header', '')),
  explainCloudflareError(6111, '', ''));

/* ---------------- no pasteable placeholders in user-facing text ---------------- */
// Every hint is shown to a person who may copy part of it into a terminal.
const allHints = [
  6003, 6111, 1001, 9109, 10000, 7003, 1000, 7001, 7000, 971, 99999, undefined,
].map((code) => explainCloudflareError(code, '', ''));
const withBrackets = allHints.filter((h) => /[<>{}]/.test(h));
check('no error message contains angle-bracket placeholders',
  withBrackets.length === 0, JSON.stringify(withBrackets.map((h) => h.slice(0, 80))));

const noInfoMsg = explainCloudflareError(undefined, undefined, '');
check('the no-information case has no placeholders either', !/[<>{}]/.test(noInfoMsg), noInfoMsg);

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} error-reporting checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} error-reporting checks passed\x1b[0m\n`);
