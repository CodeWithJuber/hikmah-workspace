# Hikmah Context Field v6 — research, mathematics and implemented boundaries

10 September 2026. This report accompanies the fitted parameter files and the private workspace implementation. It distinguishes executed experiments, source-backed observations and research proposals. The new owned core uses sparse learned factors and constrained graph decoding. It does not contain a transformer, dense embedding encoder or next-token language generator. The connected provider still supplies broad conversational and coding generation.

## The architectural correction

The previous six-slot learner could represent one event, with restricted participants, action, tense, polarity and modality. A broad coding request exceeded that schema. Reporting a bootstrap workflow choice alongside “No supported parse” as a successful intelligence action concealed that limitation. Adding more rows to the same representation would not create document understanding.

V6 therefore separates **syntax learning**, **context compilation**, **lexical association**, **workflow choice** and **provider generation**. The legacy learner remains inspectable. The primary chat path now uses the expanded context compiler when enabled; it preserves original messages and treats every local event prediction as a fallible annotation. A workflow rating changes workflow preference, not the new parser's semantic knowledge or any provider weights.

A complete shared meaning system needs distinct layers for symbols, senses, roles, reference and operator scope. That separation is grounded in existing meaning-bank practice, rather than a claim that root substitution alone solves language. [Parallel Meaning Bank manual](https://pmb.let.rug.nl/manual.php). Document-level reference, temporal and modal relations are also explicit research subjects in UMR. [Uniform Meaning Representation](https://umr4nlp.github.io/web/).

## What is trained and what is not

| Component                   | Actual v6 state                                                                                                            | Evidence boundary                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sparse syntax models        | Five models fitted from English, Arabic, Hindi, Spanish and Turkish PUD data                                               | Syntax labels, not gold meaning                                                         |
| POS decoder                 | Whole-sequence Viterbi over learned lexical/affix and transition factors                                                   | Gold segmentation in reported evaluation                                                |
| Dependency decoder          | Learned arc factors, maximum rooted tree per candidate root                                                                | Top three root candidates; global root search is approximate                            |
| Document compiler           | Multiple event hypotheses, source sentences, candidate role edges, operator cues, exact literals and unresolved references | Explicit heuristic rules; not a trained or validated full scope parser                  |
| Cross-language associations | Bidirectional IBM Model 1 parameters learned for English with Arabic, Hindi, Urdu, Spanish and Turkish                     | Single-token association candidates; not translation or sense equivalence               |
| Quranic-root research       | Seven root families, 18 word examples and six contextual contrasts                                                         | Source-checked AI research seed; not independent scholarly gold                         |
| Formal meaning fixtures     | Fourteen licensed PMB gold-status examples, German/Italian/Dutch                                                           | Inspection fixtures only; not used for model training or an accuracy claim              |
| Controlled local output     | Deterministic readable rendering of event hypotheses and unresolved references                                             | No general free-text generation                                                         |
| Reviewed updates            | Browser worker refits parameters; server recomputes the development gate; D1/R2 retain receipts and models                 | Reused development gate is not a fresh test                                             |
| Main-model replacement      | Not achieved                                                                                                               | Requires independent semantics, realization, world interaction and unseen task evidence |

This is an owned trained multilingual **syntactic base with partial context graphs**, not a completed foundation model. Established methods are credited: spanning-tree dependency parsing, dynamic programming and IBM Model 1 are prior art. Ownership of this implementation and learned parameters is different from inventing every mathematical primitive. [McDonald et al., non-projective dependency parsing](https://aclanthology.org/H05-1066/), [Brown et al., statistical translation models](https://aclanthology.org/J93-2003/).

## Data actually acquired and partitioned

PUD provides 1,000 parallel sentences in each selected language: 5,000 records and 105,920 basic tokens in this pack. Source documents and translations are grouped before splitting. Each language has **827 train, 97 development and 76 test sentences**. Exactly **4,135 sentences / 87,703 tokens** entered parser fitting. Group and tree-validity checks passed. PUD is originally distributed as test-only data; its maintainers allow training reuse while recommending ten-fold cross-validation. This experiment uses one internal grouped split, not a completed ten-fold study or an official shared-task score. [PUD documentation](https://universaldependencies.org/treebanks/en_pud/index.html).

The lexical research set contains **21,742 selected Tatoeba pairs**: 17,356 train, 2,219 development, 2,167 test. Five EM iterations fit training rows only, after length/vocabulary eligibility filtering. Translation-connected components remain within one split. Exact cross-split normalized text and exact PUD-overlap checks passed; they do not rule out paraphrase or topical leakage. No source Tatoeba sentences are served by the app. The 1.93 MB deployed asset contains **16,619 aggregate token associations**, plus probabilities and support counts. Exact eligibility counts by direction are in the lexical report. [OPUS Tatoeba](https://opus.nlpl.eu/Tatoeba/corpus/version/Tatoeba).

The inspected PMB 4.0 sample contains 120 documents spanning gold, silver and bronze status. The displayed subset has four German, five Italian and five Dutch gold-status fixtures with retained component text licenses. Gold tagging layers do not mean an automatically compiled formal representation is infallible. These inspected fixtures are unsuitable as a fresh evaluation set. [PMB data](https://pmb.let.rug.nl/data.php).

## Mathematics executed by the owned core

### Sparse sequence factors

For a feature \(f\) and POS tag \(t\), the learned count table supplies

\[
q(t\mid f)=\frac{c_f(t)+0.2}{\sum_{t'}c_f(t')+0.2|T|}.
\]

Features include normalized surface word, character shape, suffixes of lengths 1–4 and prefixes of lengths 1–2. Word factors receive weight 3.4 when known; the tag prior receives 0.25, shape 0.45, and affixes 0.08 for known words or 0.55 otherwise. These coefficients are implementation choices, not discovered universal linguistic constants. The selected transition coefficient is development-tested.

The tag sequence is decoded jointly:

\[
\hat t_{1:n}=\arg\max_{t_{1:n}}\left[\sum_i \ell(t_i,w_i)+\lambda\sum_i\log q(t_i\mid t_{i-1})\right].
\]

Viterbi's state transition considers the entire sentence's score, rather than greedily choosing each POS. It costs \(O(n|T|^2)\) with backpointers. Unicode normalization and affix extraction are deterministic preprocessing; they are not a learned tokenizer. Frequency of a seen surface form is not calibrated semantic confidence.

### Learned dependency factors and tree constraints

For each arc feature \(f\), let \(a_f\) count gold positive occurrences and \(b_f\) count possible candidate-arc exposures in training. The implementation fits

\[
w_f=\log\frac{a_f+0.5}{b_f+1}-\log\frac{N_{sentences}}{N_{tokens}}.
\]

Arc features combine head/dependent POS, direction, distance bin and lexical head/dependent features. Arc scores sum these learned weights with fixed structural coefficients and the development-selected lexical coefficient. This is a sparse association scorer, not a globally normalized conditional model.

For each of the three highest-scoring root candidates, the decoder enforces exactly one root and solves

\[
\hat A_r=\arg\max_{A\in\mathcal T_r}\sum_{(h,d)\in A}s(h,d).
\]

Chu–Liu/Edmonds cycle contraction finds the maximum rooted arborescence for that candidate. The best of the three candidates is retained. An independent exhaustive check compared 2,250 small random graphs with 248,589 valid enumerated trees: all 2,028 feasible cases matched the optimum; all 222 disconnected cases were rejected. This verifies the decoder on those cases, not the correctness of linguistic predictions.

The independent review found two implementation defects: a non-root could receive a `root` relation through fallback counts, and an unseen prototype-name token could inherit a JavaScript morphology property. Both were corrected. Empty/punctuation-only evaluation and malformed model validation were also corrected. Existing selected parameters were retained and scores recomputed; this is not a new untouched test.

### Lexical bridge

For a source sequence \(s_0,\ldots,s_m\), including a null source during fitting, IBM Model 1 assigns expected alignment mass

\[
\delta_{ij}=\frac{\tau(t_j\mid s_i)}{\sum_{k=0}^{m}\tau(t_j\mid s_k)}.
\]

Expected counts are accumulated and normalized to refit \(\tau\). Bidirectional models are fitted independently. The exported model requires source and joint document-group support of at least three, retains three candidates, and records the retained probability mass. Displayed `probability` remains the conditional probability from the full distribution; `top3Share` is only the renormalized share among retained candidates.

For a non-English token, the explorer shows candidate paths through English to an Arabic surface word:

\[
\operatorname{pathScore}(w,e,a)=\tau(e\mid w)\tau(a\mid e).
\]

This product ranks a path. It is not a calibrated probability of semantic truth, an etymological relationship, or an identified Quranic root. Multiple paths and unknowns are retained. The exported model's aligned-versus-shuffled sentence controls range approximately 87.7–96.0%; these are easy compatibility sanity checks with substantial confounds and are deliberately not presented as translation, gold alignment, meaning or AGI accuracy. Exact metrics and full-table diagnostics are separate in the report.

### Context graph and future semantic loss

The executed compiler builds \(G=(X,E,O,R,S)\): entity mentions, event hypotheses, operator cues, unresolved reference candidates and source sentences. Exact repeated names may share an entity; common-noun mentions remain separate. Pronouns preserve candidates instead of becoming confirmed links. Quotation boundaries and operator attachment can remain unresolved. A source sentence is always retained when parsing fails. Current raw-text inference is bounded to the latest 24 sentences, each up to 96 tokens.

The intended semantic system needs a separate scoped expression algebra, for example `not(event)`, `if(antecedent, consequent)`, reported propositions and temporal/modal boxes. The current compiler does **not** correctly resolve arbitrary combinations of these operators. More vocabulary cannot substitute for labeled contextual supervision. UCCA and cross-language meaning representation research provide relevant comparison targets, with their own representational choices. [UCCA](https://aclanthology.org/P13-1023/), [Cross-linguistic AMR study](https://aclanthology.org/2024.cl-2.1/).

A proposed next-stage supervised loss should separate concept, role, scope, reference and provenance errors:

\[
L=\lambda_cL_{concept}+\lambda_rL_{role}+\lambda_sL_{scope}+\lambda_aL_{reference}+\lambda_pL_{provenance}.
\]

This loss is a research specification, not a loss already optimized in v6. Candidate graph construction can use sparse grammar induction and constrained search, followed by grammar-based realization. GF demonstrates that abstract meanings and language-specific realization can be separated without transformer decoding. [Grammatical Framework](https://www.grammaticalframework.org/doc/tutorial/gf-tutorial.html). A full graph plan still needs an output ordering mechanism; “context-wide” does not remove the sequential nature of speech or text display.

## Measured parser results

| Language | Train tokens | Development LAS | Test LAS | Test POS |
| -------- | -----------: | --------------: | -------: | -------: |
| English  |       17,541 |          53.45% |   48.85% |   87.23% |
| Arabic   |       17,143 |          49.58% |   47.81% |   83.62% |
| Hindi    |       19,764 |          50.42% |   48.96% |   88.25% |
| Spanish  |       19,273 |          57.68% |   59.90% |   90.04% |
| Turkish  |       13,982 |          36.73% |   35.69% |   82.88% |

LAS counts an edge correct only when its head and base relation label match. Evaluation uses **gold basic-token segmentation, predicted POS and gold-punctuation exclusion**. Raw browser tokenization does not inherit these scores. Urdu has a lexical association model but no trained syntax parser. Romanized Hindi/Urdu, code switching, arbitrary sound-to-meaning mapping, semantic accuracy, general generation quality and autonomous task success have not been established.

Development ablations compared four factor settings. The local-only LAS values were 48.61/49.47/46.94/54.65/35.41% for en/ar/hi/es/tr. Selected structured settings reached 53.45/49.58/50.42/57.68/36.73%. The improvement is not uniform evidence for every factor: Arabic selected transition context without lexical arc weighting, while Turkish selected moderate sequence and lexical factors. This small split cannot establish universal transfer.

## Quranic roots and the recovered full corpus

The original package is now available: **191/191 files match their manifest hashes**. It contains 6,236 unique ayah review rows, 6,236 context memberships covering 2,275 spans, 114 cached ar-Jalalayn tafsir files with 6,236 entries, and 22 engineering patterns with 29 acyclic prerequisite links. The app exposes the complete original review ledger, preserving its source links and study order.

All ledger entries remain **AI contextual first-pass records**. The dispositions are 1,541 candidates, 2,180 no direct analogy, 2,048 context only and 467 needing deeper review. A complete row count does not establish complete scholarly analysis or a full semantic dependency graph. This update audits the available package and deepens the small root/context seed; it does not claim an independent new reading of every tafsir entry.

Root, lemma, morphological operators and contextual proposition must remain distinct. The Quranic Arabic Corpus explicitly documents particles outside the root-template paradigm. Thus an all-root representation would discard information even within Quranic Arabic. [QAC morphology](https://corpus.quran.com/documentation/morphologicalfeatures.jsp). The source-checked seed contrasts investigation with respite under ن ظ ر, and physical writing with prescription or scoped exceptions under ك ت ب. The explorer preserves each attested context and excluded inference rather than merging these occurrences.

The universal-ancestry hypothesis is not established by this research. Arabic and Semitic classifications do not subsume every language family; a translation pivot is different evidence from historical descent. [Arabic classification](https://glottolog.org/resource/languoid/id/arab1395), [Indo-European classification](https://glottolog.org/resource/languoid/id/indo1319). The productive engineering question is whether a reviewed Arabic-sense pivot improves controlled semantic transfer beyond no-anchor and arbitrary-label baselines. The protocol includes root-only, sense-aware, no-root and label-permutation controls, withheld languages and scope contrasts. Iteration should resolve these tests, including negative results, rather than continue until a preferred claim appears true.

The original 22 principle patterns remain engineering interpretations. Verification-before-assertion, preserving entrusted context, keeping disagreement visible and repairing observed errors can guide tool workflows. Their provenance does not itself validate a parsing algorithm, numerical constant, consensus threshold or general intelligence claim.

## Learning, control and the application

A reviewed batch refits the sparse model in a browser worker using PUD training rows plus cumulative corrections from the active checkpoint. The server ignores client claims of approval, validates model structure and independently scores the frozen development set. Automatic activation requires a strict LAS gain, no sentence-level LAS/POS regressions and no aggregate POS regression against the current active checkpoint. Parameters are stored in R2, with owner-isolated D1 metadata, hashes and receipts. Stale activation receipts cannot overwrite a newer version. The released model can be restored. A failed gate is retained for inspection; a thumbs-up does not silently become a gold parse.

This is input-triggered training while the application is open, not an autonomous always-on training service. The current correction batch format is bounded and requires explicit linguistic labels. Repeated development use can overfit; wider deployment needs a separately reserved blind gate and fresh construction-family tests. COGS and ReCOGS illustrate why compositional evaluation and representation artifacts require careful separation. [COGS](https://aclanthology.org/2020.emnlp-main.731/), [ReCOGS](https://arxiv.org/abs/2303.13716).

Compare now has independently streaming lanes with requested/returned model identities, generation/review/repair stages, provider usage when reported, first-text time and per-stage explanations. The direct lane omits the Hikmah context compiler, principle injection and tools; both lanes retain ordinary user preferences and starting conversation. Using different models is an exploratory comparison. Using the same model isolates workflow differences more directly, but extra calls still make compute unequal. No superiority or token-saving score is inferred from one pair.

Readable provider-returned reasoning/summary fields are displayed. Opaque continuation blocks are preserved for tool-call continuity without rendering or decoding them. Some models do not return readable explanations. This follows the provider's documented API behavior and does not claim access to inaccessible internal thoughts. [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Interrupted answer text is retained in continuation checkpoints. A failure in one lane no longer discards a completed response in the other.

## Research gates beyond v6

1. **Raw language analysis:** learn segmentation/morphology; add measured romanization and code-switching data. Keep document/translation groups disjoint.
2. **Scoped semantics:** obtain sufficiently licensed, adjudicated sense/role/reference/scope annotations. Add counterfactual pairs where negation, attribution, quantifiers or roles change while vocabulary stays similar.
3. **Pivot ablation:** compare Arabic-root labels, Arabic contextual senses, language-neutral concepts and randomized identifiers with matched data and compute. Accept an Arabic pivot only where it improves measured transfer.
4. **Controlled realization:** implement a typed multilingual grammar over verified graph families. Score meaning preservation, scope, literal retention and human acceptability, separately from fluency.
5. **Tool competence:** train and verify reusable procedures against observable task outcomes. Provider judgments can propose labels; they cannot certify their own truth.
6. **Acoustic research:** acquire licensed parallel speech with speaker, channel and context controls before fitting any sound-to-meaning model. Existing FFT/STFT experiments inspect signals; they have no trained semantic interpretation. A global frequency magnitude discards temporal/phase information, so it cannot uniquely identify arbitrary meaning.
7. **Broader autonomy:** evaluate independent task families, failure recovery, cost and latency against the same provider under matched budgets before delegating more responsibility locally.

No gate guarantees eventual AGI. The deliverable is a testable implementation and research path with retained failures, not evidence that an unfinished component already achieves the target.
