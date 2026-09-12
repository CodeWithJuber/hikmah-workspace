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
