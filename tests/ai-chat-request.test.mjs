// The chat route's decisions: who may start a run, and what a valid one looks
// like. A run spends the owner's provider budget and can reach the network, so
// these are the checks that keep another origin from starting one.
// Run: node --test tests/ai-chat-request.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatRequestError,
  MAX_ALLOWED_STEPS,
  assertSameOrigin,
  parseChatRequest,
} from '../lib/ai/chat-request.ts';

const ORIGIN = 'https://hikmah.example';
const request = (origin) =>
  new Request('https://hikmah.example/api/chat', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });

const valid = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/free',
  instructions: 'You are Hikmah.',
  messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
};

test('a same-origin request is accepted', () => {
  assert.doesNotThrow(() => assertSameOrigin(request(ORIGIN), ORIGIN));
});

test('another origin cannot start a run on the owner session', () => {
  assert.throws(() => assertSameOrigin(request('https://evil.example'), ORIGIN), ChatRequestError);
});

test('a missing Origin is untrusted, not waved through', () => {
  // A state-changing POST without an Origin header is exactly the shape a
  // cross-site form submission takes.
  try {
    assertSameOrigin(request(null), ORIGIN);
    assert.fail('should have rejected');
  } catch (error) {
    assert.equal(error.status, 403);
  }
});

test('a valid body is normalised, and free-only defaults to on', () => {
  const parsed = parseChatRequest({ ...valid, baseUrl: '  https://openrouter.ai/api/v1  ' });
  assert.equal(parsed.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(parsed.freeOnly, true, 'omitting freeOnly must not spend money');
  assert.deepEqual(parsed.disabledTools, []);
});

test('free-only is only off when explicitly set to false', () => {
  assert.equal(parseChatRequest({ ...valid, freeOnly: false }).freeOnly, false);
  assert.equal(parseChatRequest({ ...valid, freeOnly: 'no' }).freeOnly, true);
  assert.equal(parseChatRequest({ ...valid, freeOnly: 0 }).freeOnly, true);
});

test('an incomplete run configuration is rejected with a usable message', () => {
  for (const [patch, expected] of [
    [{ baseUrl: '' }, /provider endpoint/i],
    [{ model: '' }, /model/i],
    [{ instructions: '' }, /instructions/i],
    [{ messages: [] }, /message/i],
  ]) {
    assert.throws(() => parseChatRequest({ ...valid, ...patch }), expected);
  }
  assert.throws(() => parseChatRequest(null), ChatRequestError);
  assert.throws(() => parseChatRequest('a string'), ChatRequestError);
});

test('the step count is bounded so one request cannot run forever', () => {
  assert.equal(parseChatRequest({ ...valid, maxSteps: 4 }).maxSteps, 4);
  assert.equal(parseChatRequest(valid).maxSteps, undefined);
  for (const bad of [0, -1, 1.5, MAX_ALLOWED_STEPS + 1, '8']) {
    assert.throws(() => parseChatRequest({ ...valid, maxSteps: bad }), ChatRequestError, `${bad}`);
  }
});

test('apiKeySecret accepts a secret name and drops anything else', () => {
  // The field names a stored secret. Anything that is not a valid name, such as
  // a raw key pasted into it, is dropped rather than forwarded as a credential.
  assert.equal(parseChatRequest({ ...valid, apiKeySecret: 'MY_KEY' }).apiKeySecret, 'MY_KEY');
  for (const bad of ['sk-live-abc123', 'lower_case', '', 123, null]) {
    assert.equal(parseChatRequest({ ...valid, apiKeySecret: bad }).apiKeySecret, undefined);
  }
});

test('disabledTools keeps only strings', () => {
  const parsed = parseChatRequest({
    ...valid,
    disabledTools: ['search_web', 7, null, 'calculate'],
  });
  assert.deepEqual(parsed.disabledTools, ['search_web', 'calculate']);
});

test('deep research is a per-turn switch, off unless the body says exactly true', () => {
  const body = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'a/b',
    instructions: 'x',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }],
  };
  assert.equal(parseChatRequest(body).deepResearch, false);
  assert.equal(parseChatRequest({ ...body, deepResearch: true }).deepResearch, true);
  assert.equal(parseChatRequest({ ...body, deepResearch: 'yes' }).deepResearch, false);
});

test('web search is a per-turn switch, off unless the body says exactly true', () => {
  const body = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'a/b',
    instructions: 'x',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }],
  };
  assert.equal(parseChatRequest(body).webSearch, false);
  assert.equal(parseChatRequest({ ...body, webSearch: true }).webSearch, true);
  assert.equal(parseChatRequest({ ...body, webSearch: 1 }).webSearch, false);
});
