// The transport that makes a run survive the tab that started it. The property
// under test throughout is that the browser is disposable: it can drop, double
// submit or reload, and the answer being written on the server is unaffected.
// Run: node --test tests/durable-transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelRun,
  createDurableChatTransport,
  readEvents,
  runStream,
} from '../lib/chat/durable-transport.ts';

/** A response body carrying the given text. */
const bodyOf = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

/** One SSE frame as the run stream writes them. */
const frame = (seq, payload) => `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;

/** Collect a stream into an array. */
async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** A fetch that answers from a script and records what it was asked. */
function scripted(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const handler = handlers.shift();
    if (!handler) throw new Error('Unexpected request: ' + url);
    return handler(String(url), init);
  };
  return { fetch, calls };
}

const sse = (text) => new Response(bodyOf(text), { status: 200 });
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// --- Frame parsing ---------------------------------------------------------

test('a keep-alive carries nothing and is not delivered as a chunk', async () => {
  // It exists to hold the connection open through a proxy. Treating it as an
  // event would push an empty chunk into the message on every quiet interval.
  const frames = [];
  for await (const event of readEvents(bodyOf(': keep-alive\n\n' + frame(0, { type: 'x' }))))
    frames.push(event);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 0);
});

test('a multi-line data field is rejoined, not truncated', async () => {
  const frames = [];
  for await (const event of readEvents(bodyOf('id: 4\ndata: {"a":\ndata: 1}\n\n')))
    frames.push(event);
  assert.deepEqual(JSON.parse(frames[0].data), { a: 1 });
});

test('a frame split across two reads is parsed once it is whole', async () => {
  // The chunk boundary is the network's business, not the protocol's.
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('id: 7\ndata: {"type":"te'));
      controller.enqueue(encoder.encode('xt-delta"}\n\n'));
      controller.close();
    },
  });
  const frames = [];
  for await (const event of readEvents(body)) frames.push(event);
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0].data), { type: 'text-delta' });
});

// --- Tailing a run ---------------------------------------------------------

test('a run that has already finished ends the stream rather than hanging', async () => {
  const { fetch } = scripted([async () => new Response(null, { status: 204 })]);
  assert.deepEqual(await drain(runStream({ runId: 'r1', fetch })), []);
});

test('a dropped connection resumes from the last sequence seen', async () => {
  // This is the reason the event log exists. Reconnecting from 0 would repeat
  // the first half of the answer; reconnecting from nothing would lose it.
  const { fetch, calls } = scripted([
    async () => sse(frame(0, { type: 'start' }) + frame(1, { type: 'text-delta', delta: 'as' })),
    async () => sse(frame(2, { type: 'text-delta', delta: 'salam' })),
    async () => new Response(null, { status: 204 }),
  ]);
  const chunks = await drain(runStream({ runId: 'r1', fetch }));
  assert.deepEqual(
    chunks.map((chunk) => chunk.delta ?? chunk.type),
    ['start', 'as', 'salam'],
  );
  assert.match(calls[0].url, /after=-1/);
  assert.match(calls[1].url, /after=1/, 'resumes after the last delivered chunk');
});

test('a chunk already delivered is never delivered twice', async () => {
  // Sequence dedup on the transport (PR-09): a frame whose id is at or behind
  // the highest id already delivered — repeated by a reconnect that raced the
  // previous connection's last read, announced twice server-side, or replayed
  // out of order — was already folded in and is dropped, not delivered again.
  const { fetch } = scripted([
    async () => sse(frame(0, { type: 'a' }) + frame(1, { type: 'b' })),
    async () => sse(frame(1, { type: 'b' }) + frame(0, { type: 'a' }) + frame(2, { type: 'c' })),
    async () => new Response(null, { status: 204 }),
  ]);
  const chunks = await drain(runStream({ runId: 'r1', fetch }));
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['a', 'b', 'c'],
  );
});

test('an error response is reported with the server’s own words', async () => {
  const { fetch } = scripted([async () => json({ error: 'Run not found.' }, 404)]);
  await assert.rejects(drain(runStream({ runId: 'r1', fetch })), /Run not found/);
});

// --- Sending a turn --------------------------------------------------------

const transportWith = (fetch) => createDurableChatTransport({ config: { model: 'm' }, fetch });

test('only the new message is sent: the rest are already rows', async () => {
  const { fetch, calls } = scripted([
    async () => json({ runId: 'run_1' }, 202),
    async () => new Response(null, { status: 204 }),
  ]);
  await drain(
    await transportWith(fetch).sendMessages({
      chatId: 'c1',
      messages: [
        { id: 'm1', role: 'user', parts: [] },
        { id: 'm2', role: 'user', parts: [] },
      ],
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined,
    }),
  );
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(
    sent.messages.map((message) => message.id),
    ['m2'],
  );
  assert.equal(sent.model, 'm', 'the run configuration travels with the turn');
});

test('a model changed between turns is used by the next one', async () => {
  // useChat holds one transport for the life of the conversation, so a new
  // model has to reach the instance that already exists or it never applies.
  const { fetch, calls } = scripted([
    async () => json({ runId: 'run_1' }, 202),
    async () => new Response(null, { status: 204 }),
  ]);
  const transport = transportWith(fetch);
  transport.setConfig({ model: 'other', freeOnly: true });
  await drain(
    await transport.sendMessages({
      chatId: 'c1',
      messages: [{ id: 'm1', role: 'user', parts: [] }],
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined,
    }),
  );
  assert.deepEqual(JSON.parse(calls[0].init.body).model, 'other');
});

test('a second submit tails the run already in flight instead of failing', async () => {
  // The work is happening. Reporting an error would hide a run that is already
  // producing output, and the owner would have no way to see it finish.
  const { fetch } = scripted([
    async () => json({ runId: 'run_1', alreadyRunning: true }, 409),
    async () => sse(frame(0, { type: 'text-delta', delta: 'hi' })),
    async () => new Response(null, { status: 204 }),
  ]);
  const chunks = await drain(
    await transportWith(fetch).sendMessages({
      chatId: 'c1',
      messages: [{ id: 'm1', role: 'user', parts: [] }],
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined,
    }),
  );
  assert.equal(chunks.length, 1);
});

test('a refusal is surfaced rather than swallowed into an empty answer', async () => {
  const { fetch } = scripted([
    async () => json({ error: 'Sign in to your private workspace.' }, 401),
  ]);
  await assert.rejects(
    transportWith(fetch).sendMessages({
      chatId: 'c1',
      messages: [{ id: 'm1', role: 'user', parts: [] }],
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined,
    }),
    /Sign in/,
  );
});

// --- Rejoining after a reload ----------------------------------------------

test('a reload with nothing running loads the conversation instead of a stream', async () => {
  const { fetch } = scripted([async () => json({ runId: null })]);
  const transport = transportWith(fetch);
  assert.equal(await transport.reconnectToStream({ chatId: 'c1' }), null);
  assert.equal(transport.activeRun(), null, 'there is nothing for Stop to cancel');
});

test('a reload mid-answer rejoins the run the server is still driving', async () => {
  const { fetch, calls } = scripted([
    async () => json({ runId: 'run_9', status: 'running' }),
    async () => sse(frame(3, { type: 'text-delta', delta: 'continues' })),
    async () => new Response(null, { status: 204 }),
  ]);
  const transport = transportWith(fetch);
  const stream = await transport.reconnectToStream({ chatId: 'c1' });
  assert.equal(transport.activeRun(), 'run_9', 'Stop now knows which run to cancel');
  assert.deepEqual(
    (await drain(stream)).map((chunk) => chunk.delta),
    ['continues'],
  );
  assert.match(calls[1].url, /\/api\/runs\/run_9\/stream/);
});

// --- Stopping ---------------------------------------------------------------

test('stopping asks the server, because closing a socket stops nothing', async () => {
  const { fetch, calls } = scripted([async () => json({ stopped: true, status: 'cancelled' })]);
  assert.equal(await cancelRun('run_9', fetch), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/api\/runs\/run_9\/cancel/);
});

test('a cancel the server refuses is reported as not stopped', async () => {
  const { fetch } = scripted([async () => json({ error: 'Run not found.' }, 404)]);
  assert.equal(await cancelRun('run_9', fetch), false);
});

test('a run that stops producing is backed off, not hammered', async () => {
  // The backoff used to be reset at the top of every iteration, including
  // iterations that received nothing — so `attempt` was always 0, the delay was
  // always the first one (250ms), and a stream that opened but yielded no
  // frames was re-opened 200 times at four requests a second. Each of those
  // re-reads the run's whole event log on a server that writes SQLite
  // synchronously, so the client's retry loop was making the stall worse.
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    // 200 with a body that ends immediately: the run exists, but nothing came.
    return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  };

  const controller = new AbortController();
  const stream = runStream({ runId: 'r1', fetch, signal: controller.signal });
  const reader = stream.getReader();
  const draining = reader.read().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));
  controller.abort();
  await draining;

  // 250 + 500 + 1000 + 2000 means four attempts inside two seconds. The old
  // behaviour made eight.
  assert.ok(calls <= 5, `re-opened the stream ${calls} times in 2s; the backoff is not engaging`);
  assert.ok(calls >= 2, 'it should still be retrying at all');
});
