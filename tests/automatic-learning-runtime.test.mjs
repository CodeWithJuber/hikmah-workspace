import test from 'node:test';
import './fixtures/vault.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { applySchema } from './schema.mjs';
import { createRunStore } from '../lib/runs/store.ts';
import { createLearningStore } from '../lib/learning/store.ts';
import { createAutomaticStore } from '../lib/learning/automatic-store.ts';
import {
  boundedAnnotationFetch,
  AUTOMATIC_RESPONSE_BYTES,
} from '../lib/learning/automatic-fetch.ts';

test('automatic annotation fetch refuses redirects and bounds chunked response bytes', async () => {
  let request;
  const fetcher = boundedAnnotationFetch(async (url, init) => {
    request = init;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(AUTOMATIC_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );
  });
  const response = await fetcher('https://fixture.test', {
    headers: { Authorization: 'Bearer fixture' },
  });
  assert.equal(request.redirect, 'error');
  await assert.rejects(response.text(), /size limit/);
});

test(
  'the real background service annotates through the configured provider and fits in a bounded Node worker',
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hikmah-automatic-runtime-'));
    const db = applySchema(new DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys=ON');
    const objects = new Map();
    const previousDirectory = process.env.HIKMAH_RESEARCH_DIR;
    const root = join(directory, 'research');
    await mkdir(join(root, 'v6'), { recursive: true });
    await symlink(resolve('public/research/v6/data'), join(root, 'v6/data'));
    await symlink(resolve('public/research/v6/models'), join(root, 'v6/models'));
    process.env.HIKMAH_RESEARCH_DIR = root;
    globalThis.__automaticRuntimeStorage = {
      raw: db,
      BUCKET: {
        async get(key) {
          return objects.has(key) ? { text: async () => objects.get(key) } : null;
        },
        async put(key, value) {
          objects.set(key, value);
        },
        async delete(key) {
          objects.delete(key);
        },
      },
    };
    const requests = [];
    const provider = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      requests.push({ value, authorization: request.headers.authorization, path: request.url });
      const prompt = JSON.parse(
        value.messages.findLast((message) => message.role === 'user').content,
      );
      const annotation = {
        language: prompt.language,
        sentences: prompt.sentences.map((sample) => ({
          tokens: sample.tokens.map((token, index) => ({
            ...token,
            lemma: token.form.toLowerCase(),
            upos: index === 2 ? 'VERB' : index === sample.tokens.length - 1 ? 'PUNCT' : 'NOUN',
            head: index === 2 ? 0 : 3,
            deprel: index === 2 ? 'root' : index === sample.tokens.length - 1 ? 'punct' : 'dep',
            feats: {},
          })),
        })),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'runtime-fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(annotation) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 220, total_tokens: 340 },
        }),
      );
    });
    await new Promise((resolveListening) => provider.listen(0, '127.0.0.1', resolveListening));
    const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    let service;
    t.after(async () => {
      await service?.stop();
      await new Promise((done) => provider.close(done));
      db.close();
      if (previousDirectory === undefined) delete process.env.HIKMAH_RESEARCH_DIR;
      else process.env.HIKMAH_RESEARCH_DIR = previousDirectory;
      delete globalThis.__automaticRuntimeStorage;
      delete globalThis.__hikmahAutomaticLearning;
      await rm(directory, { recursive: true, force: true });
    });
    await build({
      entryPoints: ['lib/learning/automatic-fit-worker.ts'],
      outfile: join(root, 'v6/automatic-fit-worker.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    await build({
      entryPoints: ['lib/learning/automatic-server.ts'],
      outfile: join(directory, 'service.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      plugins: [
        {
          name: 'automatic-runtime-fixtures',
          setup(builder) {
            builder.onResolve({ filter: /server\/storage\.mjs$/ }, () => ({
              path: 'storage',
              namespace: 'fixture',
            }));
            builder.onResolve({ filter: /^\.\/server\.ts$/ }, ({ importer }) =>
              importer.endsWith('/lib/learning/automatic-server.ts')
                ? { path: 'secrets', namespace: 'fixture' }
                : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
              loader: 'js',
              contents:
                path === 'storage'
                  ? 'export function getStorage(){ return globalThis.__automaticRuntimeStorage; }'
                  : 'export async function learningSecrets(userId, extra=[]){return extra;}',
            }));
          },
        },
      ],
    });
    const runtime = await import(pathToFileURL(join(directory, 'service.mjs')));
    const runs = createRunStore(db);
    const learning = createLearningStore(db);
    const automatic = createAutomaticStore(db);
    runs.createConversation({ id: 'chat', userId: 'owner' });
    learning.configure('owner', { automatic: true });
    const config = {
      baseUrl,
      model: 'runtime-fixture',
      apiKey: 'fixture-only-secret',
      freeOnly: true,
      metered: false,
    };
    runs.createRun({ id: 'run', conversationId: 'chat', userId: 'owner', config });
    runs.finish('run', 'done');
    const exchange = {
      model: 'runtime-fixture',
      provider: new URL(baseUrl).origin,
      prompt: 'Bright otters chase playful butterflies.',
      response: 'Quiet robins watch distant travelers.',
      redactions: [],
    };
    assert.equal(learning.capture('owner', 'run', exchange), true);
    runtime.enqueueAutomaticLearning({
      userId: 'owner',
      runId: 'run',
      revision: learning.policy('owner').revision,
      exchange,
      config,
    });
    service = runtime.automaticLearningService();
    let eventLoopTicks = 0;
    const pulse = setInterval(() => {
      eventLoopTicks++;
    }, 20);
    service.start();
    const started = Date.now();
    try {
      while (!['updated', 'held', 'error'].includes(automatic.snapshot('owner').status)) {
        if (Date.now() - started > 75_000) throw Error('Background training did not complete.');
        await new Promise((done) => setTimeout(done, 25));
      }
    } finally {
      clearInterval(pulse);
    }
    const status = automatic.snapshot('owner');
    assert.ok(['updated', 'held'].includes(status.status), JSON.stringify(status));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].value.model, 'runtime-fixture');
    assert.equal(requests[0].value.max_tokens, 3840);
    assert.equal(requests[0].authorization, 'Bearer fixture-only-secret');
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(requests[0].value.tools, undefined);
    assert.ok(eventLoopTicks > 0, 'the event loop remains responsive during fitting');
    assert.equal(automatic.snapshot('owner').requestsToday, 1);
    assert.equal(learning.snapshot('owner').counts.approved, 0);
    assert.equal(objects.size, 1, 'a real locally trained candidate was saved');
    const checkpoint = JSON.parse([...objects.values()][0]);
    assert.ok(checkpoint.model.training.sentences > 2);
    assert.match(checkpoint.model.training.source, /provider-generated syntax annotations/);
    assert.match(checkpoint.receipt.scope, /Reused development syntax gate/);
    assert.equal(checkpoint.receipt.providerWeightsChanged, false);
    assert.equal(
      db.prepare('SELECT input_tokens+output_tokens AS total FROM usage_events').get().total,
      340,
    );
    assert.equal(
      db
        .prepare('SELECT config FROM automatic_learning_jobs')
        .get()
        .config.includes('providerCredential'),
      false,
    );
    runs.createRun({ id: 'repeat', conversationId: 'chat', userId: 'owner', config });
    runs.finish('repeat', 'done');
    assert.equal(learning.capture('owner', 'repeat', exchange), true);
    runtime.enqueueAutomaticLearning({
      userId: 'owner',
      runId: 'repeat',
      revision: learning.policy('owner').revision,
      exchange,
      config,
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM automatic_learning_jobs').get().n,
      1,
      'already annotated sentences do not spend the provider budget again',
    );
  },
);
