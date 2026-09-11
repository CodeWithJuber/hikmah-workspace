// Compare mode answers the same question twice: once through the agent, once
// with no tools at all. These cover what the lane writes into the run, and what
// it does when the second answer is the one that goes wrong.
// Run: node --test tests/compare-lane.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPARE_PART_ID, runComparison } from '../lib/ai/compare.ts';
import { parseChatRequest, ChatRequestError } from '../lib/ai/chat-request.ts';

/** A language model that says the given words, one at a time. */
function speaking(words, { fail } = {}) {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test/baseline',
    supportedUrls: {},
    async doStream() {
      if (fail) throw new Error(fail);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            for (const word of words)
              controller.enqueue({ type: 'text-delta', id: '0', delta: word });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

const conversation = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'How do I restart nginx?' }] },
];

/** Run the lane and collect every chunk it wrote. */
async function lane(model, { signal } = {}) {
  const chunks = [];
  let tick = 0;
  const view = await runComparison({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    instructions: 'Be brief.',
    messages: conversation,
    signal: signal ?? new AbortController().signal,
    write: (chunk) => chunks.push(chunk),
    model,
    now: () => (tick += 10),
  });
  return { chunks, view };
}

test('the lane writes to one part id, so the transcript holds an answer not fragments', async () => {
  // Every chunk replaces the last. Without a shared id a hundred deltas would
  // become a hundred parts in the stored message.
  const { chunks } = await lane(speaking(['sudo ', 'systemctl ', 'restart ', 'nginx']));
  assert.ok(chunks.length > 1);
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.id))], [COMPARE_PART_ID]);
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.type))], ['data-' + COMPARE_PART_ID]);
});

test('the answer accumulates rather than being replaced by the latest delta', async () => {
  const { view, chunks } = await lane(speaking(['sudo ', 'systemctl ', 'restart ', 'nginx']));
  assert.equal(view.text, 'sudo systemctl restart nginx');
  assert.equal(chunks.at(-1).data.text, 'sudo systemctl restart nginx');
  assert.equal(chunks.at(-1).data.status, 'done');
});

test('the lane opens in a running state before any word arrives', async () => {
  // The panel has to be able to say "answering" from the first frame, or a slow
  // model looks like a broken one.
  const { chunks } = await lane(speaking(['hi']));
  assert.equal(chunks[0].data.status, 'running');
  assert.equal(chunks[0].data.text, '');
});

test('both timings are reported, because they answer different questions', async () => {
  // Time to the first word is what a person feels; the total is what the
  // workflow costs.
  const { view } = await lane(speaking(['a', 'b']));
  assert.ok(view.firstTextMs > 0, 'time to first word');
  assert.ok(view.latencyMs >= view.firstTextMs, 'total is not less than the first word');
});

test('the model that actually answered is reported, not the one asked for', async () => {
  // A provider may route elsewhere, and a comparison that names the wrong model
  // is worse than one that names none.
  const { view } = await lane(speaking(['x']));
  assert.equal(view.model, 'test/baseline');
});

test('a failed comparison costs the lane and not the run', async () => {
  // It is the second answer on the page. Failing the run would take the answer
  // the person actually asked for with it.
  const { view, chunks } = await lane(speaking([], { fail: 'model not found' }));
  assert.equal(view.status, 'failed');
  assert.match(view.error, /model not found/);
  assert.equal(chunks.at(-1).data.status, 'failed', 'and the transcript says so');
});

test('a run the person stopped is cancelled, not failed', async () => {
  // Calling a Stop they pressed themselves a failure is a small lie in a
  // transcript they will read later.
  const controller = new AbortController();
  controller.abort();
  const { view } = await lane(speaking(['x'], { fail: 'aborted' }), { signal: controller.signal });
  assert.equal(view.status, 'cancelled');
  assert.equal(view.error, undefined);
});

// --- What the request may ask for ------------------------------------------

const base = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'a/b:free',
  instructions: 'x',
  messages: conversation,
};

test('compare is off unless asked for', () => {
  assert.equal(parseChatRequest(base).compare, undefined);
  assert.equal(parseChatRequest({ ...base, compare: false }).compare, undefined);
  assert.equal(parseChatRequest({ ...base, compare: null }).compare, undefined);
});

test('compare with no model named compares workflows, not models', () => {
  // The lane falls back to the run's own model, which is the more useful
  // default: it isolates what the tools are buying.
  assert.deepEqual(parseChatRequest({ ...base, compare: {} }).compare, { model: undefined });
  assert.deepEqual(parseChatRequest({ ...base, compare: { model: '  ' } }).compare, {
    model: undefined,
  });
});

test('a named comparison model is carried through', () => {
  assert.deepEqual(parseChatRequest({ ...base, compare: { model: ' c/d:free ' } }).compare, {
    model: 'c/d:free',
  });
});

test('only the model may be chosen: the key and endpoint are not the caller’s', () => {
  // Everything else comes from the run's own configuration, so the comparison
  // cannot be pointed at another endpoint with the owner's credentials.
  const parsed = parseChatRequest({
    ...base,
    compare: { model: 'c/d', baseUrl: 'https://elsewhere.test', apiKey: 'stolen' },
  });
  assert.deepEqual(parsed.compare, { model: 'c/d' });
});

test('a malformed compare is refused rather than quietly ignored', () => {
  assert.throws(() => parseChatRequest({ ...base, compare: 'yes' }), ChatRequestError);
  assert.throws(() => parseChatRequest({ ...base, compare: [] }), ChatRequestError);
  assert.throws(() => parseChatRequest({ ...base, compare: { model: 42 } }), ChatRequestError);
  assert.throws(
    () => parseChatRequest({ ...base, compare: { model: 'x'.repeat(300) } }),
    ChatRequestError,
  );
});
