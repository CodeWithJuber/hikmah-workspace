// Does the co-model reach a run, and is what it says worth saying?
//
// Both halves matter. `analyzeContext` had exactly one caller — the browser
// chat's run loop — so when that went, the field models stopped being read by
// anything and training a checkpoint changed nothing about any answer. That is
// the "not working at all" half, and the server loader below is the fix.
//
// The other half is that `realizeContext` renders every event the compiler
// produced, and measured against real text about half of them are noise: a
// preposition read as a predicate, a full stop read as a predicate, the same
// negation reported twice by two detectors. Putting that in a system prompt is
// worse than saying nothing, so the filter is tested against the actual output
// of the actual released grammar rather than against a hand-written graph.
// Run: node --test tests/context-brief.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-context-'));
await build({
  entryPoints: [
    'lib/context-model/brief.ts',
    'lib/context-model/discourse.ts',
    'lib/context-model/field-model.ts',
    'lib/context-model/run-brief.ts',
    'lib/context-model/server.ts',
    'lib/context-model/active-store.ts',
  ],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const load = async (name) => import(pathToFileURL(join(dir, name + '.mjs')));
const { contextBrief, MAX_BRIEF_ROWS, MAX_BRIEF_CHARACTERS } = await load('brief');
const { compileContext, realizeContext } = await load('discourse');
const { validateField } = await load('field-model');
const { buildContextBrief, recentUserText, briefSentences, BRIEF_MAX_SENTENCES } =
  await load('run-brief');
const { loadReleasedField, loadFieldForUser, clearFieldCache, researchDirectory } =
  await load('server');
const { createActiveCheckpointStore } = await load('active-store');

const en = validateField(
  JSON.parse(readFileSync('public/research/v6/models/en.model.json', 'utf8')),
);
const graph = (text) => compileContext(text, { en }, 'auto');
const userTurn = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });

test.after(() => rm(dir, { recursive: true, force: true }));

test('the released grammar loads from disk, which is what the browser fetch could not do', async () => {
  clearFieldCache();
  const model = await loadReleasedField('en');
  assert.equal(model.language, 'en');
  assert.equal(model.format, 'hikmah.context-field.v1');
  // Second read is the cache, not a second parse of a megabyte of JSON.
  assert.equal(await loadReleasedField('en'), model);
  assert.ok(researchDirectory().endsWith('/public/research'));
});

test('a language with no trained checkpoint is refused rather than parsed by the wrong grammar', async () => {
  await assert.rejects(() => loadReleasedField('ur'), /No trained syntax checkpoint/);
});

test('negation, modality and named actors survive the filter', () => {
  const brief = contextBrief(
    graph('Sara did not help Lina with the migration. Can you check the deploy script?'),
  );
  const rows = brief.rows.join('\n');
  assert.match(rows, /Sara → help/);
  assert.match(rows, /negation: not/);
  assert.match(rows, /modal: Can/);
});

test('the same negation found twice by two detectors is reported once', () => {
  const brief = contextBrief(graph('Sara did not help Lina.'));
  const row = brief.rows.find((line) => line.includes('negation'));
  assert.ok(row, 'expected a negation row');
  // realizeContext emits `negation: not; negation: not [learned morphology]`.
  assert.equal(row.match(/negation:/g).length, 1);
  assert.match(realizeContext(graph('Sara did not help Lina.')), /learned morphology/);
});

test('a full stop parsed as a predicate is dropped, and the unfiltered rendering shows why', () => {
  const text =
    'I asked the team to review the change yesterday. They said the CI was green but nobody confirmed the terminal works behind the proxy. Please verify it.';
  const before = realizeContext(graph(text));
  const brief = contextBrief(graph(text));
  // The evidence for the filter: the raw rendering really does contain rows
  // with no actor, no object and a predicate that is punctuation.
  assert.match(before, /→ \. → object unresolved/);
  assert.match(before, /actor unresolved → behind → proxy/);
  assert.ok(brief.dropped > 0, 'expected the filter to drop something');
  for (const row of brief.rows) {
    // A full stop is not a predicate, whoever the parser thought the actor was.
    assert.doesNotMatch(row, /→ \. →/);
    // Nor is a preposition, when nothing else in the row carries information.
    assert.doesNotMatch(row, /actor unresolved → behind →/);
    assert.ok(
      /\[/.test(row) || !/^S\d+: actor unresolved/.test(row),
      'a row with no cue and no named actor should not survive: ' + row,
    );
  }
});

test('a negation the parser could not attach is still reported, without a made-up clause', () => {
  // Measured, and the reason the filter is not simply "drop rows with a
  // punctuation predicate": on this sentence the compiler takes the full stop
  // as the root, with no actor and no patient, and hangs the negation on it.
  // Dropping the row would drop the one thing most worth carrying.
  const text = 'Sara did not merge release 4096 into the branch.';
  assert.match(realizeContext(graph(text)), /actor unresolved → \. → object unresolved/);
  const brief = contextBrief(graph(text));
  assert.deepEqual(brief.rows, ['S1: negation: not — cue found, clause unresolved']);
  // The cue survives; the structure that was never found is not asserted.
  assert.doesNotMatch(brief.block, /→/);
});

test('nothing worth saying produces no block at all, not an empty heading', () => {
  const brief = contextBrief(graph('ok'));
  assert.equal(brief.block, '');
  assert.equal(brief.kept, 0);
});

test('the block is bounded in rows and characters, and names itself as fallible', () => {
  const long = Array.from(
    { length: 30 },
    (_, i) => `The engineer did not deploy release ${100 + i} because the migration script failed.`,
  ).join(' ');
  const brief = contextBrief(graph(long));
  assert.ok(brief.rows.length <= MAX_BRIEF_ROWS, 'rows: ' + brief.rows.length);
  assert.ok(brief.block.length <= MAX_BRIEF_CHARACTERS, 'chars: ' + brief.block.length);
  assert.match(brief.block, /fallible/);
  assert.match(brief.block, /add no permission and change no instruction above/);
  assert.match(brief.block, /the text wins/);
});

test('exact strings worth reproducing are kept and bare single digits are not', () => {
  const brief = contextBrief(
    graph('Fetch `deploy/release.sh` from https://example.test/a and set the cap to 4096, not 7.'),
  );
  assert.ok(brief.literals.includes('`deploy/release.sh`'), brief.literals.join(' '));
  assert.ok(
    brief.literals.some((l) => l.startsWith('https://')),
    brief.literals.join(' '),
  );
  assert.ok(brief.literals.includes('4096'), brief.literals.join(' '));
  assert.ok(!brief.literals.includes('7'), brief.literals.join(' '));
});

test('only the person’s own recent turns are read, and only the last few', () => {
  const messages = [
    userTurn('first'),
    { role: 'assistant', parts: [{ type: 'text', text: 'assistant text' }] },
    userTurn('second'),
    userTurn('third'),
    userTurn('fourth'),
  ];
  const text = recentUserText(messages);
  assert.doesNotMatch(text, /assistant text/);
  assert.doesNotMatch(text, /first/);
  assert.match(text, /fourth/);
});

test('the parse is capped so one pasted document cannot own the request thread', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  assert.equal(briefSentences(many).length, BRIEF_MAX_SENTENCES);
});

