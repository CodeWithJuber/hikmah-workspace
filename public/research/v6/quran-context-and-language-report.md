# Quranic roots, contextual meaning, and the owned multilingual core

Research date: 10 September 2026. This is a bounded audit and engineering specification. It does not claim a new full tafsir, universal language ancestry, a trained general-purpose model, or measured superiority. Companion JSON files preserve exact original IDs and file hashes.

## What the original work actually contains

The previous statement that the original ledger was unrecovered is now incorrect. The original directory is available. An independent read-only audit recomputed coverage and hashes, rather than accepting the old summary.

| Layer | Audited result | What it establishes |
|---|---:|---|
| Original package manifest | 191 of 191 files present; all hashes match | Package integrity |
| Ayah ledger | 6,236 unique ayahs, 114 surahs, no missing/extra/duplicate keys | Complete row coverage |
| Context links | 6,236 memberships, 2,275 distinct spans; bounds and links pass | A context-reading index |
| Tafsir acquisition | 114 files, 282 pages, 6,236 entries; all recorded file hashes match | Retained ar-Jalalayn acquisition, complete key coverage |
| Engineering candidates | 1,541 ayahs | AI-authored proposed analogies |
| No direct analogy | 2,180 ayahs | A valid retained negative result |
| Context only | 2,048 ayahs | No direct engineering transfer asserted |
| Needs deeper review | 467 ayahs | Unresolved review queue |
| Pattern catalog | 22 patterns, 29 direct prerequisite edges; acyclic | Preserved dependency-aware policy specification |
| Root-and-context seed | 7 root families, 18 word examples, 15 ayahs | Small source-checked semantic seed |

Every ledger row is marked `ai_contextual_first_pass`; independent scholarly verification is absent. Context links mean `first_review_context_membership`. They are not a complete coreference, causal, entailment, discourse, or semantic argument graph. Thus there is a real distinction between **full-corpus first-pass coverage** and **a full-corpus trained meaning model**. The former exists; the latter does not.

The retained translation check reports 342 keyed cross-interface checks: 335 normalized exact matches, six punctuation variants, and one wording variant at 86:1. This is same-provider cross-interface checking; the originally described Claude ZIP was not independently verified. The retained study order is a traditional surah-onset ordering, not exact revelation order for every verse.

## The hypothesis must be stated in two different ways

