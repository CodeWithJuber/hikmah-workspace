// The page lives in the URL hash, which anyone can type. These cover that only
// known pages are honoured and that the terminal is reachable by link.
// Run: node --test tests/workspace-navigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceDestination } from '../lib/playground/navigation.ts';

test('a known page is honoured, with or without a slash', () => {
  assert.equal(workspaceDestination('#/terminal'), 'terminal');
  assert.equal(workspaceDestination('#terminal'), 'terminal');
  assert.equal(workspaceDestination('#/admin/providers'), 'admin/providers');
});

test('an unknown page falls back to the workspace rather than rendering nothing', () => {
  for (const hash of ['', '#', '#/', '#/nope', '#/../admin', '#/terminal/extra']) {
    assert.equal(workspaceDestination(hash), 'workspace', hash);
  }
});

test('a hash cannot smuggle in a page by case or padding', () => {
  for (const hash of ['#/Terminal', '#/ terminal', '#/terminal ']) {
    assert.equal(workspaceDestination(hash), 'workspace', hash);
  }
});
