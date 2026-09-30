// Deep research: one question, several lanes, one honest answer.
//
// The orchestration is tested with the planner and the lane runner injected,
// so what is asserted is the shape the plan promised — parallel lanes, the
// free-key rule, the 429 stop, the progress part, per-lane usage, the time cap
// — and not a provider. The last test runs a real lane over a scripted model.
// Run: node --test tests/deep-research.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchema, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  deepResearch,
  deepResearchTools,
  detectContradictions,
  parseClaims,
  parseSubQuestions,
  isRateLimit,
  RESEARCH_PART_ID,
} from '../lib/ai/tools/deep-research.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A lane runner that records when each lane ran. */
function timedLanes({ delay = 30, fail = () => null } = {}) {
  const spans = [];
  const runLane = async (question, signal) => {
    const started = Date.now();
    await sleep(delay);
    const error = fail(question);
    spans.push({ question, started, ended: Date.now() });
    if (error) throw error;
    if (signal.aborted) throw new Error('aborted');
    return {
      summary: 'Finding for ' + question,
      sources: ['https://example.org/' + spans.length],
      usage: { inputTokens: 100, outputTokens: 10 },
    };
  };
  return { spans, runLane };
}

const overlap = (a, b) => a.started < b.ended && b.started < a.ended;

const base = (over = {}) => ({
  model: {},
  tools: {},
  signal: new AbortController().signal,
  freeOnly: false,
  plan: async () => ['What is A?', 'What is B?', 'What is C?'],
  ...over,
});

test('three sub-questions run concurrently', async () => {
  const { spans, runLane } = timedLanes();
  const out = await deepResearch(base({ runLane }), { question: 'A, B and C?' });
  assert.equal(spans.length, 3);
  assert.ok(
    overlap(spans[0], spans[1]) && overlap(spans[1], spans[2]),
    'the lanes overlapped in time',
  );
  assert.equal(out.findings.length, 3);
  assert.deepEqual(out.gaps, []);
  assert.match(out.findings[0].summary, /Finding for What is A/);
});

test('on a free key the lanes run one at a time, and at most two of them', async () => {
  // 20 requests a minute and 50 a day: three lanes in parallel is the whole
  // day's allowance in one message, and 429s for the chat that follows.
  const { spans, runLane } = timedLanes();
  const out = await deepResearch(base({ runLane, freeOnly: true }), {
    question: 'A, B and C?',
    breadth: 5,
  });
  assert.equal(spans.length, 2, 'the third sub-question is never planned');
  assert.equal(overlap(spans[0], spans[1]), false, 'and the two do not overlap');
  assert.equal(out.findings.length, 2);
});

test('the first 429 stops further lanes from starting', async () => {
  const { spans, runLane } = timedLanes({
    fail: (q) =>
      q.includes('A')
        ? Object.assign(new Error('429 Too Many Requests'), { statusCode: 429 })
        : null,
  });
  const out = await deepResearch(base({ runLane, freeOnly: true }), { question: 'q' });
  assert.equal(spans.length, 1, 'only the first lane ran');
  assert.deepEqual(out.gaps, ['What is A?', 'What is B?']);
  assert.match(out.note, /refused on rate/);
  assert.equal(out.findings.length, 0);
});

test('progress is one part: every publish shares the id and the last one holds every lane', async () => {
  const published = [];
  const { runLane } = timedLanes();
  await deepResearch(base({ runLane, publish: (view) => published.push(structuredClone(view)) }), {
    question: 'q',
  });
  assert.ok(published.length >= 5, 'planning, running, and a change per lane');
  assert.equal(published[0].status, 'planning');
  const last = published.at(-1);
  assert.equal(last.status, 'done');
  assert.deepEqual(
    last.lanes.map((l) => l.status),
    ['done', 'done', 'done'],
  );
  assert.equal(last.lanes[1].sources.length, 1);
  // Only lane state changes are published — not a chunk per token. Three
  // lanes: queued→running and running→done each, plus planning, running, done.
  assert.ok(published.length <= 9, 'published ' + published.length + ' times');
});

