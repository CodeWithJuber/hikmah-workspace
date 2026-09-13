// Bulk training needs a format a corpus actually arrives in.
//
// The studio took one thing: a JSON array typed into a textarea, capped — as it
// turned out — at 100 sentences for the owner's entire lifetime, because each
// submission is concatenated onto everything saved before it. So "upload karne
// ka bhi options ho taaki bulk me model ko train kar sake" needed both halves:
// a real format, and a cap that makes bulk mean something.
// Run: node --test tests/conllu.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConllu } from '../lib/context-model/conllu.ts';
import { MAX_CORPUS, MAX_SUBMISSION, validateTeaching } from '../lib/context-model/training.ts';

// A real extract, in the shape UD distributes: comments, ten tab-separated
// columns, a blank line between sentences.
const DOCUMENT = `# sent_id = n01001011
# text = The quick fox sleeps.
1\tThe\tthe\tDET\tDT\tDefinite=Def|PronType=Art\t3\tdet\t_\t_
2\tquick\tquick\tADJ\tJJ\tDegree=Pos\t3\tamod\t_\t_
3\tfox\tfox\tNOUN\tNN\tNumber=Sing\t4\tnsubj\t_\t_
4\tsleeps\tsleep\tVERB\tVBZ\tNumber=Sing|Person=3\t0\troot\t_\t_
5\t.\t.\tPUNCT\t.\t_\t4\tpunct\t_\t_

# sent_id = n01001012
# text = Dogs bark.
1\tDogs\tdog\tNOUN\tNNS\tNumber=Plur\t2\tnsubj\t_\t_
2\tbark\tbark\tVERB\tVBP\t_\t0\troot\t_\t_
3\t.\t.\tPUNCT\t.\t_\t2\tpunct\t_\t_
`;

test('a CoNLL-U document becomes sentences the trainer accepts', () => {
  const { rows, problems } = parseConllu(DOCUMENT, 'owner/reader');
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 2);

  const [first] = rows;
  assert.equal(first.id, 'n01001011');
  assert.equal(first.text, 'The quick fox sleeps.');
  assert.equal(first.groupId, 'owner/reader');
  assert.equal(first.split, 'train');
  assert.equal(first.tokens.length, 5);
  assert.deepEqual(first.tokens[3], {
    id: 4,
    form: 'sleeps',
    lemma: 'sleep',
    upos: 'VERB',
    head: 0,
    deprel: 'root',
    feats: { Number: 'Sing', Person: '3' },
  });
  // The real gate, unchanged: parsing is not permission to train.
  assert.equal(validateTeaching(rows, new Set()).length, 2);
});

test('an underscore lemma falls back to the form rather than to nothing', () => {
  const { rows } = parseConllu('1\tبِسْمِ\t_\tNOUN\t_\t_\t0\troot\t_\t_\n', 'owner/x');
  assert.equal(rows[0].tokens[0].lemma, 'بِسْمِ');
});

test('multiword ranges and empty nodes are skipped, not counted', () => {
  const text =
    '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_\n' +
    '1\tde\tde\tADP\t_\t_\t2\tcase\t_\t_\n' +
    '2\tel\tel\tDET\t_\t_\t0\troot\t_\t_\n' +
    '2.1\t_\t_\t_\t_\t_\t_\t_\t_\t_\n';
  const { rows, problems } = parseConllu(text, 'owner/es');
  assert.deepEqual(problems, []);
  assert.equal(rows[0].tokens.length, 2, 'only the real tokens');
});

test('a text comment is optional; the forms stand in for it', () => {
  const { rows } = parseConllu(
    '# sent_id = s1\n1\tHello\thello\tINTJ\t_\t_\t0\troot\t_\t_\n',
    'owner/x',
  );
  assert.equal(rows[0].text, 'Hello');
});

test('a malformed sentence is reported by line, and the rest still import', () => {
  // One broken sentence in the middle: too few columns.
  const broken = DOCUMENT.replace('3\tfox\tfox\tNOUN\tNN\tNumber=Sing\t4\tnsubj\t_\t_', '3\tfox');
  const { rows, problems } = parseConllu(broken, 'owner/reader');
  assert.equal(rows.length, 1, 'the good sentence survives the bad one');
  assert.equal(rows[0].id, 'n01001012');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].sentence, 'n01001011');
  assert.match(problems[0].reason, /columns/);
  // The line number is what makes the report actionable in a 300-sentence file.
  assert.ok(problems[0].line >= 1);
});

test('out-of-order token ids are reported rather than silently renumbered', () => {
  const text =
    '# sent_id = s1\n' +
    '1\ta\ta\tDET\t_\t_\t2\tdet\t_\t_\n' +
    '3\tb\tb\tNOUN\t_\t_\t0\troot\t_\t_\n';
  const { rows, problems } = parseConllu(text, 'owner/x');
  assert.equal(rows.length, 0);
  assert.match(problems[0].reason, /token ids must run/);
});

test('an empty document is empty, not an error', () => {
  assert.deepEqual(parseConllu('', 'owner/x'), { rows: [], problems: [] });
  assert.deepEqual(parseConllu('\n\n  \n', 'owner/x'), { rows: [], problems: [] });
});

// The cap the upload exists to lift.
test('the corpus limit is a lifetime one, and it is no longer 100', () => {
  const sentence = (index) => ({
    id: 's' + index,
    groupId: 'owner/bulk',
    split: 'train',
    text: 'Dogs bark.',
    tokens: [
      { id: 1, form: 'Dogs', lemma: 'dog', upos: 'NOUN', head: 2, deprel: 'nsubj', feats: {} },
      { id: 2, form: 'bark', lemma: 'bark', upos: 'VERB', head: 0, deprel: 'root', feats: {} },
    ],
  });
  const many = Array.from({ length: 101 }, (_, index) => sentence(index));
  // 101 threw before this change, which is what made a bulk upload pointless:
  // the studio concatenates every previously saved row onto each submission, so
  // the old 100 was the owner's whole corpus, for good.
  assert.equal(validateTeaching(many, new Set()).length, 101);
  assert.ok(MAX_CORPUS >= 1000, 'larger than the licensed base corpus');
  assert.ok(MAX_SUBMISSION < MAX_CORPUS, 'one upload cannot fill the corpus');
  assert.throws(
    () =>
      validateTeaching(
        Array.from({ length: MAX_CORPUS + 1 }, (_, i) => sentence(i)),
        new Set(),
      ),
    /reviewed sentences/,
  );
});
