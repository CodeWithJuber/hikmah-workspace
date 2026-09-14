// What one streamed answer costs the phone holding it.
//
// Measured on the standalone build at 390x844 with the CPU throttled 4x, over a
// 30-turn transcript while a 400-line code block streamed in: the main thread
// was blocked for 49 seconds, and one single task ran for 33 of them. A CPU
// profile named the cost precisely — `findNextMatchSync`, the TextMate regex
// engine inside Shiki, at 61% of all CPU.
//
// Three facts caused it, and this file pins all three, because each would
// regress silently: nothing throws, nothing looks wrong in a diff, and the only
// symptom is a phone that stops responding.
//
//   1. useChat committed once per streamed chunk.
//   2. MessageParts re-rendered every message on every one of those commits.
//   3. `isAnimating` was the run's status, so starting an answer flipped it on
//      every settled message at once and re-highlighted every code block in the
//      transcript.
//
// After: 14.0s blocking, worst task 8.1s — 71% and 76% down.
// Run: node --test tests/chat-streaming-cost.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

test('the chat commits on a frame budget, not on every streamed chunk', () => {
  const view = read('components/chat/chat-view.tsx');
  const throttle = view.match(/\bthrottle:\s*(\d+)/);
  assert.ok(
    throttle,
    'useChat has no throttle, so every chunk from the provider is a full React commit',
  );
  const ms = Number(throttle[1]);
  assert.ok(ms >= 16, `a ${ms}ms throttle is below one frame and buys nothing`);
  assert.ok(ms <= 250, `a ${ms}ms throttle is long enough for the answer to look stuck`);
});

test('a settled message is not re-rendered while a later one streams', () => {
  const parts = read('components/chat/message-parts.tsx');
  assert.match(
    parts,
    /export const MessageParts = memo\(/,
    'MessageParts is not memoised, so every message re-renders on every commit',
  );
  // A memo is only worth having if its props can actually compare equal. These
  // three were inline arrows built per message per render, which defeated it.
  const view = read('components/chat/chat-view.tsx');
  const map = view.slice(view.indexOf('messages.map('), view.indexOf('</ConversationContent>'));
  assert.doesNotMatch(
    map,
    /on(Regenerate|Edit|Question|Answer)=\{\s*\(/,
    'a handler is built inline per message, which defeats the memo entirely',
  );
  for (const handler of ['onAnswer', 'onRegenerateMessage', 'onEditMessage']) {
    assert.match(map, new RegExp(`${handler}=\\{\\w+\\}`), `${handler} is not a stable reference`);
  }
});

test('only the message being written is animating', () => {
  const parts = read('components/chat/message-parts.tsx');
  // `isAnimating={streaming}` where streaming was the run's status meant every
  // Streamdown in the transcript re-rendered — and re-ran Shiki — twice per
  // turn, once when the answer started and once when it finished.
  assert.match(
    parts,
    /const streaming = status === 'streaming' && isLast;/,
    'the animating flag is the run status, not the message — it will re-highlight the whole transcript',
  );
  const view = read('components/chat/chat-view.tsx');
  assert.match(
    view,
    /isLast=\{index === messages\.length - 1\}/,
    'nothing tells a message whether it is the newest one',
  );
});