**Historical hypothesis:** every language descends from Quranic Arabic. The inspected linguistic classifications do not establish this. Glottolog records Arabic and Semitic classifications, and separately records Indo-European with its own family-membership evidence. A future ancestry claim would need systematic sound correspondences, reconstructible intermediate forms, dated attestations and controls for borrowing and chance; translating meanings into Arabic is not that evidence. We have not established universal descent. [Arabic classification](https://glottolog.org/resource/languoid/id/arab1395), [Semitic classification](https://glottolog.org/resource/languoid/id/semi1276), [Indo-European classification](https://glottolog.org/resource/languoid/id/indo1319).

**Engineering hypothesis:** Quranic lexical senses, retained with their context, can provide a useful inspectable pivot for some multilingual reasoning tasks. This is implementable and testable without asserting ancestry. The pivot must support many-to-many mappings, compositional operators, unresolved alternatives, and concepts with no reviewed Quranic link. Its value is measured by semantic accuracy and transfer, not the number of Arabic labels it emits.

Research must iterate until a specified test is resolved, not until one preferred conclusion appears. Negative results, invariances and unknowns are part of the model's knowledge. A study that changes its success criterion after every failure cannot verify its starting claim.

## Why a root is not a complete meaning

Arabic roots group derivational families; lemmas group forms more narrowly. Morphological segments preserve information such as conjunctions, participants, aspect and mood. The Quranic Arabic Corpus explicitly gives particles with lemmas but no roots, because they lie outside the root-template paradigm. An all-root representation would therefore lose distinctions even within Quranic Arabic. [QAC morphological features](https://corpus.quran.com/documentation/morphologicalfeatures.jsp).

The existing seed already contains decisive contrasts: ن ظ ر links looking, pending examination and respite; ك ت ب covers writing and prescription. These require different event senses and conditions. The root concordances independently illustrate this variation. [ن ظ ر concordance](https://corpus.quran.com/qurandictionary.jsp?q=nZr), [ك ت ب concordance](https://corpus.quran.com/qurandictionary.jsp?q=ktb).

The adapter also must respect the source language. Turkish can express multiple modalities within a morphologically complex word. Chinese lacks ordinary whitespace segmentation and uses particles and aspect markers extensively. Sharing a semantic target does not make those analyses interchangeable. [Turkish annotation guidelines](https://universaldependencies.org/tr/index.html), [Chinese annotation guidelines](https://universaldependencies.org/zh/index.html).

Graph semantics is relevant prior art, not a new discovery of this project. AMR encodes predicate roles, coreference, modality and scoped negation; UCCA uses conceptual units and relations that can abstract over surface constructions. Cross-language AMR research nevertheless finds differences due to source language, translation choices and annotation. A shared graph is useful but cannot be assumed to erase all distinctions. [AMR paper](https://aclanthology.org/W13-2322.pdf), [UCCA paper](https://aclanthology.org/P13-1023.pdf), [Cross-linguistic AMR study](https://aclanthology.org/2024.cl-2.1/).

## Proposed representation contract

Use a source-preserving typed graph, with an optional Arabic sense anchor on semantic concepts. Keep original text and offsets; never replace raw input with a root string. A practical record has these layers:

| Layer | Required fields | Failure behavior |
|---|---|---|
| Surface | language, script, text, spans, normalization version | Preserve original text |
| Morphology | segment candidates, lemma, optional root, features, evidence | Keep competing analyses |
| Sense | stable concept ID, candidate senses, optional Quranic root/lemma links | `unmapped` is valid |
| Proposition | participants, event roles, scope tree, polarity, time, aspect, modality | Do not flatten operators |
| Discourse | speaker, addressee, referents, quotation scope, topic, time anchors | Clarify unresolved references |
| Epistemics | asserted/reported/hypothesized/observed, support and contradiction IDs | No self-certification |
| Task state | requested goal, accepted constraints, pending question, completion checks | Separate intent from execution |
| Provenance | source edition, ayah/word, context span, hashes, reviewer, version | Reject unsupported source attribution |

Every graph node or edge must identify its origin: observed span, reviewed lexical entry, deterministic derivation, external-model proposal, or reviewed correction. Confidence is separate from execution permission. A high scoring parse cannot authorize a tool or make a religious interpretation authoritative.

A root anchor is a relation `concept -> attested contextual sense -> lemma/form -> root`, with evidence. It is not `word -> root -> truth`. A concept may have several anchors; a root may anchor several different concepts; an exact literal, code identifier, new technical term or unresolved span may have none.

Important scope distinctions include:

- `not(required(send))` versus `required(not(send))`.
- `said(A, completed(test))` versus `observed(completed(test))`.
- `if(pass(test), deploy)` versus `pass(test) and deploy`.
- `before(approval, send)` versus `before(send, approval)`.
- An analogy such as “the server is sleeping” versus a literal biological sleep event.
- Quoted instructions versus the current user's instructions.
- A pronoun with one supported antecedent versus two unresolved candidates.

The earlier six-field single-event frame remains useful as a compatibility projection of a supported graph. It must not silently discard extra clauses or unknown roles to claim a successful full parse.

## Algorithms that can run without transformer inference in the owned core

Let the learned state be M = (L, G, S, W, P, T): lexical mappings, weighted constructions, sense inventory, sparse rule weights, executable procedures and observed transition statistics. Raw evidence and authority policy are separately versioned stores.

1. **Candidate segmentation:** retain language-specific candidate spans, including multiword expressions and morphemes. Character or word units are representation choices; avoiding transformer subword tokens does not remove the need to segment evidence.
2. **Typed composition:** constructions combine lexical senses into graph fragments. Unification checks role types, agreement and operator scope. Pack alternatives that share spans instead of committing too early.
3. **Context integration:** resolve references only against compatible discourse candidates; attach unfilled references explicitly. Retrieve only evidence relevant to current graph nodes, with source versions.
4. **Constrained ranking:** rank candidate graphs using learned lexical/construction evidence, argument compatibility, discourse fit and observed outcomes. Mark the score as a ranking value until calibration is measured.
5. **Execution boundary:** validate the graph against task permissions and tool schemas outside the learner. Execute available tests or ask a targeted clarification when ambiguity changes the action.
6. **Realization:** choose a complete supported proposition or clause plan, realize it through target-language constructions, and preserve unresolved details. A stream may display completed clauses progressively. This does not prove humans reason this way or make external provider generation non-autoregressive.
7. **Learning:** external models propose aligned examples; correction or executable evidence supplies admissible labels. Train a candidate, compare on frozen development families, record regressions, promote narrowly, retain rollback. Logs alone are not training.

For a candidate graph g from utterance u and context c, an initial transparent objective is:

`score(g|u,c) = lexical(g,u) + construction(g,u) + discourse(g,c) + evidence(g,c) - unsupported(g) - conflict(g) - description_length(g)`.

These are our proposed feature terms and penalties. They are not a proof of semantic correctness or probabilities. A sparse structured learner can update weights on a reviewed pair `(g_gold, g_pred)` by adding the feature difference, or constructions can retain smoothed observed counts. Either mechanism changes subsequent predictions and can be versioned.

For a construction r in family F, a simple estimated preference is `p(r|F) = (count(r)+alpha)/(sum_F count + alpha*|F|)`. Observations must be deduplicated by source lineage; repeating one generated paraphrase a thousand times must not count as a thousand independent confirmations.

Weighted grammar parsing has established non-transformer algorithms. The cited Earley work gives a grammar-conditioned complexity bound, but unrestricted graph unification and discourse inference require their own bounds. Use capped alternatives, explicit exhaustion status and resumable search. [Efficient semiring-weighted Earley parsing](https://aclanthology.org/2023.acl-long.204/).

“Whole context” should mean that all relevant scoped constraints influence the decision. It should not mean placing an unbounded history into every step. Compress only after measuring the loss of answer-critical distinctions. A lossy map that merges two decision-relevant contexts cannot preserve their different correct outputs without additional information.

## The preserved 22 patterns must remain executable contracts

Do not replace the original catalog with a handful of new names. `quran-patterns-preserved.json` contains exact original IDs, instructions and prerequisites. Compile prerequisite closure before running a pattern. Store results as `pattern_id, pattern_version, applicable, status, evidence_ids, blocked_by, next_action`. Example: P13 progressive learning depends on P09 verification and P11 revisable beliefs; those depend on evidence, uncertainty and context preservation. Learning admission therefore cannot ignore the same evidence rules the learner is meant to improve.

UI labels can use plain language while the inspectable evidence page retains the source trace. The corpus is data and provenance; it is not a channel through which retrieved text changes system permissions. Existing rules about privacy, authority, context, causal care, honest completion and proportionate effort stay in the dependency graph.

## Concrete experiments and falsification tests

The companion `root-context-experiments.json` specifies executable acceptance conditions. These are proposed tests, not reported victories.

| Test | Required comparison | Meaning of failure |
|---|---|---|
| Root label permutation | Rename all root IDs consistently; keep graph structure and training rows fixed | If pure symbolic predictions change, implementation leaks display labels; unchanged performance shows labels alone are not the source of power |
| Root-only collapse | Root-only baseline versus root+sense+scope graph | Loss on prescription/writing or respite/examination disproves root sufficiency |
| Remove Arabic anchors | Identical graph with anchors present versus absent | No change means metadata provenance, not measured predictive benefit |
| Sense sharing | Shared reviewed senses versus language-isolated senses, fixed annotation budget | No transfer gain weakens the semantic-pivot hypothesis for that task |
| No-link concepts | Code identifiers, UUIDs, new technical terms, particles | Invented roots or lost literals violate the representation contract |
| Operator minimal pairs | Negation, permission, obligation, quotation, exception, conditional changes | Identical actionable meaning exposes scope loss |
| Many-to-many | Synonyms across roots; one root with contrasting senses | One-to-one assumptions must be removed |
| Context swap | Same words with changed antecedents, speaker, timing or task constraint | Unchanged output where action should change reveals context blindness |
| Held-out transfer | Hold out construction families, scenarios and annotator sources | Random-row success alone cannot support generalization |
| Mixed scripts/languages | Arabic/Urdu shared script, Hindi/Urdu parallel senses, Hinglish, unspaced Chinese | Script detection must not masquerade as language understanding |
| Natural text | Independently reviewed native passages beyond generated templates | Synthetic repetition is not base-model coverage |
| Learning rollback | Correction improves supported cases; bad labels rejected; rollback restores prior behavior | Memory-only changes or silent regressions do not satisfy training |

For each release publish exact graph/role/scope scores, answer coverage, error among answered cases, unsupported-claim rate, per-language results, latency, actual provider tokens, annotation cost and model/dataset hashes. One favorable average must not hide a failing language or permission-critical contrast.

A same-model comparison needs the provider/model ID for each stage and the direct baseline. Compare both (a) an ordinary direct call versus the full system and (b) a matched-total-budget baseline. Improvement with more calls is different evidence from improved efficiency. Avoid “hundreds of times better” until a defined ratio has been measured.

## Data expansion that actually addresses the gap

Start with the seven seed families and all their retained contrasts. Add reviewed sense IDs and roles across the 18 examples before expanding by raw row count. Use the 467 deeper-review rows as an explicitly unresolved queue. Preserve no-analogy outcomes rather than manufacturing an engineering lesson for every ayah.

Then expand coverage in independent dimensions: root families, contextual senses, constructions, languages, dialogue contexts and practical task domains. A million substitutions from one template do not supply a million linguistic phenomena. For each batch record annotation origin, bilingual review status, agreement/adjudication, source license, family split and source hash.

The official QAC v0.4 release notes report syntactic treebank coverage of 40% by word count. Morphological availability therefore cannot be presented as a complete dependency or semantic graph. Any imported release must record its exact version and actual coverage. [QAC release notes](https://corpus.quran.com/releasenotes.jsp).

Prior sound research is retained separately. It concerns selected phonetic/iconic associations and signal-processing tools, not a universal mapping from acoustic frequency to full meaning or Quranic ancestry. Current direct fetches of several sound papers were blocked; this report does not upgrade the previous access status. Required future controls include speaker, device, rate, pitch, language-family and lexical-item holdouts, plus signed-language and text-only tasks. A system that represents meaning must work when no acoustic waveform is present.

The research loop should continue through preregistered milestones and failed-test repairs. “A complete new general-purpose base model” remains an evidence-dependent program. A useful release now can own typed parsing, context memory, verification, narrow reasoning, learned constructions and realization while explicitly identifying which broader outputs still came from an external model.
