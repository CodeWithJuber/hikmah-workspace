// The sr-only polite region announces the run edge (P0-4): "Working on your
// request." while busy, then exactly one settled announcement — "Response
// ready.", "Response stopped.", or "The request failed." — then silence.
// Never the answer text. A stop or failure must never be announced as ready.
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
  for (const outcome of [false, 'ready', 'stopped', 'error']) {
    assert.equal(busyAnnouncement(true, outcome), 'Working on your request.');
  }
});

test('a settled run announces ready', () => {
  assert.equal(busyAnnouncement(false, 'ready'), 'Response ready.');
});

test('a stopped run is announced as stopped, never as ready', () => {
  assert.equal(busyAnnouncement(false, 'stopped'), 'Response stopped.');
});

test('a failed run is announced as failed, never as ready', () => {
  assert.equal(busyAnnouncement(false, 'error'), 'The request failed.');
});

test('silence when nothing settled', () => {
  assert.equal(busyAnnouncement(false, false), '');
});

test('announcement never carries answer text', () => {
  for (const text of [
    busyAnnouncement(true, false),
    busyAnnouncement(false, 'ready'),
    busyAnnouncement(false, 'stopped'),
    busyAnnouncement(false, 'error'),
  ]) {
    assert.ok(text.length < 40, 'announcement stays a short atomic label');
  }
});
