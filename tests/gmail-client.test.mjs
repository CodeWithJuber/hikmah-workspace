// The Gmail API client against a stubbed network: list, read, send, and the
// one 401 retry. The fetch stub throws on any URL it does not expect, so a
// test that accidentally reaches the real API fails loudly.
// Run: node --test tests/gmail-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailClient } from '../lib/gmail/client.ts';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(routes, token = 'tok') {
  const calls = [];
  const seenTokens = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    seenTokens.push(init.headers?.authorization);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler(url, init, calls.length);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const tokenFor = async (force) => {
    seenTokens.push(`force:${force}`);
    return `${token}${force ? '-refreshed' : ''}`;
  };
  return { client: createGmailClient({ fetchImpl, tokenFor }), calls, seenTokens };
}

test('list passes the query through and caps the page size', async () => {
  const { client, calls } = setup([
    [
      'https://www.googleapis.com/gmail/v1/users/me/messages',
      async (url) => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('q'), 'from:boss');
        assert.ok(Number(params.get('maxResults')) <= 100);
        return json({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'next' });
      },
    ],
  ]);
  const result = await client.listMessages({ q: 'from:boss', maxResults: 500 });
  assert.deepEqual(result.messages, [{ id: 'm1', threadId: 't1' }]);
  assert.equal(result.nextPageToken, 'next');
  assert.equal(calls.length, 1);
});

test('read returns the parsed message', async () => {
  const { client } = setup([
    [
      'https://www.googleapis.com/gmail/v1/users/me/messages/m1',
      async () =>
        json({
          id: 'm1',
          threadId: 't1',
          snippet: 'hi',
          payload: { headers: [{ name: 'Subject', value: 'Hey' }] },
        }),
    ],
  ]);
  const message = await client.getMessage('m1');
  assert.equal(message.subject, 'Hey');
  assert.equal(message.snippet, 'hi');
});

test('a missing message is a 404, not a 502', async () => {
  const { client } = setup([
    ['https://www.googleapis.com/gmail/v1/users/me/messages/', async () => json({}, 404)],
  ]);
  await assert.rejects(client.getMessage('gone'), /not found/);
});

test('send posts base64url RFC 2822 and returns the Gmail id', async () => {
  const { client, calls } = setup([
    [
      'https://www.googleapis.com/gmail/v1/users/me/messages/send',
      async (url, init) => {
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        assert.ok(/^[A-Za-z0-9_-]+$/.test(body.raw), 'base64url');
        const raw = Buffer.from(body.raw, 'base64url').toString('utf8');
        assert.ok(raw.includes('To: a@example.com'));
        assert.ok(raw.includes('Subject: Hello'));
        return json({ id: 'gmail-1', threadId: 'thread-1' });
      },
    ],
  ]);
  const sent = await client.sendMessage({ to: ['a@example.com'], subject: 'Hello', body: 'b' });
  assert.equal(sent.id, 'gmail-1');
  assert.equal(calls.length, 1);
});

test('one 401 refreshes the token and retries; a second 401 surfaces', async () => {
  let hits = 0;
  const { client, seenTokens } = setup([
    [
      'https://www.googleapis.com/gmail/v1/users/me/messages',
      async () =>
        ++hits === 1 ? json({ error: { message: 'expired' } }, 401) : json({ messages: [] }),
    ],
  ]);
  const result = await client.listMessages({});
  assert.deepEqual(result.messages, []);
  assert.equal(hits, 2, 'retried once');
  assert.ok(seenTokens.includes('force:true'), 'the retry forced a refresh');

  let always = 0;
  const second = setup([
    [
      'https://www.googleapis.com/gmail/v1/users/me/messages',
      async () => (++always, json({}, 401)),
    ],
  ]);
  await assert.rejects(second.client.listMessages({}), /401/);
  assert.equal(always, 2, 'no third attempt: a revoked grant surfaces');
});

test('every call carries the bearer token', async () => {
  const { client, seenTokens } = setup([
    ['https://www.googleapis.com/gmail/v1/users/me/messages', async () => json({ messages: [] })],
  ]);
  await client.listMessages({});
  assert.ok(seenTokens.some((t) => t === 'Bearer tok'));
});
