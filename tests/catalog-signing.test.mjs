// Ed25519 manifest signing: canonical bytes, sign/verify round trip,
// tampering and wrong keys fail closed.
// Run: node --test tests/catalog-signing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalBytes,
  fingerprint,
  generateSigningKey,
  signManifest,
  verifyManifest,
  verifySignedManifest,
} from '../lib/catalog/signing.ts';

const manifest = () => ({
  name: 'calculator',
  version: '1.0.0',
  description: 'Does arithmetic.',
  permissions: ['calc:compute'],
  entrypoint: 'calculator',
});

test('sign then verify round-trips', () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const signature = signManifest(manifest(), privateKeyB64);
  assert.ok(verifyManifest(manifest(), signature, publicKeyB64));
});

test('a tampered manifest fails verification', () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const signature = signManifest(manifest(), privateKeyB64);
  assert.ok(!verifyManifest({ ...manifest(), description: 'Does evil.' }, signature, publicKeyB64));
  assert.ok(
    !verifyManifest({ ...manifest(), permissions: ['notes:read'] }, signature, publicKeyB64),
    'widened permissions break the signature',
  );
  assert.ok(!verifyManifest({ ...manifest(), version: '9.9.9' }, signature, publicKeyB64));
});

test('the wrong key fails verification', () => {
  const first = generateSigningKey();
  const second = generateSigningKey();
  const signature = signManifest(manifest(), first.privateKeyB64);
  assert.ok(!verifyManifest(manifest(), signature, second.publicKeyB64));
});

test('canonical bytes ignore key order', () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const shuffled = {
    entrypoint: 'calculator',
    permissions: ['calc:compute'],
    description: 'Does arithmetic.',
    version: '1.0.0',
    name: 'calculator',
  };
  assert.deepEqual(canonicalBytes(manifest()), canonicalBytes(shuffled));
  const signature = signManifest(shuffled, privateKeyB64);
  assert.ok(verifyManifest(manifest(), signature, publicKeyB64));
});

test('signatures are 64-byte Ed25519 base64', () => {
  const { privateKeyB64 } = generateSigningKey();
  const signature = signManifest(manifest(), privateKeyB64);
  assert.equal(signature.length, 88);
  assert.equal(Buffer.from(signature, 'base64').length, 64);
});

test('verification never throws on garbage', () => {
  const { publicKeyB64 } = generateSigningKey();
  assert.equal(verifyManifest(manifest(), '!!!not-base64!!!', publicKeyB64), false);
  assert.equal(verifyManifest(manifest(), 'AAAA', publicKeyB64), false, 'short signature');
  assert.equal(verifyManifest(manifest(), 'A'.repeat(88), 'AAAA'), false, 'garbage key');
});

test('verifySignedManifest checks the attached triple', () => {
  const { publicKeyB64, privateKeyB64 } = generateSigningKey();
  const signed = {
    manifest: manifest(),
    signature: signManifest(manifest(), privateKeyB64),
    signer: publicKeyB64,
  };
  assert.ok(verifySignedManifest(signed));
  assert.ok(!verifySignedManifest({ ...signed, signer: generateSigningKey().publicKeyB64 }));
});

test('fingerprints are stable and unique per key', () => {
  const first = generateSigningKey();
  const second = generateSigningKey();
  assert.equal(fingerprint(first.publicKeyB64), fingerprint(first.publicKeyB64));
  assert.equal(fingerprint(first.publicKeyB64).length, 64);
  assert.notEqual(fingerprint(first.publicKeyB64), fingerprint(second.publicKeyB64));
});
