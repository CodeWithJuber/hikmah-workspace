// Policy-gated, Jev-assisted memory auto-triage.
// Run: node --test tests/memory-triage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createMemoryStore } from '../lib/memory/store.ts';
import {
  getPolicy,
  setPolicy,
  triageCandidate,
  listDecisions,
  retryDeferred,
  undoDecision,
} from '../lib/memory/triage.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  return db;
}

let n = 0;
const cand = (over = {}) => ({
  id: `cand_${++n}`,
  kind: 'reference',
  title: over.title ?? 'Something to remember',
  content: over.content ?? 'A durable fact worth remembering.',
  provenance: 'inference',
  status: 'suggested',
  ...over,
});

const ctx = (over = {}) => ({ incognito: false, userId: 'u1', ...over });

/** A Jev that answers the two questions. */
const jev = (durable, verdict, probability = 0.9) => ({
  apiKey: 'test-key',
  fetcher: async () =>
    new Response(
      JSON.stringify({
        answers: [
          { id: 'durable', value: durable, probability },
          { id: 'verdict', value: verdict, probability },
        ],
      }),
      { status: 200 },
    ),
});
const jevDown = () => ({
  apiKey: 'test-key',
  fetcher: async () => {
    throw new Error('unreachable');
  },
});
const jevMalformed = () => ({
  apiKey: 'test-key',
  fetcher: async () =>
    new Response(JSON.stringify({ answers: [{ id: 'nope', value: 1 }] }), { status: 200 }),
});

const memories = (db) => createMemoryStore(db);
const auditRules = (db) => listDecisions(db).map((d) => d.rule);

test('policy: defaults are seeded on first read, and get/set round-trips', (t) => {
  const db = setup(t);
  const first = getPolicy(db);
  assert.equal(first.version, 1);
  assert.deepEqual(first.autoSaveKinds, ['preference']);
  assert.deepEqual(first.secretBlocklist, []);
  assert.equal(first.jev.enabled, true);
  assert.equal(first.jev.durableThreshold, 0.8);
  assert.equal(first.jev.discardThreshold, 0.25);
  assert.equal(first.jev.confidenceFloor, 0.6);
  assert.equal(first.jev.timeoutMs, 3000);
  assert.equal(first.deferRetryHours, 24);
  assert.ok(first.transientPatterns.length > 0);

  const next = {
    ...first,
    autoSaveKinds: ['preference', 'reference'],
    secretBlocklist: ['BEGIN RSA PRIVATE KEY'],
    jev: { ...first.jev, durableThreshold: 0.9, enabled: false },
    updatedBy: 'user',
  };
  setPolicy(db, next);
  const back = getPolicy(db);
  assert.deepEqual(back.autoSaveKinds, ['preference', 'reference']);
  assert.deepEqual(back.secretBlocklist, ['BEGIN RSA PRIVATE KEY']);
  assert.equal(back.jev.durableThreshold, 0.9);
  assert.equal(back.jev.enabled, false);
  assert.equal(back.updatedBy, 'user');
  assert.ok(back.updatedAt.length > 0);
});

test('incognito: zero memory writes, but the audit row is still written', async (t) => {
  const db = setup(t);
  const decision = await triageCandidate(
    db,
    cand({ kind: 'preference', content: 'I like tea.' }),
    ctx({ incognito: true, jevOptions: jev(0.9, 'save') }),
  );
  assert.equal(decision.action, 'discard');
  assert.equal(decision.rule, 'policy:incognito-no-write');
  assert.equal(memories(db).count('u1'), 0, 'no memory row written');
  assert.ok(auditRules(db).includes('policy:incognito-no-write'), 'audit row written');
});

test('credential-shaped content is blocked, never remembered', async (t) => {
  const db = setup(t);
  for (const content of [
    'my key is sk-abcdefghijklmno12345 done',
    'use Bearer abcdefghijklmnop.qr for auth',
  ]) {
    const decision = await triageCandidate(
      db,
      cand({ content }),
      ctx({ jevOptions: jev(0.9, 'save') }),
    );
    assert.equal(decision.action, 'discard');
    assert.equal(decision.rule, 'deterministic:secret-blocked');
  }
  // The policy's own blocklist also blocks.
  setPolicy(db, { ...getPolicy(db), secretBlocklist: ['BEGIN RSA PRIVATE KEY'] });
  const blocked = await triageCandidate(
    db,
    cand({ content: '-----BEGIN RSA PRIVATE KEY----- xyz' }),
    ctx({ jevOptions: jev(0.9, 'save') }),
  );
  assert.equal(blocked.rule, 'deterministic:secret-blocked');
  assert.equal(memories(db).count('u1'), 0, 'no secret ever lands in memories');
  // But ordinary text passes through.
  const clean = await triageCandidate(
    db,
    cand({ content: 'plain text, no secrets' }),
    ctx({ jevOptions: jev(0.9, 'save') }),
  );
  assert.equal(clean.action, 'save');
});

