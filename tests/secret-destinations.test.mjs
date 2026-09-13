// Can a person actually save the credential the code goes looking for?
//
// The MCP manager resolves a server config's ${NAME} references against the
// destination `mcp-env`, and the vault accepts that destination — but the
// Secrets screen builds its whole "Use with" menu from SECRET_SERVICES, and
// that list had no entry for it. So nothing could write one, every reference
// resolved to '', and any server needing a credential failed to connect while
// the interface told the owner to "save it in Settings first".
//
// The general rule this asserts: a destination the app resolves must be one the
// Secrets screen can produce. Two lists that disagree is the same defect as an
// unlabelled built-in tool, and is caught the same way — by comparing them.
// Run: node --test tests/secret-destinations.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-secrets-'));
await build({
  entryPoints: ['lib/playground/secret-reference.ts', 'lib/mcp/config.ts'],
  outdir: dir,
  // Both entry points, so esbuild's common base is `lib/` and the outputs keep
  // their subdirectory. Naming them explicitly below rather than guessing.
  outbase: 'lib',
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { SECRET_SERVICES } = await import(
  pathToFileURL(join(dir, 'playground/secret-reference.mjs'))
);
const { MCP_SECRET_DESTINATION } = await import(pathToFileURL(join(dir, 'mcp/config.mjs')));
const { createSecretStore, validateDestination } = await import('../server/workspace-secrets.mjs');
const { openStorage } = await import('../server/storage.mjs');

test.after(() => rm(dir, { recursive: true, force: true }));

test('the destination MCP resolves credentials against is one the Secrets screen offers', () => {
  const offered = SECRET_SERVICES.map((service) => service.value);
  assert.ok(
    offered.includes(MCP_SECRET_DESTINATION),
    `nothing can save a ${MCP_SECRET_DESTINATION} secret; the menu offers ${offered.join(', ')}`,
  );
});

test('every destination the menu offers is one the vault accepts', () => {
  for (const service of SECRET_SERVICES) {
    // 'mcp' is the legacy per-endpoint form: the screen appends the URL to it
    // before saving, so the bare value is deliberately not a destination.
    if (service.value === 'mcp') continue;
    assert.equal(validateDestination(service.value), service.value, service.value);
  }
});

test('every offered destination has a label a person can tell apart from the others', () => {
  const labels = SECRET_SERVICES.map((service) => service.label);
  assert.equal(new Set(labels).size, labels.length, 'two services share a label');
  for (const service of SECRET_SERVICES)
    assert.ok(service.label && service.label.length > 3, service.value + ' has no usable label');
});

test('a saved MCP environment secret comes back to the run that asked for it', async () => {
  process.env.HIKMAH_VAULT_KEY ||= 'a'.repeat(64);
  // Its own database, like tests/workspace-secrets.test.mjs: a suite that
  // writes into .data/ is a suite that behaves differently on the second run.
  const store = createSecretStore(openStorage(await mkdtemp(join(tmpdir(), 'hikmah-vault-'))).DB);
  // The same three arguments the Secrets screen sends and the MCP manager asks
  // for. Before the menu entry existed the first half of this was unreachable.
  await store.save('u1', {
    name: 'GITHUB_TOKEN',
    value: 'ghp_example_value',
    destination: MCP_SECRET_DESTINATION,
  });
  assert.equal(
    await store.resolve('u1', 'GITHUB_TOKEN', MCP_SECRET_DESTINATION, true),
    'ghp_example_value',
  );
  // Bound to the destination: the same name saved for MCP cannot be spent as a
  // provider key.
  await assert.rejects(() => store.resolve('u1', 'GITHUB_TOKEN', 'provider:openrouter', true));
});
