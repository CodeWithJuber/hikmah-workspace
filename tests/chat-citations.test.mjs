// Inline citation pills: dedupe, marker finding, anchor ids, labels.
// Run: node --test tests/chat-citations.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeSources,
  findCitationMarkers,
  pillAriaLabel,
  sourceAnchorId,
  sourceLabel,
} from '../lib/chat/citations.ts';

const src = (over = {}) => ({ type: 'source-url', ...over });
const three = [
  src({ url: 'https://a.example', title: 'Alpha' }),
  src({ url: 'https://b.example', title: 'Beta' }),
  src({ url: 'https://c.example' }),
];

test('dedupe keeps first occurrence and order', () => {
  const parts = [
    src({ url: 'https://a.example', title: 'Alpha' }),
    src({ url: 'https://b.example', title: 'Beta' }),
    src({ url: 'https://a.example', title: 'Alpha again' }),
    { type: 'source-document', title: 'Doc' },
    { type: 'source-document', title: 'Doc' },
  ];
  const deduped = dedupeSources(parts);
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].title, 'Alpha');
  assert.equal(deduped[2].title, 'Doc');
});

test('anchor ids are message-scoped and sanitised', () => {
  assert.equal(sourceAnchorId('msg-1', 0), 'cite-msg-1-0');
  assert.equal(sourceAnchorId('weird id/here', 2), 'cite-weird-id-here-2');
});

test('finds resolvable markers in order', () => {
  const markers = findCitationMarkers('First claim [1] and second [2].', three);
  assert.deepEqual(
    markers.map((m) => m.index),
    [0, 1],
  );
  assert.equal(markers[0].start, 12);
  assert.equal('First claim [1] and second [2].'.slice(markers[1].start, markers[1].end), '[2]');
});

test('out-of-range marker is skipped', () => {
  assert.deepEqual(findCitationMarkers('Claim [9] here.', three), []);
});

test('marker for source without url/title is skipped', () => {
  const sources = [src({}), src({ url: 'https://b.example' })];
  const markers = findCitationMarkers('A [1] and B [2].', sources);
  assert.deepEqual(
    markers.map((m) => m.index),
    [1],
  );
});

test('markdown link/image markers are skipped', () => {
  assert.deepEqual(findCitationMarkers('See [1](https://x.example).', three), []);
  assert.deepEqual(findCitationMarkers('![1](img.png)', three), []);
});

test('no sources means no markers', () => {
  assert.deepEqual(findCitationMarkers('Claim [1].', []), []);
});

test('out-of-range markers resolve to nothing', () => {
  assert.deepEqual(findCitationMarkers('Claim [0] and [4] here.', three), []);
});

test('sourceLabel prefers title then url', () => {
  assert.equal(
    sourceLabel({ type: 'source-url', url: 'https://a.example', title: 'Alpha' }),
    'Alpha',
  );
  assert.equal(sourceLabel({ type: 'source-url', url: 'https://a.example' }), 'https://a.example');
  assert.equal(sourceLabel({ type: 'source-document' }), 'Source');
});

test('pill aria-label names the source', () => {
  assert.equal(pillAriaLabel(1, three[0]), 'Source 1: Alpha');
  assert.equal(pillAriaLabel(3, three[2]), 'Source 3: https://c.example');
});
