// The learner behind triage: every learner `remember` goes through the
// policy-gated pipeline, incognito writes nothing at all, surfaced items are
// chips rather than approval cards, and the deferred retry hook re-runs
// retryDeferred. Run: node --test tests/learner-triage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { createMemoryStore } from '../lib/memory/store.ts';
import { rememberTools } from '../lib/ai/tools/memory.ts';
import { triageCandidate, setPolicy, getPolicy } from '../lib/memory/triage.ts';
import { retryDeferredMemories } from '../lib/memory/triage-retry.ts';

function setup(t, over = {}) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  const store = createMemoryStore(db);
  const context = {
    userId: 'u1',
    store,
    db,
    latestUserText: 'Learn how sourdough starters behave in warm kitchens.',
    hasAttachments: false,
    conversationId: 'conv_1',
    conversationTitle: 'Learn: sourdough',
    autoSaveQuotes: false,
    unattended: true,
    ...over,
  };
  return { db, store, remember: rememberTools(context).remember, context };
}

/** Jev must stay unreachable for deterministic defer/surface assertions. */
function noJev(t) {
  const savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
  });
}

const auditRows = (db) => {
  try {
    return db.prepare(`SELECT action, rule, candidate_id FROM triage_audit`).all();
  } catch {
    return [];
  }
};

test('a learner preference is triaged to save, deterministically, with no Jev call', async (t) => {
  noJev(t);
  const { db, remember, store } = setup(t, { triage: triageCandidate });
  const out = await remember.execute({
    title: 'Warm kitchen',
    quote: 'Keep the starter somewhere warm.',
    kind: 'preference',
  });
  assert.equal(out.status, 'saved');
  const [row] = store.list('u1');
  assert.equal(row.status, 'saved', 'triage persisted the save itself');
  assert.equal(row.provenance, 'inference');
  const [audit] = auditRows(db);
  assert.equal(audit.action, 'save');
  assert.equal(audit.rule, 'deterministic:auto-save-kind');
});

test('triage is called with the run’s user and consent state', async (t) => {
  const seen = [];
  const { remember } = setup(t, {
    triage: async (handle, candidate, ctx) => {
      seen.push({ handle, candidate, ctx });
      return {
        id: 'triage_1',
        candidateId: candidate.id,
        action: 'discard',
        rule: 'test-double',
        confidence: null,
        jevRaw: null,
        createdAt: new Date().toISOString(),
      };
    },
  });
  const out = await remember.execute({
    title: 'Warm kitchen',
    quote: 'Keep the starter somewhere warm.',
    kind: 'reference',
  });
  assert.equal(out.status, 'refused');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ctx.userId, 'u1', 'Agent A’s contract: ctx carries userId');
  assert.equal(seen[0].ctx.incognito, false);
  assert.ok(seen[0].candidate.id.startsWith('mem_'));
});

test('incognito: zero writes — no candidate, no memory, no triage audit row', async (t) => {
  let triageCalls = 0;
  const { db, remember, store } = setup(t, {
    incognito: true,
    triage: async () => {
      triageCalls += 1;
      throw new Error('triage must not be called under incognito');
    },
  });
  const out = await remember.execute({
    title: 'Warm kitchen',
    quote: 'Keep the starter somewhere warm.',
    kind: 'preference',
  });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /incognito/);
  assert.equal(triageCalls, 0, 'the triage pipeline is never entered');
  assert.equal(store.count('u1'), 0, 'no memory row');
  assert.equal(auditRows(db).length, 0, 'not even an audit row');
});

test('a secret-shaped learner candidate is discarded, never stored', async (t) => {
  noJev(t);
  const { db, remember, store } = setup(t, { triage: triageCandidate });
  const out = await remember.execute({
    title: 'Deploy key',
    quote: 'The deploy key is sk-abcdefghijklmnopqrstuvwx for the nightly job.',
    kind: 'reference',
  });
  assert.equal(out.status, 'refused');
  assert.equal(store.count('u1'), 0);
  const [audit] = auditRows(db);
  assert.equal(audit.action, 'discard');
  assert.equal(audit.rule, 'deterministic:secret-blocked');
});

