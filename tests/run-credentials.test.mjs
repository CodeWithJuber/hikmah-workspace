import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from './schema.mjs';
import { openStorage } from '../server/storage.mjs';
import {
  sealRunConfig,
  executionRunConfig,
  migrateRunCredentials,
} from '../server/run-credentials.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createWorker } from '../lib/runs/worker.ts';

const master = 'fixture-run-encryption-master-'.padEnd(64, '1');
const privateKey = 'only-a-fixture-provider-credential-612e';
const config = { baseUrl: 'https://provider.test/v1', model: 'model', apiKey: privateKey };
function env(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}
function setup(t) {
  env(t, 'HIKMAH_VAULT_KEY', master);
  const db = applySchema(new DatabaseSync(':memory:'));
  const store = createRunStore(db);
  store.createConversation({ id: 'chat', userId: 'alice' });
  t.after(() => db.close());
  return { db, store };
}

test('queued and paused run credentials are encrypted and bound to owner, run and provider', (t) => {
  const { store } = setup(t);
  store.createRun({ id: 'run', userId: 'alice', conversationId: 'chat', config });
  const run = store.getRun('run'),
    stored = JSON.parse(run.config);
  assert.equal(Object.hasOwn(stored, 'apiKey'), false);
  assert.match(stored.providerCredential, /^v1\./);
  assert.ok(!run.config.includes(privateKey));
  assert.equal(executionRunConfig(run).apiKey, privateKey);
  for (const changed of [
    { ...run, id: 'another-run' },
    { ...run, user_id: 'bob' },
    { ...run, config: JSON.stringify({ ...stored, baseUrl: 'https://another-provider.test' }) },
    {
      ...run,
      config: JSON.stringify({
        ...stored,
        providerCredential: stored.providerCredential.slice(0, -4) + 'AAAA',
      }),
    },
  ])
    assert.throws(() => executionRunConfig(changed), /cannot be decrypted/);
  store.setStatus('run', 'waiting_approval');
  assert.equal(executionRunConfig(store.getRun('run')).apiKey, privateKey);
  assert.notEqual(
    sealRunConfig(config, run).providerCredential,
    stored.providerCredential,
    'fresh nonce per encryption',
  );
});

test('missing or changed encryption keys fail closed without saving a plaintext fallback', (t) => {
  const { db, store } = setup(t);
  store.createRun({ id: 'run', userId: 'alice', conversationId: 'chat', config });
  process.env.HIKMAH_VAULT_KEY = 'wrong-master-'.padEnd(64, '2');
  assert.throws(() => executionRunConfig(store.getRun('run')), /cannot be decrypted/);
  env(t, 'HIKMAH_VAULT_KEY', undefined);
  env(t, 'BETTER_AUTH_SECRET', undefined);
  assert.throws(
    () => store.createRun({ id: 'refused', userId: 'alice', conversationId: 'chat', config }),
    /HIKMAH_VAULT_KEY is not set/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id=?').get('refused').n, 0);
  store.createRun({
    id: 'keyless',
    userId: 'alice',
    conversationId: 'chat',
    config: { model: 'local', apiKey: '' },
  });
  assert.equal(executionRunConfig(store.getRun('keyless')).apiKey, '');
});

test('pause and resume use the encrypted credential snapshot and terminal completion removes it', async (t) => {
  const { db } = setup(t);
  let calls = 0;
  const worker = createWorker({
    db,
    drive: async ({ run }) => {
      assert.ok(!run.config.includes(privateKey));
      assert.equal(executionRunConfig(run).apiKey, privateKey);
      calls++;
      return calls === 1
        ? { message: { id: 'answer', role: 'assistant', parts: [] }, awaitingApproval: true }
        : { message: { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] } };
    },
  });
  worker.store.createRun({ id: 'run', userId: 'alice', conversationId: 'chat', config });
  await worker.tick();
  assert.equal(worker.store.getRun('run').status, 'waiting_approval');
  env(t, 'HIKMAH_PROVIDER_KEY', 'rotated-deployment-provider-key');
  const resumed = createWorker({
    db,
    drive: async ({ run }) => {
      assert.equal(
        executionRunConfig(run).apiKey,
        privateKey,
        'server restart and key rotation do not change this queued request',
      );
      return {
        message: { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] },
      };
    },
  });
  assert.equal(resumed.store.requeueApproved('run'), true);
  await resumed.tick();
  const complete = JSON.parse(resumed.store.getRun('run').config);
  assert.ok(!Object.hasOwn(complete, 'apiKey'));
  assert.ok(!Object.hasOwn(complete, 'providerCredential'));
});

