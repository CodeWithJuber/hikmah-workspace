// The chat shell's side drawers are hand-rolled, not radix, so this file
// pins their focus contract against the source (PR-11): opening a modal
// drawer moves focus inside via the shared helper, Escape closes through the
// helper's 'close' outcome, and closing returns focus to the opener — or, on
// a phone where the opener may be gone, to the topbar back chevron. The old
// code fell back to the desktop Conversations button (never rendered below
// the breakpoint) and accepted document.body (a silent no-op focus), so
// these fail against the pre-PR-11 shell and pass with it.
// Run: node --test tests/chat-drawer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = readFileSync(resolve(root, 'components/chat/chat-shell.tsx'), 'utf8');

test('the shell drives drawer focus through the shared helper module', () => {
  assert.ok(
    shell.includes("from '@/lib/ui/drawer-focus'"),
    'chat-shell must import the drawer-focus contract',
  );
  for (const name of ['focusFirstInDrawer', 'handleDrawerKey', 'pickReturnFocusTarget'])
    assert.ok(shell.includes(name), `chat-shell must use ${name}`);
});

test('opening a modal drawer moves focus inside it', () => {
  assert.ok(
    shell.includes('requestAnimationFrame(() => focusFirstInDrawer(root))'),
    'focus must move into the drawer on open',
  );
});

test("Escape closes the drawer through the helper's close outcome", () => {
  const at = shell.indexOf("if (outcome === 'close')");
  assert.ok(at > 0, "the trap must map the helper's 'close' outcome");
  const block = shell.slice(at, at + 300);
  for (const closer of ['setSidebarOpen(false)', 'closePanel()', 'setArtifact(null)'])
    assert.ok(block.includes(closer), `Escape must run ${closer}`);
});

test('closing returns focus to the opener, never to document.body', () => {
  const at = shell.indexOf('pickReturnFocusTarget(');
  assert.ok(at > 0, 'close must pick a return-focus target');
  const call = shell.slice(at, at + 200);
  // document.body is passed as the excluded body: focusing it is a silent
  // no-op that strands keyboard users (e.g. ?settings=connection deep links).
  assert.ok(call.includes('document.body'), 'document.body must be the excluded body');
});

test('the phone gets its own return-focus fallback, not the desktop button alone', () => {
  const at = shell.indexOf('pickReturnFocusTarget(');
  const call = shell.slice(at, at + 200);
  // The desktop Conversations button is not rendered below the breakpoint;
  // the narrow topbar back chevron must be in the fallback chain.
  assert.ok(
    call.includes('backButtonRef.current'),
    'the narrow back chevron must be a return-focus fallback',
  );
  assert.ok(shell.includes('ref={backButtonRef}'), 'the back chevron must carry the ref');
});

test('the narrow drawer is a labelled modal dialog', () => {
  assert.ok(shell.includes("role={narrow ? 'dialog' : undefined}"), 'drawer role');
  assert.ok(shell.includes('aria-modal={narrow || undefined}'), 'drawer aria-modal');
  assert.ok(
    shell.includes('inert={modalOpen || undefined}'),
    'the page behind a modal drawer is inert',
  );
});

test('drawer open/close never writes browser history', () => {
  assert.ok(!shell.includes('history.pushState'), 'no pushState in the chat shell');
  assert.ok(!shell.includes('history.replaceState'), 'no replaceState in the chat shell');
});

test('the scrim dismisses the drawer like Escape does', () => {
  const at = shell.indexOf('chat-drawer-scrim');
  assert.ok(at > 0, 'the modal scrim must exist');
  const block = shell.slice(at, at + 400);
  for (const closer of ['setSidebarOpen(false)', 'closePanel()', 'setArtifact(null)'])
    assert.ok(block.includes(closer), `scrim click must run ${closer}`);
});