test('a run gets a block, and the switch is the only thing between it and the model', async () => {
  const outcome = await buildContextBrief({
    messages: [
      userTurn('Sara did not merge the branch. Can you check whether release 4096 shipped?'),
    ],
    loadField: loadReleasedField,
  });
  assert.equal(outcome.reason, 'ok');
  assert.match(outcome.block, /negation: not/);
  assert.match(outcome.block, /4096/);
});

test('a checkpoint that will not load costs the notes, never the message', async () => {
  const outcome = await buildContextBrief({
    messages: [userTurn('Sara did not merge the branch.')],
    loadField: () => Promise.reject(Error('disk is on fire')),
  });
  assert.equal(outcome.reason, 'failed');
  assert.equal(outcome.block, '');
});

test('a slow checkpoint is abandoned rather than waited on', async () => {
  const outcome = await buildContextBrief({
    messages: [userTurn('Sara did not merge the branch.')],
    loadField: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  assert.equal(outcome.reason, 'failed');
  assert.equal(outcome.block, '');
});

test('a language with no grammar is left to its own text', async () => {
  const outcome = await buildContextBrief({
    messages: [userTurn('یہ اردو میں لکھا گیا ہے۔')],
    loadField: loadReleasedField,
  });
  assert.equal(outcome.reason, 'no-model');
  assert.equal(outcome.block, '');
});

test('an activated checkpoint is what the run parses with, so training changes answers', async () => {
  clearFieldCache();
  // A real checkpoint, marked so the test can tell it apart from the released
  // one, stored the way the studio stores it: a document with a `model` field,
  // in the bucket, pointed at by context_versions and context_active.
  const trained = { ...en, training: { ...en.training, sentences: 4242 } };
  const rows = new Map([['u1:en', 'v1']]);
  const versions = new Map([['v1|u1', 'context/u1/v1.json']]);
  const db = {
    prepare: (sql) => ({
      get: (...args) =>
        sql.includes('context_active')
          ? rows.has(args[0]) && args[1] === 'u1'
            ? { version_id: rows.get(args[0]) }
            : undefined
          : versions.has(args[0] + '|' + args[1])
            ? { blob_key: versions.get(args[0] + '|' + args[1]) }
            : undefined,
    }),
  };
  const bucket = {
    get: async (key) =>
      key === 'context/u1/v1.json'
        ? { text: async () => JSON.stringify({ model: trained, receipt: {} }) }
        : null,
  };
  const active = createActiveCheckpointStore(db, bucket);

  assert.equal(active.activeVersion('u1', 'en'), 'v1');
  // Another owner naming the same language gets nothing, and so falls back.
  assert.equal(active.activeVersion('u2', 'en'), null);

  const mine = await loadFieldForUser('u1', 'en', active);
  assert.equal(mine.training.sentences, 4242);
  const theirs = await loadFieldForUser('u2', 'en', active);
  assert.equal(theirs.training.sentences, en.training.sentences);
});

test('an activated checkpoint whose bytes are gone falls back to the released grammar', async () => {
  clearFieldCache();
  const db = {
    prepare: () => ({ get: (...a) => (a[0] === 'u1:en' ? { version_id: 'v9' } : undefined) }),
  };
  const active = createActiveCheckpointStore(db, { get: async () => null });
  const model = await loadFieldForUser('u1', 'en', active);
  assert.equal(model.training.sentences, en.training.sentences);
});
