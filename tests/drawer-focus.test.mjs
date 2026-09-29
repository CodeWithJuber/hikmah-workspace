// The chat shell's custom drawers own their focus contract (PR-11): focus
// moves inside when the drawer opens as a modal, Tab cycles within it,
// Escape closes, and closing returns focus to the opener. The contract lives
// in lib/ui/drawer-focus.ts as pure functions over a minimal element shape;
// this file drives them with fakes, no DOM required.
// Run: node --test tests/drawer-focus.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'hikmah-drawer-focus-'));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, 'drawer-focus.cjs');
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import { focusableElements, focusFirstInDrawer, handleDrawerKey, pickReturnFocusTarget } from './lib/ui/drawer-focus';
      export const api = { focusableElements, focusFirstInDrawer, handleDrawerKey, pickReturnFocusTarget };
    `,
    resolveDir: root,
    sourcefile: 'drawer-focus-test.ts',
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const { api } = createRequire(import.meta.url)(output);

/** A fake element with just the surface lib/ui/drawer-focus.ts needs. */
const makeEl = ({ rects = 1, inert = false } = {}) => {
  const el = {
    focused: 0,
    focus() {
      el.focused += 1;
    },
    getClientRects: () => ({ length: rects }),
    closest: (selector) => (inert && selector === '[inert]' ? {} : null),
  };
  return el;
};

/** A fake drawer root holding fake elements. */
const makeRoot = (children) => {
  const node = {
    children,
    focused: 0,
    focus() {
      node.focused += 1;
    },
    querySelectorAll: () => children,
    contains: (candidate) => children.includes(candidate),
  };
  return node;
};

const keyEvent = (key, shiftKey = false) => {
  const event = {
    key,
    shiftKey,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
};

test('focusableElements keeps visible controls in tab order, drops hidden ones', () => {
  const visible = [makeEl(), makeEl(), makeEl()];
  const hidden = makeEl({ rects: 0 });
  const found = api.focusableElements(makeRoot([visible[0], hidden, visible[1], visible[2]]));
  assert.deepEqual(found, visible);
});

test('focusFirstInDrawer focuses the first control, or the drawer when empty', () => {
  const [first, second] = [makeEl(), makeEl()];
  const drawer = makeRoot([first, second]);
  api.focusFirstInDrawer(drawer);
  assert.equal(first.focused, 1);
  assert.equal(second.focused, 0);
  const empty = makeRoot([]);
  api.focusFirstInDrawer(empty);
  assert.equal(empty.focused, 1);
});

test('Escape closes the drawer and is swallowed', () => {
  const drawer = makeRoot([makeEl()]);
  const event = keyEvent('Escape');
  assert.equal(api.handleDrawerKey(drawer, null, event), 'close');
  assert.ok(event.prevented);
});

test('Tab on the last control wraps to the first', () => {
  const [first, , last] = [makeEl(), makeEl(), makeEl()];
  const drawer = makeRoot([first, makeEl(), last]);
  const event = keyEvent('Tab');
  assert.equal(api.handleDrawerKey(drawer, last, event), 'trapped');
  assert.ok(event.prevented);
  assert.equal(first.focused, 1);
});

test('Shift+Tab on the first control wraps to the last', () => {
  const [first, , last] = [makeEl(), makeEl(), makeEl()];
  const drawer = makeRoot([first, makeEl(), last]);
  const event = keyEvent('Tab', true);
  assert.equal(api.handleDrawerKey(drawer, first, event), 'trapped');
  assert.ok(event.prevented);
  assert.equal(last.focused, 1);
});

test('Tab in the middle of the drawer is left alone', () => {
  const [first, middle, last] = [makeEl(), makeEl(), makeEl()];
  const drawer = makeRoot([first, middle, last]);
  const event = keyEvent('Tab');
  assert.equal(api.handleDrawerKey(drawer, middle, event), 'ignored');
  assert.ok(!event.prevented);
  assert.equal(first.focused + middle.focused + last.focused, 0);
});

test('focus that escaped the drawer is pulled back in on Tab', () => {
  const [first, , last] = [makeEl(), makeEl(), makeEl()];
  const drawer = makeRoot([first, makeEl(), last]);
  const outsider = makeEl();
  assert.equal(api.handleDrawerKey(drawer, outsider, keyEvent('Tab')), 'trapped');
  assert.equal(first.focused, 1);
  assert.equal(api.handleDrawerKey(drawer, outsider, keyEvent('Tab', true)), 'trapped');
  assert.equal(last.focused, 1);
});

test('Tab in an empty drawer holds focus on the drawer itself', () => {
  const drawer = makeRoot([]);
  const event = keyEvent('Tab');
  assert.equal(api.handleDrawerKey(drawer, null, event), 'trapped');
  assert.ok(event.prevented);
  assert.equal(drawer.focused, 1);
});

test('ordinary keys are never intercepted', () => {
  const drawer = makeRoot([makeEl()]);
  for (const key of ['Enter', ' ', 'a', 'ArrowDown']) {
    const event = keyEvent(key);
    assert.equal(api.handleDrawerKey(drawer, null, event), 'ignored');
    assert.ok(!event.prevented, `${key} must not be swallowed`);
  }
});

test('return focus goes to the opener when it is still usable', () => {
  const opener = makeEl();
  const fallback = makeEl();
  assert.equal(api.pickReturnFocusTarget(opener, [fallback], makeEl()), opener);
});

test('a detached opener falls back to the first usable fallback', () => {
  const opener = makeEl({ rects: 0 });
  const [gone, fallback] = [makeEl({ rects: 0 }), makeEl()];
  assert.equal(api.pickReturnFocusTarget(opener, [gone, fallback], makeEl()), fallback);
});

test('an inert opener is skipped', () => {
  const opener = makeEl({ inert: true });
  const fallback = makeEl();
  assert.equal(api.pickReturnFocusTarget(opener, [fallback], makeEl()), fallback);
});

test('document.body is never a return target: deep links fall back', () => {
  // ?settings=connection opens the drawer with document.activeElement ===
  // document.body. Focusing body is a silent no-op, so the contract must skip
  // it and land on a real control instead.
  const body = makeEl();
  const fallback = makeEl();
  assert.equal(api.pickReturnFocusTarget(body, [fallback], body), fallback);
});

test('with nothing usable, return focus is null rather than a guess', () => {
  const body = makeEl();
  assert.equal(api.pickReturnFocusTarget(body, [makeEl({ rects: 0 })], body), null);
  assert.equal(api.pickReturnFocusTarget(null, [], body), null);
});
