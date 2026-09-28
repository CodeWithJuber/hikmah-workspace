// Keyboard shortcut matching: chords per platform, in-field suppression,
// non-matches, and the master kill-switch.
// Run: node --test tests/chat-v2-shortcuts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUTS,
  EXISTING_SHORTCUTS,
  matchShortcut,
  shortcutKeys,
  isEditableTarget,
} from '../lib/chat/shortcuts.ts';

/** A DOM-like keydown event, the only shape matchShortcut reads. */
function key({ key, mod = false, shift = false, alt = false }) {
  return { key, metaKey: mod, ctrlKey: mod, shiftKey: shift, altKey: alt };
}

test('the advertised shortcuts are all present with both label sets', () => {
  const ids = SHORTCUTS.map((s) => s.id);
  assert.deepEqual(ids, [
    'new-chat',
    'focus-composer',
    'toggle-sidebar',
    'open-shortcuts-dialog',
    'stop-generation',
    'scroll-bottom',
  ]);
  for (const s of SHORTCUTS) {
    assert.ok(s.label, `${s.id} needs a label`);
    assert.ok(s.mac.length > 0 && s.win.length > 0, `${s.id} needs both label sets`);
    assert.ok(s.chord.key, `${s.id} needs a chord`);
  }
});

test('new chat: Cmd/Ctrl+Shift+O', () => {
  assert.equal(matchShortcut(key({ key: 'o', mod: true, shift: true }))?.id, 'new-chat');
  assert.equal(matchShortcut(key({ key: 'O', mod: true, shift: true }))?.id, 'new-chat');
  // Without shift it is something else entirely.
  assert.notEqual(matchShortcut(key({ key: 'o', mod: true }))?.id, 'new-chat');
});

test('focus composer: Cmd/Ctrl+J', () => {
  assert.equal(matchShortcut(key({ key: 'j', mod: true }))?.id, 'focus-composer');
});

test('toggle sidebar: Cmd/Ctrl+.', () => {
  assert.equal(matchShortcut(key({ key: '.', mod: true }))?.id, 'toggle-sidebar');
});

test('open shortcuts dialog: Cmd/Ctrl+/', () => {
  assert.equal(matchShortcut(key({ key: '/', mod: true }))?.id, 'open-shortcuts-dialog');
});

test('stop generation: bare Esc', () => {
  assert.equal(matchShortcut(key({ key: 'Escape' }))?.id, 'stop-generation');
  assert.equal(
    matchShortcut(key({ key: 'Escape', mod: true }))?.id,
    undefined,
    'Cmd+Esc is not the stop chord',
  );
});

test('scroll bottom: Cmd/Ctrl+End', () => {
  assert.equal(matchShortcut(key({ key: 'End', mod: true }))?.id, 'scroll-bottom');
});

test('plain typing matches nothing', () => {
  assert.equal(matchShortcut(key({ key: 'j' })), null);
  assert.equal(matchShortcut(key({ key: 'Enter' })), null);
  assert.equal(matchShortcut(key({ key: 'o', shift: true })), null);
});

test('a chord while typing in a field is ignored, except Esc', () => {
  assert.equal(
    matchShortcut(key({ key: 'j', mod: true }), { inField: true }),
    null,
    'focus-composer must not fire from inside the composer',
  );
  assert.equal(
    matchShortcut(key({ key: 'o', mod: true, shift: true }), { inField: true }),
    null,
    'new-chat must not fire while typing',
  );
  assert.equal(
    matchShortcut(key({ key: 'Escape' }), { inField: true })?.id,
    'stop-generation',
    'Esc still stops a run while the caret is in the composer',
  );
});

test('the kill-switch turns off all matching', () => {
  assert.equal(matchShortcut(key({ key: 'j', mod: true }), { enabled: false }), null);
  assert.equal(matchShortcut(key({ key: 'Escape' }), { enabled: false }), null);
});

test('Cmd+K is documented as existing, not rebound', () => {
  const listed = SHORTCUTS.map((s) => s.id);
  assert.ok(!listed.includes('global-search'), 'no shortcut here may claim Cmd+K');
  const existing = EXISTING_SHORTCUTS.find((s) => s.id === 'global-search');
  assert.ok(existing, 'the dialog needs the existing binding to show it as taken');
  assert.deepEqual(existing.mac, ['⌘', 'K']);
});

test('shortcutKeys is platform-aware', () => {
  const stop = SHORTCUTS.find((s) => s.id === 'stop-generation');
  assert.deepEqual(shortcutKeys(stop, true), ['Esc']);
  assert.deepEqual(shortcutKeys(stop, false), ['Esc']);
  const fresh = SHORTCUTS.find((s) => s.id === 'new-chat');
  assert.deepEqual(shortcutKeys(fresh, true), ['⌘', '⇧', 'O']);
  assert.deepEqual(shortcutKeys(fresh, false), ['Ctrl', 'Shift', 'O']);
});

test('isEditableTarget recognises typing surfaces', () => {
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'input' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget(null), false);
});
