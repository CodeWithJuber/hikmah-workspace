# Context Field v6 model card

Model format: `hikmah.context-field.v1`. Created 10 September 2026. Models: English, Arabic, Hindi, Spanish, Turkish. Architecture: learned sparse count factors, whole-sequence POS Viterbi, sparse arc scores, Chu–Liu/Edmonds trees with three candidate roots. No pretrained neural encoder, embedding model, transformer, or external API is used in fitting or local inference.

## Intended use

Inspect learned syntax, experiment with document context, propose fallible local annotations, and evaluate reviewed syntax corrections. Do not use this model as an authority for factual truth, unconstrained semantics, translation quality or independent general-purpose generation. The UI preserves untrained languages and unresolved references instead of labeling them understood.

## Data and supervision

Five UD Parallel PUD treebanks, pinned source revisions in `public/research/v6/source-notices/ud-pud/`. Each contains 1,000 aligned sentences. Internal split: 827 train / 97 development / 76 test per language, grouped by original document and aligned translation. Fitting uses 4,135 sentences, 87,703 tokens. Development selects among four factor settings. Reported test uses gold basic-token segmentation, predicted POS, base dependency relation labels, with gold punctuation excluded. English lemma/morphology provenance is weaker than manually corrected POS/dependencies; see upstream notes.

PUD is officially test-only data. This is an internal research reuse, not the original shared-task evaluation and not completed ten-fold cross-validation. All held-out translations remain together. No semantic accuracy score is claimed. Parameter tables are actual fitted counts and weights, not model-name placeholders.

## Separate lexical model

`hikmah.lexical-association.ibm1.v1` uses five-iteration bidirectional IBM Model 1 over train-only OPUS Tatoeba pairs. The exported 16,619 associations include source group frequency, joint support, full-distribution probability, retained mass and displayed top-three share. Six represented languages include English and Urdu. These associations do not supply Urdu syntax, complete translation, roots, or etymological evidence. The source-sentence corpus is not distributed through this model.

## Attribution and terms for data artifacts

PUD-derived processed data and fitted parameter files in this release are distributed with the source CC BY-SA 3.0 terms and contributor notices. See `source-notices/ud-pud/*/LICENSE.txt`, READMEs and pinned provenance. The copied PUD data has been transformed into JSON and partitioned by document group; the model files derive sparse statistics from the training partition.

Association parameters derive from the OPUS Tatoeba v2026-07-08 sentence collection, contributed by Tatoeba users and distributed by OPUS (Jörg Tiedemann), under CC BY 2.0 France. Transformation: normalization, grouping, train-only sparse statistical alignment learning and pruning. Available upstream corpus attribution, exact URLs, revisions and hashes are preserved; missing individual source-author metadata has not been invented. Parameters are not treated as automatically exempt from source obligations. No endorsement is implied.

Contains information from the Parallel Meaning Bank, made available under ODC-BY 1.0. Selected fixture texts retain CC BY 3.0 German/Italian and CC BY 4.0 Dutch component terms. The excluded sample texts are not redistributed. Application implementation authorship does not override these data notices.

## Updates and release discipline

Reviewed corrections need token/POS/head/relation annotations. A browser worker refits parameters using the released configuration and training data plus cumulative corrections from the active saved checkpoint. The candidate is retained in memory for export if saving fails. D1 stores owner-isolated metadata and evaluation receipts; R2 stores parameter bytes and cumulative reviewed rows. The server recomputes development results and ignores client-supplied approval claims.

Passing requires a strict development LAS gain, no per-sentence LAS/POS regressions and no aggregate POS regression against the currently active reference. Automatic activation is available after the check. Compare-and-set activation rejects stale parents; restoration to the released checkpoint is explicit. This is experimental deployment within the private workspace, not a claim that a reused development gate certifies generalization.

Conversation ratings update the separate workflow preference learner. Conversations and unreviewed generated answers are not automatically ground-truth linguistic training data. There is no unattended background trainer after the tab closes.

## Reproduction

1. Download and unpack `public/research/v6/pud-reproduction.zip`. It contains full processed PUD train/development/reported-test rows and source notices.
2. From the project checkout, run `node scripts/train-context-model.mjs /absolute/path/to/unpacked/processed /absolute/path/to/new-output`.
3. Model timestamps change between runs. Compare the fitted parameter tables and predictions, not only raw file hashes. Existing release hashes are recorded in the model manifest.
4. Run `node scripts/build-context-worker.mjs` after changing the worker, training or inference implementation.
5. Data acquisition/preparation scripts are retained in `scripts/v6-data/`. Lexical training takes the prepared research-data directory with `python scripts/train-lexical.py /absolute/path/to/research-data`. This directory must contain the attributed Tatoeba train/development/test pair files; the app does not include those source sentences.
6. Do not train on development/test data to reproduce favorable scores. Any further tuning after reading this report needs a fresh reserved evaluation.

See `research.md`, per-language evaluation JSON and `lexical-association-report.json` for actual measurements and unresolved work.
