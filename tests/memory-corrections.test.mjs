// Corrections stick, stale context expires, memory is scoped.
// The learning-memory ticket at the store boundary: a correction is a new row
// linked to the old one (never an edit in place), recall drops whatever a
// live row corrects, expiry gates recall, scopes do not leak, and a delete
// mid-recall is simply gone from the next recall.
// Run: node --test tests/memory-corrections.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createMemoryStore, isExpired, normalizeScope } from '../lib/memory/store.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  let tick = 0;
  const base = Date.parse('2026-09-30T00:00:00Z');
  const clock = () => new Date(base + tick++ * 1000).toISOString();
  return {
    db,
    store: createMemoryStore(db, clock),
    now: () => new Date(base + 3_600_000).toISOString(),
  };
}

const ref = (content, over = {}) => ({
  kind: 'reference',
  title: content.slice(0, 40),
  content,
  provenance: 'quote',
  status: 'saved',
  ...over,
});

test('a correction supersedes: the old fact leaves recall, the new one stays', (t) => {
  const { store, now } = setup(t);
  const oldId = store.add('u1', ref('The deadline is Thursday.')).id;
  const fixed = store.addCorrection('u1', oldId, ref('The deadline is Friday.'));
  assert.ok(fixed && fixed.id !== oldId, 'a new row, not an edit');
  assert.deepEqual(fixed.conflicts, [], 'one correction is not a conflict');
  const recalled = store.forRecall('u1', { now: now() }).map((m) => m.id);
  assert.ok(recalled.includes(fixed.id), 'the correction is recalled');
  assert.ok(!recalled.includes(oldId), 'the outdated fact is not');
  // History survives: the old row is still the person's to see.
  assert.equal(store.get('u1', oldId).content, 'The deadline is Thursday.');
  assert.deepEqual(
    store
      .list('u1')
      .map((m) => m.id)
      .sort(),
    [fixed.id, oldId].sort(),
    'list keeps the full history',
  );
});

test('a correction of a correction extends the chain; only the head is recalled', (t) => {
  const { store, now } = setup(t);
  const a = store.add('u1', ref('The deadline is Thursday.')).id;
  const b = store.addCorrection('u1', a, ref('The deadline is Friday.')).id;
  const c = store.addCorrection('u1', b, ref('The deadline is Monday.')).id;
  const recalled = store.forRecall('u1', { now: now() }).map((m) => m.content);
  assert.deepEqual(recalled, ['The deadline is Monday.']);
  assert.equal(store.get('u1', c).supersedes, b);
});

test('correcting what is not yours, or what is not there, is nothing', (t) => {
  const { store } = setup(t);
  const id = store.add('u1', ref('The deadline is Thursday.')).id;
  assert.equal(store.addCorrection('u1', 'mem_missing', ref('x')), null);
  assert.equal(store.addCorrection('u2', id, ref('The deadline is never.')), null);
  assert.equal(store.get('u1', id).supersedes, null, 'untouched');
});

test('two live corrections of the same memory are a surfaced conflict', (t) => {
  const { store, now } = setup(t);
  const oldId = store.add('u1', ref('The launch is in June.')).id;
  const first = store.addCorrection('u1', oldId, ref('The launch is in July.'));
  const second = store.addCorrection('u1', oldId, ref('The launch is in August.'));
  assert.deepEqual(second.conflicts, [first.id], 'the disagreement is named');
  const conflicts = store.conflicts('u1', now());
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].memory.id, oldId);
  assert.deepEqual(conflicts[0].correctedBy.map((m) => m.id).sort(), [first.id, second.id].sort());
  // Both corrections stay recallable: the conflict is visible, not hidden.
  const recalled = store.forRecall('u1', { now: now() }).map((m) => m.id);
  assert.ok(recalled.includes(first.id) && recalled.includes(second.id));
  assert.ok(!recalled.includes(oldId));
});

test('an expired memory is never recalled, however well it would match', (t) => {
  const { store, now } = setup(t);
  const past = new Date(Date.parse('2026-09-30T00:00:00Z') - 1000).toISOString();
  const future = new Date(Date.parse('2026-09-30T00:00:00Z') + 86_400_000).toISOString();
  const gone = store.add('u1', ref('Offer ends today.', { expiresAt: past })).id;
  const live = store.add('u1', ref('Offer ends tomorrow.', { expiresAt: future })).id;
  assert.ok(isExpired(store.get('u1', gone), now()), 'expired');
  assert.ok(!isExpired(store.get('u1', live), now()), 'not expired');
  const recalled = store.forRecall('u1', { now: now() }).map((m) => m.id);
  assert.ok(!recalled.includes(gone), 'expired is gated out of recall');
  assert.ok(recalled.includes(live));
  // Expiry is editable and clearable through the same update path.
  assert.equal(store.update('u1', gone, { expiresAt: future }).expiresAt, future);
  assert.ok(
    store
      .forRecall('u1', { now: now() })
      .map((m) => m.id)
      .includes(gone),
  );
  assert.equal(store.update('u1', gone, { expiresAt: null }).expiresAt, null);
});

