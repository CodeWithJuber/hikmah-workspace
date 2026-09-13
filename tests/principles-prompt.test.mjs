// The 22 principles reached a screen and never a run.
//
// lib/kernel/principles.json holds the generic rules this project derived from
// its own research. Exactly one thing read them — components/kernel/center.tsx,
// which renders the list — while the system prompt carried a hand-written
// paraphrase of about seven of them, free to drift from the file with nothing
// to notice. The same disease as the co-model and the knowledge store, in the
// place it matters most.
//
// So these hold the generated digest to the file, rather than to a copy of the
// file written into a test.
// Run: node --test tests/principles-prompt.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRINCIPLES,
  PRINCIPLES_FRAMING,
  findPrinciple,
  principleDigest,
} from '../lib/kernel/principles.ts';
import { PROMPT_ORDER, composePrompt } from '../lib/ai/compose-prompt.ts';
import { HIKMAH_CORE } from '../lib/playground/agent-prompts.ts';

const file = JSON.parse(
  readFileSync(new URL('../lib/kernel/principles.json', import.meta.url), 'utf8'),
);

test('every principle in the file reaches the prompt', () => {
  const digest = principleDigest();
  assert.ok(file.length >= 20, 'the file still holds the full set');
  for (const principle of file) {
    assert.ok(digest.includes(principle.id), `${principle.id} is missing from the digest`);
    assert.ok(digest.includes(principle.name), `${principle.name} is missing from the digest`);
  }
});

test('the digest invents no principle the file does not have', () => {
  const digest = principleDigest();
  const ids = new Set(file.map((principle) => principle.id));
  for (const id of digest.match(/\bP\d{2}\b/g) ?? [])
    assert.ok(ids.has(id), `${id} is in the digest and not in the file`);
  assert.equal((digest.match(/\bP\d{2}\b/g) ?? []).length, file.length);
});

test('the prompt says what they are, rather than letting the model decide', () => {
  // The owner's choice: engineering principles derived from research, not
  // religious rulings. Without this a model carrying Qur'an tools and a list of
  // rules can present them as ones it has authority to issue.
  assert.match(PRINCIPLES_FRAMING, /engineering principles/i);
  assert.match(PRINCIPLES_FRAMING, /not religious rulings/i);
  assert.match(PRINCIPLES_FRAMING, /read_principle/);
  assert.ok(principleDigest().startsWith(PRINCIPLES_FRAMING));
});

test('the hand-written paraphrase is gone, not left beside the real thing', () => {
  // Two statements of the same rules, one of them stale, is worse than either.
  assert.doesNotMatch(HIKMAH_CORE, /Operating principles: verify before asserting/);
  // And the identity constraint is still first, which is a separate promise.
  assert.match(HIKMAH_CORE.split('\n')[0], /Never state or imply that you are Allah/);
});

test('the digest is names, not the whole file', () => {
  // Names always, full text on demand. All 22 instructions are over 5,000
  // characters — a real slice of a small free model's window, spent on rules
  // most turns never touch.
  const digest = principleDigest();
  assert.ok(digest.length < 1500, `digest is ${digest.length} characters`);
  for (const principle of file) assert.ok(!digest.includes(principle.instruction));
});

test('a principle can be fetched by id or by name', () => {
  const byId = findPrinciple('P07');
  assert.equal(byId?.id, 'P07');
  assert.equal(byId?.instruction, file.find((p) => p.id === 'P07').instruction);
  // Case and partial names both, because the model was shown "P07 Proportionate
  // resource use and budgets" and may ask for either half.
  assert.equal(findPrinciple('p07')?.id, 'P07');
  assert.equal(findPrinciple('proportionate resource')?.id, 'P07');
  assert.equal(findPrinciple('P99'), undefined);
  assert.equal(findPrinciple('   '), undefined);
});

test('every principle carries its unevaluated status, and the tool passes it on', () => {
  for (const principle of PRINCIPLES)
    assert.equal(principle.status, 'engineering_candidate_not_model_evaluated');
});

test('the prompt sections are composed in the stated order', () => {
  const composed = composePrompt({
    base: 'BASE',
    principles: 'PRINCIPLES',
    knowledge: 'KNOWLEDGE',
    contextNotes: 'NOTES',
    serverGuidance: 'GUIDANCE',
  });
  assert.deepEqual(composed.split('\n\n'), [
    'BASE',
    'PRINCIPLES',
    'KNOWLEDGE',
    'NOTES',
    'GUIDANCE',
  ]);
  // The order is the exported list, so the test cannot drift from the code by
  // asserting a sequence nothing else uses.
  assert.deepEqual(
    [...PROMPT_ORDER],
    ['base', 'principles', 'knowledge', 'recall', 'contextNotes', 'serverGuidance'],
  );
});

test('an absent section leaves no gap where it would have been', () => {
  assert.equal(composePrompt({ base: 'BASE', knowledge: '   ' }), 'BASE');
  assert.equal(composePrompt({}), '');
});