test('with Jev unreachable a reference defers: held, not stored, not lost', async (t) => {
  noJev(t);
  const { db, remember, store } = setup(t, { triage: triageCandidate });
  const out = await remember.execute({
    title: 'Starter hydration',
    quote: 'A wetter starter ferments faster in a warm kitchen.',
    kind: 'reference',
  });
  assert.equal(out.status, 'deferred');
  assert.equal(store.count('u1'), 0, 'defer writes nothing to the memories table');
  const [audit] = auditRows(db);
  assert.equal(audit.action, 'defer');
  assert.equal(audit.rule, 'fallback:deferred');
});

test('the deferred retry hook re-runs retryDeferred and surfaces what Jev still cannot judge', async (t) => {
  noJev(t);
  const { db, store } = setup(t, { triage: triageCandidate });
  // Seed one deferred item through the real pipeline.
  const decision = await triageCandidate(
    db,
    {
      id: 'mem_deferred1',
      kind: 'reference',
      title: 'Starter hydration',
      content: 'A wetter starter ferments faster in a warm kitchen.',
      provenance: 'inference',
      source: 'Hikmah · Learn: sourdough',
      sourceConversationId: 'conv_1',
      status: 'suggested',
    },
    { incognito: false, userId: 'u1' },
  );
  assert.equal(decision.action, 'defer');
  // Age it past the retry horizon (default 24h).
  db.prepare(`UPDATE triage_audit SET created_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 25 * 3_600_000).toISOString(),
    decision.id,
  );
  const result = await retryDeferredMemories({ userId: 'u1', handle: db });
  assert.equal(result.retried, 1);
  assert.equal(result.surfaced, 1, 'a second defer surfaces instead of deferring forever');
  assert.equal(result.saved, 0);
  const [row] = store.list('u1', { status: 'suggested' });
  assert.equal(row.title, 'Starter hydration');
  const rules = auditRows(db).map((r) => r.rule);
  assert.ok(rules.includes('fallback:surface-after-retry'));
});

test('the deferred retry hook writes nothing under incognito', async (t) => {
  const { db, store } = setup(t);
  const result = await retryDeferredMemories({ userId: 'u1', incognito: true, handle: db });
  assert.deepEqual(result, { retried: 0, surfaced: 0, saved: 0 });
  assert.equal(store.count('u1'), 0);
  assert.equal(auditRows(db).length, 0);
});

test('a due deferred item is saved on retry when the policy auto-saves its kind', async (t) => {
  noJev(t);
  const { db, store } = setup(t);
  const decision = await triageCandidate(
    db,
    {
      id: 'mem_deferred2',
      kind: 'reference',
      title: 'Feeding ratio',
      content: 'Feed the starter a 1:2:2 ratio before baking day.',
      provenance: 'inference',
      source: 'Hikmah · Learn: sourdough',
      sourceConversationId: 'conv_1',
      status: 'suggested',
    },
    { incognito: false, userId: 'u1' },
  );
  assert.equal(decision.action, 'defer');
  // Jev comes back with a confident save verdict via the policy path: flip
  // the stored kind to a preference-like durable fact by re-seeding through
  // a preference candidate instead — the retry re-runs the same pipeline.
  db.prepare(`UPDATE triage_audit SET created_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 25 * 3_600_000).toISOString(),
    decision.id,
  );
  const policy = getPolicy(db);
  setPolicy(db, { ...policy, autoSaveKinds: ['preference', 'reference'] });
  const result = await retryDeferredMemories({ userId: 'u1', handle: db });
  assert.equal(result.retried, 1);
  assert.equal(result.saved, 1);
  assert.equal(store.list('u1', { status: 'saved' }).length, 1);
});

test('surfaced items render as non-blocking chips, never an approval card', () => {
  const source = readFileSync(
    new URL('../components/chat/memory-panel.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('ApprovalCard'), 'no approval-card import in the memory flow');
  assert.ok(
    !source.includes('To review'),
    'the old approval queue heading is gone from the memory flow',
  );
  assert.ok(source.includes('memory-chip-row'), 'surfaced items render as inline chips');
  assert.ok(source.includes('Keep all'), 'batch keep is offered');
  assert.ok(source.includes('Dismiss all'), 'batch dismiss is offered');
  assert.ok(
    source.includes('Nothing here needs your approval'),
    'the copy says no approval is needed',
  );
});
