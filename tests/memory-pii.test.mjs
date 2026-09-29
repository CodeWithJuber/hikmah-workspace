// Personal identifiers in memory: detected, never auto-saved, inspectable.
// The triage gate (Jev: surface-review) means an identifier-bearing candidate
// is surfaced for the person — never saved without review — and the audit row
// carries only the kinds found, never the values.
// Run: node --test tests/memory-pii.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { detectPii, containsPii, redactPii, inspectPii } from '../lib/memory/pii.ts';
import { createMemoryStore } from '../lib/memory/store.ts';
import { triageCandidate, listDecisions } from '../lib/memory/triage.ts';

test('detectPii finds emails, phones and id numbers — and only those', () => {
  assert.deepEqual(
    detectPii('write to juber@example.com please').map((h) => h.kind),
    ['email'],
  );
  assert.deepEqual(
    detectPii('call me on +971 50 000 0001').map((h) => h.kind),
    ['phone'],
  );
  assert.deepEqual(
    detectPii('call 5551234 tomorrow').map((h) => h.kind),
    ['phone'],
  );
  assert.deepEqual(
    detectPii('passport no AB1234567').map((h) => h.kind),
    ['id-number'],
  );
  assert.deepEqual(
    detectPii('card 4111111111111111 declined').map((h) => h.kind),
    ['id-number'],
  );
  // Not identifiers: years, small amounts, percentages.
  assert.deepEqual(detectPii('The Mumbai cap is 7500, NOT 5000.'), []);
  assert.deepEqual(detectPii('Zakat is 2.5% of savings; deadline 2026.'), []);
  assert.deepEqual(detectPii('Answer in Urdu.'), []);
  assert.equal(containsPii('mail me at a@b.co'), true);
  assert.equal(containsPii('nothing personal here'), false);
});

test('redactPii replaces values with placeholders, keeps the rest', () => {
  const redacted = redactPii(
    'Email juber@example.com or call +971500000001 about passport AB1234567.',
  );
  assert.ok(!redacted.includes('juber@example.com'), 'no email survives');
  assert.ok(!redacted.includes('971500000001'), 'no phone survives');
  assert.ok(!redacted.includes('AB1234567'), 'no id survives');
  assert.match(redacted, /\[email redacted\]/);
  assert.match(redacted, /\[phone redacted\]/);
  assert.match(redacted, /\[id redacted\]/);
  assert.match(redacted, /Email .* or call .* about passport/, 'prose survives');
  assert.equal(redactPii('nothing personal'), 'nothing personal');
});

test('inspectPii lists kinds without echoing values or content', (t) => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  const store = createMemoryStore(db);
  const withEmail = store.add('u1', {
    kind: 'reference',
    title: 'Contact',
    content: 'Ali can be reached at ali@example.com any time.',
    provenance: 'quote',
    status: 'saved',
  }).id;
  store.add('u1', {
    kind: 'reference',
    title: 'Cap',
    content: 'The Mumbai cap is 7500.',
    provenance: 'quote',
    status: 'saved',
  });
  const findings = inspectPii(store.list('u1'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, withEmail);
  assert.deepEqual(findings[0].kinds, ['email']);
  const serialised = JSON.stringify(findings);
  assert.ok(!serialised.includes('ali@example.com'), 'values never leave');
  assert.ok(!serialised.includes('can be reached'), 'content never leaves');
});

function triageSetup(t) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  return db;
}

const candidate = (over = {}) => ({
  id: 'mem_cand1',
  kind: 'preference',
  title: 'Contact preference',
  content: 'Prefers email.',
  provenance: 'inference',
  source: 'test',
  sourceConversationId: null,
  status: 'suggested',
  ...over,
});

test('an identifier-bearing candidate is surfaced, never auto-saved — even a preference', async (t) => {
  const db = triageSetup(t);
  const store = createMemoryStore(db);
  // kind 'preference' would auto-save on sight without the PII gate.
  const decision = await triageCandidate(
    db,
    candidate({ content: 'Prefers email at juber@example.com for invoices.' }),
    { incognito: false, userId: 'u1' },
  );
  assert.equal(decision.action, 'surface');
  assert.equal(decision.rule, 'deterministic:pii-review');
  const row = store.get('u1', 'mem_cand1');
  assert.ok(row, 'surfaced for review');
  assert.equal(row.status, 'suggested', 'never saved without the person');
  const audit = listDecisions(db, 10)[0];
  assert.deepEqual(audit.jevRaw, { piiKinds: ['email'] }, 'kinds only, no values');
  assert.ok(!JSON.stringify(audit).includes('juber@example.com'), 'audit carries no identifiers');
});

test('the PII gate runs before Jev: a "save" verdict cannot rescue identifiers', async (t) => {
  const db = triageSetup(t);
  const decision = await triageCandidate(
    db,
    candidate({ id: 'mem_cand2', kind: 'reference', content: 'His number is 5551234.' }),
    {
      incognito: false,
      userId: 'u1',
      jevOptions: {
        // A Jev that would save everything, if it were ever asked.
        fetcher: async () => ({
          ok: true,
          json: async () => ({
            answers: [
              { id: 'durable', value: 0.99, probability: 0.99 },
              { id: 'verdict', value: 'save', probability: 0.99 },
            ],
          }),
        }),
      },
    },
  );
  assert.equal(decision.action, 'surface');
  assert.equal(decision.rule, 'deterministic:pii-review');
});

test('a clean candidate is untouched by the PII gate', async (t) => {
  const db = triageSetup(t);
  const decision = await triageCandidate(db, candidate({ id: 'mem_cand3' }), {
    incognito: false,
    userId: 'u1',
  });
  assert.equal(decision.rule, 'deterministic:auto-save-kind');
  assert.equal(decision.action, 'save');
});
