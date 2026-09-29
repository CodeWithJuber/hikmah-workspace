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
