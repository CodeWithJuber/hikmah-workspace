// Where the MCP call is, where the answer is, and what Hikmah added.
//
// The transcript rendered every part in the order the model produced them, so
// reasoning, tool calls, MCP calls and the answer were one interleaved column.
// Reported as: you cannot tell where the MCP call is happening, where the
// actual response is, where the thinking is, or what value Hikmah is adding.
// Run: node --test tests/chat-working.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWorking, groupParts, toolProvenance } from '../lib/chat/working.ts';

const done = (type, over = {}) => ({ type, state: 'output-available', ...over });

test('the answer, the working and anything still asking are three different things', () => {
  const grouped = groupParts([
    { type: 'reasoning', text: 'thinking' },
    done('tool-mcp__quran__fetch_tafsir'),
    { type: 'text', text: 'Here is the answer.' },
    { type: 'data-plan', data: {} },
  ]);
  assert.deepEqual(
    grouped.answer.map((p) => p.text),
    ['Here is the answer.'],
  );
  assert.equal(grouped.working.length, 2);
  assert.deepEqual(
    grouped.live.map((p) => p.type),
    ['data-plan'],
  );
});

test('a question is never filed as working, however the activity setting is set', () => {
  const grouped = groupParts([{ type: 'tool-ask_user', state: 'input-available' }]);
  assert.equal(grouped.working.length, 0);
  assert.equal(grouped.live.length, 1);
});

test('a tool waiting for approval stays in front of the reader', () => {
  const grouped = groupParts([{ type: 'tool-bash', state: 'approval-requested' }]);
  assert.equal(grouped.live.length, 1);
  assert.equal(grouped.working.length, 0);
});

test('an MCP tool waiting for approval is not filed under the working', () => {
  // How an MCP tool actually arrives: the SDK knows nothing about it at build
  // time, so it is a dynamic-tool part with the name in toolName.
  const grouped = groupParts([
    {
      type: 'dynamic-tool',
      toolName: 'mcp__quran__fetch_grounding_rules',
      state: 'approval-requested',
    },
  ]);
  assert.equal(grouped.live.length, 1);
  assert.equal(grouped.working.length, 0);
});

test('the working names the MCP server rather than calling it Dynamic-tool', () => {
  const line = describeWorking([
    {
      type: 'dynamic-tool',
      toolName: 'mcp__quran__fetch_grounding_rules',
      state: 'output-available',
    },
  ]);
  assert.match(line, /quran/i);
  assert.doesNotMatch(line, /dynamic/i);
});

test('an MCP tool says which server answered', () => {
  assert.deepEqual(toolProvenance('tool-mcp__quran__fetch_tafsir'), {
    server: 'quran',
    tool: 'fetch_tafsir',
  });
  // A built-in has no server, and must not be given a fake one.
  assert.deepEqual(toolProvenance('tool-search_web'), { tool: 'search_web' });
  // A tool whose own name contains the separator keeps all of it.
  assert.deepEqual(toolProvenance('tool-mcp__git__log__all'), {
    server: 'git',
    tool: 'log__all',
  });
});

test('the header says what was done and where it came from', () => {
  const line = describeWorking([
    { type: 'reasoning' },
    done('tool-mcp__quran__fetch_tafsir'),
    done('tool-search_web'),
  ]);
  assert.match(line, /asked quran/i);
  assert.match(line, /searched the web/i);
  assert.match(line, /3 steps/);
});

test('the same tool twice is named once, and the step count still counts both', () => {
  const line = describeWorking([done('tool-search_web'), done('tool-search_web')]);
  assert.equal((line.match(/searched the web/gi) ?? []).length, 1);
  assert.match(line, /2 steps/);
});

test('thinking is counted, never quoted', () => {
  const line = describeWorking([{ type: 'reasoning', text: 'private chain of thought' }]);
  assert.doesNotMatch(line, /private chain of thought/);
  assert.match(line, /1 step/);
});

test('a tool added later is named from itself rather than as an identifier', () => {
  assert.match(describeWorking([done('tool-transition_estimate')]), /transition estimate/i);
});

test('nothing done means no header at all, not an empty one', () => {
  assert.equal(describeWorking([]), '');
});

test('a long list is trimmed with a count rather than run on', () => {
  const line = describeWorking(
    ['a', 'b', 'c', 'd', 'e'].map((n) => done('tool-mcp__' + n + '__go')),
  );
  assert.match(line, /and 2 more/);
});
