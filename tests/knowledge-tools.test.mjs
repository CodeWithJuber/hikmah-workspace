import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge, retrieveKnowledge, knowledgePrompt } from '../lib/playground/knowledge.ts';
const note = (id, content, extra = {}) => ({
  id,
  title: id,
  content,
  kind: 'reference',
  source: 'User reviewed',
  createdAt: '2026-09-10',
  updatedAt: '2026-09-10',
  enabled: true,
  ...extra,
});
test('knowledge retrieval preserves exact negation, amounts and sources; excludes unrelated/disabled/suggested records', () => {
  const items = parseKnowledge([
    note('budget', 'Mumbai project budget is NOT 5000; it is 7500.'),
    note('other', 'Garden tomatoes'),
    note('disabled', 'Mumbai project', { enabled: false }),
    note('suggestion', 'Mumbai project', { status: 'suggested' }),
  ]);
  const selected = retrieveKnowledge(items, 'Mumbai project');
  assert.deepEqual(
    selected.map((x) => x.id),
    ['budget'],
  );
  assert.ok(knowledgePrompt(selected).includes('NOT 5000; it is 7500.'));
  assert.ok(knowledgePrompt(selected).includes('User reviewed'));
});
test('approve/edit/forget immediately changes retrieval; scope is server-owned', () => {
  let items = parseKnowledge([
    note('a', 'Use simple Hindi', { kind: 'preference', status: 'suggested', owner: 'someone' }),
  ]);
  assert.deepEqual(retrieveKnowledge(items, 'anything'), []);
  items = parseKnowledge([{ ...items[0], status: 'saved' }]);
  assert.equal(retrieveKnowledge(items, 'anything')[0].content, 'Use simple Hindi');
  items = parseKnowledge([{ ...items[0], content: 'Use English' }]);
  assert.equal(retrieveKnowledge(items, 'anything')[0].content, 'Use English');
  assert.deepEqual(retrieveKnowledge([], 'anything'), []);
  assert.equal(items[0].owner, undefined);
});
test('retrieval enforces a bounded prompt and never truncates a record', () => {
  const selected = retrieveKnowledge(
    [note('large', 'relevant '.repeat(1000)), note('small', 'relevant facts')],
    'relevant',
    300,
  );
  assert.deepEqual(
    selected.map((x) => x.id),
    ['small'],
  );
  assert.throws(() => parseKnowledge([note('same', 'one'), note('same', 'two')]));
});
// A test lived here asserting that the four chat modes all resolved the same
// tool set, and that `connector_call` appeared only when a connector had a
// catalogue. Both of its subjects are gone: the modes retired into agents, and
// the connector meta-tools were replaced by real MCP tools with real schemas.
// What an agent is allowed to run is now buildRunAgent's allowlist, covered by
// tests/agents and tests/chat-tools-menu.

// The tokeniser was `[\p{L}\p{N}]+`, which splits Hindi at the virama and
// Arabic at the harakat — so a vowelled Qur'anic phrase never matched its
// plain form, and a Hindi word never matched itself. Both fail against that
// tokeniser; see lib/text/normalise.ts.
test('a vowelled Arabic memory is found by its plain spelling', () => {
  const items = parseKnowledge([note('basmala', 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ')]);
  assert.deepEqual(
    retrieveKnowledge(items, 'الله').map((x) => x.id),
    ['basmala'],
  );
});
test('a Hindi word with a virama is one word, not three', () => {
  // Split at the virama, 'सब्र' (patience) is ['सब','र'] — and 'सब' (everything)
  // is a different word that then matches it. The fragments made false hits,
  // not misses, which is why this asks for the miss.
  const items = parseKnowledge([note('sabr', 'सब्र का मतलब धैर्य है')]);
  assert.deepEqual(
    retrieveKnowledge(items, 'सब्र').map((x) => x.id),
    ['sabr'],
  );
  assert.deepEqual(retrieveKnowledge(items, 'सब कुछ'), [], 'a different word is not a hit');
});
test('Urdu and Arabic keyboards meet: ک finds ك and ی finds ي', () => {
  const items = parseKnowledge([note('karachi', 'میں كراچي میں رہتا ہوں')]);
  assert.deepEqual(
    retrieveKnowledge(items, 'کراچی').map((x) => x.id),
    ['karachi'],
  );
});
test('preferences are capped to the six most used, so they cannot crowd every reference out', () => {
  const preferences = Array.from({ length: 9 }, (_, i) =>
    note('p' + i, 'Preference number ' + i, { kind: 'preference', uses: i }),
  );
  const items = parseKnowledge([...preferences, note('ref', 'The Mumbai cap is 7500.')]);
  const selected = retrieveKnowledge(items, 'Mumbai cap');
  const chosen = selected.filter((x) => x.kind === 'preference').map((x) => x.id);
  assert.equal(chosen.length, 6, 'six preferences, not nine');
  assert.deepEqual(chosen.sort(), ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'], 'the most used ones');
  assert.ok(
    selected.some((x) => x.id === 'ref'),
    'and the reference still fits',
  );
});
test('the prompt says where each item came from', () => {
  const items = parseKnowledge([
    note('q', 'Answer in Urdu.', { kind: 'preference', provenance: 'quote' }),
    note('s', 'Zakat is 2.5% of savings.', {
      provenance: 'source',
      source: 'https://example.test/zakat',
    }),
    note('i', 'Probably prefers short answers.', { provenance: 'inference' }),
  ]);
  const prompt = knowledgePrompt(items);
  assert.match(prompt, /"provenance":"quote"/);
  assert.match(prompt, /"provenance":"source"/);
  assert.match(prompt, /"provenance":"inference"/);
  assert.match(prompt, /own words/i, 'and the preamble says what the three mean');
});
