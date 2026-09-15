// Whether a run may reach a machine, read the safe way round.
//
// `lib/runs/service.ts` read `config.execution !== false`, so a run config that
// did not carry the key at all was granted the workbench shell and SSH. That is
// a gate that fails open: the one direction a gate must never fail. Absent now
// means no.
//
// Measured by building the real agent the way service.ts builds it and reading
// its tool map, as tests/run-media-entitlement.test.mjs does for media — not by
// describing the gate.
// Run: node --test tests/run-execution-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunAgent } from '../lib/ai/run-agent.ts';
import { executionAllowed } from '../lib/runs/execution.ts';

/** The real agent, built the way lib/runs/service.ts builds it: the same two
 * fields, gated by the same function. */
function toolsFor(config) {
  const execution = executionAllowed(config);
  const agent = buildRunAgent({
    provider: { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' },
    model: {},
    instructions: 'test',
    meaningModel: {},
    signal: new AbortController().signal,
    ssh: execution ? { listHosts: async () => [], userId: 'u1' } : undefined,
    shell: { conversationId: 'conv-1', available: execution },
  });
  return new Set(Object.keys(agent.tools));
}

const MACHINE_TOOLS = ['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts'];

test('a run whose config never said it could reach a machine does not', () => {
  // The whole point. Fails against `config.execution !== false`, which handed
  // this config a shell.
  const tools = toolsFor({});
  for (const name of MACHINE_TOOLS)
    assert.equal(tools.has(name), false, `${name} must not be offered to a config with no answer`);
  // And the run is otherwise whole: this removes some tools, not a run.
  assert.ok(tools.has('run_javascript'), 'everything else it had, it still has');
});

test('an explicit no is still no, and an explicit yes is still yes', () => {
  const refused = toolsFor({ execution: false });
  for (const name of MACHINE_TOOLS) assert.equal(refused.has(name), false, name);

  const allowed = toolsFor({ execution: true });
  for (const name of MACHINE_TOOLS) assert.ok(allowed.has(name), `${name} is offered when granted`);
});

test('the gate reads one field, and reads it closed', () => {
  assert.equal(executionAllowed({ execution: true }), true);
  assert.equal(executionAllowed({ execution: false }), false);
  assert.equal(executionAllowed({}), false, 'absent is no, unlike media');
  // The shapes a malformed or half-parsed config actually arrives in. Each of
  // these was granted a shell by `!== false`.
  for (const value of [undefined, null, 0, '', 'true', 'false', 1, {}, []])
    assert.equal(executionAllowed({ execution: value }), false, `${JSON.stringify(value)} is no`);
});
