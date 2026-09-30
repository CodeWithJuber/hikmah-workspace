// Catalog store: installs record explicit grants, revoked manifests refuse
// new installs but keep existing ones, updates enforce the policy.
// Run: node --test tests/catalog-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createCatalogStore, CatalogStoreError } from '../lib/catalog/store.ts';
import { generateSigningKey, signManifest, verifySignedManifest } from '../lib/catalog/signing.ts';

const MIGRATION = readFileSync(new URL('../drizzle/0039_catalog.sql', import.meta.url), 'utf8');

function freshStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  return { db, store: createCatalogStore(db) };
}

const stamp = '2026-09-30T00:00:00.000Z';

function insertSigned(db, manifest, keypair, status = 'active') {
  const id = `${manifest.name}@${manifest.version}`;
  db.prepare(
    `INSERT INTO connector_manifests (id, name, version, manifest_json, signature, signer, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    manifest.name,
    manifest.version,
    JSON.stringify(manifest),
    signManifest(manifest, keypair.privateKeyB64),
    keypair.publicKeyB64,
    status,
    stamp,
    stamp,
  );
  for (const permission of manifest.permissions)
    db.prepare('INSERT INTO connector_permissions (manifest_id, permission) VALUES (?, ?)').run(
      id,
      permission,
    );
  return id;
}

const widget = (version, permissions = ['calc:compute']) => ({
  name: 'widget',
  version,
  description: 'A test connector.',
  permissions,
  entrypoint: 'calculator',
});

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CatalogStoreError, `expected CatalogStoreError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('the seed catalog lists four signed, installable connectors', () => {
  const { store } = freshStore();
  const listed = store.listActive();
  assert.equal(listed.length, 4);
  for (const row of listed)
    assert.ok(verifySignedManifest(row), `${row.id} verifies against the shipped public key`);
  assert.deepEqual(
    listed.map((r) => r.manifest.name),
    ['calculator', 'local-file-reader', 'notes-search', 'timezone-converter'],
  );
});

test('install records the explicitly granted permissions', () => {
  const { store } = freshStore();
  const install = store.install('user-1', 'notes-search@1.0.0', ['notes:read']);
  assert.equal(install.userId, 'user-1');
  assert.deepEqual(install.grantedPermissions, ['notes:read']);
  const fetched = store.getInstall('user-1', 'notes-search@1.0.0');
  assert.ok(fetched);
  assert.deepEqual(fetched.grantedPermissions, ['notes:read']);
});

test('install refuses a revoked manifest', async () => {
  const { store } = freshStore();
  store.revoke('calculator@1.0.0');
  await rejects(
    Promise.resolve().then(() => store.install('user-1', 'calculator@1.0.0', ['calc:compute'])),
    'manifest-revoked',
  );
});

test('install refuses permissions the manifest never requested', async () => {
  const { store } = freshStore();
  await rejects(
    Promise.resolve().then(() =>
      store.install('user-1', 'calculator@1.0.0', ['calc:compute', 'files:read']),
    ),
    'permission-not-requested',
  );
});

test('install refuses unknown permissions', async () => {
  const { store } = freshStore();
  await rejects(
    Promise.resolve().then(() => store.install('user-1', 'calculator@1.0.0', ['billing:override'])),
    'unknown-permission',
  );
});

test('revoke deactivates without deleting', () => {
  const { store } = freshStore();
  store.install('user-1', 'calculator@1.0.0', ['calc:compute']);
  const revoked = store.revoke('calculator@1.0.0');
  assert.equal(revoked.status, 'revoked');
  // Gone from browse...
  assert.ok(!store.listActive().some((r) => r.id === 'calculator@1.0.0'));
  // ...but the row, its signature and the install all survive.
  assert.ok(store.versions('calculator').some((r) => r.status === 'revoked'));
  const install = store.getInstall('user-1', 'calculator@1.0.0');
  assert.ok(install, 'the existing install keeps working');
  assert.equal(install.manifest.status, 'revoked');
});

test('updateCheck reports a newer version', () => {
  const { db, store } = freshStore();
  const keypair = generateSigningKey();
  insertSigned(db, widget('1.0.0'), keypair);
  insertSigned(db, widget('1.1.0'), keypair);
  store.install('user-1', 'widget@1.0.0', ['calc:compute']);
  const updates = store.updateCheck('user-1');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].latestVersion, '1.1.0');
  assert.equal(updates[0].needsRegrant, false);
});

test('updateCheck flags a permission-widening update', () => {
  const { db, store } = freshStore();
  const keypair = generateSigningKey();
  insertSigned(db, widget('1.0.0'), keypair);
  insertSigned(db, widget('1.1.0', ['calc:compute', 'net:fetch']), keypair);
  store.install('user-1', 'widget@1.0.0', ['calc:compute']);
  const updates = store.updateCheck('user-1');
  assert.equal(updates[0].needsRegrant, true);
  assert.deepEqual(updates[0].permissionsAdded, ['net:fetch']);
});

test('updateToVersion applies a clean update', () => {
  const { db, store } = freshStore();
  const keypair = generateSigningKey();
  insertSigned(db, widget('1.0.0'), keypair);
  insertSigned(db, widget('1.1.0'), keypair);
  store.install('user-1', 'widget@1.0.0', ['calc:compute']);
  const updated = store.updateToVersion('user-1', 'widget@1.1.0', ['calc:compute']);
  assert.equal(updated.manifestId, 'widget@1.1.0');
  assert.equal(
    store.getInstall('user-1', 'widget@1.0.0'),
    null,
    'one installed version per connector',
  );
});

test('a widening update needs explicit re-grant', async () => {
  const { db, store } = freshStore();
  const keypair = generateSigningKey();
  insertSigned(db, widget('1.0.0'), keypair);
  insertSigned(db, widget('1.1.0', ['calc:compute', 'net:fetch']), keypair);
  store.install('user-1', 'widget@1.0.0', ['calc:compute']);
  await rejects(
    Promise.resolve().then(() => store.updateToVersion('user-1', 'widget@1.1.0', ['calc:compute'])),
    'regrant-required',
  );
  const updated = store.updateToVersion('user-1', 'widget@1.1.0', ['calc:compute', 'net:fetch']);
  assert.equal(updated.manifestId, 'widget@1.1.0');
  assert.deepEqual(updated.grantedPermissions, ['calc:compute', 'net:fetch']);
});

test('an update signed by another key is refused', async () => {
  const { db, store } = freshStore();
  insertSigned(db, widget('1.0.0'), generateSigningKey());
  insertSigned(db, widget('1.1.0'), generateSigningKey());
  store.install('user-1', 'widget@1.0.0', ['calc:compute']);
  await rejects(
    Promise.resolve().then(() => store.updateToVersion('user-1', 'widget@1.1.0', ['calc:compute'])),
    'signer-changed',
  );
});
