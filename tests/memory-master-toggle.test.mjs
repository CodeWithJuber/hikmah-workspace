import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-memory-master-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'master-toggle.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { planMemoryMasterToggle } from './lib/memory/master-toggle';
      export { planMemoryMasterToggle };
    `,
    resolveDir: root,
    sourcefile: 'master-toggle-test.ts',
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { planMemoryMasterToggle } = createRequire(import.meta.url)(output);

const memory = (overrides) => ({
  id: 'm',
  title: 't',
  content: 'c',
  kind: 'reference',
  status: 'saved',
  enabled: true,
  provenance: 'quote',
  source: null,
  uses: 0,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('with any saved memory on, the switch plans a bulk disable', () => {
  const plan = planMemoryMasterToggle([
    memory({ id: 'a', enabled: true }),
    memory({ id: 'b', enabled: false }),
    memory({ id: 'c', status: 'suggested', enabled: true }),
  ]);
  assert.equal(plan.enable, false);
  // Only the enabled saved memory needs a write; the suggestion is untouched.
  assert.deepEqual(plan.ids, ['a']);
});

test('with every saved memory off, the switch plans a bulk enable', () => {
  const plan = planMemoryMasterToggle([
    memory({ id: 'a', enabled: false }),
    memory({ id: 'b', enabled: false }),
  ]);
  assert.equal(plan.enable, true);
  assert.deepEqual(plan.ids.sort(), ['a', 'b']);
});

test('already-correct memories are left alone, and empty means nothing to do', () => {
  const allOff = planMemoryMasterToggle([memory({ id: 'a', enabled: false })]);
  assert.equal(allOff.enable, true);
  assert.deepEqual(allOff.ids, ['a']);
  const none = planMemoryMasterToggle([]);
  assert.deepEqual(none.ids, []);
});

test('suggestions never count toward the switch state', () => {
  const plan = planMemoryMasterToggle([memory({ id: 's', status: 'suggested', enabled: true })]);
  assert.equal(plan.enable, true);
  assert.deepEqual(plan.ids, []);
});
