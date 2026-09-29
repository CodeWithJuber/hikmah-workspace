// The rule that makes a memory trustworthy: what is saved is what the person
// wrote, not what the model made of it.
// Run: node --test tests/remember-tool.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createMemoryStore } from '../lib/memory/store.ts';
import { rememberTools, quoteIsVerbatim } from '../lib/ai/tools/memory.ts';

function setup(t, over = {}) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  const store = createMemoryStore(db);
  const context = {
    userId: 'u1',
    store,
    db,
    latestUserText: 'Mujhe jawab hamesha simple Urdu mein chahiye. Mera beta Ahmed hai.',
    hasAttachments: false,
    conversationId: 'conv_1',
    conversationTitle: 'Pehli baat',
    autoSaveQuotes: true,
    ...over,
  };
  return { db, store, remember: rememberTools(context).remember, context };
}

test('a quote that is not in the latest user message is refused', async (t) => {
  const { remember, store } = setup(t);
  const out = await remember.execute({
    title: 'Language',
    quote: 'The person prefers simple Urdu.',
    kind: 'preference',
  });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /exact words/);
  assert.equal(store.count('u1'), 0, 'nothing written');
});

test('a preference in their own words is saved, and the answer is told so', async (t) => {
  const { remember, store } = setup(t);
  const out = await remember.execute({
    title: 'Language',
    quote: 'Mujhe jawab hamesha simple Urdu mein chahiye.',
    kind: 'preference',
  });
  assert.equal(out.status, 'saved');
  assert.equal(out.location, 'Memory');
  const [row] = store.list('u1');
  assert.equal(row.status, 'saved');
  assert.equal(row.provenance, 'quote');
  assert.equal(row.source, 'You · Pehli baat');
  assert.equal(row.sourceConversationId, 'conv_1');
});

test('a reference is suggested, never saved outright', async (t) => {
  const { remember, store } = setup(t);
  const out = await remember.execute({
    title: 'Son',
    quote: 'Mera beta Ahmed hai.',
    kind: 'reference',
  });
  assert.equal(out.status, 'suggested');
  assert.equal(store.list('u1')[0].status, 'suggested');
});

test('spacing and code-point form do not make an honest quote a refusal', async (t) => {
  const { remember } = setup(t, { latestUserText: 'الصَّبْرُ  جَمِيلٌ\nyeh meri pasand hai' });
  // The model re-emits with single spaces and a decomposed form.
  const out = await remember.execute({
    title: 'Sabr',
    quote: 'الصَّبْرُ جَمِيلٌ yeh meri pasand hai'.normalize('NFD'),
    kind: 'preference',
  });
  assert.equal(out.status, 'saved');
  assert.equal(quoteIsVerbatim('a  b', 'x a b y'), true);
  assert.equal(quoteIsVerbatim('', 'anything'), false);
});

test('a turn with an attachment, a long quote, or a long message waits for review', async (t) => {
  const withFile = setup(t, { hasAttachments: true });
  assert.equal(
    (
      await withFile.remember.execute({
        title: 'L',
        quote: 'Mujhe jawab hamesha simple Urdu mein chahiye.',
        kind: 'preference',
      })
    ).status,
    'suggested',
  );
  const longMessage = 'Mujhe jawab hamesha simple Urdu mein chahiye. ' + 'x'.repeat(2100);
  const long = setup(t, { latestUserText: longMessage });
  assert.equal(
    (
      await long.remember.execute({
        title: 'L',
        quote: 'Mujhe jawab hamesha simple Urdu mein chahiye.',
        kind: 'preference',
      })
    ).status,
    'suggested',
  );
  const off = setup(t, { autoSaveQuotes: false });
  assert.equal(
    (
      await off.remember.execute({
        title: 'L',
        quote: 'Mujhe jawab hamesha simple Urdu mein chahiye.',
        kind: 'preference',
      })
    ).status,
    'suggested',
  );
});

test('the same words remembered twice are one memory', async (t) => {
  const { remember, store } = setup(t);
  const input = {
    title: 'Language',
    quote: 'Mujhe jawab hamesha simple Urdu mein chahiye.',
    kind: 'preference',
  };
  await remember.execute(input);
  await remember.execute(input);
  assert.equal(store.count('u1'), 1);
  assert.equal(store.list('u1')[0].uses, 1, 'counted, not copied');
});

test('a background task routes every remember through triage, never the store directly', async (t) => {
  // Unattended, there is no person's message to quote from — the brief is all
  // there is. The verbatim rule still holds for that brief; anything else the
  // task wants to keep is handed to triage as its own inference. The tool
  // itself never writes: 'save' and 'surface' are triage's own writes.
  const calls = [];
  const { remember, store } = setup(t, {
    latestUserText: 'Learn what the Hanafi school says about combining prayers when travelling.',
    unattended: true,
    autoSaveQuotes: false,
    conversationTitle: 'Learn: combining prayers',
    triage: async (db, candidate, ctx) => {
      calls.push({ candidate, ctx });
      // The double stands in for the real policy: surface everything.
      store.add('u1', { ...candidate, status: 'suggested' });
      return {
        id: 'triage_1',
        candidateId: candidate.id,
        action: 'surface',
        rule: 'test-double',
        confidence: null,
        jevRaw: null,
        createdAt: new Date().toISOString(),
      };
    },
  });
  const out = await remember.execute({
    title: 'Combining prayers (Hanafi)',
    quote:
      'The Hanafi position is that prayers are not combined in time while travelling, only in appearance.',
    kind: 'reference',
  });
  assert.equal(out.status, 'suggested');
  assert.equal(calls.length, 1, 'triage was called exactly once');
  assert.equal(calls[0].ctx.userId, 'u1', 'triage gets the run’s user');
  assert.equal(calls[0].ctx.incognito, false);
  const [row] = store.list('u1', { status: 'suggested' });
  assert.equal(row.provenance, 'inference', 'not the person’s words, and not claimed to be');
  assert.equal(row.source, 'Hikmah · Learn: combining prayers');
  assert.equal(row.sourceConversationId, 'conv_1', 'so the task can count what it left to review');

  // The brief itself is still the person's words.
  const quoted = await remember.execute({
    title: 'Topic',
    quote: 'combining prayers when travelling',
    kind: 'reference',
  });
  assert.equal(quoted.status, 'suggested');
  assert.equal(calls.length, 2, 'every learner write goes through triage');
  assert.equal(
    calls[1].candidate.provenance,
    'quote',
    'the brief’s own words stay the person’s even inside triage',
  );
});

test('without an injected double the learner still goes through the real triage', async (t) => {
  // The context default is the real pipeline, not a direct write: with no
  // Jev reachable a reference defers — nothing lands in the memories table.
  const savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
  });
  const { db, remember, store } = setup(t, {
    latestUserText: 'Learn something.',
    unattended: true,
    conversationTitle: 'Learn: x',
  });
  const out = await remember.execute({ title: 'x', quote: 'Learn something.', kind: 'reference' });
  assert.equal(out.status, 'deferred');
  assert.equal(store.count('u1'), 0, 'defer writes nothing to the memories table');
  const audit = db
    .prepare(`SELECT action, rule FROM triage_audit ORDER BY created_at DESC LIMIT 1`)
    .get();
  assert.equal(audit.action, 'defer');
  assert.equal(audit.rule, 'fallback:deferred');
});

test('in a chat, a paraphrase is still refused', async (t) => {
  const { remember } = setup(t, { unattended: false });
  const out = await remember.execute({ title: 'x', quote: 'not their words', kind: 'reference' });
  assert.equal(out.status, 'refused');
});
