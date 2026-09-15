// What a panel says when it could not load, and whether its actions can be
// reached by a thumb.
//
// Two defects with the same shape: the interface asserting something it does
// not know. A failed request was caught into an empty array, so "couldn't
// reach the server" rendered as "No conversations yet." — a confident, false
// statement about someone's own data. And the row actions were `opacity: 0`
// until `:hover`, with a comment claiming `:focus-visible` kept them reachable
// without a mouse. A phone has neither a pointer to hover with nor keyboard
// focus without a keyboard, and all three of these panels are drawers on a
// phone, so deleting a conversation, a file or an agent was impossible by
// touch.
//
// Run: node --test tests/panel-states.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { allStyles } from './stylesheet.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
// The rules moved into app/styles/*; allStyles follows the import graph.
const css = allStyles();

const PANELS = [
  ['components/chat/conversation-list.tsx', 'conversations'],
  ['components/chat/files-panel.tsx', 'files'],
  ['components/chat/agents-panel.tsx', 'agents'],
];

test('a failed load is never reported as an empty one', () => {
  for (const [file] of PANELS) {
    const source = read(file);
    // The tell: catching into the empty value the empty state renders from.
    assert.doesNotMatch(
      source,
      /catch\([^)]*\)\s*=>\s*\{?\s*if \(live\) set\w+\(\[\]\)/,
      `${file} still turns a failed request into an empty list`,
    );
    assert.match(source, /setFailed\(true\)/, `${file} has no way to record that a load failed`);
    assert.match(source, /Couldn&rsquo;t load/, `${file} never tells the reader the load failed`);
  }
});

test('the failure is recoverable without reloading the page', () => {
  for (const [file] of PANELS) {
    const source = read(file);
    assert.match(source, /Try again/, `${file} reports a failure with no way out of it`);
    // Retry has to actually re-run the load, not just clear the message.
    assert.match(
      source,
      /setAttempt\(\(n\) => n \+ 1\)/,
      `${file}'s retry does not re-trigger the fetch`,
    );
    assert.match(source, /attempt\]\)/, `${file}'s effect does not depend on the retry counter`);
  }
});

test('a failed load does not wipe rows that are already on screen', () => {
  // The failure is its own state, deliberately: if it lived in the rows (a null
  // or an empty array meaning "broken") then a refresh that failed would blank
  // a list the reader was already looking at. Keeping them separate is what
  // makes a failed *re*load harmless.
  for (const [file] of PANELS) {
    const source = read(file);
    assert.match(
      source,
      /const \[failed, setFailed\] = useState\(false\)/,
      `${file} does not track failure separately from its rows`,
    );
    // And the rendered branch has to consult it before the empty state, or the
    // empty state wins and the lie comes back.
    const failedAt = source.indexOf('{failed ?');
    assert.ok(failedAt > -1, `${file} does not branch on the failure at all`);
    const emptyAt = source.search(/length === 0 \?/);
    assert.ok(
      emptyAt === -1 || failedAt < emptyAt,
      `${file} checks its empty state before its failure, so a failure still reads as empty`,
    );
  }
});

test('row actions are reachable on a touch screen', () => {
  // `opacity: 0` plus `:hover` is unreachable on a phone, and these three
  // panels are drawers on a phone.
  for (const selector of ['.conversation-delete', '.files-delete']) {
    // Found by pattern rather than at column zero: globals.css wraps its rules
    // in `@layer components`, so every selector in it is now indented.
    const found = new RegExp(`\n\\s*\\${selector} \\{`).exec(css);
    assert.ok(found, `${selector} has no rule`);
    const start = found.index;
    const block = css.slice(start, css.indexOf('}', start));
    assert.doesNotMatch(
      block,
      /opacity:\s*0;/,
      `${selector} is invisible until hover, so it cannot be pressed on a phone`,
    );
    assert.match(block, /opacity:\s*0\.\d+/, `${selector} should be dimmed, not hidden`);
    // And large enough to hit: WCAG 2.2 asks for 24px, a thumb wants more.
    assert.match(block, /min-width:\s*(3[2-9]|[4-9]\d)px/, `${selector} is too narrow to press`);
    assert.match(block, /min-height:\s*(3[2-9]|[4-9]\d)px/, `${selector} is too short to press`);
  }
});

test('hovering still brings the action to full strength', () => {
  // Dimmed by default is only acceptable if a pointer still gets the old
  // behaviour; this is what keeps the desktop experience unchanged.
  for (const selector of ['.conversation-delete', '.files-delete']) {
    assert.ok(
      css.includes(`${selector}:hover`),
      `${selector} never reaches full opacity under a pointer`,
    );
  }
});
