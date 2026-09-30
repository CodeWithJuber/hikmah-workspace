// Manifest schema and validation: a manifest that fails is refused with
// named errors, version must be semver, permissions must be from the known
// vocabulary.
// Run: node --test tests/catalog-manifest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  compareVersions,
  isCatalogPermission,
  CATALOG_PERMISSIONS,
} from '../lib/catalog/manifest.ts';

const good = () => ({
  name: 'notes-search',
  version: '1.2.0',
  description: 'Searches workspace notes.',
  permissions: ['notes:read'],
  entrypoint: 'notes-search',
});

const codes = (value) => {
  const result = validateManifest(value);
  assert.equal(result.ok, false);
  return result.errors.map((e) => e.code);
};

test('a complete valid manifest passes', () => {
  const result = validateManifest({ ...good(), homepage: 'https://example.com/notes' });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.name, 'notes-search');
});

test('homepage is optional', () => {
  const result = validateManifest(good());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.homepage, undefined);
});

test('missing fields are named', () => {
  const rest = { ...good() };
  delete rest.name;
  assert.ok(codes(rest).includes('missing-field'));
});

test('a non-object is refused', () => {
  assert.ok(codes(null).includes('not-an-object'));
  assert.ok(codes([1, 2]).includes('not-an-object'));
  assert.ok(codes('nope').includes('not-an-object'));
});

test('bad names are refused', () => {
  for (const name of ['Notes-Search', 'notes search', 'notes_search', '-notes', 'notes-', '']) {
    assert.ok(codes({ ...good(), name }).includes('bad-name'), name || '(empty)');
  }
});

test('bad semver is refused', () => {
  for (const version of ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '1.2.x', 'latest']) {
    assert.ok(codes({ ...good(), version }).includes('bad-semver'), version);
  }
});

test('strict semver forms pass', () => {
  for (const version of ['1.2.3', '0.0.1', '2.0.0-beta.1', '1.0.0+build.42', '10.20.30']) {
    assert.equal(validateManifest({ ...good(), version }).ok, true, version);
  }
});

test('an unknown permission is refused by name', () => {
  const result = validateManifest({ ...good(), permissions: ['notes:read', 'billing:override'] });
  assert.equal(result.ok, false);
  const unknown = result.errors.find((e) => e.code === 'unknown-permission');
  assert.ok(unknown, 'names the unknown-permission error');
  assert.ok(unknown.message.includes('billing:override'), 'names the offending permission');
});

test('duplicate permissions are refused', () => {
  assert.ok(
    codes({ ...good(), permissions: ['notes:read', 'notes:read'] }).includes(
      'duplicate-permission',
    ),
  );
});

test('an empty permission list is honest and allowed', () => {
  const result = validateManifest({ ...good(), permissions: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.permissions, []);
});

test('non-array permissions are refused', () => {
  assert.ok(codes({ ...good(), permissions: 'notes:read' }).includes('bad-type'));
});

test('empty and overlong descriptions are refused', () => {
  assert.ok(codes({ ...good(), description: '   ' }).length > 0);
  assert.ok(codes({ ...good(), description: 'x'.repeat(501) }).includes('description-too-long'));
});

test('a bad entrypoint is refused', () => {
  assert.ok(codes({ ...good(), entrypoint: '../evil' }).includes('bad-entrypoint'));
  assert.ok(codes({ ...good(), entrypoint: 'Notes Search' }).includes('bad-entrypoint'));
});

test('homepage must be https', () => {
  assert.ok(codes({ ...good(), homepage: 'http://example.com' }).includes('bad-homepage'));
  assert.ok(codes({ ...good(), homepage: 'not a url' }).includes('bad-homepage'));
});

test('every error carries a field and a message', () => {
  const result = validateManifest({ name: 'Bad Name', version: 'x', permissions: ['nope'] });
  assert.equal(result.ok, false);
  for (const error of result.errors) {
    assert.ok(error.code.length > 0);
    assert.ok(error.field.length > 0);
    assert.ok(error.message.length > 0);
  }
});

test('the vocabulary is closed and recognised', () => {
  assert.ok(isCatalogPermission('notes:read'));
  assert.ok(isCatalogPermission('calc:compute'));
  assert.ok(
    !isCatalogPermission('billing:override'),
    'operator powers are not connector permissions',
  );
  assert.ok(!isCatalogPermission('notes:delete'));
  assert.ok(CATALOG_PERMISSIONS.length >= 4);
});

test('compareVersions orders semver', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1, 'prerelease sorts below release');
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});
