// The smart dispatcher: the run pipeline's brain.
//
// Until this module, every run sent everything — the 24 tool definitions
// (~15k input tokens), all retrieval, the full prompt — and the model figured
// out what the turn needed. Now the turn is classified FIRST: deterministic
// rules (zero model cost, pure function) pick a lane, and only an ambiguous
// turn asks Jev (typed choice, capped, fail-open to `standard`).
//
// Lanes: direct (greeting/filler — no tools, no retrieval), standard (today's
// behavior), research (web tools), quran (quran tools + the owner's Quran lens
// as a lane constraint: lā taqfu / tabayyun / amāna).
// Run: node --test tests/smart-dispatcher.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'hikmah-dispatcher-'));

// The Jev client needs a key even when fetch is stubbed; the stub never
// touches the network.
process.env.TYPESAFE_API_KEY = 'test-key';

// dispatch.ts is pure: recall.ts only needs the text normaliser, the Jev
// client is a fetch wrapper, the research registry is a Map. No stubs.
await build({
  entryPoints: ['lib/runs/dispatch.ts'],
  outfile: join(directory, 'dispatch.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
await build({
  entryPoints: ['lib/research/tool-slot.ts'],
  outfile: join(directory, 'tool-slot.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // The type-only import of DispatchLane is erased; keep the bundle
  // self-contained either way.
  external: [],
});
const dispatch = await import(pathToFileURL(join(directory, 'dispatch.mjs')));
const slots = await import(pathToFileURL(join(directory, 'tool-slot.mjs')));
const { classifyDispatch, dispatchTurn, adviseLane, toDecision, laneToolAllowlist } = dispatch;
const { registerResearchSlot, unregisterResearchSlot, researchSlotNames } = slots;

test.after(async () => {
  await rm(directory, { recursive: true, force: true });
});

// --- Deterministic classification ----------------------------------------

test('classify: greetings and filler take the direct lane', () => {
  for (const q of ['Hi', 'how are you', 'kaise ho', 'ok thanks', 'السلام عليكم', ''])
    assert.equal(classifyDispatch(q).kind === 'lane' && classifyDispatch(q).lane, 'direct', q);
});

test('classify: an explicit tool request wins over every signal', () => {
  assert.equal(classifyDispatch('hi', { webSearch: true }).lane, 'research', 'Search switch wins');
  assert.equal(
    classifyDispatch('hello', { deepResearch: true }).lane,
    'research',
    'deep research wins',
  );
});

test('classify: research intent takes the research lane', () => {
  for (const q of [
    'search latest AI news',
    'what is happening in Gaza',
    'research quantum computing breakthroughs',
    'google the prayer times api',
  ])
    assert.equal(classifyDispatch(q).lane, 'research', q);
});

test('classify: quran signals take the quran lane', () => {
  for (const q of [
    'what does ayah 2:255 mean',
    'explain surah al-fatihah',
    '2:255',
    'tafsir of 49:6',
    'what is the quranic view on charity',
  ])
    assert.equal(classifyDispatch(q).lane, 'quran', q);
});

test('classify: freshness words beat a quran signal into the research lane', () => {
  const c = classifyDispatch('latest news about quran translations');
  assert.equal(c.kind, 'lane');
  assert.equal(c.lane, 'research', 'wants the live web, not the quran index');
});

test('classify: ordinary turns are ambiguous — Jev judges', () => {
  for (const q of ['explain zakat', 'calculate my zakat', 'write a poem about rain'])
    assert.equal(classifyDispatch(q).kind, 'ambiguous', q);
});

// --- The async dispatch ----------------------------------------------------

const jevAnswering = (lane) => async () => ({
  ok: true,
  json: async () => ({ answers: [{ id: 'dispatch-lane', value: lane }] }),
});
const jevDown = async () => {
  throw new Error('connection refused');
};
const jevMustNotBeCalled = async () => {
  throw new Error('Jev must not be asked for a deterministic lane');
};

test('dispatchTurn: deterministic lanes never call Jev', async () => {
  const d = await dispatchTurn('Hi', {}, { fetcher: jevMustNotBeCalled });
  assert.equal(d.lane, 'direct');
  assert.equal(d.jevAdvised, false);
});

test('dispatchTurn: Jev advisory picks the lane for an ambiguous turn', async () => {
  const d = await dispatchTurn('explain zakat', {}, { fetcher: jevAnswering('quran') });
  assert.equal(d.lane, 'quran');
  assert.equal(d.jevAdvised, true);
});

test('dispatchTurn: Jev down falls back to standard, never blocks', async () => {
  const d = await dispatchTurn('explain zakat', {}, { fetcher: jevDown, timeoutMs: 1000 });
  assert.equal(d.lane, 'standard');
  assert.equal(d.jevAdvised, false);
});

test('dispatchTurn: a nonsense Jev answer falls back to standard', async () => {
  const d = await dispatchTurn('explain zakat', {}, { fetcher: jevAnswering('banana') });
  assert.equal(d.lane, 'standard');
  assert.equal(d.jevAdvised, false);
});

test('adviseLane: a hung Jev hits the timeout and yields null', async () => {
  // Like a real fetch: rejects when the client's AbortController fires.
  const hung = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const lane = await adviseLane('explain zakat', {}, { fetcher: hung, timeoutMs: 50 });
  assert.equal(lane, null);
});

// --- Lane decisions --------------------------------------------------------

test('direct lane: no tools, no retrieval, the 2.5k budget', () => {
  const d = toDecision('direct');
  assert.equal(d.tools, 'none');
  assert.equal(d.retrieval, false);
  assert.equal(d.useWeb, false);
  assert.equal(d.promptBudget, 2500, 'the greeting-tokens-v2 contract');
  assert.equal(d.laneConstraint, '');
  assert.equal(d.jevAdvised, false);
});

test('standard lane: today’s behavior, retrieval on', () => {
  const d = toDecision('standard');
  assert.equal(d.tools, 'full');
  assert.equal(d.retrieval, true);
  assert.equal(d.promptBudget, 32000);
});

test('research lane: web tools, retrieval on, biggest budget', () => {
  const d = toDecision('research');
  assert.equal(d.tools, 'web');
  assert.equal(d.retrieval, true);
  assert.equal(d.useWeb, true);
  assert.ok(d.promptBudget > toDecision('standard').promptBudget, 'web pages are heavy');
});

test('quran lane: quran tools and the lens constraint', () => {
  const d = toDecision('quran');
  assert.equal(d.tools, 'quran');
  assert.equal(d.retrieval, true);
  assert.match(d.laneConstraint, /tabayyun/, 'verify-before-acting (49:6)');
  assert.match(d.laneConstraint, /lā taqfu/, 'no assertion without knowledge (17:36)');
  assert.match(d.laneConstraint, /amāna/, 'stewardship of the trust (33:72)');
  assert.match(
    d.laneConstraint,
    /never quote a verse, translation, or tafsir from memory/,
    'the grounding rule, stated plainly',
  );
});

// --- Tool allowlist composition ---------------------------------------------

test('laneToolAllowlist: narrowed lanes name their tools', () => {
  assert.deepEqual(laneToolAllowlist(toDecision('research')), [
    'search_web',
    'search_reference',
    'read_webpage',
  ]);
  assert.deepEqual(laneToolAllowlist(toDecision('quran')), ['research_quran', 'search_reference']);
});

test('laneToolAllowlist: direct and standard leave the tool set alone', () => {
  assert.equal(laneToolAllowlist(toDecision('direct')), undefined);
  assert.equal(laneToolAllowlist(toDecision('standard')), undefined);
});

test('laneToolAllowlist: an explicit allowlist on the run wins over the lane', () => {
  assert.deepEqual(laneToolAllowlist(toDecision('research'), ['calculate']), ['calculate']);
  assert.deepEqual(laneToolAllowlist(toDecision('quran'), ['calculate']), ['calculate']);
});

// --- Research extension point (the honest stub) -------------------------------

test('researchSlotNames: nothing registered in v1', () => {
  for (const lane of ['direct', 'standard', 'research', 'quran'])
    assert.deepEqual(researchSlotNames(lane), [], lane + ' has no research slots yet');
});

test('research slots: register, lane-scoped lookup, unregister', () => {
  registerResearchSlot({
    name: 'ruh_infer',
    description: 'Ruh model inference (placeholder registration)',
    lanes: ['quran'],
    build: () => ({}),
  });
  try {
    assert.deepEqual(researchSlotNames('quran'), ['ruh_infer']);
    assert.deepEqual(researchSlotNames('research'), [], 'lane-scoped, not global');
    // The dispatcher exposes the slot on its lane's decision.
    assert.deepEqual(toDecision('quran').researchSlots, ['ruh_infer']);
    assert.deepEqual(
      laneToolAllowlist(toDecision('quran')),
      ['research_quran', 'search_reference', 'ruh_infer'],
      'slots join the lane allowlist',
    );
  } finally {
    assert.equal(unregisterResearchSlot('ruh_infer'), true);
  }
  assert.deepEqual(researchSlotNames('quran'), [], 'unregistered again');
});

test('registerResearchSlot: a slot without a name, build, or lanes is refused', () => {
  assert.throws(() => registerResearchSlot({ name: '', lanes: ['quran'], build: () => ({}) }));
  assert.throws(() => registerResearchSlot({ name: 'x', lanes: [], build: () => ({}) }));
});
