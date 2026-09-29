// visualViewport binding: the iOS keyboard listener.
// Run: node --test tests/visual-viewport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readVisualViewport, bindVisualViewport } from '../hooks/use-visual-viewport.ts';

/** A fake visualViewport: the fields the hook reads, plus manual dispatch. */
function fakeViewport(height, offsetTop = 0) {
  const listeners = new Map();
  const vv = {
    height,
    offsetTop,
    addEventListener: (name, fn) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    removeEventListener: (name, fn) => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((f) => f !== fn),
      );
    },
    dispatch: (name) => {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  };
  return vv;
}

test('resize to a reduced height reports keyboardOpen with the new height', () => {
  const vv = fakeViewport(800);
  const seen = [];
  const cleanup = bindVisualViewport(
    vv,
    () => 800,
    (s) => seen.push(s),
  );
  assert.ok(cleanup, 'binding should return a cleanup');
  assert.equal(seen[0].height, 800);
  assert.equal(seen[0].keyboardOpen, false);

  vv.height = 400;
  vv.dispatch('resize');
  assert.equal(seen.at(-1).height, 400);
  assert.equal(seen.at(-1).keyboardOpen, true);
  assert.equal(vv.listenerCount('resize'), 1);
  assert.equal(vv.listenerCount('scroll'), 1);
  cleanup();
  assert.equal(vv.listenerCount('resize'), 0);
  assert.equal(vv.listenerCount('scroll'), 0);
});

test('scroll reports the new offsetTop without touching keyboard state', () => {
  const vv = fakeViewport(400);
  const seen = [];
  bindVisualViewport(
    vv,
    () => 800,
    (s) => seen.push(s),
  );
  vv.offsetTop = 120;
  vv.dispatch('scroll');
  assert.equal(seen.at(-1).offsetTop, 120);
  assert.equal(seen.at(-1).keyboardOpen, true);
});

test('a full-height viewport is not a keyboard', () => {
  const vv = fakeViewport(800);
  const seen = [];
  bindVisualViewport(
    vv,
    () => 800,
    (s) => seen.push(s),
  );
  assert.equal(seen[0].keyboardOpen, false);
});

test('a 1px shortfall is rounding noise, not a keyboard', () => {
  const s = readVisualViewport(fakeViewport(799), 800);
  assert.equal(s.keyboardOpen, false);
  assert.equal(readVisualViewport(fakeViewport(798), 800).keyboardOpen, true);
});

test('absent visualViewport binds nothing and never crashes', () => {
  assert.equal(
    bindVisualViewport(
      null,
      () => 800,
      () => {},
    ),
    null,
  );
  assert.equal(
    bindVisualViewport(
      undefined,
      () => 800,
      () => {},
    ),
    null,
  );
});