test('a memory learned in one scope never leaks into another; global travels', (t) => {
  const { store, now } = setup(t);
  const aFact = store.add('u1', ref('Project A ships in June.', { scope: 'project:a' })).id;
  const bFact = store.add('u1', ref('Project B ships in July.', { scope: 'project:b' })).id;
  const general = store.add('u1', ref('Answer in Urdu.')).id;
  assert.equal(store.get('u1', aFact).scope, 'project:a');
  const inA = store.forRecall('u1', { scope: 'project:a', now: now() }).map((m) => m.id);
  assert.ok(inA.includes(aFact), 'own scope recalled');
  assert.ok(inA.includes(general), 'global travels everywhere');
  assert.ok(!inA.includes(bFact), 'project B fact does not leak into project A');
  const inB = store.forRecall('u1', { scope: 'project:b', now: now() }).map((m) => m.id);
  assert.ok(inB.includes(bFact) && !inB.includes(aFact));
  const unscoped = store.forRecall('u1', { now: now() }).map((m) => m.id);
  assert.ok(unscoped.includes(general) && !unscoped.includes(aFact), 'default is global only');
});

test('a correction stays in the scope of what it corrects', (t) => {
  const { store } = setup(t);
  const oldId = store.add('u1', ref('Project A ships in June.', { scope: 'project:a' })).id;
  const fixed = store.addCorrection(
    'u1',
    oldId,
    ref('Project A ships in July.', { scope: 'project:b' }),
  );
  assert.equal(store.get('u1', fixed.id).scope, 'project:a', 'scope follows the corrected memory');
});

test('the same text may live once per scope', (t) => {
  const { store } = setup(t);
  const a = store.add('u1', ref('Ships in June.', { scope: 'project:a' }));
  const b = store.add('u1', ref('Ships in June.', { scope: 'project:b' }));
  assert.ok(a.created && b.created && a.id !== b.id, 'per-scope dedup, not global');
  const again = store.add('u1', ref('Ships in June.', { scope: 'project:a' }));
  assert.equal(again.id, a.id, 'same scope still dedups');
  assert.equal(again.created, false);
});

test('a bad scope never reaches the table', (t) => {
  const { store } = setup(t);
  const id = store.add('u1', ref('Hello.', { scope: '../../etc' })).id;
  assert.equal(store.get('u1', id).scope, 'global');
  assert.equal(normalizeScope('project:a'), 'project:a');
  assert.equal(normalizeScope(''), 'global');
});

test('a memory deleted mid-recall is gone from the next recall, silently', (t) => {
  const { store, now } = setup(t);
  const id = store.add('u1', ref('Temporary fact.')).id;
  assert.ok(
    store.forRecall('u1', { now: now() }).some((m) => m.id === id),
    'recalled before',
  );
  assert.equal(store.remove('u1', id), true);
  assert.ok(!store.forRecall('u1', { now: now() }).some((m) => m.id === id), 'gone after');
  assert.equal(store.get('u1', id), null);
  // markUsed on the deleted id updates zero rows and stays silent.
  store.markUsed('u1', [id]);
});

test('deleting the correction restores the corrected fact to recall', (t) => {
  const { store, now } = setup(t);
  const oldId = store.add('u1', ref('The deadline is Thursday.')).id;
  const fixedId = store.addCorrection('u1', oldId, ref('The deadline is Friday.')).id;
  assert.ok(!store.forRecall('u1', { now: now() }).some((m) => m.id === oldId));
  store.remove('u1', fixedId);
  assert.ok(
    store.forRecall('u1', { now: now() }).some((m) => m.id === oldId),
    'the correction is gone, so the fact stands again',
  );
});

test('a store that cannot be read or written answers empty, never throws', (t) => {
  const broken = {
    prepare() {
      throw new Error('no such table');
    },
  };
  const store = createMemoryStore(broken);
  assert.equal(store.addCorrection('u1', 'x', ref('y')), null);
  assert.deepEqual(store.forRecall('u1'), []);
  assert.deepEqual(store.conflicts('u1'), []);
  assert.deepEqual(store.liveCorrectionsOf('u1', 'x'), []);
  assert.deepEqual(store.list('u1', { scope: 'project:a' }), []);
});
