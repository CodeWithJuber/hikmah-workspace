// Phase 2A polish for the Chat view, its empty state, and its sheets (model
// picker, connection settings, tools menu): native sheet structure, tap
// targets on the bar, press states, and the two shimmer root-cause fixes the
// sheets depend on. Static checks over the source: the other half is a device
// and an eye.
// Run: node --test tests/chat-view-polish.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const ui = strip(readFileSync(resolve(root, 'app/styles/native-ui.css'), 'utf8'));
const motion = strip(readFileSync(resolve(root, 'app/styles/native-motion.css'), 'utf8'));
const experience = strip(readFileSync(resolve(root, 'app/styles/chat-experience.css'), 'utf8'));
const chat = strip(readFileSync(resolve(root, 'app/styles/chat.css'), 'utf8'));
const view = readFileSync(resolve(root, 'components/chat/chat-view.tsx'), 'utf8');
const empty = readFileSync(resolve(root, 'components/chat/empty-state-onboarding.tsx'), 'utf8');
const model = readFileSync(resolve(root, 'components/chat/model-picker.tsx'), 'utf8');
const connection = readFileSync(resolve(root, 'components/chat/connection-settings.tsx'), 'utf8');
const tools = readFileSync(resolve(root, 'components/chat/tools-menu.tsx'), 'utf8');

/** Fail fast if any of the touched surfaces regresses into emoji. */
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

test('the model picker is a native sheet, not a cmdk dialog wearing a costume', () => {
  // The DialogContent gets the sheet class; its own close stands down so the
  // sheet head's 44px n-icon-btn X is the only close (agent-picker.tsx has
  // both — the Phase 3 re-verify item).
  assert.ok(model.includes('className="model-dialog n-model-sheet"'), 'sheet class on the dialog');
  assert.ok(model.includes('showCloseButton={false}'), 'no second close button');
  assert.ok(
    model.includes('className="n-sheet-head n-model-head"') &&
      model.includes('aria-label="Close model picker"') &&
      model.includes('className="n-icon-btn n-press"'),
    'own head with title, sub, and the 44px close',
  );
  assert.ok(
    model.includes('className="n-chip-row"') && model.includes("className={'n-chip n-press'"),
    'filters are chips, not small secondary Buttons',
  );
  assert.ok(
    model.includes('className="n-stagger"') && model.includes("style={{ '--i': index }"),
    'rows stagger in per index',
  );
  assert.ok(
    model.includes('className="n-shimmer-line"') && model.includes('role="status"'),
    'loading is the shimmer primitive, announced',
  );
  assert.ok(
    model.includes('className="n-empty"') && model.includes('<SearchX size={32}'),
    'empty/error is the n-empty primitive with the 32px icon',
  );
  assert.ok(
    model.includes('className="n-sheet-foot n-model-foot"') &&
      model.includes('className="n-cta n-press"') &&
      />\s*Done\s*</.test(model),
    'the Done footer is a thumb-zone CTA',
  );
});

test('the connection form speaks the sheet interior language', () => {
  const fields = (connection.match(/className="n-sheet-field"/g) || []).length;
  assert.ok(fields >= 3, `at least the Provider/Endpoint/Key/Model fields (${fields} found)`);
  assert.ok(
    connection.includes('className="n-sheet-note"'),
    'helper text is the note style, not bare <small>',
  );
  assert.ok(connection.includes('n-action-row n-press'), 'disclosures are 52px action rows');
  assert.ok(
    connection.includes('className="chat-connection-actions n-sheet-foot"'),
    'Save/Test/Discard live in the sheet foot with safe-area clearance',
  );
  assert.ok(
    connection.includes('className="n-cta n-press"') &&
      connection.includes('className="n-cta n-cta-ghost n-press"') &&
      connection.includes('className="chat-connection-discard n-press"'),
    'Save is the CTA, Test its ghost, Discard the text action',
  );
});

