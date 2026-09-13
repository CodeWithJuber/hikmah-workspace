// Every chat should make the co-model better, and it could not.
//
// The co-model is a dependency parser fitted on gold annotations, so a chat
// reply carries nothing it can learn from — and training it on its own parses
// would teach it to agree with itself. What every chat *can* do is say which
// sentences the model found hardest, which the run already measures and then
// threw away.
//
// These cover the ranking and the conversion: a parse becomes a row the trainer
// will accept, or nothing at all, because handing the owner a row that will be
// refused on submit wastes the review rather than saving it.
// Run: node --test tests/context-candidates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TOKENS,
  candidatesFrom,
  fingerprint,
  toAnnotation,
  uncertainty,
} from '../lib/context-model/candidates.ts';

/** A parse in the shape parseForms returns. */
const parsed = (tokens, over = {}) => ({
  tokens: tokens.map((t, i) => ({
    id: i + 1,
    form: t.form,
    lemma: t.lemma ?? t.form.toLowerCase(),
    upos: t.upos,
    head: t.head,
    relation: t.relation,
    known: t.known ?? true,
    morphology: t.morphology ?? {},
  })),
  root: tokens.findIndex((t) => t.head === 0) + 1,
  score: 4,
  lexicalCoverage: 1,
  decoder: 'test',
  warnings: [],
  ...over,
});

const GOOD = [
  { form: 'The', upos: 'DET', head: 3, relation: 'det' },
  { form: 'quick', upos: 'ADJ', head: 3, relation: 'amod' },
  { form: 'fox', upos: 'NOUN', head: 4, relation: 'nsubj' },
  { form: 'sleeps', upos: 'VERB', head: 0, relation: 'root' },
];

const graph = (sentences) => ({ sentences });

test('a parse becomes a row the trainer accepts', () => {
  const annotation = toAnnotation(parsed(GOOD), {
    id: 's1',
    groupId: 'owner/chat',
    text: 'The quick fox sleeps',
  });
  assert.ok(annotation);
  assert.equal(annotation.split, 'train');
  assert.equal(annotation.tokens.length, 4);
  assert.deepEqual(annotation.tokens[3], {
    id: 4,
    form: 'sleeps',
    lemma: 'sleeps',
    upos: 'VERB',
    head: 0,
    deprel: 'root',
    feats: {},
  });
});

test('the trainer would accept what this produces', async () => {
  // Not a re-implementation of the rules: the real validator, on the real
  // output. If these two ever disagree the review is wasted at submit time.
  const { validateTeaching } = await import('../lib/context-model/training.ts');
  const annotation = toAnnotation(parsed(GOOD), {
    id: 's1',
    groupId: 'owner/chat',
    text: 'The quick fox sleeps',
  });
  assert.equal(validateTeaching([annotation], new Set()).length, 1);
});

test('a parse the trainer would refuse produces nothing at all', () => {
  const at = (over) => toAnnotation(parsed(over), { id: 'x', groupId: 'owner/chat', text: 't' });
  // Two roots.
  assert.equal(
    at([
      { form: 'a', upos: 'NOUN', head: 0, relation: 'root' },
      { form: 'b', upos: 'NOUN', head: 0, relation: 'root' },
      { form: 'c', upos: 'NOUN', head: 1, relation: 'nmod' },
      { form: 'd', upos: 'NOUN', head: 1, relation: 'nmod' },
    ]),
    null,
  );
  // No root.
  assert.equal(
    at([
      { form: 'a', upos: 'NOUN', head: 2, relation: 'nmod' },
      { form: 'b', upos: 'NOUN', head: 1, relation: 'nmod' },
      { form: 'c', upos: 'NOUN', head: 1, relation: 'nmod' },
      { form: 'd', upos: 'NOUN', head: 1, relation: 'nmod' },
    ]),
    null,
  );
  // A tag outside the seventeen.
  assert.equal(
    at([...GOOD.slice(0, 3), { form: 'x', upos: 'GERUND', head: 0, relation: 'root' }]),
    null,
  );
  // A relation the trainer's pattern refuses.
  assert.equal(
    at([...GOOD.slice(0, 3), { form: 'x', upos: 'VERB', head: 0, relation: 'ROOT!' }]),
    null,
  );
  // head 0 and a relation that is not root, which must agree.
  assert.equal(
    at([...GOOD.slice(0, 3), { form: 'x', upos: 'VERB', head: 0, relation: 'nsubj' }]),
    null,
  );
});

test('a fragment is not worth anyone reviewing', () => {
  const short = parsed(GOOD.slice(0, 2));
  assert.equal(toAnnotation(short, { id: 'x', groupId: 'owner/chat', text: 'The quick' }), null);
  assert.ok(MIN_TOKENS >= 3);
});

test('the hardest sentence comes first', () => {
  const easy = parsed(GOOD, { lexicalCoverage: 1, score: 8 });
  const hard = parsed(GOOD, { lexicalCoverage: 0.25, score: -3 });
  const ranked = candidatesFrom(
    graph([
      { id: 1, text: 'A familiar sentence here', language: 'en', parse: easy },
      { id: 2, text: 'Ek naya jumla yahan', language: 'en', parse: hard },
    ]),
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].text, 'Ek naya jumla yahan');
  assert.ok(uncertainty(ranked[0]) > uncertainty(ranked[1]));
});

test('unseen vocabulary outweighs a close call on the tree', () => {
  // An owner's annotations fix words the model has never met; they do less for
  // a familiar sentence the parser merely found ambiguous.
  const unknownWords = uncertainty({ coverage: 0.1, score: 6 });
  const familiarButAmbiguous = uncertainty({ coverage: 1, score: -6 });
  assert.ok(unknownWords > familiarButAmbiguous);
});

test('the same sentence twice is one thing to review', () => {
  const ranked = candidatesFrom(
    graph([
      { id: 1, text: 'The quick fox sleeps', language: 'en', parse: parsed(GOOD) },
      { id: 2, text: '  the QUICK   fox sleeps ', language: 'en', parse: parsed(GOOD) },
    ]),
  );
  assert.equal(ranked.length, 1);
  assert.equal(fingerprint('  the QUICK   fox sleeps '), 'the quick fox sleeps');
});

test('punctuation, fragments and unparsed sentences are skipped, not queued', () => {
  const ranked = candidatesFrom(
    graph([
      { id: 1, text: '!!! ???', language: 'en', parse: parsed(GOOD) },
      { id: 2, text: 'No parse here', language: 'en' },
      { id: 3, text: 'Too short', language: 'en', parse: parsed(GOOD.slice(0, 2)) },
      { id: 4, text: 'The quick fox sleeps', language: 'en', parse: parsed(GOOD) },
    ]),
  );
  assert.deepEqual(
    ranked.map((c) => c.text),
    ['The quick fox sleeps'],
  );
});

test('an empty turn queues nothing rather than failing', () => {
  assert.deepEqual(candidatesFrom(graph([])), []);
  assert.deepEqual(candidatesFrom({}), []);
});
