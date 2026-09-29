/** Mobile tap-target ratchet (390px audit, 2026-09-29).
 *
 * Jev bump-40: the secondary controls a thumb actually hits on a phone —
 * the free-upgrade pill in the composer, starter chips in the agent-picker
 * sheet, first-run persona starters, artifact version pills — sit at 40px
 * min-height. The composer row itself is already 44px on <=600px (see
 * composer-flow.css), so this file guards the ones around it that used to
 * be 28-32px and easy to miss.
 *
 * These tests read the styles and components the way the browser does and
 * fail if anyone shrinks a target back below the bar. They are floors, not
 * equals: raising a target further must never break them.
 *
 * Run: node --test tests/mobile-touch-targets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allStyles } from './stylesheet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** Comments are prose about CSS, not CSS. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const css = strip(allStyles());

/** The rule body for the first selector match, so `min-height` below means
 * the rule's own declaration, not a substring coincidence elsewhere. */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'));
  assert.ok(m, `selector not found in styles: ${selector}`);
  return m[1];
}

/** Largest px value declared for `prop` inside a rule body. */
function maxPx(body, prop) {
  const values = [...body.matchAll(new RegExp(`${prop}\\s*:\\s*(\\d+)px`, 'g'))].map((m) =>
    Number(m[1]),
  );
  assert.ok(values.length > 0, `no ${prop} in px found in rule`);
  return Math.max(...values);
}

test('free-upgrade pill is a 40px tap target', () => {
  const body = ruleBody('.workspace-experience .chat-free-pill');
  assert.ok(
    maxPx(body, 'min-height') >= 40,
    `chat-free-pill min-height below 40px: ${body.trim().slice(0, 120)}`,
  );
});

test('artifact version pills are 40px tap targets', () => {
  const body = ruleBody('.artifact-version');
  assert.ok(
    maxPx(body, 'min-height') >= 40,
    `artifact-version min-height below 40px: ${body.trim().slice(0, 120)}`,
  );
});

test('agent-picker bottom sheet clears the home indicator', () => {
  // The safe-area padding lives in the <=600px docked-sheet override, not the
  // base rule: find the rule body that carries the docked `bottom: 0`.
  const escaped = '.agent-picker-sheet'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodies = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs'))].map(
    (m) => m[1],
  );
  const docked = bodies.find((b) => /bottom:\s*0/.test(b));
  assert.ok(docked, 'docked .agent-picker-sheet rule not found');
  assert.ok(
    docked.includes('env(safe-area-inset-bottom)'),
    'agent-picker-sheet has no safe-area-inset-bottom padding for the docked sheet',
  );
});

test('dialog close button is a 40px target (size-10)', () => {
  const dialog = read('components/ui/dialog.tsx');
  const closeTag = dialog.match(/<DialogPrimitive\.Close[\s\S]*?className="([^"]*)"/);
  assert.ok(closeTag, 'dialog close className not found');
  assert.ok(
    closeTag[1].split(/\s+/).includes('size-10'),
    `dialog close button className lacks size-10: ${closeTag[1].slice(0, 80)}`,
  );
  assert.ok(
    !closeTag[1].split(/\s+/).includes('size-8'),
    'dialog close button regressed to size-8',
  );
});

test('agent-picker starter chips are h-10, not h-8', () => {
  const picker = read('components/chat/agent-picker.tsx');
  assert.ok(
    picker.includes('h-10 rounded-full px-3 text-xs'),
    'agent-picker starter chips lost their h-10 sizing',
  );
  assert.ok(
    !picker.includes('h-8 rounded-full px-3 text-xs'),
    'agent-picker starter chips regressed to h-8',
  );
});

test('empty-state persona starters are h-10, not h-8', () => {
  const empty = read('components/chat/empty-state-onboarding.tsx');
  assert.ok(
    empty.includes('h-10 justify-start rounded-full px-3 text-xs'),
    'empty-state persona starters lost their h-10 sizing',
  );
  assert.ok(
    !empty.includes('h-8 justify-start rounded-full px-3 text-xs'),
    'empty-state persona starters regressed to h-8',
  );
});

test('no page-level overflow-x band-aid on the chat shell', () => {
  // The mobile chat layout must absorb the off-canvas drawer with
  // `overflow-x: clip` (keeps the transcript's own scrolling), never with a
  // blanket `overflow-x: hidden` that would swallow legitimate scroll.
  const chatCss = strip(read('app/styles/chat.css'));
  const hiddenOnShell = [...chatCss.matchAll(/\.chat-(body|view|shell)[^}]*overflow-x:\s*hidden/g)];
  assert.deepEqual(
    hiddenOnShell.map((m) => m[0].slice(0, 60)),
    [],
    'page-level overflow-x: hidden on the chat shell',
  );
});

test('(app) pages scroll inside the shell (P0: no-scroll pages)', () => {
  // The app shell is height:100dvh + overflow:hidden; without overflow-y on
  // .workspace-main every non-chat page taller than the viewport was clipped
  // with no scroll — content died behind the mobile bottom nav (device
  // report 2026-09-29 "No scroll in other pages").
  const body = ruleBody('.workspace-main');
  assert.ok(
    /overflow-y:\s*auto/.test(body),
    '.workspace-main does not scroll: non-chat pages are clipped',
  );
});

test('workspace settings tab row signals horizontal scroll (P1)', () => {
  // Seven tabs never fit a phone; the row scrolls, and the fade + hidden
  // scrollbar are the affordance that it does.
  const body = ruleBody(".admin-tabs > [data-slot='tabs-list']");
  assert.ok(/overflow-x:\s*auto/.test(body), 'admin tab row does not scroll');
  assert.ok(body.includes('mask-image'), 'admin tab row has no fade affordance for the scroll');
});

test('composer hint is mobile-aware (touch wording)', () => {
  // "Shift + Enter" does not exist on phones; the touch wording shows there.
  const view = read('components/chat/chat-view.tsx');
  assert.ok(
    view.includes('chat-hint-touch') && view.includes('Tap the arrow to send'),
    'chat-view has no touch-specific composer hint',
  );
  const hintBody = ruleBody('.workspace-experience .chat-hint-touch');
  assert.ok(/display:\s*none/.test(hintBody), 'touch hint not hidden by default');
  assert.ok(
    /@media\s*\(hover:\s*none\)[\s\S]*?\.workspace-experience \.chat-hint-touch\s*\{[^}]*display:\s*inline/.test(
      css,
    ),
    'touch hint not shown on hover:none',
  );
});

test('saved-key placeholder fits a phone input (C)', () => {
  // The old "A key is saved for OpenRouter. Type to replace it." truncated
  // mid-word ("Type t") on mobile widths.
  const conn = read('components/chat/connection-settings.tsx');
  assert.ok(
    !conn.includes('A key is saved for'),
    'saved-key placeholder still uses the long truncating wording',
  );
});
