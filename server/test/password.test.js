// Password hashing: pure functions, no database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { hashPassword, verifyPassword, needsRehash } from '../src/modules/auth/password.js';
import { isCommonPassword } from '../src/modules/auth/common-passwords.js';

const PASSWORD = 'correct horse battery staple';

test('hash is argon2id with the OWASP settings, and does not contain the password', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(!hash.includes(PASSWORD));
});

test('same password hashed twice gives different hashes (random salt)', async () => {
  const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword(a, PASSWORD));
  assert.ok(await verifyPassword(b, PASSWORD));
});

test('verify: right password true, wrong password false, broken hash false', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(hash, PASSWORD), true);
  assert.equal(await verifyPassword(hash, 'correct horse battery stapl'), false);
  assert.equal(await verifyPassword('not-a-real-hash', PASSWORD), false);
});

test('unicode: the same visible password matches in both encodings', async () => {
  const composed = 'café-au-lait-2026'; // "é" as ONE character
  const decomposed = 'café-au-lait-2026'; // "e" + combining accent: looks identical
  assert.notEqual(composed, decomposed); // different strings in JavaScript...
  const hash = await hashPassword(composed);
  assert.ok(await verifyPassword(hash, decomposed)); // ...but the same password to us
});

test('needsRehash: current hash is fine, a weaker old hash needs upgrading', async () => {
  const current = await hashPassword(PASSWORD);
  const old = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 4096, timeCost: 1 });
  assert.equal(needsRehash(current), false);
  assert.equal(needsRehash(old), true);
});

test('common passwords are detected, case-insensitively', () => {
  assert.equal(isCommonPassword('qwertyuiop'), true);
  assert.equal(isCommonPassword('QwertyUIOP'), true);
  assert.equal(isCommonPassword('correct horse battery staple'), false);
});

test('timing: how long one hash takes on this machine', async (t) => {
  const runs = 5;
  const start = performance.now();
  for (let i = 0; i < runs; i++) await hashPassword(PASSWORD);
  const ms = (performance.now() - start) / runs;
  t.diagnostic(`argon2id hash: ~${ms.toFixed(0)} ms each`); // printed in the test output
  assert.ok(ms < 1000, 'hashing is unreasonably slow');
});