test('each lane reports its own usage, so each can become a usage row', async () => {
  const seen = [];
  const { runLane } = timedLanes();
  await deepResearch(base({ runLane, onLaneUsage: (lane, usage) => seen.push([lane, usage]) }), {
    question: 'q',
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0][1], { inputTokens: 100, outputTokens: 10 });
});

test('a provider error cannot write the run credential into research progress', async () => {
  const credential = 'fixture-provider-credential-for-research';
  const published = [];
  await deepResearch(
    base({
      diagnosticSecrets: [credential],
      publish: (view) => published.push(structuredClone(view)),
      runLane: async () => {
        throw Error('The upstream rejected ' + credential + ' for this model.');
      },
    }),
    { question: 'q' },
  );
  const diagnostic = published.at(-1).lanes[0].error;
  assert.match(diagnostic, /The upstream rejected/);
  assert.match(diagnostic, /\[credential redacted\]/);
  assert.equal(JSON.stringify(published).includes(credential), false);
});

test('the time cap ends a lane that never settles', async () => {
  const runLane = (_q, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  const out = await deepResearch(base({ runLane, timeoutMs: 60, plan: async () => ['never'] }), {
    question: 'q',
  });
  assert.deepEqual(out.gaps, ['never']);
  assert.equal(out.findings.length, 0);
});

test('cancelling the run cancels the research, as an error rather than a finding', async () => {
  const controller = new AbortController();
  const runLane = (_q, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  const pending = deepResearch(
    base({ runLane, signal: controller.signal, plan: async () => ['x'] }),
    { question: 'q' },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending);
});

test('a plan that yields nothing is one lane on the question itself', async () => {
  const { spans, runLane } = timedLanes();
  await deepResearch(base({ runLane, plan: async () => [] }), { question: 'The whole question' });
  assert.deepEqual(
    spans.map((s) => s.question),
    ['The whole question'],
  );
});

test('sub-questions are read off a numbered list, bullets and all', () => {
  const text =
    'Sub-questions:\n1. What does the Hanafi school say?\n2) And the Shafi‘i?\n- What do the hadith say?\n\n1. What does the Hanafi school say?';
  assert.deepEqual(parseSubQuestions(text, 5), [
    'What does the Hanafi school say?',
    'And the Shafi‘i?',
    'What do the hadith say?',
  ]);
  assert.deepEqual(parseSubQuestions(text, 2).length, 2);
  assert.ok(isRateLimit(new Error('Rate limit exceeded')));
  assert.ok(isRateLimit({ statusCode: 429, message: '' }));
  assert.ok(!isRateLimit(new Error('Not found')));
});

test('a real lane over a scripted model: reads a page, and the finding cites only what it read', async () => {
  // agent.generate() drives doGenerate, not doStream: two scripted steps, a
  // read_webpage call and then the finding.
  const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
  const steps = [
    {
      content: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'read_webpage',
          input: JSON.stringify({ url: 'https://example.org/a' }),
        },
      ],
      finishReason: { unified: 'tool-calls' },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Found it at https://example.org/a.' }],
      finishReason: { unified: 'stop' },
      usage,
      warnings: [],
    },
  ];
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => steps[step++] });
  const read = tool({
    description: 'x',
    inputSchema: jsonSchema({ type: 'object', properties: { url: { type: 'string' } } }),
    execute: async () => ({ text: 'page text' }),
  });
  const seen = [];
  const { deep_research } = deepResearchTools({
    model,
    tools: { read_webpage: read },
    signal: new AbortController().signal,
    freeOnly: true,
    plan: async () => ['Where is it?'],
    onLaneUsage: (lane, u) => seen.push(u),
  });
  const out = await deep_research.execute(
    { question: 'Where is it?' },
    { toolCallId: 't', messages: [] },
  );
  assert.equal(out.findings.length, 1);
  // Sources are records now: the URL plus what the lane extracted from it.
  assert.deepEqual(out.findings[0].sources, [{ url: 'https://example.org/a' }]);
  assert.match(out.findings[0].summary, /Found it/);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].inputTokens > 0);
  assert.equal(RESEARCH_PART_ID, 'research');
});

