// The sr-only polite region announces the run edge (P0-4): "Working on your
// request." while busy, "Response ready." once when streaming settles, then
// silence. Never the answer text.
// Run: node --test tests/chat-announce.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { busyAnnouncement, streamingJustSettled } from '../lib/chat/announce.ts';

test('streaming -> ready is a finish', () => {
  assert.equal(streamingJustSettled('streaming', 'ready'), true);
});

test('streaming -> error is a finish', () => {
  assert.equal(streamingJustSettled('streaming', 'error'), true);
});

test('streaming -> submitted is not a finish (still busy)', () => {
  assert.equal(streamingJustSettled('streaming', 'submitted'), false);
});

test('submitted -> streaming is not a finish (run just started)', () => {
  assert.equal(streamingJustSettled('submitted', 'streaming'), false);
});

test('idle transitions never announce', () => {
  assert.equal(streamingJustSettled('ready', 'ready'), false);
  assert.equal(streamingJustSettled('error', 'ready'), false);
  assert.equal(streamingJustSettled('ready', 'streaming'), false);
});

test('busy announcement wins while busy', () => {
  assert.equal(busyAnnouncement(true, true), 'Working on your request.');
  assert.equal(busyAnnouncement(true, false), 'Working on your request.');
});

test('just-finished announcement shows exactly once then clears', () => {
  assert.equal(busyAnnouncement(false, true), 'Response ready.');
  assert.equal(busyAnnouncement(false, false), '');
});

test('announcement never carries answer text', () => {
  for (const text of [busyAnnouncement(true, false), busyAnnouncement(false, true)]) {
    assert.ok(text.length < 40, 'announcement stays a short atomic label');
  }
});