test('startup encrypts inherited active credentials, scrubs terminal copies and removes old disk/WAL plaintext', async (t) => {
  env(t, 'HIKMAH_VAULT_KEY', master);
  const directory = await mkdtemp(join(tmpdir(), 'hikmah-run-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let storage = openStorage(directory),
    store = createRunStore(storage.raw);
  store.createConversation({ id: 'chat', userId: 'alice' });
  for (const status of [
    'queued',
    'running',
    'waiting_approval',
    'waiting_client',
    'done',
    'failed',
    'cancelled',
  ]) {
    // Simulate an inherited row written by the previous release.
    storage.raw
      .prepare(
        'INSERT INTO runs (id,conversation_id,user_id,status,config,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(status, 'chat', 'alice', status, JSON.stringify(config), new Date().toISOString());
  }
  storage.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(
    (await readFile(join(directory, 'workspace.sqlite'))).includes(Buffer.from(privateKey)),
  );
  storage.close();
  storage = openStorage(directory);
  t.after(() => storage.close());
  store = createRunStore(storage.raw);
  for (const status of ['queued', 'running', 'waiting_approval', 'waiting_client']) {
    const run = store.getRun(status);
    assert.equal(run.status, status);
    assert.equal(executionRunConfig(run).apiKey, privateKey);
  }
  for (const status of ['done', 'failed', 'cancelled']) {
    const stored = JSON.parse(store.getRun(status).config);
    assert.ok(!Object.hasOwn(stored, 'apiKey'));
    assert.ok(!Object.hasOwn(stored, 'providerCredential'));
  }
  assert.equal(migrateRunCredentials(storage.raw), 0, 'idempotent on the next restart');
  assert.ok(
    !(await readFile(join(directory, 'workspace.sqlite'))).includes(Buffer.from(privateKey)),
  );
  const wal = await readFile(join(directory, 'workspace.sqlite-wal')).catch(() => Buffer.alloc(0));
  assert.ok(!wal.includes(Buffer.from(privateKey)));
});

test('legacy plaintext is never accepted directly as executable configuration', (t) => {
  setup(t);
  assert.throws(
    () => executionRunConfig({ id: 'old', user_id: 'alice', config: JSON.stringify(config) }),
    /storage upgrade/,
  );
});

test('a busy credential scrub is retried after restart until the inherited plaintext WAL is removed', async (t) => {
  env(t, 'HIKMAH_VAULT_KEY', master);
  const directory = await mkdtemp(join(tmpdir(), 'hikmah-run-scrub-retry-'));
  let reader, restarted;
  t.after(async () => {
    restarted?.close();
    if (reader) {
      if (reader.isTransaction) reader.exec('ROLLBACK');
      reader.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  const seed = openStorage(directory);
  createRunStore(seed.raw).createConversation({ id: 'chat', userId: 'alice' });
  seed.raw
    .prepare(
      'INSERT INTO runs (id,conversation_id,user_id,status,config,created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      'legacy',
      'chat',
      'alice',
      'waiting_approval',
      JSON.stringify(config),
      new Date().toISOString(),
    );
  reader = new DatabaseSync(join(directory, 'workspace.sqlite'));
  reader.exec('BEGIN');
  reader.prepare('SELECT config FROM runs WHERE id=?').get('legacy');
  seed.close();

  assert.throws(() => openStorage(directory), /exclusive storage access/);
  assert.ok(
    (await readFile(join(directory, 'workspace.sqlite-wal'))).includes(Buffer.from(privateKey)),
    'the old reader retains the WAL containing the inherited plaintext',
  );
  assert.throws(
    () => {
      restarted = openStorage(directory);
    },
    /exclusive storage access/,
    'restart must not skip cleanup merely because encryption already committed',
  );

  reader.exec('COMMIT');
  restarted = openStorage(directory);
  const run = createRunStore(restarted.raw).getRun('legacy');
  assert.equal(run.status, 'waiting_approval');
  assert.equal(executionRunConfig(run).apiKey, privateKey);
  assert.ok(
    !(await readFile(join(directory, 'workspace.sqlite'))).includes(Buffer.from(privateKey)),
  );
  const wal = await readFile(join(directory, 'workspace.sqlite-wal')).catch(() => Buffer.alloc(0));
  assert.ok(!wal.includes(Buffer.from(privateKey)));
});

test('a provider error cannot echo its decrypted key into the failure row or log callback', async (t) => {
  const { db } = setup(t);
  let logged;
  const worker = createWorker({
    db,
    drive: async () => {
      throw Error('Provider rejected credential ' + privateKey);
    },
    onError: (error) => {
      logged = error;
    },
  });
  worker.store.createRun({
    id: 'run',
    userId: 'alice',
    conversationId: 'chat',
    config: { ...config, operator: true },
  });
  await worker.tick();
  assert.ok(!worker.store.getRun('run').error.includes(privateKey));
  assert.ok(!String(logged?.stack).includes(privateKey));
  assert.match(worker.store.getRun('run').error, /credential redacted/);
});
