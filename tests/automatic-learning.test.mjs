import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createLearningStore } from '../lib/learning/store.ts';
import { createAutomaticStore } from '../lib/learning/automatic-store.ts';
import {
  automaticSamples,
  surfaceFingerprint,
  validateTeacherAnnotations,
  fitAutomatic,
} from '../lib/learning/automatic-training.ts';
import { processAutomaticJob } from '../lib/learning/automatic-worker.ts';
import { executionRunConfig } from '../server/run-credentials.mjs';
import frozen from '../lib/context-model/frozen-gates.json' with { type: 'json' };

const key = 'automatic-fixture-private-provider-key';
const exchange = {
  model: 'fixture-model',
  provider: 'https://provider.test',
  prompt: 'Bright otters chase playful butterflies.',
  response: 'Quiet robins watch distant travelers.',
  redactions: [],
};
const proposal = (samples, language = 'en') =>
  JSON.stringify({
    language,
    sentences: samples.map(({ forms }) => ({
      tokens: forms.map((form, index) => ({
        id: index + 1,
        form,
        lemma: form.toLowerCase(),
        upos: index === 2 ? 'VERB' : index === forms.length - 1 ? 'PUNCT' : 'NOUN',
        head: index === 2 ? 0 : 3,
        deprel: index === 2 ? 'root' : index === forms.length - 1 ? 'punct' : 'dep',
        feats: {},
      })),
    })),
  });

function setup(t) {
  const db = applySchema(new DatabaseSync(':memory:'));
  db.exec('PRAGMA foreign_keys=ON');
  let timestamp = '2026-09-21T08:00:00.000Z';
  const now = () => timestamp;
  const runs = createRunStore(db, now);
  const learning = createLearningStore(db, now);
  const store = createAutomaticStore(db, now);
  for (const userId of ['one', 'two']) runs.createConversation({ id: userId + '-chat', userId });
  let sequence = 0;
  function enqueue(userId = 'one') {
    const id = 'run-' + ++sequence;
    runs.createRun({
      id,
      conversationId: userId + '-chat',
      userId,
      config: { baseUrl: 'https://provider.test/v1', model: 'fixture-model', apiKey: key },
    });
    runs.finish(id, 'done');
    assert.equal(learning.capture(userId, id, exchange), true);
    const exampleId = db.prepare('SELECT id FROM learning_examples WHERE run_id=?').get(id).id;
    const selected = automaticSamples(exchange);
    const added = store.enqueue({
      userId,
      exampleId,
      revision: learning.policy(userId).revision,
      ...selected,
      config: {
        baseUrl: 'https://provider.test/v1',
        model: 'fixture-model',
        apiKey: key,
        metered: false,
      },
    });
    return { added, exampleId, samples: selected.sentences };
  }
  t.after(() => db.close());
  return {
    db,
    runs,
    learning,
    store,
    enqueue,
    now,
    time(value) {
      timestamp = value;
    },
  };
}

function dependencies(fixture, overrides = {}) {
  const objects = new Map();
  let calls = 0;
  let fits = 0;
  const gate = {
    approved: true,
    gain: 0.01,
    scope: 'Reused development syntax gate; not semantic or new held-out proof',
    reason: 'Development syntax improved with no per-sentence LAS/POS regressions.',
  };
  const deps = {
    store: fixture.store,
    secrets: async () => [key],
    canSpend: () => true,
    recordUsage() {},
    async annotate(config, language, samples) {
      calls++;
      assert.equal(config.apiKey, key);
      return {
        text: proposal(samples, language),
        inputTokens: 120,
        outputTokens: 300,
        finishReason: 'stop',
      };
    },
    async load(job) {
      return {
        input: {
          automaticRows: fixture.store.annotations(job.user_id, job.language),
          reviewedRows: [],
        },
        basedOn: 'released',
        restoreVersion: 'released',
      };
    },
    async fit(input, signal, stage) {
      fits++;
      stage('training');
      stage('evaluating');
      return { model: { fixture: true }, gate, reviewedRows: [] };
    },
    bucket: {
      async put(name, value) {
        objects.set(name, value);
      },
      async delete(name) {
        objects.delete(name);
      },
    },
    ...overrides,
  };
  return { deps, objects, gate, calls: () => calls, fits: () => fits };
}

