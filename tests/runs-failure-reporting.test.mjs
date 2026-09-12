// A failed run has to say why.
//
// The worker writes the reason onto the run row and nothing forwarded it, so
// every failure reached the owner as the AI SDK's own "An error occurred." — a
// missing key, a rejected model and a provider outage all looked identical,
// and the one thing that told them apart was already written down.
//
// Worse, a run that fails before emitting a single chunk has no events at all,
// so the stream route answered 204 "nothing to send" and the reason never left
// the database. That is the commonest first-run failure there is.
// Run: node --test tests/runs-failure-reporting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nothingToSend, streamIsFinished } from '../lib/runs/resume.ts';

const failed = (error) => ({ status: 'failed', error });

test('a failure with no events is not "nothing to send"', () => {
  // The exact shape of a provider rejecting the key: terminal, zero events,
  // and a reason worth reading.
  assert.equal(nothingToSend(failed('No API key for this provider.'), 0, true), false);
});

test('the failure is offered once, not on every reconnect', () => {
  // The transport re-opens the stream until it gets a 204. Offering the notice
  // again to a client whose cursor is already past it would hand it the same
  // error up to MAX_CONTINUATIONS times.
  const run = { ...failed('No API key for this provider.'), event_seq: 4 };
  assert.equal(nothingToSend(run, 0, true, -1), false, 'a fresh client is told');
  assert.equal(nothingToSend(run, 0, true, 3), false, 'a client mid-run is told');
  assert.equal(nothingToSend(run, 0, true, 4), true, 'a client already told is not told twice');
  assert.equal(nothingToSend(run, 0, true, 9), true);
});

test('a failure that recorded no reason has nothing to add', () => {
  // Without a message there is genuinely nothing to send, and 204 is right.
  assert.equal(nothingToSend(failed(null), 0, true), true);
  assert.equal(nothingToSend(failed(''), 0, true), true);
});

test('unsent events always win, whatever the status', () => {
  assert.equal(nothingToSend({ status: 'done' }, 3, true), false);
  assert.equal(nothingToSend(failed('boom'), 3, true), false);
});

test('a finished or paused run with nothing pending still ends the stream', () => {
  assert.equal(nothingToSend({ status: 'done' }, 0, true), true);
  assert.equal(nothingToSend({ status: 'cancelled' }, 0, true), true);
  // A pause is an ending as far as the stream is concerned.
  assert.equal(nothingToSend({ status: 'waiting_approval' }, 0, false), true);
  assert.equal(nothingToSend({ status: 'waiting_client' }, 0, false), true);
});

test('a run still working is still worth tailing', () => {
  assert.equal(nothingToSend({ status: 'running' }, 0, false), false);
  assert.equal(nothingToSend({ status: 'queued' }, 0, false), false);
});

test('a missing run is nothing to send', () => {
  assert.equal(nothingToSend(null, 0, true), true);
  assert.equal(streamIsFinished(undefined, true), true);
});

// --- Which saved secret a run's key comes from ---------------------------

const { providerDestination } = await import('../lib/ai/endpoint.ts');
const { validateDestination } = await import('../server/workspace-secrets.mjs');

test('a run resolves its key against the provider, not the model', () => {
  // The bug: these routes built the destination from the model, so a perfectly
  // ordinary model name produced `provider:deepseek/deepseek-chat:free`.
  assert.equal(providerDestination('https://openrouter.ai/api/v1'), 'provider:openrouter');
  assert.equal(providerDestination('https://api.experientiallabs.ai/v1'), 'provider:experiential');
});

test('what the routes build is a destination the vault will accept', () => {
  // The whole failure in one assertion. The old string was rejected, the
  // rejection was swallowed by the caller's catch, and the run went to the
  // provider with an empty key — so a key the owner had saved was never used.
  assert.equal(
    validateDestination(providerDestination('https://openrouter.ai/api/v1')),
    'provider:openrouter',
  );
  for (const model of ['openrouter/free', 'deepseek/deepseek-chat:free', 'a/b'])
    assert.throws(() => validateDestination('provider:' + model), `provider:${model}`);
});

test('an endpoint that is not a known relay has no shared destination', () => {
  // A custom or local endpoint keeps its key elsewhere; inventing a
  // destination for it would resolve against somebody else's secret.
  assert.equal(providerDestination('http://127.0.0.1:11434/v1'), '');
  assert.equal(providerDestination('not a url'), '');
});