test('sources carry what was extracted: a bounded excerpt and the retrieval time', async () => {
  // The lane read a real page; the source record keeps the head of the page
  // text it actually saw, so the card can show what was extracted from it.
  const usage = { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 5, text: 5 } };
  const steps = [
    {
      content: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'read_webpage',
          input: JSON.stringify({ url: 'https://example.org/a' }),
        },
      ],
      finishReason: { unified: 'tool-calls' },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Found it at https://example.org/a.' }],
      finishReason: { unified: 'stop' },
      usage,
      warnings: [],
    },
  ];
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => steps[step++] });
  const read = tool({
    description: 'x',
    inputSchema: jsonSchema({ type: 'object', properties: { url: { type: 'string' } } }),
    execute: async () => ({
      source: 'https://example.org/a',
      content: 'Alpha beta gamma. ' + 'filler '.repeat(500),
      retrievedAt: '2026-09-30T00:00:00.000Z',
      untrusted: true,
    }),
  });
  const { deep_research } = deepResearchTools({
    model,
    tools: { read_webpage: read },
    signal: new AbortController().signal,
    freeOnly: true,
    plan: async () => ['Where is it?'],
  });
  const out = await deep_research.execute(
    { question: 'Where is it?' },
    { toolCallId: 't', messages: [] },
  );
  const source = out.findings[0].sources[0];
  assert.equal(source.url, 'https://example.org/a');
  assert.match(source.excerpt ?? '', /^Alpha beta gamma\./);
  assert.ok((source.excerpt ?? '').length <= 400, 'the excerpt is bounded');
  assert.equal(source.retrievedAt, '2026-09-30T00:00:00.000Z');
});

test('claims are read off SUPPORTS:/REFUTES: lines, bullets and all', () => {
  const text =
    'Finding text.\nSUPPORTS: X causes Y.\n- REFUTES: Z prevents Y\nsupports:  short  \nNot a claim line.\nSUPPORTS:';
  assert.deepEqual(parseClaims(text), [
    { text: 'X causes Y.', stance: 'supports' },
    { text: 'Z prevents Y', stance: 'refutes' },
    { text: 'short', stance: 'supports' },
  ]);
});

test('detectContradictions groups exact claims and gates on the contract', () => {
  const lane = (question, claims, sources = []) => ({ question, status: 'done', sources, claims });
  const url = 'https://example.org/a';
  const contradictions = detectContradictions(
    [
      lane('Lane one?', [{ text: 'X causes Y', stance: 'supports' }], [{ url }]),
      lane('Lane two?', [{ text: 'X causes Y.', stance: 'refutes' }], [{ url }]),
      lane('Lane three?', [{ text: 'X causes Y', stance: 'supports' }], [{ url }]),
    ],
    'Does X cause Y?',
  );
  assert.equal(contradictions.length, 1, 'one group, however many lanes repeat it');
  assert.equal(contradictions[0].supporting.length, 2);
  assert.equal(contradictions[0].refuting.length, 1);
  assert.deepEqual(contradictions[0].refuting[0].sources, [url]);

  // One-sided groups are not contradictions, however many lanes agree.
  assert.deepEqual(
    detectContradictions(
      [
        lane('A?', [{ text: 'X causes Y', stance: 'supports' }]),
        lane('B?', [{ text: 'X causes Y', stance: 'supports' }]),
      ],
      'q',
    ),
    [],
  );
  // Lanes with no claims contribute nothing.
  assert.deepEqual(detectContradictions([lane('A?', undefined)], 'q'), []);
});

test('opposing lane claims on the same proposition surface as a contradiction', async () => {
  const published = [];
  const runLane = async (question) => ({
    summary: 'Finding for ' + question,
    sources: [{ url: 'https://example.org/' + encodeURIComponent(question) }],
    claims: question.includes('A')
      ? [{ text: 'X causes Y', stance: 'supports' }]
      : [{ text: 'X causes Y', stance: 'refutes' }],
  });
  const out = await deepResearch(
    base({
      runLane,
      plan: async () => ['Claim about A?', 'Claim about B?'],
      publish: (view) => published.push(structuredClone(view)),
    }),
    { question: 'q' },
  );
  assert.equal(out.contradictions.length, 1);
  const contradiction = out.contradictions[0];
  assert.equal(contradiction.claim, 'X causes Y');
  assert.equal(contradiction.supporting.length, 1);
  assert.equal(contradiction.refuting.length, 1);
  assert.equal(contradiction.supporting[0].lane, 'Claim about A?');
  assert.equal(contradiction.refuting[0].lane, 'Claim about B?');
  assert.ok(contradiction.supporting[0].sources[0].includes('example.org'));
  const last = published.at(-1);
  assert.equal(last.contradictions.length, 1);
});

