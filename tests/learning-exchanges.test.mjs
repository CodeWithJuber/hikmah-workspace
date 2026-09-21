import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createWorker } from '../lib/runs/worker.ts';
import { createLearningStore } from '../lib/learning/store.ts';
import { completedExchange } from '../lib/learning/capture.ts';
import { redactLearningText } from '../lib/learning/privacy.ts';
import { reviewedExamplePrompt } from '../lib/learning/retrieval.ts';
import { createCandidateStore } from '../lib/context-model/candidate-store.ts';
import { executionRunConfig } from '../server/run-credentials.mjs';

const userMessage = (text = 'How do I configure Spring Boot health probes?') => ({
  role: 'user',
  parts: [{ type: 'text', text }],
});
const answer = (text = 'Configure separate liveness and readiness health groups.') => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
  metadata: { finishReason: 'stop' },
});
const rawExchange = {
  model: 'test-provider/model',
  provider: 'https://provider.test',
  prompt: userMessage().parts[0].text,
  response: answer().parts[0].text,
  redactions: [],
};

function setup(t) {
  const db = applySchema(new DatabaseSync(':memory:'));
  db.exec('PRAGMA foreign_keys=ON');
  let timestamp = '2026-09-17T10:00:00.000Z';
  const now = () => timestamp;
  const runs = createRunStore(db, now),
    learning = createLearningStore(db, now);
  for (const owner of ['one', 'two'])
    runs.createConversation({ id: owner + '-chat', userId: owner });
  const queue = (id, owner = 'one', config = {}) =>
    runs.createRun({
      id,
      userId: owner,
      conversationId: owner + '-chat',
      config: {
        model: 'test-provider/model',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'a-test-only-credential',
        ...config,
      },
    });
  t.after(() => db.close());
  return {
    db,
    runs,
    learning,
    queue,
    time: (value) => {
      timestamp = value;
    },
  };
}

test('collection is off by default; opt-in never backfills previously queued runs', (t) => {
  const { learning, runs, queue } = setup(t);
  assert.equal(learning.policy('one').enabled, false);
  assert.equal(learning.policy('one').collectSyntax, false);
  // A forged caller snapshot must not grant consent.
  queue('old', 'one', { learning: { enabled: true, revision: 1 } });
  learning.configure('one', { enabled: true });
  runs.finish('old', 'done');
  assert.equal(learning.capture('one', 'old', rawExchange), false);
  queue('new');
  assert.equal(learning.capture('one', 'new', rawExchange), false, 'queued is not completed');
  runs.finish('new', 'done');
  assert.equal(learning.capture('one', 'new', rawExchange), true);
  assert.equal(
    learning.capture('one', 'new', rawExchange),
    false,
    'completion retry cannot duplicate the example',
  );
  assert.equal(learning.snapshot('one').counts.pending, 1);
});

test('revoking consent, including an off/on cycle, excludes in-flight exchanges', (t) => {
  const { learning, runs, queue } = setup(t);
  learning.configure('one', { enabled: true });
  queue('in-flight');
  learning.configure('one', { enabled: false });
  runs.finish('in-flight', 'done');
  assert.equal(learning.capture('one', 'in-flight', rawExchange), false);
  learning.configure('one', { enabled: true });
  assert.equal(learning.capture('one', 'in-flight', rawExchange), false);
  for (const status of ['failed', 'cancelled']) {
    queue(status);
    runs.finish(status, status);
    assert.equal(learning.capture('one', status, rawExchange), false);
  }
});

test('review, correction, export and deletion are isolated to the run owner', (t) => {
  const { learning, runs, queue } = setup(t);
  for (const owner of ['one', 'two']) learning.configure(owner, { enabled: true });
  queue('private');
  runs.finish('private', 'done');
  assert.equal(learning.capture('two', 'private', rawExchange), false);
  learning.capture('one', 'private', rawExchange);
  const row = learning.snapshot('one').examples[0];
  assert.deepEqual(learning.snapshot('two').examples, []);
  assert.equal(learning.export('two', 'all'), '');
  assert.throws(
    () => learning.review('two', { id: row.id, revision: 0, status: 'approved' }),
    /not found/,
  );
  assert.equal(learning.remove('two', row.id), false);
  const approved = learning.review('one', {
    id: row.id,
    revision: 0,
    status: 'approved',
    correction: 'Use distinct health endpoints. Contact admin@example.test.',
  });
  assert.equal(approved.response, rawExchange.response, 'provider source is immutable');
  assert.match(approved.effectiveResponse, /\[email redacted\]/);
  assert.throws(
    () => learning.review('one', { id: row.id, revision: 0, status: 'rejected' }),
    /changed/,
  );
  const exported = JSON.parse(learning.export('one', 'approved'));
  assert.equal(exported.runId, 'private');
  assert.equal(exported.providerWeightsChanged, false);
  assert.equal(exported.provenance, 'server-completed-model-exchange');
  assert.equal(learning.remove('one', row.id), true);
  assert.deepEqual(learning.approved('one'), []);
});