test('transient instructions are discarded', async (t) => {
  const db = setup(t);
  const decision = await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'Remind me to call mom tomorrow.' }),
    ctx({ jevOptions: jev(0.9, 'save') }),
  );
  assert.equal(decision.action, 'discard');
  assert.equal(decision.rule, 'deterministic:transient');
  assert.equal(memories(db).count('u1'), 0);
});

test('a preference is auto-saved without asking Jev', async (t) => {
  const db = setup(t);
  let jevCalled = false;
  const decision = await triageCandidate(
    db,
    cand({ kind: 'preference', content: 'I write with fountain pens.' }),
    ctx({
      jevOptions: {
        apiKey: 'test-key',
        fetcher: async () => {
          jevCalled = true;
          throw new Error('should not be called');
        },
      },
    }),
  );
  assert.equal(decision.action, 'save');
  assert.equal(decision.rule, 'deterministic:auto-save-kind');
  assert.equal(jevCalled, false, 'Jev is never consulted for auto-save kinds');
  const row = memories(db).get('u1', decision.candidateId);
  assert.equal(row.status, 'saved');
  assert.equal(row.kind, 'preference');
});

test('Jev: durable + save verdict + confident -> save', async (t) => {
  const db = setup(t);
  const decision = await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'The user is allergic to peanuts.' }),
    ctx({ jevOptions: jev(0.95, 'save', 0.9) }),
  );
  assert.equal(decision.action, 'save');
  assert.equal(decision.rule, 'jev:save');
  assert.equal(decision.confidence, 0.9);
  assert.ok(decision.jevRaw, 'raw Jev answer is kept');
  assert.equal(memories(db).get('u1', decision.candidateId).status, 'saved');
});

test('Jev: discard verdict -> discard; low durability -> discard even on save verdict', async (t) => {
  const db = setup(t);
  const byVerdict = await triageCandidate(
    db,
    cand({ content: 'Trivia with no lasting value.' }),
    ctx({ jevOptions: jev(0.8, 'discard', 0.9) }),
  );
  assert.equal(byVerdict.action, 'discard');
  assert.equal(byVerdict.rule, 'jev:discard');

  const byDurable = await triageCandidate(
    db,
    cand({ content: 'A fleeting remark.' }),
    ctx({ jevOptions: jev(0.1, 'save', 0.9) }),
  );
  assert.equal(byDurable.action, 'discard');
  assert.equal(byDurable.rule, 'jev:discard');
  assert.equal(memories(db).count('u1'), 0, 'discards write no memory rows');
});

test('Jev: ask verdict or under-confident -> surface as suggested', async (t) => {
  const db = setup(t);
  const asked = await triageCandidate(
    db,
    cand({ content: 'Maybe worth remembering?' }),
    ctx({ jevOptions: jev(0.9, 'ask', 0.9) }),
  );
  assert.equal(asked.action, 'surface');
  assert.equal(asked.rule, 'jev:surface-low-confidence');

  const unsure = await triageCandidate(
    db,
    cand({ content: 'Borderline case.' }),
    ctx({ jevOptions: jev(0.85, 'save', 0.4) }),
  );
  assert.equal(unsure.action, 'surface');
  assert.equal(unsure.rule, 'jev:surface-low-confidence');
  assert.equal(
    memories(db).get('u1', unsure.candidateId).status,
    'suggested',
    'surfaced as a suggestion',
  );
});

test('Jev down -> defer, never auto-save and never silently discard', async (t) => {
  const db = setup(t);
  const down = await triageCandidate(
    db,
    cand({ content: 'Durable but unjudged.' }),
    ctx({ jevOptions: jevDown() }),
  );
  assert.equal(down.action, 'defer');
  assert.equal(down.rule, 'fallback:deferred');
  assert.equal(memories(db).count('u1'), 0, 'defer writes nothing to memories');

  // Keyless is the same as unreachable.
  const keyless = await triageCandidate(
    db,
    cand({ content: 'Also unjudged.' }),
    ctx({ jevOptions: { apiKey: '' } }),
  );
  assert.equal(keyless.rule, 'fallback:deferred');
});

test('a malformed Jev answer is treated as unavailable -> defer', async (t) => {
  const db = setup(t);
  const decision = await triageCandidate(
    db,
    cand({ content: 'Garbled advice.' }),
    ctx({ jevOptions: jevMalformed() }),
  );
  assert.equal(decision.action, 'defer');
  assert.equal(decision.rule, 'fallback:deferred');
  assert.equal(memories(db).count('u1'), 0);
});

test('Jev disabled by policy -> surface, never defer forever', async (t) => {
  const db = setup(t);
  setPolicy(db, { ...getPolicy(db), jev: { ...getPolicy(db).jev, enabled: false } });
  const decision = await triageCandidate(db, cand({ content: 'No Jev to ask.' }), ctx());
  assert.equal(decision.action, 'surface');
  assert.equal(decision.rule, 'policy:jev-disabled-surface');
  assert.equal(memories(db).get('u1', decision.candidateId).status, 'suggested');
});