test('automatic learning needs its own opt-in and never approves answer examples', (t) => {
  const f = setup(t);
  assert.equal(f.learning.policy('one').automatic, false);
  assert.equal(f.learning.snapshot('one').automatic.status, 'paused');
  f.learning.configure('one', { enabled: true });
  assert.equal(f.enqueue().added, false, 'existing capture consent is insufficient');
  f.learning.configure('one', { automatic: true });
  assert.equal(f.learning.policy('one').enabled, true);
  assert.equal(f.enqueue().added, true);
  assert.equal(f.learning.snapshot('one').counts.approved, 0);
  assert.equal(f.learning.snapshot('two').automatic.queued, 0);
  f.learning.configure('one', { enabled: false });
  assert.equal(f.learning.policy('one').automatic, false);
  assert.equal(f.store.claim('worker'), null);
});

test('job credentials are encrypted, tenant-bound, and removed on terminal outcomes', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('worker');
  assert.equal(job.config.includes(key), false);
  assert.equal(executionRunConfig(job).apiKey, key);
  assert.throws(() => executionRunConfig({ ...job, user_id: 'two' }));
  const fixture = dependencies(f, {
    annotate: async () => {
      throw Error(key);
    },
  });
  await processAutomaticJob(job, 'worker', new AbortController().signal, fixture.deps);
  const row = f.db.prepare('SELECT * FROM automatic_learning_jobs').get();
  assert.equal(row.status, 'error');
  assert.equal(row.reason.includes(key), false);
  assert.equal(row.config.includes('providerCredential'), false);
  assert.equal(row.config.includes('apiKey'), false);
});

test('only one worker claims globally and lease recovery does not repeat a billed annotation', (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('first');
  assert.equal(f.store.claim('second'), null);
  assert.equal(f.store.reserveRequest(job, 'first'), true);
  f.time('2026-09-21T08:01:00.000Z');
  assert.equal(f.store.claim('second'), null);
  const row = f.db.prepare('SELECT * FROM automatic_learning_jobs').get();
  assert.equal(row.status, 'error');
  assert.equal(row.config.includes('providerCredential'), false);
  assert.equal(f.store.snapshot('one').requestsToday, 1);
  assert.equal(f.store.live(job, 'first'), false);
});

test('persisted annotations resume local training without another provider request', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  const enqueued = f.enqueue();
  const original = f.store.claim('first');
  f.store.reserveRequest(original, 'first');
  f.store.saveAnnotations(
    original,
    'first',
    validateTeacherAnnotations(
      proposal(enqueued.samples),
      'en',
      enqueued.samples,
      original.example_id,
    ),
  );
  f.time('2026-09-21T08:01:00.000Z');
  const recovered = f.store.claim('second');
  assert.ok(recovered.annotations);
  const fixture = dependencies(f);
  await processAutomaticJob(recovered, 'second', new AbortController().signal, fixture.deps);
  assert.equal(fixture.calls(), 0);
  assert.equal(fixture.fits(), 1);
  assert.equal(f.store.snapshot('one').status, 'updated');
});

test('the daily request cap survives clear and is isolated per user', (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  for (let i = 0; i < 4; i++) {
    f.enqueue();
    const job = f.store.claim('worker');
    assert.equal(f.store.reserveRequest(job, 'worker'), i < 3);
    f.store.finish(job, 'worker', 'held', 'fixture');
    f.store.release('worker');
  }
  assert.equal(f.store.snapshot('one').requestsToday, 3);
  f.learning.clear('one');
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const blocked = f.store.claim('worker');
  assert.equal(f.store.reserveRequest(blocked, 'worker'), false);
  f.store.release('worker');
  f.learning.configure('two', { automatic: true });
  f.enqueue('two');
  const other = f.store.claim('worker');
  assert.equal(f.store.reserveRequest(other, 'worker'), true);
  assert.equal(f.store.snapshot('two').requestsToday, 1);
});

test('consent revoked during provider request discards its result without training or promotion', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('worker');
  let metered = false;
  const fixture = dependencies(f, {
    async annotate(config, language, samples) {
      f.learning.configure('one', { automatic: false });
      return { text: proposal(samples), finishReason: 'stop', inputTokens: 12, outputTokens: 20 };
    },
    recordUsage() {
      metered = true;
    },
  });
  await processAutomaticJob(job, 'worker', new AbortController().signal, fixture.deps);
  assert.equal(metered, true, 'a completed provider request still has usage');
  assert.equal(fixture.fits(), 0);
  assert.equal(f.store.annotations('one', 'en').length, 0);
  assert.equal(f.store.active('one', 'en'), undefined);
});