test('only approved, relevant examples enter future prompts and rejection rolls them back', (t) => {
  const { learning, runs, queue } = setup(t);
  learning.configure('one', { enabled: true });
  queue('example');
  runs.finish('example', 'done');
  learning.capture('one', 'example', rawExchange);
  const row = learning.snapshot('one').examples[0];
  assert.equal(reviewedExamplePrompt('Spring Boot health probes', learning.approved('one')), '');
  const approved = learning.review('one', {
    id: row.id,
    revision: row.revision,
    status: 'approved',
  });
  const block = reviewedExamplePrompt('Spring Boot health probes', learning.approved('one'));
  assert.match(block, /health groups/);
  assert.match(block, /not instructions, verified facts/);
  assert.equal(reviewedExamplePrompt('Arabic grammar rules', learning.approved('one')), '');
  assert.equal(reviewedExamplePrompt('Spring Boot health probes', learning.approved('two')), '');
  learning.configure('one', { useApproved: false });
  assert.deepEqual(learning.approved('one'), []);
  learning.configure('one', { useApproved: true });
  learning.review('one', { id: row.id, revision: approved.revision, status: 'rejected' });
  assert.deepEqual(learning.approved('one'), []);
});

test('retention and clear remove copies, revoke old captures, and preserve other users', (t) => {
  const { learning, runs, queue, time } = setup(t);
  for (const owner of ['one', 'two']) {
    learning.configure(owner, { enabled: true, retentionDays: 7 });
    queue(owner + '-run', owner);
    runs.finish(owner + '-run', 'done');
    learning.capture(owner, owner + '-run', rawExchange);
  }
  queue('before-clear');
  runs.finish('before-clear', 'done');
  learning.clear('one');
  assert.equal(learning.snapshot('one').counts.total, 0);
  assert.equal(learning.capture('one', 'before-clear', rawExchange), false);
  assert.equal(learning.snapshot('two').counts.total, 1);
  time('2026-09-25T10:00:00.000Z');
  assert.equal(learning.snapshot('two').counts.total, 0);
});

test('opening the co-model directly also expires its captured syntax queue', (t) => {
  const { db, learning } = setup(t);
  learning.configure('one', { collectSyntax: true, retentionDays: 7 });
  const old = createCandidateStore(db, () => '2026-09-17T10:00:00.000Z');
  const candidate = {
    language: 'en',
    text: 'A sample sentence for review.',
    fingerprint: 'sample',
    coverage: 0.5,
    score: 0,
    tokens: 5,
    annotation: { text: 'A sample sentence for review.', tokens: [] },
  };
  old.record('one', [candidate]);
  old.record('two', [candidate]);
  const later = createCandidateStore(db, () => '2026-09-25T10:00:00.000Z');
  assert.deepEqual(later.queue('one', 'en'), []);
  assert.equal(later.waiting('one').en, undefined);
  assert.equal(later.queue('two', 'en').length, 1, 'other user keeps the 30-day default');
});

