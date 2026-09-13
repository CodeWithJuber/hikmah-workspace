// A place a run can write a memory to.
//
// Personal knowledge lived only in the workspace blob, which no server may
// write. This is the table that replaces it, and the rules that keep it honest:
// the same text is one row, the person's own ids survive the import, and the
// import happens once.
// Run: node --test tests/memory-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createMemoryStore, toKnowledgeItem } from '../lib/memory/store.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  let tick = 0;
  return createMemoryStore(db, () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString());
}

const pref = (content, over = {}) => ({
  kind: 'preference',
  title: content,
  content,
  provenance: 'quote',
  status: 'saved',
  ...over,
});

test('the same memory saved twice is one row with a rising count', (t) => {
  const store = setup(t);
  const first = store.add('u1', pref('Answer in Urdu.'));
  assert.ok(first?.created);
  // Spacing, case and vowel marks do not make a second memory.
  const again = store.add('u1', pref('  answer   in URDU. '));
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  assert.equal(store.get('u1', first.id).uses, 1, 'counted, not copied');
  assert.equal(store.count('u1'), 1);
});

test('memories are the person’s own: another account sees nothing', (t) => {
  const store = setup(t);
  const { id } = store.add('u1', pref('Answer in Urdu.'));
  assert.equal(store.get('u2', id), null);
  assert.deepEqual(store.list('u2'), []);
  assert.equal(store.update('u2', id, { status: 'rejected' }), null);
  assert.equal(store.remove('u2', id), false);
  assert.equal(store.get('u1', id).status, 'saved', 'and could not change it');
});

test('accepting a suggestion is an update; the retrieval shape follows the row', (t) => {
  const store = setup(t);
  const { id } = store.add('u1', {
    kind: 'reference',
    title: 'Zakat rate',
    content: 'Zakat on savings is 2.5%.',
    provenance: 'source',
    source: 'https://example.test/zakat',
    status: 'suggested',
  });
  assert.equal(toKnowledgeItem(store.get('u1', id)).status, 'suggested', 'not retrieved yet');
  const accepted = store.update('u1', id, { status: 'saved' });
  assert.equal(accepted.status, 'saved');
  const item = toKnowledgeItem(accepted);
  assert.equal(item.status, 'saved');
  assert.equal(item.provenance, 'source');
  assert.equal(item.source, 'https://example.test/zakat');
});

test('what an answer used is counted and dated', (t) => {
  const store = setup(t);
  const a = store.add('u1', pref('Answer in Urdu.')).id;
  const b = store.add('u1', pref('Keep it short.')).id;
  store.markUsed('u1', [a]);
  store.markUsed('u1', [a]);
  store.markUsed('u1', [b]);
  assert.equal(store.get('u1', a).uses, 2);
  assert.equal(store.get('u1', b).uses, 1);
  assert.deepEqual(
    store.recentlyUsed('u1').map((m) => m.id),
    [b, a],
    'most recently used first',
  );
});

test('the import keeps the person’s ids, happens once, and an empty blob is done too', (t) => {
  const store = setup(t);
  const items = [
    {
      id: 'k-old-1',
      title: 'House style',
      content: 'Cite the edition.',
      kind: 'reference',
      source: 'Added by you',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      enabled: true,
      status: 'saved',
    },
    {
      id: 'k-old-2',
      title: 'Language',
      content: 'Answer in Hindi.',
      kind: 'preference',
      source: 'Added by you',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      enabled: false,
      status: 'saved',
    },
  ];
  assert.equal(store.imported('u1'), false);
  assert.equal(store.importItems('u1', items), 2);
  assert.equal(store.imported('u1'), true);
  const one = store.get('u1', 'k-old-1');
  assert.equal(one.provenance, 'quote', 'they typed it');
  assert.equal(one.createdAt, '2026-01-01T00:00:00Z', 'dates travel');
  assert.equal(store.get('u1', 'k-old-2').enabled, false, 'and so does a switched-off one');
  assert.equal(store.importItems('u1', items), 0, 'a second import adds nothing');
  assert.equal(store.importItems('u2', []), 0);
  assert.equal(store.imported('u2'), true, 'nothing to import is also finished');
});

test('the per-person cap and the content cap hold', (t) => {
  const store = setup(t);
  assert.equal(store.add('u1', pref('')), null, 'nothing to remember');
  const { id } = store.add('u1', pref('x'.repeat(20_000)));
  assert.equal(store.get('u1', id).content.length, 12_000);
});
