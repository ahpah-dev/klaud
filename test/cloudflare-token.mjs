'use strict';
// Verify account-ID extraction against every shape Cloudflare tokens use.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { accountIdFromToken } = require('../src/providers');

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const cases = [
  ['account_id claim', { account_id: ID }, ID],
  ['nested account.id claim', { account: { id: ID } }, ID],
  ['acc claim', { acc: ID }, ID],
  ['sub of the form account:<id>', { sub: `account:${ID}` }, ID],
  ['scope string containing the id', { scope: `com.cloudflare.api.account.${ID}` }, ID],
  ['scope array containing the id', { scope: ['com.cloudflare.api.account.zone', `com.cloudflare.api.account.${ID}`] }, ID],
  ['id buried in a nested object', { policies: [{ resources: { [`com.cloudflare.api.account.${ID}`]: '*' } }] }, ID],
  ['uppercase hex is normalised', { account_id: ID.toUpperCase() }, ID],
  ['no account id anywhere', { sub: 'user:someone' }, null],
  // An explicit claim wins even when other 32-hex values are present. This was
  // the real-world failure: realistic tokens carry a jti and policy resource
  // keys alongside the account id, and requiring "exactly one" returned nothing,
  // which sent setup down the wrong path and produced a nonsense error.
  ['an explicit claim wins over other 32-hex values', { account_id: ID, jti: 'a'.repeat(32), other: 'f'.repeat(32) }, ID],
  ['an explicit account.id wins over policy resource keys',
    { account: { id: ID }, policies: [{ resources: { [`com.cloudflare.api.account.${'b'.repeat(32)}`]: '*' } }] }, ID],
  // With no explicit claim, a scan that finds several candidates must refuse.
  ['ambiguous scan with no explicit claim refuses',
    { sub: 'user:not-hex', a: 'a'.repeat(32), b: 'b'.repeat(32) }, null],
  ['not a jwt', 'plain-api-key', null],
  ['malformed jwt', 'a.b.c', null],
  ['empty', '', null],
  ['null', null, null],
];

let pass = 0;
let fail = 0;
console.log('\n\x1b[38;5;209m* Cloudflare token claim extraction\x1b[0m\n');

for (const [name, claims, expected] of cases) {
  const token = typeof claims === 'string' || claims === null ? claims : jwt(claims);
  let got;
  try {
    got = accountIdFromToken(token);
  } catch (err) {
    got = `threw: ${err.message}`;
  }
  const ok = got === expected;
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${expected}, got ${got}`);
  }
}

// The real-world case that matters: a token whose id only appears in scope.
assert.equal(accountIdFromToken(jwt({ scope: [`com.cloudflare.api.account.${ID}`] })), ID);

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} extraction checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} extraction checks passed\x1b[0m\n`);