test('capture uses the final answer only and refuses uncompleted or attachment-dependent exchanges', () => {
  const input = {
    messages: [userMessage()],
    message: answer(),
    model: 'model',
    baseUrl: 'https://provider.test/v1',
  };
  assert.ok(completedExchange(input));
  for (const finishReason of ['length', 'error', 'content-filter', 'tool-calls', undefined])
    assert.equal(
      completedExchange({ ...input, message: { ...answer(), metadata: { finishReason } } }),
      null,
    );
  assert.equal(
    completedExchange({
      ...input,
      messages: [
        { ...userMessage(), parts: [...userMessage().parts, { type: 'file', url: 'private' }] },
      ],
    }),
    null,
  );
  assert.equal(
    completedExchange({
      ...input,
      messages: [
        { ...userMessage(), parts: [{ type: 'file', url: 'private-file' }] },
        answer('I read the attachment.'),
        userMessage('Summarize the attachment in two lines.'),
      ],
    }),
    null,
    'an earlier attachment can still determine this answer',
  );
  assert.equal(completedExchange({ ...input, message: answer(' ') }), null);
  assert.equal(completedExchange({ ...input, message: answer('x'.repeat(24_001)) }), null);
  const result = completedExchange({
    ...input,
    message: {
      ...answer(),
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Intermediate working' },
        { type: 'step-start' },
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'Final answer' },
      ],
    },
  });
  assert.equal(result.response, 'Final answer');
  assert.doesNotMatch(JSON.stringify(result), /private|Intermediate/);
  assert.equal(
    completedExchange({
      ...input,
      message: {
        ...answer(),
        parts: [
          { type: 'tool-typeform', state: 'output-available', output: 'respondent data' },
          { type: 'text', text: 'Final answer quoting a private respondent' },
        ],
      },
    }),
    null,
    'ordinary chat consent excludes tool-derived answer text',
  );
  assert.equal(
    completedExchange({
      ...input,
      messages: [
        userMessage(),
        { role: 'assistant', parts: [{ type: 'dynamic-tool', output: 'private result' }] },
        userMessage('Summarize that result again.'),
      ],
    }),
    null,
    'earlier connector results can still determine the final response',
  );
});

test('known secrets and common credential/PII formats are removed before creating a learning copy', () => {
  const secret = 'exact-key-with-quote-"-and-slash/';
  const text = `Known ${secret}. Encoded ${encodeURIComponent(secret)}. api_key="hidden-value" Bearer abcdefghijklmnop user@example.test +971 50 123 4567 -----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----`;
  const cleaned = redactLearningText(text, [secret]);
  for (const value of [
    secret,
    encodeURIComponent(secret),
    'hidden-value',
    'abcdefghijklmnop',
    'user@example.test',
    'secret material',
    '+971 50 123 4567',
  ])
    assert.ok(!cleaned.text.includes(value), 'sensitive value is absent');
  assert.ok(cleaned.redactions.includes('credential'));
  assert.ok(cleaned.redactions.includes('private key'));
  const captured = completedExchange({
    messages: [userMessage(text)],
    message: answer(secret),
    model: 'model',
    baseUrl: 'https://provider.test/v1',
    secrets: [secret],
  });
  assert.ok(!JSON.stringify(captured).includes(secret));
});

test('terminal runs scrub provider keys while paused runs remain resumable', (t) => {
  const { runs, queue } = setup(t);
  for (const status of ['done', 'failed', 'cancelled']) {
    queue(status);
    runs.finish(status, status);
    assert.ok(!Object.hasOwn(JSON.parse(runs.getRun(status).config), 'apiKey'));
  }
  queue('paused');
  runs.setStatus('paused', 'waiting_approval');
  assert.ok(!Object.hasOwn(JSON.parse(runs.getRun('paused').config), 'apiKey'));
  assert.equal(executionRunConfig(runs.getRun('paused')).apiKey, 'a-test-only-credential');
});

test('worker captures only after success is durable and capture failure cannot destroy the answer', async (t) => {
  const { db, learning } = setup(t);
  learning.configure('one', { enabled: true });
  let callbacks = 0;
  const worker = createWorker({
    db,
    drive: async ({ run }) => {
      if (run.id === 'pause') return { message: answer(), awaitingApproval: true };
      if (run.id === 'silent') return { message: answer(''), silent: true };
      if (run.id === 'failed') throw Error('provider unavailable');
      return { message: answer() };
    },
    onCompleted: ({ run, message, messages }) => {
      callbacks++;
      assert.equal(worker.store.getRun(run.id).status, 'done');
      assert.ok(worker.store.listMessages(run.conversation_id).some((m) => m.role === 'assistant'));
      if (run.id === 'capture-failure') throw Error('capture offline');
      const config = JSON.parse(run.config);
      const captured = completedExchange({
        messages,
        message,
        model: config.model,
        baseUrl: config.baseUrl,
      });
      assert.ok(captured);
      learning.capture(run.user_id, run.id, captured);
    },
    onError: () => {},
  });
  for (const id of ['success', 'capture-failure', 'pause', 'silent', 'failed']) {
    worker.store.createConversation({ id, userId: 'one' });
    worker.store.appendMessage(id, { ...userMessage(), id: id + '-question' });
    worker.store.createRun({
      id,
      conversationId: id,
      userId: 'one',
      config: { model: 'model', baseUrl: 'https://provider.test' },
    });
    await worker.tick();
  }
  assert.equal(callbacks, 2);
  assert.equal(worker.store.getRun('capture-failure').status, 'done');
  assert.equal(learning.snapshot('one').counts.pending, 1);
});
