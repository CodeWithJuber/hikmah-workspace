// Browser Back/forward must navigate sensibly instead of breaking state
// (PR-11). The contract: drawers and sheets are ephemeral per-route UI —
// they never write browser history, so one Back always moves one route and a
// drawer can never trap the history stack. Route changes are the only thing
// that touches history: push for a new conversation, replace for transient
// param cleanup that Back should skip.
// Run: node --test tests/drawer-history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function sourcesUnder(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|mts)$/.test(name)) files.push(full);
    }
  };
  walk(join(root, dir));
  return files;
}

test('no drawer, sheet, dialog or nav component writes browser history', () => {
  const bad = [];
  for (const dir of ['components/app', 'components/chat', 'components/ui']) {
    for (const file of sourcesUnder(dir)) {
      const source = readFileSync(file, 'utf8');
      if (/history\.(pushState|replaceState)/.test(source)) bad.push(file.replace(root + '/', ''));
    }
  }
  assert.deepEqual(bad, [], 'history writers: ' + bad.join(', '));
});

test('closing the settings drawer replaces, never pushes, history', () => {
  const shell = read('components/chat/chat-shell.tsx');
  // The ?settings=connection param is transient drawer state: cleaning it up
  // must not leave a history entry that Back would land on.
  assert.ok(
    shell.includes('router.replace(`/chat/${encodeURIComponent(conversationId)}`'),
    'closePanel must replace the URL when clearing the settings param',
  );
  assert.ok(
    !/router\.push\([^)]*settings/.test(shell),
    'the settings param must never be pushed onto the history stack',
  );
});

test('the desktop /chat redirect replaces instead of pushing', () => {
  const entry = read('app/chat/chat-entry.tsx');
  assert.ok(
    entry.includes('router.replace(`/chat/${encodeURIComponent(latestId)}'),
    'landing on the latest conversation must not add a history entry',
  );
});

test('a new conversation is one push: Back returns to the previous one', () => {
  const shell = read('components/chat/chat-shell.tsx');
  assert.ok(
    shell.includes('router.push(`/chat/${encodeURIComponent(payload.id)}`)'),
    'newChat must push exactly one entry per conversation',
  );
});

test('the mobile More sheet is state-driven, not history-driven', () => {
  const bar = read('components/app/mobile-nav-bar.tsx');
  assert.ok(bar.includes('useState(false)'), 'the sheet opens from React state');
  assert.ok(
    bar.includes('<Sheet open={moreOpen} onOpenChange={setMoreOpen}>'),
    'the radix sheet is controlled by that state, with no URL coupling',
  );
});

test('the command palette is prop-driven, not history-driven', () => {
  const palette = read('components/chat/workspace-commands.tsx');
  assert.ok(
    palette.includes('<Dialog open={open} onOpenChange={onOpenChange}>'),
    'the palette opens from props, with no URL coupling',
  );
});
