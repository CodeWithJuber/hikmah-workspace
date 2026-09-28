import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME_CELLS,
  isPromotable,
  markSynthetic,
  queryEpisodes,
  stripObservation,
  trainingEpisodes,
} from '../lib/research/episode-annotations.ts';
import { contentKey } from '../lib/text/normalise.ts';
import { sha256 } from '../lib/engines/meaning-engine.ts';
import { EpisodeModel } from '../lib/research/episode-model.ts';

const example = (overrides) => ({
  id: 'a1',
  runId: 'run-1',
  conversationId: 'conv-1',
  model: 'model-x',
  provider: 'prov',
  status: 'approved',
  prompt: 'How do I reset my password?',
  response: 'Click the reset link.',
  correction: null,
  effectiveResponse: 'Click the reset link in your inbox.',
  redactions: [],
  createdAt: '2026-09-28T00:00:00.000Z',
  reviewedAt: '2026-09-28T01:00:00.000Z',
  revision: 1,
  ...overrides,
});

test('approved examples become observations with provenance; pending/rejected skipped', () => {
  const approved = example({ id: 'a1', correction: 'Reviewed wording.' });
  const approvedPlain = example({ id: 'a2', prompt: 'Where is my invoice?' });
  const pending = example({ id: 'p1', status: 'pending' });
  const rejected = example({ id: 'r1', status: 'rejected' });
  const { episodes, skipped } = trainingEpisodes([approved, approvedPlain, pending, rejected]);

  assert.equal(episodes.length, 2);
  assert.equal(skipped, 2);

  const [first, second] = episodes;
  assert.equal(first.rowId, 'learning:a1');
  assert.equal(first.source, 'learning:a1');
  assert.equal(first.key, sha256(contentKey(approved.prompt)));
  assert.equal(first.sense, 'Click the reset link in your inbox.');
  assert.deepEqual([...first.allowed], ['approved', 'corrected']);
  assert.equal(first.episode, null);
  assert.deepEqual(
    { ...first.provenance },
    {
      annotationId: 'a1',
      reviewedAt: '2026-09-28T01:00:00.000Z',
      synthetic: false,
    },
  );

  assert.deepEqual([...second.allowed], ['approved'], 'no correction means no corrected cell');
  assert.equal(second.provenance.annotationId, 'a2');
});

test('approved examples with empty prompts or responses are skipped, not crashed', () => {
  const emptyPrompt = example({ id: 'e1', prompt: '   ' });
  const emptyResponse = example({ id: 'e2', effectiveResponse: '  ' });
  const { episodes, skipped } = trainingEpisodes([emptyPrompt, emptyResponse]);
  assert.equal(episodes.length, 0);
  assert.equal(skipped, 2);
});

test('long responses are truncated to the solver sense limit', () => {
  const long = example({ id: 'long', effectiveResponse: 'x'.repeat(500) });
  const { episodes } = trainingEpisodes([long]);
  assert.equal(episodes.length, 1);
  assert.ok(new TextEncoder().encode(episodes[0].sense).byteLength <= 256);
});

test('OUTCOME_CELLS is the documented, frozen outcome vocabulary', () => {
  assert.deepEqual([...OUTCOME_CELLS], ['approved', 'corrected']);
  assert.ok(Object.isFrozen(OUTCOME_CELLS));
});

test('synthetic rows are NEVER promotable, even with allowPromotion: true', () => {
  const { episodes } = trainingEpisodes([example({ id: 'a1' })]);
  const synthetic = markSynthetic(episodes[0]);
  assert.equal(synthetic.provenance.synthetic, true);
  assert.equal(isPromotable(synthetic), false);
  assert.equal(isPromotable(synthetic, { allowPromotion: true }), false);
  assert.equal(isPromotable(synthetic, { allowPromotion: false }), false);
});

test('markSynthetic works on plain solver rows too (no annotation to launder)', () => {
  const { episodes } = trainingEpisodes([example({ id: 'a1' })]);
  const synthetic = markSynthetic(stripObservation(episodes[0]));
  assert.equal(synthetic.provenance.synthetic, true);
  assert.equal(synthetic.provenance.annotationId, null);
  assert.equal(isPromotable(synthetic, { allowPromotion: true }), false);
});

test('approved annotations are promotable only via explicit opt-in, never automatically', () => {
  const { episodes } = trainingEpisodes([example({ id: 'a1' })]);
  const [obs] = episodes;
  // Default: not eligible. Promotion is opt-in, never automatic.
  assert.equal(isPromotable(obs), false);
  assert.equal(isPromotable(obs, { allowPromotion: false }), false);
  // Explicit opt-in: eligible as a *reviewed annotation* — this still does not
  // promote; actual promotion goes through the existing human review path.
  assert.equal(isPromotable(obs, { allowPromotion: true }), true);
  // Unknown origin (no provenance) is not eligible even when opted in.
  assert.equal(isPromotable(stripObservation(obs), { allowPromotion: true }), false);
});

test('stripObservation returns a solver-compatible plain row', () => {
  const { episodes } = trainingEpisodes([example({ id: 'a1' })]);
  const plain = stripObservation(episodes[0]);
  assert.ok(!('provenance' in plain));
  assert.equal(plain.source, 'learning:a1');
});

test('queryEpisodes runs the solver and allowPromotion defaults to false', () => {
  const a1 = example({ id: 'a1', prompt: 'How do I reset my password?' });
  const a2 = example({ id: 'a2', prompt: 'Where is my invoice?' });
  const { episodes } = trainingEpisodes([a1, a2]);
  const senses = Object.fromEntries(episodes.map((e) => [e.key, [e.sense]]));
  const model = new EpisodeModel([...OUTCOME_CELLS], senses, { scopeId: 'test:episodes' });
  for (const episode of episodes) model.add(stripObservation(episode));

  const key = sha256(contentKey(a1.prompt));
  const { result, allowPromotion } = queryEpisodes(model, key, { allowed: ['approved'] });
  assert.equal(allowPromotion, false, 'allowPromotion defaults to false');
  assert.equal(result.status, 'ENTAILED');
  assert.equal(result.value, 'Click the reset link in your inbox.');

  const opted = queryEpisodes(model, key, { allowed: ['approved'], allowPromotion: true });
  assert.equal(opted.allowPromotion, true, 'explicit opt-in is echoed back');
  assert.equal(opted.result.status, 'ENTAILED');
});