test('source deletion or privacy changes exclude queued learning before a provider request', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  const enqueued = f.enqueue();
  const job = f.store.claim('worker');
  f.learning.remove('one', enqueued.exampleId);
  const fixture = dependencies(f);
  await processAutomaticJob(job, 'worker', new AbortController().signal, fixture.deps);
  assert.equal(fixture.calls(), 0);
  f.store.release('worker');
  f.enqueue();
  const next = f.store.claim('worker');
  const privateFixture = dependencies(f, { secrets: async () => [exchange.prompt] });
  await processAutomaticJob(next, 'worker', new AbortController().signal, privateFixture.deps);
  assert.equal(privateFixture.calls(), 0);
  assert.equal(f.store.snapshot('one').status, 'held');
});

test('neutral or regressing candidates stay inactive; passing candidates activate without approving examples', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const held = f.store.claim('worker');
  const fixture = dependencies(f);
  fixture.gate.approved = false;
  fixture.gate.gain = 0;
  fixture.gate.reason = 'No measured development syntax improvement.';
  await processAutomaticJob(held, 'worker', new AbortController().signal, fixture.deps);
  assert.equal(f.store.active('one', 'en'), undefined);
  assert.equal(f.store.snapshot('one').status, 'held');
  f.store.release('worker');
  f.time('2026-09-21T08:00:01.000Z');
  f.enqueue();
  const passing = f.store.claim('worker');
  fixture.gate.approved = true;
  fixture.gate.gain = 0.01;
  await processAutomaticJob(passing, 'worker', new AbortController().signal, fixture.deps);
  assert.ok(f.store.active('one', 'en'));
  assert.equal(f.store.snapshot('one').status, 'updated');
  assert.equal(f.learning.snapshot('one').counts.approved, 0);
  const keys = f.learning.clear('one');
  assert.equal(keys.length, 2);
  assert.equal(f.store.active('one', 'en'), undefined);
  assert.equal(f.learning.policy('one').automatic, false);
  assert.equal(f.learning.policy('one').enabled, false);
});

test('a manual activation wins a racing automatic checkpoint and its orphan is removed', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('worker');
  const fixture = dependencies(f);
  const put = fixture.deps.bucket.put;
  fixture.deps.bucket.put = async (name, value) => {
    await put(name, value);
    f.db
      .prepare('INSERT INTO context_versions VALUES(?,?,?,?,?,?)')
      .run('manual', 'one', 'en', 'manual.json', '{}', f.now());
    f.db
      .prepare('INSERT INTO context_active VALUES(?,?,?,?,?)')
      .run('one:en', 'one', 'en', 'manual', 0);
  };
  await processAutomaticJob(job, 'worker', new AbortController().signal, fixture.deps);
  assert.equal(f.store.active('one', 'en').id, 'manual');
  assert.equal(fixture.objects.size, 0);
  assert.equal(f.store.snapshot('one').status, 'held');
});

test('teacher output must match exact tokens, valid dependency trees and supported language', () => {
  const samples = automaticSamples(exchange).sentences;
  const valid = JSON.parse(proposal(samples));
  assert.equal(
    validateTeacherAnnotations(JSON.stringify(valid), 'en', samples, 'example').length,
    2,
  );
  const changed = structuredClone(valid);
  changed.sentences[0].tokens[0].form = 'Invented';
  assert.throws(() =>
    validateTeacherAnnotations(JSON.stringify(changed), 'en', samples, 'example'),
  );
  const cycle = structuredClone(valid);
  cycle.sentences[0].tokens[0].head = 2;
  cycle.sentences[0].tokens[1].head = 1;
  assert.throws(() => validateTeacherAnnotations(JSON.stringify(cycle), 'en', samples, 'example'));
  assert.throws(() =>
    validateTeacherAnnotations(proposal(samples, 'ur'), 'en', samples, 'example'),
  );
  assert.throws(() => validateTeacherAnnotations('not JSON', 'en', samples, 'example'));
  assert.equal(automaticSamples({ ...exchange, redactions: ['email'] }), null);
});