test('the extra-help menu rows press like native action rows', () => {
  assert.ok(
    tools.includes('className="chat-composer-options-list n-stagger"'),
    'the options list staggers',
  );
  assert.ok(
    tools.includes('n-action-row n-press') && tools.includes("style={{ '--i': index }"),
    'options and task buttons are n-action-rows with stagger indices',
  );
});

test('the chat view head and composer respond to the thumb', () => {
  for (const label of ['Search in this conversation', 'Keyboard shortcuts', 'Export chat'])
    assert.ok(view.includes(label) && view.includes('className="n-press"'), label + ' presses');
  assert.ok(view.includes('Show {hidden} earlier'), 'the show-earlier button exists');
  assert.ok(
    view.match(/setShowEarlier\(true\)\}\s*\n?\s*className="n-press"/),
    'show earlier presses',
  );
  assert.ok(view.includes('className="chat-teach-dismiss n-press"'), 'teach dismiss presses');
  assert.ok(
    view.includes('className="chat-send-control n-press"') &&
      view.includes('className="chat-attach-control n-press"'),
    'send and attach press',
  );
  // The badge dismisses: n-search-clear is the 32px secondary-affordance
  // grammar, the same as the search field's clear-X. A plain size-12 X was
  // untappable.
  const clears = (view.match(/className="n-search-clear n-press"/g) || []).length;
  assert.equal(clears, 3, 'all three badge dismisses use n-search-clear (found ' + clears + ')');
});

test('the empty state starts the staggered way in', () => {
  assert.ok(empty.includes('n-stagger'), 'specialist cards and idea chips stagger');
  assert.ok(
    empty.includes('className="h-10 rounded-full px-4 n-press"'),
    'idea chips are h-10 (40px), not h-9',
  );
  assert.ok(
    empty.includes('className="n-search-clear n-press shrink-0') && empty.includes('<X size={16}'),
    'the disclosure dismiss is the 32px clear-X grammar',
  );
});

test('the shimmer primitive actually shimmers (root-cause fix)', () => {
  // .n-shimmer-line::after used to name a keyframe that never existed
  // (n-shimmer; the real one is n-shimmer-sweep), so every loading row was
  // statically gray and nobody noticed. Assert the wiring, not the pixels.
  assert.ok(motion.includes('@keyframes n-shimmer-sweep'), 'the sweep keyframe exists');
  const after = ui.match(/\.n-shimmer-line::after\s*\{[^}]*\}/);
  assert.ok(after, '.n-shimmer-line::after is defined');
  assert.ok(
    after[0].includes('n-shimmer-sweep') && !after[0].includes('animation: n-shimmer '),
    'the ::after animation names n-shimmer-sweep, not the missing n-shimmer',
  );
  assert.ok(
    motion.includes('.n-shimmer-line::after'),
    'reduced-motion kills the shimmer-line sweep too',
  );
});

test('the model sheet docks to the phone like the agent sheet does', () => {
  assert.ok(experience.includes('.n-model-sheet'), 'unscoped: the sheet portals to document.body');
  const media = experience.match(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*?\}\s*\}/);
  assert.ok(media, 'a 600px docking block exists');
  const docked = experience.includes('.n-model-sheet {') || experience.includes('.n-model-sheet{');
  assert.ok(docked, '.n-model-sheet gets the bottom-sheet docking');
  assert.ok(
    experience.includes('padding-bottom: max(16px, env(safe-area-inset-bottom))'),
    'the sheet clears the home indicator',
  );
});

test('the connection footer clears the panel bottom', () => {
  assert.ok(
    chat.includes('env(safe-area-inset-bottom)'),
    'the sheet foot carries safe-area padding',
  );
});

test('no emoji anywhere near the polished surfaces', () => {
  // chat-view.tsx carries one pre-existing ✕ in a comment, untouched by this
  // pass — scoped out rather than churned.
  for (const [name, src] of [
    ['empty-state-onboarding.tsx', empty],
    ['model-picker.tsx', model],
    ['connection-settings.tsx', connection],
    ['tools-menu.tsx', tools],
  ])
    assert.ok(!emoji.test(src), name + ' must not contain emoji');
});