test('differently worded claims do not count as a contradiction', async () => {
  // evaluateEvidence demands exact scoped identity: near-misses are not
  // contradictions, and the tool must not invent one.
  const runLane = async (question) => ({
    summary: 'Finding for ' + question,
    sources: [],
    claims: question.includes('A')
      ? [{ text: 'X causes Y', stance: 'supports' }]
      : [{ text: 'X might cause Y', stance: 'refutes' }],
  });
  const out = await deepResearch(
    base({ runLane, plan: async () => ['Claim about A?', 'Claim about B?'] }),
    { question: 'q' },
  );
  assert.deepEqual(out.contradictions, []);
});

test('resume keeps finished lanes and only runs the rest', async () => {
  const seen = [];
  const runLane = async (question) => {
    seen.push(question);
    return { summary: 'Fresh: ' + question, sources: [] };
  };
  const published = [];
  const out = await deepResearch(
    base({ runLane, publish: (view) => published.push(structuredClone(view)) }),
    {
      question: 'A, B and C?',
      resumeFrom: {
        status: 'interrupted',
        question: 'A, B and C?',
        lanes: [
          {
            question: 'What is A?',
            status: 'done',
            summary: 'Already found A',
            sources: [{ url: 'https://example.org/a', excerpt: 'aaa' }],
          },
          { question: 'What is B?', status: 'running', sources: [] },
          { question: 'What is C?', status: 'queued', sources: [] },
        ],
        gaps: [],
      },
    },
  );
  assert.deepEqual(seen, ['What is B?', 'What is C?'], 'the finished lane never re-ran');
  assert.equal(out.findings.length, 3);
  assert.equal(out.findings[0].summary, 'Already found A');
  assert.deepEqual(out.findings[0].sources, [{ url: 'https://example.org/a', excerpt: 'aaa' }]);
  const running = published.find((view) => view.status === 'running');
  assert.equal(running.lanes[0].status, 'done', 'the resumed lane shows done from the start');
  assert.deepEqual(running.lanes[0].sources, [{ url: 'https://example.org/a', excerpt: 'aaa' }]);
});

test('a malformed resume snapshot is ignored, not fatal', async () => {
  const { spans, runLane } = timedLanes();
  const out = await deepResearch(base({ runLane }), {
    question: 'q',
    resumeFrom: { lanes: 'nope', question: 42 },
  });
  assert.equal(spans.length, 3, 'planned fresh and every lane ran');
  assert.equal(out.findings.length, 3);
});

test('a resume snapshot for another question is ignored', async () => {
  const { spans, runLane } = timedLanes();
  await deepResearch(base({ runLane }), {
    question: 'Something else entirely?',
    resumeFrom: {
      status: 'interrupted',
      question: 'A, B and C?',
      lanes: [{ question: 'What is A?', status: 'done', summary: 'Stale', sources: [] }],
      gaps: [],
    },
  });
  assert.equal(spans.length, 3, 'no lane was taken from the mismatched snapshot');
});

test('interruption publishes a resumable state instead of a stuck spinner', async () => {
  const controller = new AbortController();
  const published = [];
  const runLane = (_q, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  const pending = deepResearch(
    base({
      runLane,
      signal: controller.signal,
      plan: async () => ['x'],
      publish: (view) => published.push(structuredClone(view)),
    }),
    { question: 'q' },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, 'the abort still rejects, as before');
  const last = published.at(-1);
  assert.equal(last.status, 'interrupted');
  assert.match(last.note ?? '', /esume/);
});
