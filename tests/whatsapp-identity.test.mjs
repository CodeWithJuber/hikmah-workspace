// Phone <-> user identity. Normalization to E.164-ish, short link codes,
// and the explicit link step — no silent auto-linking.
// Run: node --test tests/whatsapp-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone,
  mintLinkCode,
  linkCodeHash,
  verifyLinkCode,
  LINK_CODE_TTL_MS,
  WhatsAppIdentityError,
} from '../lib/whatsapp/identity.ts';

test('normalization strips formatting and keeps E.164 shape', () => {
  assert.equal(normalizePhone('+971 50 000 0001'), '+971500000001');
  assert.equal(normalizePhone('00971-50-000-0001').slice(0, 1), '+');
  assert.equal(normalizePhone('(555) 123-4567'), '+5551234567');
});

test('garbage numbers are refused', () => {
  assert.throws(() => normalizePhone('123'), WhatsAppIdentityError);
  assert.throws(() => normalizePhone(''), WhatsAppIdentityError);
  assert.throws(() => normalizePhone('call me maybe'), WhatsAppIdentityError);
});

test('link codes are six digits grouped for reading aloud', () => {
  const code = mintLinkCode();
  assert.match(code, /^\d{3} \d{3}$/);
});

test('the stored hash is stable and ignores how the code was spaced', () => {
  assert.equal(linkCodeHash('482 913'), linkCodeHash('482913'));
  assert.notEqual(linkCodeHash('482 913'), linkCodeHash('482 914'));
});

const NOW = Date.now();
const future = new Date(NOW + LINK_CODE_TTL_MS).toISOString();
const past = new Date(NOW - 1).toISOString();
const HASH = linkCodeHash('123 456');

test('a fresh, matching code verifies', () => {
  assert.equal(verifyLinkCode('123 456', HASH, future, NOW), true);
  assert.equal(verifyLinkCode('123456', HASH, future, NOW), true);
});

test('a wrong code does not verify', () => {
  assert.equal(verifyLinkCode('654 321', HASH, future, NOW), false);
});

test('an expired code does not verify', () => {
  assert.equal(verifyLinkCode('123 456', HASH, past, NOW), false);
});

test('a missing stored code never verifies', () => {
  assert.equal(verifyLinkCode('123 456', null, future, NOW), false);
  assert.equal(verifyLinkCode('123 456', HASH, null, NOW), false);
});
