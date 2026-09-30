// The webhook signature: X-Hub-Signature-256 HMAC-SHA256 against the raw
// body. A forged body, a wrong secret, or a malformed header must never
// verify; comparison is constant-time.
// Run: node --test tests/whatsapp-signature.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyWebhookSignature,
  signForTest,
  WhatsAppSignatureError,
} from '../lib/whatsapp/signature.ts';

const SECRET = 'test-app-secret';
const BODY = '{"object":"whatsapp_business_account","entry":[]}';
const GOOD = signForTest(BODY, SECRET);

test('a correctly signed body verifies', () => {
  assert.equal(verifyWebhookSignature(BODY, GOOD, SECRET), true);
});

test('a tampered body does not verify against the original signature', () => {
  assert.equal(verifyWebhookSignature(BODY + ' ', GOOD, SECRET), false);
});

test('the wrong app secret does not verify', () => {
  assert.equal(verifyWebhookSignature(BODY, GOOD, 'other-secret'), false);
});

test('an unset app secret never verifies', () => {
  assert.equal(verifyWebhookSignature(BODY, GOOD, null), false);
  assert.equal(verifyWebhookSignature(BODY, GOOD, ''), false);
});

test('a missing header throws, not returns false', () => {
  assert.throws(() => verifyWebhookSignature(BODY, null, SECRET), WhatsAppSignatureError);
});

test('a malformed header throws — wrong prefix and short hex both', () => {
  assert.throws(() => verifyWebhookSignature(BODY, 'md5=abcdef', SECRET), /malformed/);
  assert.throws(() => verifyWebhookSignature(BODY, 'sha256=abc', SECRET), /64 hex/);
});

test('a malformed over-long signature is rejected as malformed, not a crash', () => {
  const long = 'sha256=' + 'ab'.repeat(40);
  assert.throws(() => verifyWebhookSignature(BODY, long, SECRET), WhatsAppSignatureError);
});
