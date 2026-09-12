// The page lives in the URL hash, which anyone can type. These cover that only
// known pages are honoured and that the terminal is reachable by link.
// Run: node --test tests/workspace-navigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceDestination, DEFAULT_PAGE } from '../lib/playground/navigation.ts';

test('a known page is honoured, with or without a slash', () => {
  assert.equal(workspaceDestination('#/terminal'), 'terminal');
  assert.equal(workspaceDestination('#terminal'), 'terminal');
  assert.equal(workspaceDestination('#/admin/providers'), 'admin/providers');
});

test('an unknown page falls back to a real screen rather than rendering nothing', () => {
  for (const hash of ['', '#', '#/', '#/nope', '#/../admin', '#/terminal/extra']) {
    assert.equal(workspaceDestination(hash), DEFAULT_PAGE, hash);
  }
});

test('the retired chat page is not a page of this shell', () => {
  // It was the fallback, and it was the browser-run chat. Left in the list it
  // would resolve to a branch that renders nothing at all.
  assert.equal(workspaceDestination('#/workspace'), DEFAULT_PAGE);
});

test('the fallback is a screen that exists', () => {
  // The one property the fallback must have, and the one that broke when the
  // page it named was deleted.
  assert.equal(workspaceDestination('#/' + DEFAULT_PAGE), DEFAULT_PAGE);
});

test('a hash cannot smuggle in a page by case or padding', () => {
  for (const hash of ['#/Terminal', '#/ terminal', '#/terminal ']) {
    assert.equal(workspaceDestination(hash), DEFAULT_PAGE, hash);
  }
});
