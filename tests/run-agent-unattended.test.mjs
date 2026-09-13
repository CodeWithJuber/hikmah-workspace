// An unattended run can never stop on a person.
//
// A background task, or a research lane, that calls `ask_user` or any tool
// gated behind the owner's approval pauses forever — nobody is watching the
// card — and keeps one of the owner's few run slots while it waits. So such a
// run is built without those tools at all, rather than with them and a hope.
// Run: node --test tests/run-agent-unattended.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

const provider = { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' };
const build = (extra) =>
  buildRunAgent({
    provider,
    model: {},
    instructions: 'x',
    meaningModel: {},
    signal: new AbortController().signal,
    ssh: {
      listHosts: () => [],
      credentialFor: async () => ({ type: 'password', password: 'p' }),
      stream: async function* () {},
    },
    shell: { available: true, conversationId: 'c1', run: async () => ({}) },
    mcp: {
      tools: {
        mcp__quran__fetch_quran: { description: 'reads', inputSchema: {} },
        mcp__ops__restart_service: { description: 'acts', inputSchema: {} },
      },
      approval: new Map([
        ['mcp__quran__fetch_quran', 'auto'],
        ['mcp__ops__restart_service', 'ask'],
      ]),
    },
    ...extra,
  });

test('an attended run offers the question and the gated tools', () => {
  const tools = Object.keys(build({}).tools ?? {});
  for (const name of ['ask_user', 'ssh_exec', 'bash', 'sandbox_run', 'mcp__ops__restart_service'])
    assert.ok(tools.includes(name), name + ' is offered when someone is there to answer');
});

test('an unattended run has no way to ask and no tool that would wait for approval', () => {
  const tools = Object.keys(build({ unattended: true }).tools ?? {});
  for (const name of ['ask_user', 'ssh_exec', 'bash', 'sandbox_run', 'mcp__ops__restart_service'])
    assert.ok(!tools.includes(name), name + ' must not be offered to a run nobody is watching');
  // What needs no approval stays: reading is how the task gets anything done.
  assert.ok(tools.includes('mcp__quran__fetch_quran'), 'an auto-approved server tool stays');
  assert.ok(tools.includes('search_web'), 'and so do the research tools');
  assert.ok(tools.includes('calculate'), 'and the deterministic ones');
});