test('retryDeferred: an old defer re-runs; Jev back up -> decided, still down -> surfaced', async (t) => {
  const db = setup(t);
  const first = await triageCandidate(
    db,
    cand({ content: 'Deferred, then Jev returns.' }),
    ctx({ jevOptions: jevDown() }),
  );
  assert.equal(first.action, 'defer');
  // Backdate past the retry window.
  db.prepare(`UPDATE triage_audit SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(
    first.id,
  );

  const retried = await retryDeferred(db, ctx({ jevOptions: jev(0.95, 'save', 0.9) }));
  assert.equal(retried.length, 1);
  assert.equal(retried[0].action, 'save');
  assert.equal(retried[0].rule, 'jev:save');
  assert.equal(memories(db).get('u1', retried[0].candidateId).status, 'saved');

  // A second retry must not re-triage what already has a newer decision.
  assert.deepEqual(await retryDeferred(db, ctx({ jevOptions: jev(0.95, 'save', 0.9) })), []);
});

test('retryDeferred: Jev still down -> surface, and fresh defers wait their turn', async (t) => {
  const db = setup(t);
  const old = await triageCandidate(
    db,
    cand({ content: 'Old defer.' }),
    ctx({ jevOptions: jevDown() }),
  );
  const fresh = await triageCandidate(
    db,
    cand({ content: 'Fresh defer.' }),
    ctx({ jevOptions: jevDown() }),
  );
  db.prepare(`UPDATE triage_audit SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(
    old.id,
  );

  const retried = await retryDeferred(db, ctx({ jevOptions: jevDown() }));
  assert.equal(retried.length, 1, 'only the old defer is retried');
  assert.equal(retried[0].action, 'surface');
  assert.equal(retried[0].rule, 'fallback:surface-after-retry');
  assert.equal(memories(db).get('u1', retried[0].candidateId).status, 'suggested');
  assert.equal(fresh.action, 'defer', 'the fresh defer is untouched');
});

test('undoDecision flips a saved memory to rejected and audits the undo', async (t) => {
  const db = setup(t);
  const decision = await triageCandidate(
    db,
    cand({ kind: 'preference', content: 'Undo me.' }),
    ctx(),
  );
  assert.equal(decision.action, 'save');

  undoDecision(db, decision.id);
  assert.equal(memories(db).get('u1', decision.candidateId).status, 'rejected');
  assert.ok(auditRules(db).includes('undo:decision-reverted'), 'the undo is on the audit record');

  // Unknown ids are a no-op, not a crash.
  undoDecision(db, 'triage_missing');
});

test('every path writes an audit row', async (t) => {
  const db = setup(t);
  await triageCandidate(db, cand({ content: 'x' }), ctx({ incognito: true }));
  await triageCandidate(db, cand({ content: 'sk-abcdefghijklmno12345' }), ctx());
  await triageCandidate(db, cand({ content: 'Remind me later.' }), ctx());
  await triageCandidate(db, cand({ kind: 'preference', content: 'Tea.' }), ctx());
  await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'Durable fact.' }),
    ctx({ jevOptions: jev(0.95, 'save', 0.9) }),
  );
  await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'Trivia.' }),
    ctx({ jevOptions: jev(0.8, 'discard', 0.9) }),
  );
  await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'Maybe.' }),
    ctx({ jevOptions: jev(0.5, 'ask', 0.5) }),
  );
  await triageCandidate(
    db,
    cand({ kind: 'reference', content: 'Unjudged.' }),
    ctx({ jevOptions: jevDown() }),
  );

  const decisions = listDecisions(db, 50);
  assert.equal(decisions.length, 8, 'one audit row per candidate');
  assert.deepEqual(
    decisions.map((d) => d.action).sort(),
    ['defer', 'discard', 'discard', 'discard', 'discard', 'save', 'save', 'surface'].sort(),
  );
  for (const d of decisions) {
    assert.ok(d.id.startsWith('triage_'));
    assert.ok(d.candidateId.startsWith('cand_'));
    assert.ok(d.createdAt.length > 0);
  }
});

test("retryDeferred: never re-persists another user's deferred candidate", async (t) => {
  const db = setup(t);
  const deferred = await triageCandidate(
    db,
    cand({ content: 'u1 deferred fact.' }),
    ctx({ userId: 'u1', jevOptions: jevDown() }),
  );
  assert.equal(deferred.action, 'defer');
  db.prepare(`UPDATE triage_audit SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(
    deferred.id,
  );

  // A retry issued for a DIFFERENT user must not touch u1's defer.
  const retried = await retryDeferred(
    db,
    ctx({ userId: 'u2', jevOptions: jev(0.95, 'save', 0.9) }),
  );
  assert.deepEqual(retried, [], 'cross-user defer is skipped');
  assert.equal(memories(db).count('u1'), 0, 'nothing persisted for u1');
  assert.equal(memories(db).count('u2'), 0, 'nothing persisted for u2');

  // The rightful owner's retry still works.
  const own = await retryDeferred(db, ctx({ userId: 'u1', jevOptions: jev(0.95, 'save', 0.9) }));
  assert.equal(own.length, 1);
  assert.equal(own[0].action, 'save');
  assert.equal(memories(db).get('u1', own[0].candidateId).status, 'saved');
});
