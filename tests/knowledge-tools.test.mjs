import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseKnowledge, retrieveKnowledge, knowledgePrompt } from '../lib/playground/knowledge.ts';
const note = (id, content, extra = {}) => ({
  id,
  title: id,
  content,
  kind: 'reference',
  source: 'User reviewed',
  createdAt: '2026-09-10',
  updatedAt: '2026-09-10',
  enabled: true,
  ...extra,
});
test('knowledge retrieval preserves exact negation, amounts and sources; excludes unrelated/disabled/suggested records', () => {
  const items = parseKnowledge([
    note('budget', 'Mumbai project budget is NOT 5000; it is 7500.'),
    note('other', 'Garden tomatoes'),
    note('disabled', 'Mumbai project', { enabled: false }),
    note('suggestion', 'Mumbai project', { status: 'suggested' }),
  ]);
  const selected = retrieveKnowledge(items, 'Mumbai project');
  assert.deepEqual(
    selected.map((x) => x.id),
    ['budget'],
  );
  assert.ok(knowledgePrompt(selected).includes('NOT 5000; it is 7500.'));
  assert.ok(knowledgePrompt(selected).includes('User reviewed'));
});
test('approve/edit/forget immediately changes retrieval; scope is server-owned', () => {
  let items = parseKnowledge([
    note('a', 'Use simple Hindi', { kind: 'preference', status: 'suggested', owner: 'someone' }),
  ]);
  assert.deepEqual(retrieveKnowledge(items, 'anything'), []);
  items = parseKnowledge([{ ...items[0], status: 'saved' }]);
  assert.equal(retrieveKnowledge(items, 'anything')[0].content, 'Use simple Hindi');
  items = parseKnowledge([{ ...items[0], content: 'Use English' }]);
  assert.equal(retrieveKnowledge(items, 'anything')[0].content, 'Use English');
  assert.deepEqual(retrieveKnowledge([], 'anything'), []);
  assert.equal(items[0].owner, undefined);
});
test('retrieval enforces a bounded prompt and never truncates a record', () => {
  const selected = retrieveKnowledge(
    [note('large', 'relevant '.repeat(1000)), note('small', 'relevant facts')],
    'relevant',
    300,
  );
  assert.deepEqual(
    selected.map((x) => x.id),
    ['small'],
  );
  assert.throws(() => parseKnowledge([note('same', 'one'), note('same', 'two')]));
});
const dir = await mkdtemp(join(tmpdir(), 'hikmah-tools-'));
await build({
  entryPoints: ['lib/playground/tool-registry.ts'],
  outfile: join(dir, 'tools.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { resolveRunTools } = await import(pathToFileURL(join(dir, 'tools.mjs')));
const preferences = { enabledTools: ['calculate', 'read_file', 'write_file'], allowEdits: false };
const connectors = [
  { id: 'a', enabled: true },
  { id: 'b', enabled: false },
];
const catalogs = { a: [{ name: 'search' }], b: [{ name: 'ssh' }] };
test('all chat presets use mode-independent tools; permissions and catalog availability gate execution', () => {
  const input = { preferences, connectors, catalogs };
  const names = resolveRunTools(input).map((x) => x.function.name);
  assert.ok(names.includes('calculate'));
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('suggest_memory'));
  assert.ok(names.includes('connector_call'));
  assert.ok(!names.includes('write_file'));
  for (const mode of ['chat', 'coding', 'agent', 'compare'])
    assert.deepEqual(
      resolveRunTools({ ...input, mode }).map((x) => x.function.name),
      names,
    );
  assert.equal(resolveRunTools({ ...input, modelTools: false }), undefined);
  assert.ok(
    !resolveRunTools({ ...input, catalogs: {} }).some((x) => x.function.name === 'connector_call'),
  );
});
test.after(() => rm(dir, { recursive: true, force: true }));
