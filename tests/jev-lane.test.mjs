/** Jev preflight lane routing: the lane drives the branch, and a Jev that
 * cannot answer leaves the run exactly as it was.
 * Run: node --test tests/jev-lane.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { jevLane, applyJevLane } from '../lib/runs/jev-lane.ts';

const API_KEY = 'test-key';

const answerFetcher = (value) => async () => ({
  ok: true,
  json: async () => ({ answers: [{ id: 'route', value, probability: 0.9 }] }),
});

const base = () => ({ instructions: 'Be helpful.', deepResearch: false });

test('a deep-research lane switches on the existing deepResearch option', async () => {
  const lane = await jevLane('research the history of algebra', {
    apiKey: API_KEY,
    fetcher: answerFetcher('deep-research'),
  });
  assert.equal(lane, 'deep-research');
  const routed = applyJevLane(base(), lane, { unattended: false });
  assert.equal(routed.deepResearch, true);
  assert.equal(routed.instructions, 'Be helpful.');
});

test('a clarify lane asks first when attended, and stands down when unattended', async () => {
  const lane = await jevLane('fix it', { apiKey: API_KEY, fetcher: answerFetcher('clarify') });
  assert.equal(lane, 'clarify');
  const attended = applyJevLane(base(), lane, { unattended: false });
  assert.match(attended.instructions, /ask_user/);
  assert.match(attended.instructions, /Be helpful\./);
  assert.equal(attended.deepResearch, false);
  // An unattended run has no ask_user: the deterministic gate keeps standard.
  assert.deepEqual(applyJevLane(base(), lane, { unattended: true }), base());
});

test('a standard lane changes nothing', async () => {
  const lane = await jevLane('what time is it', {
    apiKey: API_KEY,
    fetcher: answerFetcher('standard'),
  });
  assert.equal(lane, 'standard');
  assert.deepEqual(applyJevLane(base(), lane, { unattended: false }), base());
});

test('a throwing fetcher fails safe to null and the run is unchanged', async () => {
  const lane = await jevLane('research the history of algebra', {
    apiKey: API_KEY,
    fetcher: async () => {
      throw new Error('down');
    },
  });
  assert.equal(lane, null);
  assert.deepEqual(applyJevLane(base(), lane, { unattended: false }), base());
});

test('a non-ok response or a missing route answer fails safe to null', async () => {
  const badStatus = await jevLane('hi', {
    apiKey: API_KEY,
    fetcher: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.equal(badStatus, null);
  const noAnswer = await jevLane('hi', {
    apiKey: API_KEY,
    fetcher: async () => ({ ok: true, json: async () => ({ answers: [] }) }),
  });
  assert.equal(noAnswer, null);
  const wrongId = await jevLane('hi', {
    apiKey: API_KEY,
    fetcher: async () => ({
      ok: true,
      json: async () => ({ answers: [{ id: 'other', value: 'deep-research' }] }),
    }),
  });
  assert.equal(wrongId, null);
});

test('an empty task never reaches the fetcher', async () => {
  let called = 0;
  const lane = await jevLane('   ', {
    apiKey: API_KEY,
    fetcher: async () => {
      called += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(lane, null);
  assert.equal(called, 0);
});

test('no api key means no call and a null lane', async () => {
  delete process.env.TYPESAFE_API_KEY;
  let called = 0;
  const lane = await jevLane('research the history of algebra', {
    fetcher: async () => {
      called += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(lane, null);
  assert.equal(called, 0);
});
