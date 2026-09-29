// The narrated pipeline stage index (see lib/chat/pipeline-stage.ts). These pin
// the mapping the waiting UI reads: a drift between the narration and the real
// stage boundaries reads as the product lying about what it is doing.
// Run: node --test tests/pipeline-stage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineStageIndex } from '../lib/chat/pipeline-stage.ts';

const base = {
  online: true,
  status: 'streaming',
  activityLabel: '',
  activityCompleted: 0,
  streamingText: false,
};

test('offline is always stage 0 (memory) — the run cannot be doing anything', () => {
  assert.equal(
    pipelineStageIndex({ ...base, online: false, streamingText: true, activityCompleted: 5 }),
    0,
  );
});

test('submitted is stage 0 before the provider responds', () => {
  assert.equal(pipelineStageIndex({ ...base, status: 'submitted' }), 0);
});

test('tool activity moves the narration to stage 1 (tools)', () => {
  assert.equal(pipelineStageIndex({ ...base, activityLabel: 'Using web_search' }), 1);
  assert.equal(pipelineStageIndex({ ...base, activityLabel: 'Running code' }), 1);
  assert.equal(pipelineStageIndex({ ...base, activityCompleted: 2 }), 1);
});

test('arrived text moves the narration to stage 3 (writing)', () => {
  assert.equal(pipelineStageIndex({ ...base, streamingText: true }), 3);
});

test('streaming with no tool activity and no text is stage 2 (planning)', () => {
  assert.equal(pipelineStageIndex({ ...base }), 2);
});

test('tool activity wins over arrived text — the tools are still the story', () => {
  assert.equal(pipelineStageIndex({ ...base, activityCompleted: 1, streamingText: true }), 1);
});

test('error and ready statuses do not crash the mapping', () => {
  assert.equal(pipelineStageIndex({ ...base, status: 'error' }), 2);
  assert.equal(pipelineStageIndex({ ...base, status: 'ready' }), 2);
});

test('a real run phase overrides the heuristic when present (PR-07)', () => {
  // Even with text streaming, a phase that says otherwise wins: the phase is
  // the run's own account of what it is doing, not a guess from the label.
  assert.equal(pipelineStageIndex({ ...base, phase: 'connecting-tools', streamingText: true }), 1);
  assert.equal(pipelineStageIndex({ ...base, phase: 'routing' }), 2);
  assert.equal(pipelineStageIndex({ ...base, phase: 'answering' }), 2);
  assert.equal(pipelineStageIndex({ ...base, phase: 'streaming' }), 3);
});

test('early phases all narrate as stage 0 (memory)', () => {
  for (const phase of ['submitted', 'preparing', 'queued', 'starting']) {
    assert.equal(pipelineStageIndex({ ...base, phase }), 0, phase);
  }
});

test('terminal and paused phases fall back to the heuristic', () => {
  // The narration is not shown then (the run is paused or done), so the
  // mapping must not claim a stage for them.
  for (const phase of ['awaiting-approval', 'awaiting-answer', 'done', 'failed', 'cancelled']) {
    assert.equal(pipelineStageIndex({ ...base, phase }), 2, phase);
  }
});

test('a null or missing phase leaves the heuristic untouched', () => {
  assert.equal(pipelineStageIndex({ ...base, phase: null, streamingText: true }), 3);
  assert.equal(pipelineStageIndex({ ...base, streamingText: true }), 3);
});
