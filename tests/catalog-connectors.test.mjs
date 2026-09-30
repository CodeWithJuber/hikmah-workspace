// The seed connectors do what their manifests claim.
// Run: node --test tests/catalog-connectors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { definition as calculator } from '../connectors/calculator/index.ts';
import { definition as timezoneConverter } from '../connectors/timezone-converter/index.ts';
import { definition as notesSearch } from '../connectors/notes-search/index.ts';
import { definition as localFileReader } from '../connectors/local-file-reader/index.ts';
import { connectorFor, registryKeys } from '../lib/catalog/registry.ts';

const ctx = (overrides = {}) => ({
  grantedPermissions: [],
  notesDir: join(tmpdir(), 'no-notes'),
  allowedDir: join(tmpdir(), 'no-files'),
  ...overrides,
});

const data = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};

test('the registry resolves exactly the four curated connectors', () => {
  assert.deepEqual(registryKeys().sort(), [
    'calculator',
    'local-file-reader',
    'notes-search',
    'timezone-converter',
  ]);
  assert.equal(connectorFor('calculator'), calculator);
  assert.equal(connectorFor('../../etc/evil'), null, 'no arbitrary entrypoint resolves');
  assert.equal(connectorFor('notes-search'), notesSearch);
});

test('manifest entrypoints match the registry', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of registryKeys()) {
    const manifest = JSON.parse(
      await readFile(new URL(`../connectors/${name}/manifest.json`, import.meta.url), 'utf8'),
    );
    assert.equal(manifest.entrypoint, name);
    assert.ok(connectorFor(manifest.entrypoint), `${name} is executable`);
  }
});

test('calculator: precedence and parentheses', () => {
  assert.equal(data(calculator.run({ expression: '2 + 3 * 4' }, ctx())).result, 14);
  assert.equal(data(calculator.run({ expression: '(2 + 3) * 4' }, ctx())).result, 20);
  assert.equal(
    data(calculator.run({ expression: '2^3^2' }, ctx())).result,
    512,
    'exponent is right-associative',
  );
  assert.equal(data(calculator.run({ expression: '-(3 + 4) * 2' }, ctx())).result, -14);
  assert.equal(data(calculator.run({ expression: '7 % 3' }, ctx())).result, 1);
  assert.equal(
    data(calculator.run({ expression: '0.1 + 0.2' }, ctx())).result,
    0.30000000000000004,
  );
});

test('calculator: failures are named, not thrown', () => {
  const div0 = calculator.run({ expression: '1/0' }, ctx());
  assert.equal(div0.ok, false);
  assert.ok(div0.error.toLowerCase().includes('zero'));
  const syntax = calculator.run({ expression: '2 + * 3' }, ctx());
  assert.equal(syntax.ok, false);
  const empty = calculator.run({ expression: '   ' }, ctx());
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'bad-input');
});

test('calculator: no code execution primitive', () => {
  for (const expression of [
    'process.exit(1)',
    '2; console.log(1)',
    'Math.max(1,2)',
    '`id`',
    '0x10',
  ]) {
    const result = calculator.run({ expression }, ctx());
    assert.equal(result.ok, false, `${expression} must not evaluate`);
  }
});

test('timezone-converter: UTC to Dubai', () => {
  const result = data(
    timezoneConverter.run({ time: '2026-09-30T12:00:00Z', from: 'UTC', to: 'Asia/Dubai' }, ctx()),
  );
  assert.equal(result.to.local, '2026-09-30T16:00:00+04:00');
  assert.equal(result.from.local, '2026-09-30T12:00:00+00:00');
});

test('timezone-converter: wall time interpreted in the source zone', () => {
  const result = data(
    timezoneConverter.run({ time: '2026-09-30T12:00:00', from: 'Asia/Dubai', to: 'UTC' }, ctx()),
  );
  assert.equal(result.to.local, '2026-09-30T08:00:00+00:00');
  assert.equal(result.instant, '2026-09-30T08:00:00.000Z');
});

test('timezone-converter: unknown zone and bad time are named', () => {
  const zone = timezoneConverter.run(
    { time: '2026-09-30T12:00:00Z', from: 'UTC', to: 'Mars/Olympus' },
    ctx(),
  );
  assert.equal(zone.ok, false);
  assert.equal(zone.code, 'unknown-timezone');
  const bad = timezoneConverter.run({ time: 'not a time', from: 'UTC', to: 'UTC' }, ctx());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-time');
});

test('notes-search: finds matches with file and line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-'));
  await writeFile(
    join(dir, 'admissions.md'),
    '# Admissions\n\nThe admission office opens at nine.\nSecond line here.\n',
  );
  await writeFile(join(dir, 'other.md'), 'Nothing relevant.\n');
  const result = data(await notesSearch.run({ query: 'admission' }, ctx({ notesDir: dir })));
  assert.equal(result.filesSearched, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].file, 'admissions.md');
  assert.equal(result.matches[0].line, 1);
  assert.ok(result.matches[0].snippet.toLowerCase().includes('admission'));
});

test('notes-search: no match is an empty list, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-'));
  await writeFile(join(dir, 'a.md'), 'hello world\n');
  const result = data(await notesSearch.run({ query: 'zzz-nope' }, ctx({ notesDir: dir })));
  assert.deepEqual(result.matches, []);
});

test('notes-search: empty query is refused', async () => {
  const result = await notesSearch.run({ query: '  ' }, ctx());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad-input');
});

test('local-file-reader: reads a file inside the allowed dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'sub', 'note.txt'), 'hello file\n');
  const result = data(
    await localFileReader.run({ path: 'sub/note.txt' }, ctx({ allowedDir: dir })),
  );
  assert.equal(result.content, 'hello file\n');
  assert.equal(result.size, 11);
});

test('local-file-reader: escapes are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-'));
  await writeFile(join(dir, 'inside.txt'), 'inside\n');
  for (const path of ['../outside.txt', '../../etc/passwd', '/etc/passwd', '..']) {
    const result = await localFileReader.run({ path }, ctx({ allowedDir: dir }));
    assert.equal(result.ok, false, `${path} must be refused`);
    assert.ok(['path-rejected', 'not-found'].includes(result.code), result.code);
  }
});

test('local-file-reader: symlink escapes are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-'));
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  await writeFile(join(outside, 'secret.txt'), 'secret\n');
  await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
  const result = await localFileReader.run({ path: 'link.txt' }, ctx({ allowedDir: dir }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path-rejected');
});

test('local-file-reader: missing file is named', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'files-'));
  const result = await localFileReader.run({ path: 'nope.txt' }, ctx({ allowedDir: dir }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

test('each connector declares the permissions its manifest requests', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of registryKeys()) {
    const manifest = JSON.parse(
      await readFile(new URL(`../connectors/${name}/manifest.json`, import.meta.url), 'utf8'),
    );
    const connector = connectorFor(name);
    assert.deepEqual(
      [...connector.requiredPermissions].sort(),
      [...manifest.permissions].sort(),
      `${name}: implementation requirements match the manifest claim`,
    );
  }
});
