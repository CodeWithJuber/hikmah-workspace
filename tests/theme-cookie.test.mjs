// Who is allowed to decide the page's colour, and when.
//
// The layout stamps `data-theme` from a cookie before anything paints, so the
// page is the owner's colour in its first frame. The workspace provider then
// mirrors its own preference back out. The order of those two is the whole
// story: the provider holds a session object it has not loaded yet, and the
// default session is light.
// Run: node --test tests/theme-cookie.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canPublishTheme, isTheme, THEME_COOKIE, themeCookie } from '../lib/theme.ts';

test('the workspace says nothing about the theme until it knows one', () => {
  // A dark-theme owner opening /workspace was flipped to light — not for a
  // frame, but written into the cookie and carried to every other surface,
  // until they set it again. The provider published the default session's
  // theme on mount, before the saved one arrived.
  assert.equal(canPublishTheme({ loaded: false, restoreFailed: false }), false, 'not before load');
  assert.equal(canPublishTheme({ loaded: true, restoreFailed: false }), true, 'once loaded');
  // A failed restore is the same situation permanently: nothing to publish, and
  // the cookie still holds the last thing the owner actually chose.
  assert.equal(canPublishTheme({ loaded: true, restoreFailed: true }), false);
  assert.equal(canPublishTheme({ loaded: false, restoreFailed: true }), false);
});

test('the default session is light, which is why the guard matters', () => {
  // If this ever stops being true the bug above changes shape rather than going
  // away, so it is pinned here next to the guard. Read as source because
  // session.ts pulls in the whole playground module graph.
  const source = readFileSync(new URL('../lib/playground/session.ts', import.meta.url), 'utf8');
  const defaults = source.slice(source.indexOf('export const defaultPreferences'));
  assert.match(defaults.slice(0, 200), /theme: 'light'/);
});

test('the provider writes the theme only behind that guard', () => {
  // The guard is worth nothing if a later edit reinstates the unconditional
  // write, and no test here can render the effect.
  const source = readFileSync(
    new URL('../components/playground/context.tsx', import.meta.url),
    'utf8',
  );
  const write = source.indexOf('document.documentElement.dataset.theme');
  assert.ok(write > -1, 'the provider no longer writes the theme at all');
  const guard = source.lastIndexOf('canPublishTheme(', write);
  assert.ok(guard > -1, 'the theme is written without checking canPublishTheme first');
  assert.ok(write - guard < 400, 'the guard is not in the same effect as the write');
});

test('the cookie is a year long, site-wide, and readable by the workspace', () => {
  const value = themeCookie('dark');
  assert.match(value, new RegExp(`^${THEME_COOKIE}=dark;`));
  assert.match(value, /Path=\/;/, 'every surface reads it, not just /workspace');
  assert.match(value, /Max-Age=31536000/, 'a theme is not a session');
  assert.match(value, /SameSite=Lax/);
  assert.doesNotMatch(value, /HttpOnly/, 'the workspace writes it from the browser');
  assert.equal(isTheme('dark'), true);
  assert.equal(isTheme('system'), false, 'there is no third option to fall through to');
});
