# Independent review of Hikmah Context Field

Reviewed `lib/context-model/field-model.ts` and `scripts/train-context-model.mjs` read-only on 10 September 2026. The executable source snapshot is `field-model-reviewed.mjs`; `review-field-model.mjs` reproduces this review. The results are saved in `field-model-review-results.json`.

## Decoder: passed independent brute-force comparison

The Chu–Liu/Edmonds implementation was compared against exhaustive enumeration on 2,250 deterministic random graphs with 2–7 vertices, arbitrary root vertices, tied positive/negative integer weights, and forbidden edges. The oracle enumerated 248,589 valid rooted trees in total. All 2,028 feasible graphs returned an optimal valid rooted tree. All 222 infeasible graphs failed as expected. No optimum or tree-validity mismatch was found.

This supports correctness for the examined cases, not a formal proof. `parseForms` enumerates only its configured top root candidates, which is explicitly labeled in its returned decoder description. Its optimality statement is therefore correctly conditional on those candidates rather than an unrestricted single-root optimum.

## Fix before release: nonroot tokens can receive the relation `root`

`fitField` adds root relations into `relations['dep|TAG']`. `parseForms` uses this distribution as the fallback relation for nonroot heads. For tags frequently found at the root, the fallback can therefore produce a second `root` relation even though the head tree contains only one artificial-root edge.

Reproduction: train on two labeled sentences `cats run` and `dogs sleep`, each with NOUN `nsubj` of a VERB root. Parse `['run','sleep']`. The returned tokens are:

```json
[
  { "id": 1, "form": "run", "head": 0, "relation": "root" },
  { "id": 2, "form": "sleep", "head": 1, "relation": "root" }
]
```

The second label violates the dependency schema and can mislead a graph lift that detects roots by relation. Select `root` iff the head is zero, exclude `root` from nonroot fallback candidates, and use `dep` if no admissible relation remains. Test this invariant for every parsed token, not only the toy example.

## Fix before release: inherited morphology escapes the declared type

`m.morphology[normal(form)] ?? {}` does not check ownership. Serialized model dictionaries deserialize to ordinary objects. For an unseen surface `constructor`, the lookup returns the inherited Object constructor function. For `__proto__`, it returns the inherited prototype object.

Reproduction: `JSON.parse(JSON.stringify(toyModel))`, `validateField(model)`, then `parseForms(model, ['constructor','run'])`. The first token's `morphology` is a function and is exactly `Object`, although `ParsedToken` declares a string dictionary. This is a concrete prototype lookup defect; no arbitrary code execution was demonstrated.

Use `Object.hasOwn(m.morphology,key)` before lookup, or return a deeply validated copy whose maps have null prototypes. Apply the same own-property convention used by the existing `row` helper.

## Validation accepts malformed model shapes

All these mutations passed `validateField` on an otherwise fitted model:

- Delete the complete `training` manifest.
- Set `arcs` to `[]`.
- Set `morphology` to `[]`.
- Replace the tag inventory by `['NOUN','NOUN']`.
- Replace the tag inventory by `['','NOUN']`.

The validator therefore does not establish its declared `FieldModel` contract. Missing training metadata can break code that displays sentence/group counts; duplicate/empty tags can generate malformed model output; array dictionaries undermine assumptions in downstream code. Validate the training object and its bounded fields; require plain record maps rather than arrays; require distinct, nonempty supported tag strings; and return validated data rather than trusting the original cast. If imported JSON is accepted, enforce a total byte/entry budget too; per-outer-map limits do not bound nested table size.

## Metric boundary defect: punctuation-only examples inflate exactness

Evaluating a one-token punctuation sentence results in `tokenCount=0`, `exactTrees=1`, `exactTreeRate=1`, and NaN POS/UAS/LAS values. JSON serializes the NaNs as null, concealing the internal non-finite arithmetic. A dataset containing empty scored sentences can inflate the exact-tree rate.

After applying the scoring mask, exclude or separately count any sentence with zero scored tokens; use explicit null metrics for empty denominators. The exactness metric otherwise measures base-relation attachment correctness excluding punctuation, not a complete UD tree. The existing `evaluationInput` description explains this, but a UI should retain that qualifier near “exact tree.”

## Data and leakage checks passed for the current split

The five processed PUD files each contain 1,000 sentences. All examined basic trees have contiguous integer IDs, one root, valid heads and no cycles. Each language has 321 train groups, 42 development groups and 34 test groups, with no train/development/test group overlap. Parallel sentence IDs map to the same group, fold and split across languages.

The training script fits feature tables only from `split==='train'` rows. Four configurations are chosen on development LAS with a POS tie-break; test is evaluated afterward. Inference receives only test forms, predicts POS, and uses learned training-only lemma/morphology tables. No direct gold test POS/lemma/head leakage was found in this pipeline. Gold tokenization, base relation scoring and gold punctuation exclusion are explicitly disclosed.

The source manifest correctly describes this as a single internal document-group partition, not completed ten-fold cross-validation or official shared-task performance. Preserve that distinction. The foundational PUD documentation recommends ten-fold cross-validation if the official test treebank is reused for training; this run does not fulfill that broader research protocol yet.

## Scope of this review

This review verifies the implemented graph decoder and several specific parser/validation/metric contracts. It does not establish semantic correctness, raw-text segmentation quality, calibrated confidence, multilingual coreference, general-language generation, or a new foundation model. The parser's returned warning correctly describes syntax predictions as hypotheses.
