# Hikmah multilingual research data v6.1

Two real corpus collections and an official semantic-graph sample are present. They replace neither a trained model nor semantic evaluation. The former application corpus contains 144 AI-authored synthetic training records limited to a single event, two person roles, action, polarity, tense and modality.

## What is present

| Collection | Languages | Downloaded | Prepared | Supervision |
|---|---|---:|---:|---|
| Universal Dependencies PUD | English, Arabic, Hindi, Spanish, Turkish | 5,000 sentence records | 5,000 records / 105,920 basic tokens | POS, dependency arcs, morphology and lemma fields, with mixed manual/automatic annotation provenance |
| OPUS Tatoeba v2026-07-08 | English paired with Arabic, Hindi, Urdu, Spanish, Turkish | 961,407 aligned pairs | 21,742 pairs | Community sentence translation links; no gold meaning graph |

Acquisition downloaded approximately 33.6 MB. Entire research directory is approximately 62 MB. Raw sources were not executed. All retained source files and prepared outputs have hashes in `manifest.json` and adjacent `provenance.json` files.

## Files and use

`processed/ud-pud-LANGUAGE.json`: metadata plus `sentences` array. Each sentence has `id`, `parallelId`, `groupId`, `fold`, `split`, `text`, `tokens`, `hasMultiwordTokens`, `multiwordTokens`, `hasEmptyNodes` and `emptyNodes`. Basic tokens contain integer `id`, `form`, `lemma`, `upos`, integer `head`, `deprel`, and a `feats` dictionary. Range-token records and empty nodes are retained separately, not silently converted into basic tokens. Source text is unchanged.

A source-document group is kept in the same fold across all five translations. Fold 0 is the initial test partition, fold 1 development, folds 2–9 training. Each language has 827 training, 97 development and 76 test sentences. **This is an internal research split, not a completed ten-fold cross-validation result.** PUD's maintainers recommend ten-fold cross-validation if the original shared-task test corpus is reused for training. See the [upstream README](https://github.com/UniversalDependencies/UD_English-PUD/blob/master/README.md).

Evaluation with supplied token boundaries must say **gold-tokenized parsing**. A result using gold POS must additionally say **gold POS**. Neither can be described as performance from raw text. Report UAS/LAS both overall and excluding punctuation. Arabic clitic segmentation needs its own tokenizer evaluation; spaces are not a valid universal tokenization rule.

`processed/tatoeba-{train,development,test}.json`: metadata plus `pairs` array. Pairs retain English `en`, target `text`, `language`, archive line and SHA256, `groupId`, `fold` and `split`. Target languages have 5,000 selected pairs each except Urdu, which has all 1,742 available pairs. Selection uses a fixed record hash and is independent of archive order. Selected English/target text connected components prevent exact sentence translations and duplicate target strings from crossing partitions. Partitions contain 17,356 train, 2,219 development and 2,167 test pairs.

Do not load these large corpus JSON files into every chat. Train offline from `train`; export compact learned parameters and a provenance/metrics card. Keep development/test data away from the inference model and learning queue. A user-visible dataset browser should explicitly label examples as corpus material, not generated answers.

## Verification and limitations

`prepare_assets.py` asserts aligned PUD sentence IDs and document-fold maps across every language; checks basic token IDs and head ranges; asserts zero exact text overlap across Tatoeba splits; and excludes exact PUD texts from Tatoeba. The source snapshots make the procedure reproducible.

It does not prove paraphrase-family independence, an absence of pretraining contamination in third-party models, or correct translations. FLORES was not downloaded; therefore its texts were not used, but absence of phrase overlap against unseen FLORES records has not been established. Any future FLORES integration must remain evaluation-only and respect its access terms.

The PUD languages have different annotation histories. English POS and dependency corrections include human review while English lemmas/features are automatic. Arabic and Hindi have manual annotations converted into UD plus automatic lemmas. Spanish lemmas are listed as manual. Each original README is preserved. These differences affect confidence and cross-language comparisons.

