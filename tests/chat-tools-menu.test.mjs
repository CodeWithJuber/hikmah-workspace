/** The tools menu and the run's own tool set must not drift apart.
 *
 * The old workspace menu toggled nine names, four of which the server has
 * never heard of and none of which include the four the workbench adds. A menu
 * naming a tool the run does not have is a switch that changes nothing, and the
 * only way to notice is to try it — so the naming is checked here instead.
 * Run: node --test tests/chat-tools-menu.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AGENT_TEMPLATES as TEMPLATES, BUILT_IN_TOOLS } from '../lib/agents/templates.ts';
import { toolAvailability } from '../lib/agents/availability.ts';

const menu = await readFile('components/chat/tools-menu.tsx', 'utf8');

/** The keys of the LABELS map in the menu, read from the source: the menu must
 * not keep its own idea of what the tools are called. */
function labelledTools() {
  const block = menu.slice(menu.indexOf('const LABELS'), menu.indexOf('const label ='));
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
}

test('every tool the menu names is one the run can actually offer', () => {
  const known = new Set(BUILT_IN_TOOLS);
  for (const name of labelledTools())
    assert.ok(known.has(name), `${name} is labelled but is not a built-in tool`);
});

test('every built-in tool has a plain name, so none renders as an identifier', () => {
  const labelled = new Set(labelledTools());
  for (const name of BUILT_IN_TOOLS)
    assert.ok(labelled.has(name), `${name} would render as its identifier`);
});

test('the workbench tools are withheld when there is no workbench', () => {
  const without = new Map(toolAvailability({ workbench: false }).map((t) => [t.name, t]));
  for (const name of ['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts']) {
    assert.equal(without.get(name).available, false, `${name} should be unavailable`);
    assert.match(without.get(name).reason, /workbench/i, `${name} should say why`);
  }
  // And nothing else is withheld for that reason.
  assert.equal(
    without
      .values()
      .filter((tool) => !tool.available)
      .toArray().length,
    4,
  );
});

test('with a workbench, every built-in tool is on offer', () => {
  const withOne = toolAvailability({ workbench: true });
  assert.equal(withOne.length, BUILT_IN_TOOLS.length);
  assert.ok(withOne.every((tool) => tool.available));
});

test('the menu does not reach for the browser MCP client the server replaced', () => {
  // The old menu drove lib/playground/mcp-client directly. Connecting servers
  // is the run's decision now, made in lib/mcp/run-context.
  assert.doesNotMatch(menu, /mcp-client|connectConnector|connectorTools/);
  assert.doesNotMatch(menu, /usePlayground|useKernel/);
});

test('the code partner can run code without a workbench', async () => {
  // `coding` mode was three starter prompts and one prompt sentence, which is
  // what this agent already is. It needs an interpreter that does not depend on
  // a container, or the agent is useless on a deployment without one.
  const { AGENT_TEMPLATES } = await import('../lib/agents/templates.ts');
  const coder = AGENT_TEMPLATES.find((template) => template.name === 'Code partner');
  assert.ok(coder, 'the template the coding mode retires into must exist');
  assert.ok(coder.tools.includes('run_javascript'));
});

test('every tool an agent template names is a real one', () => {
  // A template naming a tool the run cannot offer narrows the agent to nothing.
  const known = new Set(BUILT_IN_TOOLS);
  for (const template of TEMPLATES)
    for (const name of template.tools)
      assert.ok(known.has(name), `${template.name} names ${name}, which is not a built-in tool`);
});
