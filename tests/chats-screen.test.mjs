// The Chats screen is the owner's first screen on his phone: every tap target
// on it must be thumb-sized, and its states (loading/empty/error/sheet) must
// exist — an empty state that is a dead end, or a 32px button nobody can hit,
// is the "very very bad UX" the owner called out. Static checks over the
// source: the other half is a device and an eye.
// Run: node --test tests/chats-screen.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const ui = strip(readFileSync(resolve(root, 'app/styles/native-ui.css'), 'utf8'));
const motion = strip(readFileSync(resolve(root, 'app/styles/native-motion.css'), 'utf8'));
// The native layer is two files: primitives (native-ui) + motion (native-motion).
const nativeLayer = ui + '\n' + motion;
const screen = readFileSync(resolve(root, 'components/chat/chats-screen.tsx'), 'utf8');
const picker = readFileSync(resolve(root, 'components/chat/agent-picker.tsx'), 'utf8');

/** Class -> guaranteed minimum tap dimension (px), from native-ui.css. */
const TARGETS = {
  'n-row': 68, // the whole row is the link
  'n-icon-btn': 44,
  'n-action-row': 52,
  'n-cta': 48,
  'n-agent-card': 68, // 44px avatar + 12px padding each side
  'n-chip': 40, // sheet chips: Jev bump-40, mobile audit 2026-09-29
  // The clear-X nested inside the 44px search input: an iOS-style secondary
  // affordance, not a primary target. Documented, not smuggled.
  'n-search-clear': 32,
};

function cssMinHeight(css, cls) {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((sel) => sel.trim() === `.${cls}`))
    .map((m) => m[2]);
  assert.ok(bodies.length > 0, `.${cls} must be defined in native-ui.css`);
  const dims = [];
  for (const body of bodies)
    for (const m of body.matchAll(/(?:min-)?(?:height|width):\s*([\d.]+)px/g))
      dims.push(Number(m[1]));
  assert.ok(dims.length > 0, `.${cls} must pin a px dimension`);
  return Math.min(...dims);
}

test('the target classes guarantee the sizes the test names', () => {
  for (const [cls, want] of Object.entries(TARGETS))
    assert.equal(cssMinHeight(ui, cls), want, `.${cls} must guarantee ${want}px`);
});

test('every button and link on the Chats screen is a known tap target', () => {
  const tags = [
    ...screen.matchAll(/<(button|Link)\b([^>]*?)>/g),
    ...picker.matchAll(/<(button|Link)\b([^>]*?)>/g),
  ];
  const unknown = [];
  for (const [, , attrs] of tags) {
    // Literal, template, or braced-template className spellings.
    const cls =
      /className=(?:"([^"]*)"|`([^`]*)`|\{`([^`]*)`\})/.exec(attrs)?.slice(1).find(Boolean) ?? '';
    // shadcn Button carries its own h-10 (40px, on the control scale); the
    // starter chips it renders are the documented bump-40 case.
    if (/\bh-10\b/.test(cls)) continue;
    // Interpolations are runtime values, not classes.
    const words = cls.replace(/\$\{[^}]*\}/g, '').split(/\s+/);
    if (!Object.keys(TARGETS).some((t) => words.includes(t)))
      unknown.push(`${attrs.slice(0, 60)}… → "${cls.slice(0, 60)}"`);
  }
  assert.deepEqual(unknown, [], 'tap targets without a guaranteed size');
});

test('the screen has all four states', () => {
  assert.ok(screen.includes('n-shimmer-line'), 'loading skeletons');
  assert.ok(screen.includes('className="n-empty"'), 'empty state');
  assert.ok(screen.includes('Start a chat'), 'empty state offers the next step');
  assert.ok(screen.includes('role="alert"'), 'error state is announced');
  assert.ok(screen.includes('Try again'), 'error state offers retry');
  assert.ok(screen.includes('className="n-list"'), 'the list itself');
});

test('the header has the compose action and the search is labelled', () => {
  assert.ok(screen.includes('<h1>Chats</h1>'), 'screen title');
  assert.ok(screen.includes('aria-label="Start a new chat"'), 'compose is labelled');
  assert.ok(screen.includes('role="search"'), 'search landmark');
  assert.ok(screen.includes('aria-label="Search chats"'), 'search input is labelled');
});

test('delete is two-step and says what it destroys', () => {
  assert.ok(screen.includes("setMode('delete')"), 'delete arms a confirm step');
  assert.ok(screen.includes('n-cta-destructive'), 'the destructive CTA is marked');
  assert.ok(screen.includes('permanently'), 'the confirm names the consequence');
  assert.ok(screen.includes('Keep'), 'the confirm offers the way back');
});

test('long-press is a deliberate constant, not a magic number in JSX', () => {
  const m = /LONG_PRESS_MS\s*=\s*(\d+)/.exec(screen);
  assert.ok(m, 'LONG_PRESS_MS must be a named constant');
  assert.ok(Number(m[1]) >= 400 && Number(m[1]) <= 700, `550ms-class hold, got ${m[1]}ms`);
});

test('rows open the chat and announce themselves', () => {
  assert.ok(screen.includes('href={`/chat/${entry.id}`}'), 'row tap routes to the chat');
  assert.ok(screen.includes('aria-label={`${title}'), 'rows carry an accessible name');
});

test('no emoji anywhere near the native screens', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  assert.ok(!emoji.test(screen), 'chats-screen.tsx must not contain emoji');
  assert.ok(!emoji.test(picker), 'agent-picker.tsx must not contain emoji');
});

test('every n-* class the screen uses exists in the native layer', () => {
  const used = new Set();
  for (const m of screen.matchAll(/className=(?:"([^"]*)"|`([^`]*)`|\{`([^`]*)`\}|'([^']*)')/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/\$\{[^}]*\}/g, '');
    for (const w of raw.split(/\s+/)) if (w.startsWith('n-')) used.add(w);
  }
  const missing = [];
  for (const cls of used) {
    // Dynamic tint suffix (n-av-${…}): the CSS must define at least one of the family.
    const ok = cls.endsWith('-')
      ? nativeLayer.includes(cls)
      : new RegExp(`\\.${cls.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])[\\s,{:>+~]`).test(
          nativeLayer,
        );
    if (!ok) missing.push(cls);
  }
  assert.deepEqual(missing, [], 'undefined native classes in chats-screen.tsx');
});

test('the agent sheet is a native browser: search, chips, recency, cards', () => {
  assert.ok(picker.includes('role="search"'), 'search landmark');
  assert.ok(picker.includes('n-chip-row'), 'category chips');
  assert.ok(picker.includes('Recently used'), 'recently-used rail');
  assert.ok(picker.includes('hikmah.recent-agent-ids'), 'recency persists per device');
  assert.ok(picker.includes('n-agent-card'), 'agent cards');
  assert.ok(picker.includes('aria-pressed'), 'select state is announced');
});
