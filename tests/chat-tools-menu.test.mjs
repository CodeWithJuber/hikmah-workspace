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

const menu = await readFile('components/chat/tool-switches.tsx', 'utf8');
const popover = await readFile('components/chat/tools-menu.tsx', 'utf8');
const toolsPage = await readFile('components/playground/runtime-home.tsx', 'utf8');

/** Source with its comments removed.
 *
 * These tests ask what the code does, and a comment explaining why something
 * was removed necessarily names the thing it removed — so matching raw source
 * would fail on the explanation. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/** The keys of the LABELS map, read from the source: no screen may keep its own
 * idea of what the tools are called. */
function labelledTools() {
  const block = menu.slice(menu.indexOf('const LABELS'), menu.indexOf('export const toolLabel'));
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

test('deployment-specific tools explain why they are withheld', () => {
  const without = new Map(
    toolAvailability({ workbench: false, typeform: false }).map((t) => [t.name, t]),
  );
  for (const name of ['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts']) {
    assert.equal(without.get(name).available, false, `${name} should be unavailable`);
    assert.match(without.get(name).reason, /workbench/i, `${name} should say why`);
  }
  for (const name of ['typeform_list_forms', 'typeform_read_responses']) {
    assert.equal(without.get(name).available, false, `${name} should be unavailable`);
    assert.match(without.get(name).reason, /Typeform/i, `${name} should say why`);
  }
  assert.deepEqual(
    without
      .values()
      .filter((tool) => !tool.available)
      .map((tool) => tool.name)
      .toArray()
      .sort(),
    [
      'bash',
      'list_ssh_hosts',
      'sandbox_run',
      'ssh_exec',
      'typeform_list_forms',
      'typeform_read_responses',
    ],
  );
});

test('with a workbench, every built-in tool is on offer', () => {
  const withOne = toolAvailability({ workbench: true, typeform: true });
  assert.equal(withOne.length, BUILT_IN_TOOLS.length);
  assert.ok(withOne.every((tool) => tool.available));
});

test('the menu does not reach for the browser MCP client the server replaced', () => {
  // The old menu drove lib/playground/mcp-client directly. Connecting servers
  // is the run's decision now, made in lib/mcp/run-context.
  assert.doesNotMatch(code(menu), /mcp-client|connectConnector|connectorTools/);
  assert.doesNotMatch(code(menu), /usePlayground|useKernel/);
});

test('both screens switch tools through the same list and the same store', () => {
  // The workspace page used to name five of the twenty-one tools and write
  // `preferences.enabledTools` in the workspace blob — a field nothing had read
  // since the browser run loop was retired, so its switches changed nothing.
  // One list, one store, or the two screens disagree again.
  for (const source of [popover, toolsPage]) {
    assert.match(source, /from '@\/components\/chat\/tool-switches'|from '\.\/tool-switches'/);
    assert.doesNotMatch(code(source), /const LABELS/, 'the names come from the shared list');
  }
  assert.match(toolsPage, /useChatSettings/);
  assert.match(toolsPage, /disabled=\{settings\.disabledTools\}/);
  // The usage, not the word: the file explains in a comment why that field is
  // gone, and a bare /enabledTools/ would match the explanation.
  assert.doesNotMatch(
    code(toolsPage),
    /enabledTools/,
    'the store keeps an off-list, not an on-list',
  );
});

test('the shared list is what reads the server\u2019s own tool list', () => {
  // Availability has to travel with the names, or a screen offers a switch for
  // something this deployment cannot run.
  assert.match(menu, /\bclientFetch\('\/api\/agents'/);
  assert.match(menu, /payload\.availability/);
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