Tatoeba describes a volunteer contribution process and explicitly does not guarantee professional translation accuracy. It is suitable for statistical alignment candidates and reviewed examples; do not treat all sentence assertions as facts or all alignments as semantic truth. [Tatoeba terms](https://tatoeba.org/en/terms_of_use)

## Licenses and attribution

PUD is distributed by its maintainers under **CC BY-SA 3.0**. The five original `LICENSE.txt` and `README.md` files are preserved. Preserve attribution and share-alike obligations for redistributed/adapted corpus material. Language-specific contributors appear in those READMEs. [Arabic PUD documentation](https://universaldependencies.org/treebanks/ar_pud/index.html)

The downloaded OPUS Tatoeba archives include **CC BY 2.0 FR** LICENSE text and upstream README. Attribution: Tatoeba contributors; OPUS collection and tools by Jörg Tiedemann. Cite J. Tiedemann (2012), *Parallel Data, Tools and Interfaces in OPUS*, LREC 2012. Original source: [OPUS Tatoeba release](https://opus.nlpl.eu/legacy/Tatoeba-v2026-07-08.php); [Tatoeba](https://tatoeba.org/). Exact archive URLs, row numbers and hashes are retained for every prepared pair. This Moses export does **not** provide original sentence IDs or individual author names: those fields are explicitly null. Do not invent them or mark individual attribution complete. Resolve sentence-author attribution before publicly displaying or redistributing extracted sentences in a production product; raw upstream notices remain included here.

## Dataset-to-algorithm pairing

1. **PUD → sparse structured prediction**: learn POS and dependency arcs from surface features, suffix/prefix patterns and contextual structural features; use constrained tree decoding. This is an independently trainable model without a transformer or dense embedding requirement. Structured perceptron/MST/transition methods are established prior art; novelty must lie in tested extensions, not renaming them.
2. **Tatoeba → alignment candidates**: learn sparse bidirectional lexical alignment from train pairs; require reciprocal agreement and report coverage plus ambiguity. Candidate links are many-to-many and contextual. Do not turn a frequent co-occurrence into a universal root equivalence.
3. **Meaning graph → a separate evaluated layer**: dependency arcs are evidence for syntax, not sufficient labels for agent/patient, quantifier scope, negation scope, coreference, presupposition or intent. Use reviewed semantic graph data and discourse tests to train/evaluate this layer before claiming broad meaning understanding.
4. **Arabic roots → optional provenance-bearing semantic anchors**: compare root anchors with language-neutral concept IDs, English anchors, shuffled roots and no-root ablations. Match parameter count/data/compute and hold out domains and languages. A mere relabeling that leaves predictions identical cannot establish an Arabic-origin advantage. No supplied corpus proves that all languages descend from Quranic Arabic.

## Alternatives evaluated

| Source | Useful for | Decision |
|---|---|---|
| [Parallel Meaning Bank](https://pmb.let.rug.nl/data.php) | Compositional meaning representations with gold/silver/bronze distinctions; English/German/Italian/Dutch | Best next semantic supervision; release 5.1 full download is about 1 GB, beyond this task cap. Official 4.0 sample acquired: 120 inspection records with 40 gold/40 silver/40 bronze; 14 fixtures selected with explicit component text licenses. |
| [FLORES+](https://huggingface.co/datasets/openlanguagedata/flores_plus) | Professionally translated multilingual evaluation | Evaluation-only, now gated; not downloaded or treated as training. |
| [Universal Dependencies](https://universaldependencies.org/) | Typed cross-language morphosyntax | PUD selected for five-way alignment and explicit CC BY-SA license. Urdu UDTB / Hindi HDTB licenses differ and were not silently mixed into the product. |
| [Wiktionary/Wikimedia dumps](https://dumps.wikimedia.org/legal.html) | Morphology, lexical relations and etymological evidence | Useful later; does not directly supply verified sentence meaning or discourse graphs. Per-entry provenance and current license conditions needed. |
| [Quranic Arabic Corpus](https://corpus.quran.com/download/) | Quranic morphological/syntactic data and root studies | Official download has a contact-email step and specific preservation/attribution terms; no email submitted and no unauthorized substitute obtained. It must remain a separately attributed source layer. |

No full-Quran tafsir study, universal etymology proof, new general base language model, or performance increase is established merely by this data acquisition.

## PMB semantic sample added in v6.2

`processed/pmb-sample-research.json` preserves 120 official sample records and 4,830 DRS clauses across English, German, Italian and Dutch, with per-layer annotation status and subcorpus metadata. `processed/pmb-shareable-graph-fixtures.json` contains 14 selected gold fixtures with explicit component text licenses. The sample contributes 40 gold records / 685 gold DRS clauses overall; the remaining 80 records are silver or bronze and must not be reported as verified meaning labels. These are inspected fixtures, not held-out performance evidence. See `raw/pmb/summary.json` and `distribution-notes.md` for scope, licenses and publication boundaries.

The PMB representation retains scope boxes, variables, lexical predicates/senses, role edges and alignment spans. No graph has been flattened into a six-field event. Gold layers were manually checked, while the final DRSs are compiled by the symbolic Boxer pipeline; this does not make the annotations infallible. The selection is small and biased by quality, so it cannot establish a general base language model.

## Trainable lexical channel

`train_lexical.py` implements a transparent bidirectional sparse IBM Model 1 baseline and was executed for five EM iterations per direction using only the prepared Tatoeba training split. The 1.93 MB `learned/lexical-associations.json` contains 16,619 top-three single-token associations; document-group frequency and pair support are each at least three. It contains no source sentence excerpts. The full conditional probability, truncated mass, candidate-relative probability, and support remain distinct.

`learned/lexical-association-report.json` reports served-parameter diagnostics separately from the full fitted tables. The held-out test control compares each genuine sentence pair to an unrelated shuffled target, an intentionally easy compatibility check, not gold word alignment, translation, context understanding, root alignment, or a base-model capability score. Train/dev/test are never merged for fitting. `learned/verification.json` records the verified invariants. For bundling, copy `source-license-attribution/` alongside the learned model.

An input token can follow target-language→English→Arabic candidate paths by multiplying conditional association probabilities. A resulting Arabic surface word still needs independently reviewed morphology and sense/context evidence before it can be linked to a Quranic root. Translational association is not historical descent.

Algorithm provenance: Peter F. Brown, Stephen A. Della Pietra, Vincent J. Della Pietra and Robert L. Mercer (1993), *The Mathematics of Statistical Machine Translation: Parameter Estimation*, Computational Linguistics 19(2), 263–311. https://aclanthology.org/J93-2003/. IBM Model 1 is established prior art used here as a transparent baseline/channel, not claimed as a new invention.
