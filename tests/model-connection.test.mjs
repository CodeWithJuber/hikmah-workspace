import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModelConnection, saveProviderKey } from '../lib/client/model-connection.ts';
import { listModels } from '../lib/playground/transport.ts';

const emptyConnection = {
  baseUrl: 'https://api.anthropic.com/v1',
  model: '',
  apiKeySecret: '',
  freeOnly: false,
};

test('a key can be saved before choosing a model and immediately used to load its catalogue', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    if (url === '/api/secrets') {
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), {
        name: 'CHAT_PROVIDER_KEY_ANTHROPIC',
        value: 'synthetic-provider-key',
        destination: 'provider:anthropic',
      });
      return Response.json({ ok: true });
    }
    assert.equal(url, '/api/provider?provider=anthropic&operation=models');
    assert.equal(options.headers['X-Hikmah-Secret-Ref'], 'CHAT_PROVIDER_KEY_ANTHROPIC');
    assert.equal(options.headers['X-Hikmah-Provider-Key'], undefined);
    return Response.json({ data: [{ id: 'test-model', name: 'Test model' }] });
  });
  const next = await saveProviderKey(emptyConnection, ' synthetic-provider-key ');
  assert.equal(next.model, '', 'saving the credential does not invent a model');
  const models = await listModels({ ...next, apiKey: '', maxTokens: 2048, temperature: 0.7 });
  assert.equal(models[0].id, 'test-model');
  assert.equal(requests.length, 2);
  assert.equal(emptyConnection.apiKeySecret, '', 'the input draft is not mutated');
});

test('a failed vault write does not save a connection or expose the key in the error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'synthetic-private-value' }, { status: 500 }),
  );
  let saved = false;
  await assert.rejects(
    saveModelConnection(
      { ...emptyConnection, model: 'test-model' },
      'synthetic-private-value',
      () => {
        saved = true;
      },
    ),
    (error) =>
      /key was not saved/i.test(error.message) &&
      !error.message.includes('synthetic-private-value'),
  );
  assert.equal(saved, false);
});

test('a rejected connection save stays rejected after a successful key write', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const draft = { ...emptyConnection, model: 'test-model' };
  const snapshot = structuredClone(draft);
  await assert.rejects(
    saveModelConnection(draft, 'synthetic-provider-key', async (connection) => {
      assert.equal(connection.apiKeySecret, 'CHAT_PROVIDER_KEY_ANTHROPIC');
      assert.ok(!JSON.stringify(connection).includes('synthetic-provider-key'));
      throw new Error('Settings were not saved.');
    }),
    /Settings were not saved/,
  );
  assert.deepEqual(draft, snapshot, 'the form can retry its unchanged draft');
});

test('a blank model fails before any storage request', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({});
  });
  const save = () => {
    throw new Error('must not save');
  };
  await assert.rejects(
    saveModelConnection(emptyConnection, 'synthetic-key', save),
    /Choose a model/,
  );
  assert.equal(requests, 0);
});

test('a hosted model may use a deployment-managed key absent from the browser', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('must not write the vault');
  });
  const connection = { ...emptyConnection, model: 'test-managed-model' };
  let saved;
  await saveModelConnection(connection, '', (next) => {
    saved = next;
  });
  assert.deepEqual(saved, connection, 'provider access remains the server’s decision');
});

test('an existing saved key is reused without another vault write', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('must not write the vault');
  });
  const draft = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: ' openrouter/free ',
    apiKeySecret: 'CHAT_PROVIDER_KEY',
    freeOnly: true,
  };
  let stored;
  const next = await saveModelConnection(draft, '', async (connection) => {
    stored = connection;
  });
  assert.deepEqual(next, stored);
  assert.equal(next.model, 'openrouter/free');
  assert.equal(next.freeOnly, true, 'saving never opens paid routing on a free-tier provider');
  assert.equal(next.apiKeySecret, 'CHAT_PROVIDER_KEY');
});

test('a local model can be connected without a credential', async () => {
  const connection = {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'test-local-model',
    apiKeySecret: '',
    freeOnly: true,
  };
  assert.deepEqual(await saveModelConnection(connection, '', () => {}), connection);
});
