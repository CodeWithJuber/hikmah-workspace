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
    latestUserText: 'Mujhe jawab hamesha simple Urdu mein chahiye. Mera beta Ahmed hai.',
    hasAttachments: false,
    conversationId: 'conv_1',
    conversationTitle: 'Pehli baat',
    autoSaveQuotes: true,
    ...over,
  };
  return { store, remember: rememberTools(context).remember, context };
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
