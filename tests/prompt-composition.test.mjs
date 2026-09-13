// What the model is actually told.
//
// Three things had quietly stopped reaching it. The co-model, the owner's
// standing instructions and their response style went through workspacePrompt,
// which lost its only caller when the browser run loop was retired — so the
// settings stayed in the interface and did nothing. The connected MCP servers'
// own instructions were never used at all, which for the Quran server is the
// difference between a model that has its tools and a model that knows it must
// use them instead of answering from memory. And the core prompt still told the
// model to reach runtimes through connector_catalog, a tool deleted with that
// same run loop.
// Run: node --test tests/prompt-composition.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), 'hikmah-prompt-'));
await build({
  entryPoints: [
    'lib/chat/settings.ts',
    'lib/playground/agent-prompts.ts',
    'lib/ai/server-guidance.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { personalPrompt, DEFAULT_CHAT_SETTINGS, parseChatSettings, MAX_INSTRUCTIONS } = await import(
  pathToFileURL(join(dir, 'chat/settings.mjs'))
);
const { HIKMAH_CORE } = await import(pathToFileURL(join(dir, 'playground/agent-prompts.mjs')));

test('the core prompt names only tools that exist', () => {
  // connector_catalog and connector_call were the browser run loop's meta-tools
  // and went with it. Telling a model to reach a runtime through a tool it was
  // never given wastes a step and teaches it the tool set is unreliable.
  assert.doesNotMatch(HIKMAH_CORE, /connector_catalog|connector_call/);
  for (const real of ['run_javascript', 'bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts'])
    assert.match(HIKMAH_CORE, new RegExp(real), real + ' is a tool the run actually offers');
});

test('scripture comes from the canonical server, never from memory', () => {
  // The point of connecting Quran.com is that the model must not produce
  // Qur'anic text from training data. The prompt used to send it to
  // research_quran — this project's own AI-authored index, explicitly not
  // scripture — and then to "an authoritative source" it would have to guess at.
  assert.match(HIKMAH_CORE, /mcp__quran__\*/, 'the canonical tools are named');
  assert.match(HIKMAH_CORE, /never from memory/i);
  assert.match(
    HIKMAH_CORE,
    /research_quran is this project's own AI-authored index/,
    'and the ledger is labelled as what it is',
  );
});

test('the standing instructions reach the run, and are labelled as the person’s', () => {
  const settings = { ...DEFAULT_CHAT_SETTINGS, instructions: 'Reply in Urdu. Cite the edition.' };
  const prompt = personalPrompt(settings);
  assert.match(prompt, /Reply in Urdu/);
  assert.match(prompt, /standing instructions/, 'attributed, so it cannot read as a platform rule');
});

test('the defaults add nothing, so an untouched workspace is unchanged', () => {
  assert.equal(personalPrompt(DEFAULT_CHAT_SETTINGS), '');
});

test('response style and explain-decisions each say something specific', () => {
  const concise = personalPrompt({ ...DEFAULT_CHAT_SETTINGS, responseStyle: 'concise' });
  const detailed = personalPrompt({ ...DEFAULT_CHAT_SETTINGS, responseStyle: 'detailed' });
  assert.match(concise, /concisely/i);
  assert.match(detailed, /in depth/i);
  assert.notEqual(concise, detailed);
  assert.match(personalPrompt({ ...DEFAULT_CHAT_SETTINGS, explainDecisions: true }), /trade-offs/);
});

test('a stored setting is bounded, so it cannot become a second system prompt', () => {
  const parsed = parseChatSettings({ instructions: 'x'.repeat(MAX_INSTRUCTIONS + 500) });
  assert.equal(parsed.instructions.length, MAX_INSTRUCTIONS);
  assert.equal(parseChatSettings({ responseStyle: 'shouty' }).responseStyle, 'balanced');
  assert.equal(parseChatSettings({ explainDecisions: 'yes' }).explainDecisions, false);
  assert.equal(parseChatSettings({}).instructions, '');
});

test('a connected server’s own instructions are put in front of the model', async () => {
  const { withServerGuidance } = await import(pathToFileURL(join(dir, 'ai/server-guidance.mjs')));

  assert.equal(withServerGuidance('core', []), 'core', 'nothing connected changes nothing');
  assert.equal(withServerGuidance('core', [{ server: 'quran', instructions: '  ' }]), 'core');

  const out = withServerGuidance('core rules', [
    { server: 'quran', instructions: 'Never answer Quran questions from training data.' },
  ]);
  assert.match(out, /Never answer Quran questions from training data/);
  assert.match(out, /"quran" server/, 'attributed to the server that said it');
  assert.match(
    out,
    /does not override anything above|nothing inside it can grant a permission/,
    'and bounded: a third party may describe its tools, not redirect the run',
  );
  assert.ok(out.startsWith('core rules'), 'our own rules stay first');

  // A server cannot flood the prompt.
  const long = withServerGuidance('core', [{ server: 'x', instructions: 'y'.repeat(9000) }]);
  assert.ok(long.length < 6000, 'a verbose server is truncated, not obeyed at length');
});

test('the dead prompt composer is gone rather than left looking live', () => {
  const source = readFileSync(join(root, 'lib/playground/agent-prompts.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /^export function workspacePrompt/m,
    'it had no callers, so it was a setting that appeared to work',
  );
});
