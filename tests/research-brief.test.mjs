import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareResearchBrief,
  RESEARCH_LIMITS,
  researchBriefError,
  researchCapabilities,
} from '../lib/client/research-brief.ts';

const question = 'Does spaced practice improve retention more than rereading?';
const input = {
  question,
  context: 'Adult learners; a two-week pilot.',
  output: 'evidence',
  useWeb: true,
};
const sourceTools = [
  { name: 'search_web', available: true },
  { name: 'read_webpage', available: true },
];

test('source research requires both discovery and reading availability; unknown is not ready', () => {
  assert.deepEqual(researchCapabilities([]), { webSearch: false, parallelResearch: false });
  assert.deepEqual(researchCapabilities(sourceTools.slice(0, 1)), {
    webSearch: false,
    parallelResearch: false,
  });
  assert.deepEqual(
    researchCapabilities([sourceTools[0], { name: 'read_webpage', available: false }]),
    { webSearch: false, parallelResearch: false },
  );
  assert.deepEqual(researchCapabilities(sourceTools), { webSearch: true, parallelResearch: true });
});

test('explicit source choice matches the run and never re-enables a disabled research agent', () => {
  const capabilities = researchCapabilities(sourceTools, ['search_web', 'deep_research']);
  const prepared = prepareResearchBrief(input, capabilities);
  assert.equal(prepared.webSearch, true);
  assert.equal(prepared.deepResearch, false);
  assert.doesNotMatch(prepared.prompt, /Use deep_research/);
});

test('lost source access produces an honest outline even if the original choice requested web', () => {
  const prepared = prepareResearchBrief(input, { webSearch: false, parallelResearch: true });
  assert.equal(prepared.webSearch, false);
  assert.equal(prepared.deepResearch, false);
  assert.match(prepared.prompt, /unverified research outline/);
  assert.match(prepared.prompt, /Do not claim to have searched/);
  assert.doesNotMatch(prepared.prompt, /Use search_web|Use deep_research/);
});

test('turning off sources also turns off research fan-out and does not fabricate citations', () => {
  const prepared = prepareResearchBrief(
    { ...input, useWeb: false },
    { webSearch: true, parallelResearch: true },
  );
  assert.equal(prepared.webSearch, false);
  assert.equal(prepared.deepResearch, false);
  assert.match(prepared.prompt, /instead of inventing citations/);
});

test('scientific briefs preserve the question and context, request counter-evidence, and scope proposed work', () => {
  const original = structuredClone(input);
  const prepared = prepareResearchBrief(
    { ...input, question: `  ${question}\n`, output: 'hypothesis' },
    { webSearch: true, parallelResearch: true },
  );
  assert.equal(prepared.question, question);
  assert.equal(prepared.output, 'hypothesis');
  assert.equal(prepared.deepResearch, true);
  assert.ok(prepared.prompt.includes(input.context));
  assert.match(prepared.prompt, /actively seek disconfirming evidence/);
  assert.match(prepared.prompt, /at most three research lanes/);
  assert.match(prepared.prompt, /when a tool actually returned its content/);
  assert.match(prepared.prompt, /experiment plan as proposed and not executed/);
  assert.match(prepared.prompt, /Do not run experiments, contact people/);
  assert.deepEqual(input, original);
});

test('experiment planning asks for a comparison and decision rule before results exist', () => {
  const prepared = prepareResearchBrief(
    { ...input, output: 'experiment' },
    { webSearch: true, parallelResearch: false },
  );
  assert.match(prepared.prompt, /comparison or control/);
  assert.match(prepared.prompt, /chosen before results are known/);
  assert.match(prepared.prompt, /Do not invent numerical confidence, sample sizes/);
});

test('invalid or oversized inputs are rejected instead of silently losing research context', () => {
  assert.match(researchBriefError({ ...input, question: '   ' }), /Add a question/);
  assert.throws(
    () =>
      prepareResearchBrief(
        { ...input, question: 'x'.repeat(RESEARCH_LIMITS.question + 1) },
        { webSearch: true, parallelResearch: true },
      ),
    /Keep the question/,
  );
  assert.match(
    researchBriefError({ ...input, context: 'x'.repeat(RESEARCH_LIMITS.context + 1) }),
    /Keep context/,
  );
  assert.match(researchBriefError({ ...input, output: 'fabricated-result' }), /Choose/);
  assert.equal(
    researchBriefError({ ...input, question: 'x'.repeat(RESEARCH_LIMITS.question) }),
    null,
  );
});
