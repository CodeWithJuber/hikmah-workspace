// Update policy and revocation: same key, version increase, no silent
// permission widening; revoke deactivates without deleting.
// Run: node --test tests/catalog-updates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKey, signManifest } from '../lib/catalog/signing.ts';
import { applyRevoke, checkUpdate, mayInstall, mayRunInstall } from '../lib/catalog/updates.ts';

const base = (overrides = {}) => ({
  name: 'calculator',
  version: '1.0.0',
  description: 'Does arithmetic.',
  permissions: ['calc:compute'],
  entrypoint: 'calculator',
  ...overrides,
});

const stored = (manifest, signer, status = 'active') => ({
  id: `${manifest.name}@${manifest.version}`,
  manifest,
  signature: 'sig',
  signer,
  status,
});

const keys = () => generateSigningKey();

test('a clean update passes', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64);
  const candidate = base({ version: '1.1.0' });
  const check = checkUpdate(
    current,
    candidate,
    signManifest(candidate, privateKeyB64),
    publicKeyB64,
  );
  assert.equal(check.ok, true);
  assert.deepEqual(check.permissionsAdded, []);
});

test('the version must increase', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64);
  for (const version of ['1.0.0', '0.9.9']) {
    const candidate = base({ version });
    const check = checkUpdate(
      current,
      candidate,
      signManifest(candidate, privateKeyB64),
      publicKeyB64,
    );
    assert.equal(check.ok, false);
    assert.equal(check.code, 'version-not-increased');
  }
});

test('a different signing key is refused', () => {
  const original = keys();
  const impostor = keys();
  const current = stored(base(), original.publicKeyB64);
  const candidate = base({ version: '1.1.0' });
  const check = checkUpdate(
    current,
    candidate,
    signManifest(candidate, impostor.privateKeyB64),
    impostor.publicKeyB64,
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'signer-changed');
});

test('a bad signature is refused', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64);
  const candidate = base({ version: '1.1.0' });
  const tampered = { ...candidate, description: 'Changed after signing.' };
  const check = checkUpdate(
    current,
    tampered,
    signManifest(candidate, privateKeyB64),
    publicKeyB64,
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'bad-signature');
});

test('permission widening is refused without re-grant, and names the delta', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64);
  const candidate = base({ version: '1.1.0', permissions: ['calc:compute', 'net:fetch'] });
  const check = checkUpdate(
    current,
    candidate,
    signManifest(candidate, privateKeyB64),
    publicKeyB64,
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'permissions-widened');
  assert.deepEqual(check.permissionsAdded, ['net:fetch']);
  assert.ok(check.message.includes('net:fetch'));
});

test('permission narrowing or reordering passes', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base({ permissions: ['calc:compute', 'time:read'] }), publicKeyB64);
  const narrowed = base({ version: '1.1.0', permissions: ['calc:compute'] });
  const check = checkUpdate(current, narrowed, signManifest(narrowed, privateKeyB64), publicKeyB64);
  assert.equal(check.ok, true);
  assert.deepEqual(check.permissionsRemoved, ['time:read']);
});

test('an update for another connector is refused', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64);
  const candidate = base({ name: 'notes-search', version: '1.1.0' });
  const check = checkUpdate(
    current,
    candidate,
    signManifest(candidate, privateKeyB64),
    publicKeyB64,
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'name-mismatch');
});

test('no updates from a revoked version', () => {
  const { publicKeyB64, privateKeyB64 } = keys();
  const current = stored(base(), publicKeyB64, 'revoked');
  const candidate = base({ version: '1.1.0' });
  const check = checkUpdate(
    current,
    candidate,
    signManifest(candidate, privateKeyB64),
    publicKeyB64,
  );
  assert.equal(check.ok, false);
  assert.equal(check.code, 'manifest-revoked');
});

test('mayInstall: active yes, deprecated yes-with-notice, revoked no', () => {
  assert.equal(mayInstall({ status: 'active' }).ok, true);
  const deprecated = mayInstall({ status: 'deprecated' });
  assert.equal(deprecated.ok, true);
  assert.ok(deprecated.notice && deprecated.notice.length > 0);
  assert.equal(mayInstall({ status: 'revoked' }).ok, false);
});

test('revocation marks without deleting', () => {
  const { publicKeyB64 } = keys();
  const row = stored(base(), publicKeyB64);
  const revoked = applyRevoke(row);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.id, row.id);
  assert.equal(revoked.signature, row.signature);
  assert.deepEqual(revoked.manifest, row.manifest);
  assert.equal(row.status, 'active', 'the input row is not mutated');
});

test('a revoked install may still run', () => {
  assert.equal(
    mayRunInstall({ status: 'revoked' }),
    true,
    'revocation refuses new installs, not existing ones',
  );
  assert.equal(mayRunInstall({ status: 'active' }), true);
  assert.equal(mayRunInstall({ status: 'deprecated' }), true);
});
