// Per-session incognito: the toggle's own semantics, the request parsing,
// and the server-side gates that make the toggle honest (a client-only flag
// would lie about what the server does with memory and learning).
// Run: node --test tests/memory-incognito.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getIncognito, setIncognito } from '../lib/memory/incognito.ts';
import { parseChatRequest } from '../lib/ai/chat-request.ts';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createLearningStore } from '../lib/learning/store.ts';
import { createMemoryStore } from '../lib/memory/store.ts';
import { rememberTools } from '../lib/ai/tools/memory.ts';
import { triageCandidate } from '../lib/memory/triage.ts';

const valid = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/free',
  instructions: 'You are Hikmah.',
  messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
};

test('incognito is off by default and flips cleanly', () => {
  setIncognito(false);
  assert.equal(getIncognito(), false);
  setIncognito(true);
  assert.equal(getIncognito(), true);
  setIncognito(false);
  assert.equal(getIncognito(), false);
});

test('the request flag is only ever an explicit true', () => {
  assert.equal(parseChatRequest({ ...valid }).incognito, false);
  assert.equal(parseChatRequest({ ...valid, incognito: true }).incognito, true);
  assert.equal(parseChatRequest({ ...valid, incognito: false }).incognito, false);
  // A mistyped value falls back to the persistent settings, never to a
  // silent opt-out.
  assert.equal(parseChatRequest({ ...valid, incognito: 'yes' }).incognito, false);
  assert.equal(parseChatRequest({ ...valid, incognito: 1 }).incognito, false);
});

function setup() {
  const db = applySchema(new DatabaseSync(':memory:'));
  const store = createRunStore(db);
  store.createConversation({ id: 'chat', userId: 'alice' });
  store.createConversation({ id: 'other', userId: 'bob' });
  return { db, store };
}

const storedLearning = (store, runId) => JSON.parse(store.getRun(runId).config).learning;

test('an explicit caller disable narrows the stored learning consent', (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  createLearningStore(db).configure('alice', { enabled: true });
  store.createRun({
    id: 'normal',
    userId: 'alice',
    conversationId: 'chat',
    config: { model: 'm' },
  });
  assert.equal(storedLearning(store, 'normal').enabled, true);
  // The incognito run: the caller opts out of capture.
  store.createRun({
    id: 'incognito',
    userId: 'alice',
    conversationId: 'chat',
    config: { model: 'm', learning: { enabled: false, revision: -1 } },
  });
  assert.equal(storedLearning(store, 'incognito').enabled, false);
});

test('a caller can never widen the stored learning consent', (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  // bob never opted in: the default policy has learning disabled.
  store.createRun({
    id: 'hostile',
    userId: 'bob',
    conversationId: 'other',
    config: { model: 'm', learning: { enabled: true, revision: 99 } },
  });
  assert.equal(storedLearning(store, 'hostile').enabled, false);
});

test('the remember tool refuses under incognito before any pipeline, writing nothing', async (t) => {
  const db = applySchema(new DatabaseSync(':memory:'));
  t.after(() => db.close());
  let triageCalls = 0;
  const remember = rememberTools({
    userId: 'alice',
    store: createMemoryStore(db),
    db,
    latestUserText: 'Remember that I like strong coffee.',
    hasAttachments: false,
    autoSaveQuotes: true,
    unattended: true,
    incognito: true,
    triage: async () => {
      triageCalls += 1;
      throw new Error('triage must not run under incognito');
    },
  }).remember;
  const out = await remember.execute({
    title: 'Coffee',
    quote: 'I like strong coffee.',
    kind: 'preference',
  });
  assert.equal(out.status, 'refused');
  assert.match(out.reason, /incognito/);
  assert.equal(triageCalls, 0, 'no candidate, so no triage pipeline at all');
  assert.equal(createMemoryStore(db).count('alice'), 0, 'no memory row');
  const auditTables = db
    .prepare(`SELECT name FROM sqlite_master WHERE name = 'triage_audit'`)
    .all();
  assert.equal(auditTables.length, 0, 'not even a triage audit table, let alone a row');
});

test('triage itself writes no memory under incognito — audit only, no content', async (t) => {
  const db = applySchema(new DatabaseSync(':memory:'));
  t.after(() => db.close());
  const decision = await triageCandidate(
    db,
    {
      id: 'mem_incog1',
      kind: 'preference',
      title: 'Coffee',
      content: 'I like strong coffee.',
      provenance: 'quote',
      source: 'You',
      sourceConversationId: null,
      status: 'suggested',
    },
    { incognito: true, userId: 'alice' },
  );
  assert.equal(decision.action, 'discard');
  assert.equal(decision.rule, 'policy:incognito-no-write');
  assert.equal(decision.jevRaw, null, 'the audit row carries no content');
  assert.equal(createMemoryStore(db).count('alice'), 0, 'no memory row');
});