test('vault changes during annotation or a resumed fit prevent using the newly sensitive sample', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  const pending = f.enqueue();
  const job = f.store.claim('worker');
  let currentSecrets = [key];
  const fixture = dependencies(f, {
    secrets: async () => currentSecrets,
    async annotate(config, language, samples) {
      currentSecrets = [key, samples[0].text];
      return { text: proposal(samples), finishReason: 'stop', inputTokens: 1, outputTokens: 1 };
    },
  });
  await processAutomaticJob(job, 'worker', new AbortController().signal, fixture.deps);
  assert.equal(fixture.fits(), 0);
  assert.equal(f.store.annotations('one', 'en').length, 0);
  f.store.release('worker');
  f.enqueue();
  const original = f.store.claim('first');
  f.store.reserveRequest(original, 'first');
  f.store.saveAnnotations(
    original,
    'first',
    validateTeacherAnnotations(
      proposal(pending.samples),
      'en',
      pending.samples,
      original.example_id,
    ),
  );
  f.time('2026-09-21T08:01:00.000Z');
  const recovered = f.store.claim('second');
  await processAutomaticJob(recovered, 'second', new AbortController().signal, fixture.deps);
  assert.equal(fixture.fits(), 0);
  assert.equal(f.store.active('one', 'en'), undefined);
});

test('speculative checkpoint objects are protected by the lease and recoverable after a crash or failed delete', async (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('worker');
  assert.equal(f.store.stageCheckpoint(job, 'worker', 'context/one/crash.json'), true);
  assert.deepEqual(f.store.garbage(), [], 'another process cannot clean a live publication');
  f.time('2026-09-21T08:01:00.000Z');
  assert.deepEqual(f.store.garbage(), ['context/one/crash.json']);
  const resumed = f.store.claim('second');
  const fixture = dependencies(f);
  fixture.deps.bucket.delete = async () => {
    throw Error('temporary disk failure');
  };
  const put = fixture.deps.bucket.put;
  fixture.deps.bucket.put = async (name, value) => {
    await put(name, value);
    f.learning.configure('one', { automatic: false });
  };
  await processAutomaticJob(resumed, 'second', new AbortController().signal, fixture.deps);
  assert.equal(fixture.objects.size, 1);
  assert.ok(
    f.store.garbage().includes([...fixture.objects.keys()][0]),
    'failed cleanup has a durable retry marker',
  );
  assert.equal(f.store.active('one', 'en'), undefined);
});

test('reset restores a previous human checkpoint and does not reset the request budget', (t) => {
  const f = setup(t);
  f.learning.configure('one', { automatic: true });
  f.enqueue();
  const job = f.store.claim('worker');
  f.store.reserveRequest(job, 'worker');
  f.db
    .prepare('INSERT INTO context_versions VALUES(?,?,?,?,?,?)')
    .run('human', 'one', 'en', 'human.json', '{}', f.now());
  f.db
    .prepare('INSERT INTO context_versions VALUES(?,?,?,?,?,?)')
    .run(
      'automatic',
      'one',
      'en',
      'automatic.json',
      JSON.stringify({ automatic: true, restoreVersion: 'human' }),
      f.now(),
    );
  f.db
    .prepare('INSERT INTO context_active VALUES(?,?,?,?,?)')
    .run('one:en', 'one', 'en', 'automatic', 0);
  assert.deepEqual(f.learning.clear('one'), ['automatic.json']);
  assert.equal(f.store.active('one', 'en').id, 'human');
  assert.equal(f.store.snapshot('one').requestsToday, 1);
  assert.equal(f.learning.policy('one').automatic, false);
  assert.deepEqual(f.store.garbage(), ['automatic.json']);
});

test('frozen evaluation text cannot become an automatic annotation or a fitted training row', async () => {
  const source = frozen.en.sentences[0];
  const sample = {
    text: source.text,
    forms: source.tokens.map((token) => token.form),
    fingerprint: surfaceFingerprint(source.text),
  };
  assert.throws(() =>
    validateTeacherAnnotations(
      JSON.stringify({ language: 'en', sentences: [{ tokens: source.tokens }] }),
      'en',
      [sample],
      'example',
    ),
  );
  const released = JSON.parse(
    await readFile(new URL('../public/research/v6/models/en.model.json', import.meta.url), 'utf8'),
  );
  const base = JSON.parse(
    await readFile(new URL('../public/research/v6/data/ud-pud-en.json', import.meta.url), 'utf8'),
  ).sentences;
  assert.throws(
    () =>
      fitAutomatic({
        base,
        released,
        current: released,
        reviewedRows: [],
        automaticRows: [
          {
            ...source,
            id: 'auto/eval',
            groupId: 'owner/new',
            split: 'train',
            text: source.text.replaceAll(' ', '  '),
          },
        ],
      }),
    /overlaps/,
  );
});
