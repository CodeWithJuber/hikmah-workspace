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

test('a long transcript renders its newest turns, not all of them', () => {
  // Measured by subtraction on the post-throttle build: of the 14s a single
  // answer spent blocking the main thread over a 30-turn transcript, 7.8s was
  // the turns above the fold — Shiki tokenising code blocks nobody could see.
  // Dropping to 2 turns of history removed exactly that.
  const view = read('components/chat/chat-view.tsx');
  const size = view.match(/const WINDOW = (\d+);/);
  assert.ok(size, 'nothing bounds how many messages are rendered at once');
  const turns = Number(size[1]);
  assert.ok(turns >= 10, `a window of ${turns} would hide turns that fit on a screen`);
  assert.ok(turns <= 100, `a window of ${turns} is large enough to be no window at all`);
  assert.match(
    view,
    /messages\.slice\(hidden\)/,
    'the window is declared but the transcript still maps over every message',
  );
  // A window nobody can see past is lost history, not a fast transcript.
  assert.match(view, /Show \{hidden\} earlier/, 'there is no way to reach the earlier turns');
  // And the newest message must stay the newest one after slicing, or the
  // animating fix above silently stops applying.
  assert.match(
    view,
    /isLast=\{index === visible\.length - 1\}/,
    'isLast is computed against the full list while a slice is rendered',
  );
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
  // Against the rendered slice, not the whole list — see the windowing test
  // above, which pins the two together.
  assert.match(
    view,
    /isLast=\{index === visible\.length - 1\}/,
    'nothing tells a message whether it is the newest one',
  );
});
