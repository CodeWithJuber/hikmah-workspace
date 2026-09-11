// Agents are a named bundle of instructions and a tool set. These cover what
// seeding does to a workspace someone has already made their own, what an
// allowlist actually narrows, and what a bad save is told.
// Run: node --test tests/agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.mjs';
import { AgentError, createAgentStore } from '../lib/agents/store.ts';
import { AGENT_TEMPLATES, BUILT_IN_TOOLS } from '../lib/agents/templates.ts';
import { buildRunAgent } from '../lib/ai/run-agent.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  t.after(() => db.close());
  let counter = 0;
  return createAgentStore(db, { newId: () => `a${++counter}` });
}

// --- Seeding ----------------------------------------------------------------

test('a new workspace starts with the built-in agents', async (t) => {
  const agents = setup(t).list('u1');
  assert.equal(agents.length, AGENT_TEMPLATES.length);
  assert.ok(agents.every((agent) => agent.builtIn));
});

test('a deleted built-in stays deleted', async (t) => {
  // Re-seeding would resurrect what the owner threw away. An agent is a
  // starting point they then own, unlike the MCP catalogue.
  const store = setup(t);
  const [first] = store.list('u1');
  assert.equal(store.delete(first.id, 'u1'), true);

  const after = store.list('u1');
  assert.equal(after.length, AGENT_TEMPLATES.length - 1);
  assert.ok(!after.some((agent) => agent.id === first.id));
});

test('a renamed built-in is not joined by the original', async (t) => {
  const store = setup(t);
  const original = AGENT_TEMPLATES[0].name;
  const target = store.list('u1').find((agent) => agent.name === original);
  store.save('u1', { id: target.id, name: 'My researcher', instructions: 'x' });

  const after = store.list('u1');
  assert.equal(after.length, AGENT_TEMPLATES.length, 'renaming is not adding');
  assert.ok(after.some((agent) => agent.name === 'My researcher'));
  assert.ok(!after.some((agent) => agent.name === original), 'the template does not come back');
});

test('one owner’s agents are not another’s', async (t) => {
  const store = setup(t);
  const [mine] = store.list('u1');
  store.save('u1', { id: mine.id, name: 'Mine only', instructions: '' });
  assert.ok(!store.list('u2').some((agent) => agent.name === 'Mine only'));
  assert.equal(store.get(mine.id, 'u2'), null);
  assert.equal(store.delete(mine.id, 'u2'), false);
});

// --- Saving -----------------------------------------------------------------

test('an unknown tool is named rather than silently dropped', async (t) => {
  // An agent quietly missing the tool its owner chose is worse than one that
  // would not save.
  const store = setup(t);
  assert.throws(
    () => store.save('u1', { name: 'Bad', tools: ['search_web', 'delete_production'] }),
    (error) => error instanceof AgentError && /delete_production/.test(error.message),
  );
});

test('an agent needs a name', async (t) => {
  const store = setup(t);
  assert.throws(() => store.save('u1', { name: '   ' }), AgentError);
});

test('editing an agent that is not yours reads as not found', async (t) => {
  const store = setup(t);
  const [agent] = store.list('u1');
  assert.throws(
    () => store.save('u2', { id: agent.id, name: 'Hijacked' }),
    (error) => error instanceof AgentError && error.status === 404,
  );
});

test('a saved agent round-trips its tools', async (t) => {
  const store = setup(t);
  const saved = store.save('u1', {
    name: 'Reader',
    description: 'Reads things',
    instructions: 'Read carefully.',
    tools: ['read_file', 'search_web', 'read_file'],
  });
  assert.deepEqual(saved.tools, ['read_file', 'search_web'], 'duplicates collapse');
  assert.equal(saved.builtIn, false);
  assert.deepEqual(store.get(saved.id, 'u1').tools, ['read_file', 'search_web']);
});

// --- What an allowlist actually narrows -------------------------------------

const provider = { baseUrl: 'https://openrouter.ai/api/v1', model: 'a/b:free', apiKey: 'k' };
const agentWith = (extra) =>
  buildRunAgent({
    provider,
    instructions: 'x',
    meaningModel: {},
    signal: new AbortController().signal,
    model: {},
    ...extra,
  });

test('no allowlist offers everything the run would offer anyway', async () => {
  const tools = Object.keys(agentWith({}).tools ?? {});
  assert.ok(tools.includes('search_web'));
  assert.ok(tools.includes('calculate'));
});

test('an allowlist narrows the built-ins to exactly what it names', async () => {
  const tools = Object.keys(agentWith({ enabledTools: ['search_web', 'calculate'] }).tools ?? {});
  assert.deepEqual(tools.sort(), ['calculate', 'search_web']);
});

test('an allowlist does not switch off an MCP server the owner turned on', async () => {
  // Narrowing which built-ins an agent uses is a different decision from which
  // servers are connected, and the second is not the agent's to make.
  const tools = Object.keys(
    agentWith({
      enabledTools: ['calculate'],
      mcp: {
        tools: { mcp__quran__fetch_quran: { description: 'x' } },
        approval: new Map(),
      },
    }).tools ?? {},
  );
  assert.ok(tools.includes('mcp__quran__fetch_quran'));
  assert.ok(tools.includes('calculate'));
  assert.ok(!tools.includes('search_web'));
});

test('a tool the owner switched off stays off, allowlist or not', async () => {
  // disabledTools is the owner's own switch and outranks a preset.
  const tools = Object.keys(
    agentWith({ enabledTools: ['search_web', 'calculate'], disabledTools: ['search_web'] }).tools ??
      {},
  );
  assert.deepEqual(tools, ['calculate']);
});

test('every template names only tools this workspace actually has', async () => {
  // A template naming a tool that does not exist would produce an agent that
  // cannot do the thing it is named for, and the store would refuse to save it.
  for (const template of AGENT_TEMPLATES)
    for (const tool of template.tools)
      assert.ok(BUILT_IN_TOOLS.includes(tool), `${template.name} names ${tool}`);
});
