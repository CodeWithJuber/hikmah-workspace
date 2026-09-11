import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  train,
  predict,
  evaluate,
  compareCandidates,
  summarize,
  validateRows,
  parseRowsJson,
  tokenize,
  sha256,
  canonicalJson,
  LIMITS,
} from '../lib/engines/meaning-engine.ts';

const data = JSON.parse(
  readFileSync(new URL('../lib/playground/frozen-dataset.json', import.meta.url), 'utf8'),
);
const oracle = JSON.parse(
  readFileSync(new URL('./fixtures/python-parity.json', import.meta.url), 'utf8'),
);
const base = train(data.base_train);
const selectedRows = [...data.base_train, ...data.good_update_train];
const selected = train(selectedRows);
const bad = train([...selectedRows, ...data.bad_update_train]);
const copy = (value) => JSON.parse(JSON.stringify(value));
const comparePrediction = (result) => ({
  status: result.status,
  reason: result.reason ?? null,
  frame: result.frame,
});
const err = (code) => (error) => error.code === code;

test('frozen corpus SHA-256 and browser SHA-256 agree with Node', () => {
  const bytes = readFileSync(new URL('../lib/playground/frozen-dataset.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), oracle.dataset_sha256);
  for (const text of ['', 'abc', 'سارة ने Sara', 'x'.repeat(1000)]) {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('learned counts and training hashes match the original Python learner', () => {
  for (const [model, expected] of [
    [base, oracle.base_summary],
    [selected, oracle.selected_summary],
  ]) {
    const actual = summarize(model);
    for (const key of Object.keys(expected)) assert.equal(actual[key], expected[key], key);
  }
  assert.equal(bad.training_hash, oracle.bad_receipt.candidate_hash);
});

test('all 53 frozen base predictions match the Python oracle', () => {
  const predictions = evaluate(base, data.final_test).predictions;
  assert.equal(predictions.length, 53);
  predictions.forEach((prediction, index) =>
    assert.deepEqual(
      comparePrediction(prediction),
      comparePrediction(oracle.base.predictions[index]),
      prediction.id,
    ),
  );
});

test('all 53 frozen selected predictions match the Python oracle', () => {
  const report = evaluate(selected, data.final_test);
  report.predictions.forEach((prediction, index) =>
    assert.deepEqual(
      comparePrediction(prediction),
      comparePrediction(oracle.selected.predictions[index]),
      prediction.id,
    ),
  );
  assert.equal(report.correct_frames, 41);
  assert.equal(report.frame_scored_examples, 51);
  assert.equal(report.schema_boundary_abstentions, 2);
});

test('development accepts measured improvement and rejects corrupt tense updates', () => {
  const goodGate = compareCandidates(base, selected, data.development);
  const badGate = compareCandidates(selected, bad, data.development);
  assert.equal(goodGate.receipt.approved, true);
  assert.equal(goodGate.selectedModel, selected);
  assert.equal(badGate.receipt.approved, false);
  assert.equal(badGate.selectedModel, selected);
  assert.equal(badGate.receipt.active_hash_before, badGate.receipt.active_hash_after);
  assert.equal(badGate.receipt.counterexample.expected.tense, 'future');
  assert.equal(badGate.receipt.counterexample.frame.tense, 'past');
  assert.deepEqual(badGate.receipt.wrong_emitted_frames, oracle.bad_receipt.wrong_emitted_frames);
});

test('every frozen prediction is invariant under bijective action relabeling', () => {
  const symbols = [...new Set(selectedRows.map((row) => row.gold.action))].sort();
  const mapping = new Map(symbols.map((symbol, index) => [symbol, `action:neutral:${index}`]));
  const inverse = new Map([...mapping].map(([a, b]) => [b, a]));
  const rows = copy(selectedRows);
  rows.forEach((row) => {
    row.gold.action = mapping.get(row.gold.action);
  });
  const relabeled = train(rows);
  for (const row of data.final_test) {
    const first = predict(selected, row.language, row.text);
    const second = predict(relabeled, row.language, row.text);
    if (second.frame) second.frame.action = inverse.get(second.frame.action);
    assert.deepEqual(comparePrediction(first), comparePrediction(second), row.id);
  }
});

test('new wording is induced from examples and generalizes to a held-out composition', () => {
  const teaching = data.base_train
    .filter((row) => row.language === 'en' && row.gold.polarity)
    .slice(0, 6)
    .map((row, index) => ({
      ...copy(row),
      id: `new-wording-${index}`,
      text: 'Earlier ' + row.text,
    }));
  const heldOut = data.development.find(
    (row) => row.language === 'en' && row.gold.polarity && row.category === 'held_out_composition',
  );
  const text = 'Earlier ' + heldOut.text;
  assert.equal(predict(base, 'en', text).status, 'abstained');
  const learned = train([...data.base_train, ...teaching]);
  assert.deepEqual(predict(learned, 'en', text).frame, heldOut.gold);
  assert.ok(learned.rules.length > base.rules.length);
  assert.equal(learned.training_ids.includes(heldOut.id), false);
});

test('a new person is learned through varied examples, without a name dictionary', () => {
  const thank = data.base_train.find((row) => row.gold.action.endsWith('#thank')).gold.action;
  const help = data.base_train.find((row) => row.gold.action.endsWith('#help')).gold.action;
  const mk = (id, text, action, patient) => ({
    id,
    language: 'en',
    text,
    gold: {
      agent: 'person:zoya',
      action,
      patient,
      polarity: true,
      tense: 'past',
      modality: 'assertion',
    },
  });
  assert.equal(predict(base, 'en', 'Lina thanked Zoya.').status, 'abstained');
  const learner = train([
    ...data.base_train,
    mk('teach-zoya-1', 'Zoya thanked Sara.', thank, 'person:sara'),
    mk('teach-zoya-2', 'Zoya helped Mira.', help, 'person:mira'),
  ]);
  const result = predict(learner, 'en', 'Lina thanked Zoya.');
  assert.equal(result.status, 'predicted');
  assert.equal(result.frame.patient, 'person:zoya');
  assert.equal(result.frame.agent, 'person:lina');
});

test('correct future supervision can gain responsibility where corrupt supervision failed', () => {
  const corrected = copy(data.bad_update_train).map((row) => ({
    ...row,
    id: row.id + '-corrected',
    gold: { ...row.gold, tense: 'future' },
    annotation_note: 'Corrected supervised future label for the synthetic experiment.',
  }));
  const future = train([...selectedRows, ...corrected], { parentModelId: selected.model_id });
  const gate = compareCandidates(selected, future, data.development);
  assert.equal(gate.receipt.approved, true);
  assert.ok(gate.receipt.new_correct_frames > 0);
  assert.equal(gate.receipt.wrong_emitted_frames.length, 0);
});

test('actor, patient, polarity and modality remain separate fields', () => {
  const first = predict(base, 'en', 'Sara thanked Mira.').frame;
  const swapped = predict(base, 'en', 'Mira thanked Sara.').frame;
  const negative = predict(base, 'en', 'Sara did not thank Mira.').frame;
  assert.equal(first.agent, swapped.patient);
  assert.equal(first.patient, swapped.agent);
  assert.deepEqual({ ...first, polarity: false }, negative);
  assert.equal(first.modality, 'assertion');
  const reversed = copy(data.base_train);
  reversed.forEach((row) => {
    row.gold.polarity = !row.gold.polarity;
  });
  assert.equal(predict(train(reversed), 'en', 'Sara thanked Mira.').frame.polarity, false);
});

test('surface order is learned from supplied examples', () => {
  const rows = copy(data.base_train);
  rows.forEach((row) => {
    row.text = tokenize(row.text).reverse().join(' ');
  });
  const reversed = train(rows);
  const heldOut = data.development.find((row) => row.category === 'held_out_composition');
  assert.deepEqual(
    predict(reversed, heldOut.language, tokenize(heldOut.text).reverse().join(' ')).frame,
    heldOut.gold,
  );
});

test('distinct conflicting rules produce explicit ambiguity instead of a majority guess', () => {
  const noisy = copy(data.base_train);
  const row = noisy.find((row) => row.language === 'en' && row.gold.polarity);
  row.gold.polarity = false;
  const result = predict(train(noisy), 'en', 'Sara thanked Mira.');
  assert.equal(result.status, 'abstained');
  assert.equal(result.reason, 'ambiguous_parse');
  assert.equal(result.candidate_count, 2);
  assert.deepEqual(
    new Set(result.alternatives.map((frame) => frame.polarity)),
    new Set([true, false]),
  );
});

test('insufficient alignment is reported as unaligned training', () => {
  const model = train([data.base_train[0]]);
  assert.equal(model.rules.length, 0);
  assert.equal(model.unaligned_training_ids.length, 1);
  assert.equal(model.alignment_issues[0].reason, 'missing_role_alignment');
  assert.equal(predict(model, 'en', data.base_train[0].text).reason, 'no_supported_parse');
});

test('schema cannot pretend that two identical person roles were aligned', () => {
  const row = copy(data.base_train.find((row) => row.language === 'en' && row.gold.polarity));
  row.id = 'self-role';
  row.gold.agent = 'person:sara';
  row.gold.patient = 'person:sara';
  row.text = 'Sara thanked Sara.';
  row.gold.action = data.base_train.find((row) => row.gold.action.endsWith('#thank')).gold.action;
  const result = train([...data.base_train, row]);
  assert.equal(
    result.alignment_issues.find((issue) => issue.id === row.id).reason,
    'ambiguous_roles',
  );
});

test('unknown words are not invented; known grammar literals are not called unknown', () => {
  const result = predict(base, 'en', 'Zoya thanked Sara.');
  assert.equal(result.reason, 'no_supported_parse');
  assert.deepEqual(result.diagnostics.unknown_tokens, ['zoya']);
  assert.deepEqual(predict(base, 'en', 'Sara did not thank Mira.').diagnostics.unknown_tokens, []);
});

test('same normalized utterance cannot have conflicting gold meanings', () => {
  const row = copy(data.base_train[0]);
  row.id = 'bad-duplicate';
  row.gold.polarity = !row.gold.polarity;
  assert.throws(() => train([...data.base_train, row]), err('CONFLICTING_SUPERVISION'));
});

test('UTF-8 JSON and row/text bounds reject excessive input', () => {
  assert.throws(() => parseRowsJson('{broken'), err('INVALID_JSON'));
  assert.throws(() => parseRowsJson(' '.repeat(LIMITS.jsonBytes + 1)), err('JSON_TOO_LARGE'));
  assert.throws(() => parseRowsJson('ع'.repeat(LIMITS.jsonBytes)), err('JSON_TOO_LARGE'));
  assert.throws(
    () => validateRows(Array(LIMITS.rows + 1).fill(data.base_train[0])),
    err('TOO_MANY_ROWS'),
  );
  const row = copy(data.base_train[0]);
  row.text = 'x'.repeat(LIMITS.textCharacters + 1);
  assert.throws(() => train([row]), err('INVALID_STRING'));
  assert.throws(
    () =>
      tokenize(
        Array(LIMITS.tokens + 1)
          .fill('a')
          .join(' '),
      ),
    err('TEXT_TOO_COMPLEX'),
  );
});

test('invalid schema, duplicate IDs and null training labels are rejected', () => {
  const row = copy(data.base_train[0]);
  row.gold.polarity = 'true';
  assert.throws(() => train([row]), err('INVALID_POLARITY'));
  row.gold.polarity = true;
  row.gold.location = 'Dubai';
  assert.throws(() => train([row]), err('INVALID_SCHEMA'));
  assert.throws(() => train([data.base_train[0], data.base_train[0]]), err('DUPLICATE_ID'));
  assert.throws(() => train([{ ...data.base_train[0], gold: null }]), err('INVALID_SHAPE'));
});

test('prototype pollution keys and accessors cannot enter row or frame data', () => {
  const row = JSON.stringify(data.base_train[0]);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const poisoned = '[' + row.slice(0, -1) + `,"${key}":{"polluted":true}}]`;
    assert.throws(() => parseRowsJson(poisoned), err('UNSAFE_KEY'));
    const framePoison = JSON.parse(row);
    Object.defineProperty(framePoison.gold, key, { value: { polluted: true }, enumerable: true });
    assert.throws(() => train([framePoison]), err('UNSAFE_KEY'));
  }
  let invoked = false;
  const accessor = copy(data.base_train[0]);
  Object.defineProperty(accessor, 'text', {
    get() {
      invoked = true;
      return 'bad';
    },
    enumerable: true,
  });
  assert.throws(() => train([accessor]), err('ACCESSOR_NOT_ALLOWED'));
  assert.equal(invoked, false);
  assert.equal({}.polluted, undefined);
});

test('training and promotion cannot consume final-test rows; development leakage is rejected', () => {
  assert.throws(() => train(data.development), err('TRAINING_SPLIT_ONLY'));
  assert.throws(
    () => compareCandidates(base, selected, data.final_test),
    err('DEVELOPMENT_SPLIT_ONLY'),
  );
  const leaked = { ...copy(data.base_train[0]), id: 'leaked', split: 'development' };
  assert.throws(() => compareCandidates(base, selected, [leaked]), err('DEVELOPMENT_LEAKAGE'));
  leaked.family = 'new-family';
  assert.throws(() => compareCandidates(base, selected, [leaked]), err('DEVELOPMENT_LEAKAGE'));
  assert.throws(() => compareCandidates(base, selected, []), err('EMPTY_DEVELOPMENT'));
});

test('workspace scope and expected parent snapshot govern candidate adoption', () => {
  const other = train(selectedRows, { scopeId: 'other-workspace' });
  assert.throws(() => compareCandidates(base, other, data.development), err('SCOPE_MISMATCH'));
  const stale = train(selectedRows, { parentModelId: selected.model_id });
  assert.throws(() => compareCandidates(base, stale, data.development), err('STALE_PARENT'));
  const valid = train(selectedRows, { parentModelId: base.model_id });
  assert.equal(compareCandidates(base, valid, data.development).receipt.approved, true);
});

test('candidate scoring leaves snapshots unchanged and serialization preserves predictions', () => {
  const before = JSON.stringify(base),
    after = JSON.stringify(selected);
  compareCandidates(base, selected, data.development);
  assert.equal(JSON.stringify(base), before);
  assert.equal(JSON.stringify(selected), after);
  assert.equal(Object.isFrozen(base), true);
  assert.equal(Object.isFrozen(base.rules[0].pattern), true);
  assert.deepEqual(
    predict(JSON.parse(after), 'en', 'Sara did thank Mira.'),
    predict(selected, 'en', 'Sara did thank Mira.'),
  );
});

test('abstention stays in the exact-match denominator and boundaries are separate', () => {
  const empty = evaluate(train([]), data.final_test);
  assert.equal(empty.frame_scored_examples, 51);
  assert.equal(empty.correct_frames, 0);
  assert.equal(empty.exact_match_including_abstentions, 0);
  assert.equal(empty.abstentions, 53);
  assert.equal(empty.selective_accuracy, null);
  assert.equal(empty.schema_boundary_examples, 2);
  assert.equal(empty.schema_boundary_abstentions, 2);
});

test('normalization supports supplied Unicode casefold and canonical data ordering', () => {
  assert.deepEqual(tokenize('  STRASSE Straße Σς  ?'), ['strasse', 'strasse', 'σσ']);
  assert.deepEqual(tokenize('سارة ساعدت ميرا؟'), ['سارة', 'ساعدت', 'ميرا']);
  assert.equal(canonicalJson({ b: true, a: 'ع' }), canonicalJson({ a: 'ع', b: true }));
});
