# Hikmah Context Compiler: an owned, trainable multilingual research architecture

Research and implementation contracts, 10 September 2026. This report is a proposal and source audit, not a claim that the proposed components have all been implemented or that a general language model has been trained. No external language model is required by the proposed parser, graph inference, or controlled realization algorithms.

## Decisions that should change the product now

The current `lib/engines/meaning-engine.ts` documents itself accurately as a bounded supervised lexical/surface-template induction engine. It accepts one event with agent, action, patient, polarity, tense, and modality; even its participant schema only permits `person:` symbols. Its lexical learner intersects the three role symbols seen beside each whitespace token. Its rules then replace recognized words with three role slots. More examples in this representation do not make it capable of objects, multiple propositions, quotations, reference, quantifier scope, or dialogue state. Its failure on a general coding request is an expected schema boundary, not evidence that a small strategy choice has performed language understanding.

Build a separate `hikmah.context.v1` model with (a) learned surface analysis; (b) typed, scoped, multi-event graphs; (c) explicit discourse state; (d) supervised construction induction; (e) graph-to-language realization. Keep the old engine as a reproducible historical experiment. The pipeline must record which component contributed each result. A workflow preference learned from thumbs-up is not a semantic parser improvement. An external provider's answer is not owned-model generation. Arabic-root associations are optional sense links, not a replacement for the graph.

For the immediate real-data milestone, train an owned sparse structured parser from UD Parallel PUD in Arabic, English, Hindi, Spanish, and Turkish. Call it a **trained multilingual syntactic base with partial context graphs**. PUD does not supply general word-sense labels, coreference, truth, or full scope. Urdu without training remains an explicit untrained/evaluation-only language. Do not claim language-wide competence merely because the parser emits a tree for arbitrary text.

## What primary research establishes, and what we are proposing

| Evidence | Consequence for Hikmah |
|---|---|
| The Parallel Meaning Bank demonstrates shared compositional representations over translated texts, including reference and formal meaning. Its annotation pipeline has distinct layers rather than a universal word replacement. [PMB paper](https://aclanthology.org/E17-2039/) | A shared interlingua is a credible engineering direction; it does not establish shared historical ancestry. Preserve annotation layers and provenance. |
| PMB's manual separately tracks symbols, senses, roles, reference, scope, syntax, and lambda-DRS. [PMB manual](https://pmb.let.rug.nl/manual.php) | Meaning and context need distinct typed fields and interaction rules. A single root identifier cannot stand in for all of them. |
| UMR explicitly extends sentence representations with document-level coreference, temporal and modal dependencies. [UMR project](https://umr4nlp.github.io/web/) | Store a document graph and discourse state instead of resetting six slots every sentence. |
| UCCA is a graph annotation scheme intended to capture cross-linguistically relevant semantic structure. [UCCA](https://aclanthology.org/P13-1023/) | Graph structures are substantial prior art. Our design must be compared with existing schemes, not presented as their invention. |
| Grammatical Framework separates meanings in abstract syntax from language-specific concrete syntax and supports parsing/linearization. [GF tutorial](https://www.grammaticalframework.org/doc/tutorial/gf-tutorial.html) | Plan a complete supported meaning graph first, then realize that graph in a language. Controlled realization does not require transformer decoding. |
| Zettlemoyer and Collins induce a grammar and log-linear semantic parser from sentences paired with logical forms, evaluated on database domains. [UAI 2005 paper](https://arxiv.org/abs/1207.1420) | Sparse learned composition is a real trainable architecture; grammar induction and typed semantics are not newly invented here. |
| Weighted Earley parsing is expressible as semiring deduction with established complexity and cycle-handling conditions. [ACL 2023 paper](https://aclanthology.org/2023.acl-long.204/) | Use a bounded chart or packed forest for composition, rather than a bag of cues. Do not claim arbitrary graph unification has the same complexity as context-free parsing. |
| Non-projective dependency parsing can be cast as a spanning-tree problem with learned arc scores. [McDonald et al. 2005](https://aclanthology.org/H05-1066/) | The real-data syntactic base can use owned sparse features and global tree decoding without attention or embeddings. |
| Popper alternates hypothesis generation, testing, and constraints obtained from failures. [Cropper and Morel](https://arxiv.org/abs/2005.02259) | The research loop should refine hypotheses using counterexamples and stop when exhausted or plateaued; it must not force a desired conclusion. |
| COGS probes systematic combinations of familiar words and structures; ReCOGS shows incidental logical-form details can distort evaluation. [COGS](https://aclanthology.org/2020.emnlp-main.731/), [ReCOGS](https://arxiv.org/abs/2303.13716) | Hold out construction families and score semantic equivalence under valid renaming, not literal JSON variable names. |

## Model state and exact representation

The proposed owned model is

\[
M=(V,\Theta_{seg},\Theta_{pos},\Theta_{dep},L,\Gamma,w,A,R,C,\mathcal E).
\]

`V` is the versioned concept/type registry; `Theta` are learned segmentation, tagging and dependency parameters; `L` is a multilingual sense lexicon; `Gamma` and `w` are typed composition rules and sparse weights; `A` contains candidate translation alignments; `R` is a realization grammar; `C` is a calibration record; `E` is the immutable supervision/evaluation manifest. Dialogue state is an input to inference, not an undocumented change to parameters.

A semantic graph has entity/event nodes and a separate expression algebra for scope:

```ts
type Id = string;
type Span = { turnId: Id; start: number; end: number }; // Unicode offset convention fixed in schema
type SenseRef =
  | { kind: 'reviewed'; id: Id }
  | { kind: 'candidate'; language: string; lemma: string; candidates: Id[] }
  | { kind: 'unknown'; surface: string; language: string };
type RootLink = {
  root: string; senseId: Id; relation: 'lexicalized-as' | 'related-sense';
  verseRefs: string[]; sourceId: Id; review: 'candidate' | 'reviewed';
};
type Entity = {
  id: Id; kind: 'person' | 'object' | 'place' | 'organization' | 'abstract' | 'unknown';
  mentions: Span[]; name?: string;
  number?: 'singular' | 'dual' | 'plural';
  grammaticalGender?: string; // not automatically a real-world gender claim
  introducedIn: Id;
};
type Event = {
  id: Id; predicate: SenseRef;
  roles: Partial<Record<'agent' | 'patient' | 'theme' | 'recipient' | 'source' |
    'destination' | 'instrument' | 'experiencer', Id[]>>;
  aspect?: 'completed' | 'ongoing' | 'habitual' | 'unknown';
  time?: { relation: 'before' | 'at' | 'after' | 'unknown'; anchor: Id };
  sourceSpans: Span[]; // every asserted edge also has an evidence record
};
type Expr =
  | { op: 'atom'; event: Id }
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'if'; antecedent: Expr; consequent: Expr }
  | { op: 'exists' | 'forall'; variable: Id; restrictor: Expr; body: Expr }
  | { op: 'modal'; mode: 'possible' | 'necessary' | 'intended' | 'requested'; arg: Expr }
  | { op: 'attributed'; holder: Id; attitude: 'said' | 'believes' | 'reported'; arg: Expr }
  | { op: 'question'; variables: Id[]; body: Expr }
  | { op: 'unknown'; span: Span; reason: string };
type Assertion = { expression: Expr; speaker: Id; sourceTurn: Id; world: Id };
type Reference = {
  mention: Span; status: 'resolved' | 'ambiguous' | 'unresolved';
  entity?: Id; candidates: { entity: Id; score: number; evidence: Id[] }[];
};
type ContextGraph = {
  schema: 'hikmah.context.v1'; entities: Entity[]; events: Event[];
  assertions: Assertion[]; references: Reference[];
  temporalEdges: { before: Id; after: Id; evidence: Id[] }[];
  unresolved: { span: Span; type: 'sense' | 'scope' | 'reference' | 'syntax' | 'segmentation'; reason: string }[];
};
```

This is a proposed minimum, not the final universal ontology. Distinguish syntactic subjects from agents: passive subjects often correspond to patients, and experiencer predicates need separate roles. Preserve `nsubj` as a syntactic edge unless a reviewed construction maps it to a semantic role. Adjectival and nominal predication need events too, not only words tagged VERB.

A concrete context example is: “Sara wrote a letter. She did not send it. Ali says she sent it.” There are entities for Sara, the letter, and Ali; three events; an explicit negation over one send event; and attribution of the other send event to Ali. The graph must not conclude that both sending and not sending are established facts in one world. It may record a disagreement between reported claims. “Every student read a book” needs alternative scopes until the intended reading is established; replacing this by two roots destroys the distinction.

## Stage A: a real trainable syntactic base from Parallel PUD

### Data and split contract

PUD provides 1,000 sentence-level segments per language in aligned order. Its English documentation says the full treebank is official test data and recommends **ten-fold cross-validation if reused for training**. English UPOS and dependency relations were manually corrected, while lemmas and morphological features were automatically assigned. Some aligned segments contain more than one actual sentence. These conditions must appear in the model card. [UD English PUD](https://universaldependencies.org/treebanks/en_pud/index.html)

1. Freeze source commit, file hash, license, language, sentence IDs and normalization version before learning.
2. Group parallel versions by shared sentence ID. Assign all translations of a group to the same fold. If reliable document IDs are available, prefer keeping complete source documents together as the grouping unit too.
3. Use ten folds with a deterministic hash assignment balanced by source domain where feasible. Hyperparameters are fixed before outer testing or selected only within nine training folds using inner development data.
4. All dictionaries, affixes, label inventories, segmentation rules, alignment distributions, feature pruning, and calibration must be learned from the permitted training folds. A shared-language lexicon learned from held-out translations is leakage.
5. Cross-validation models are separate snapshots. A final production fit on all permissible rows has no untouched PUD test set; report its cross-validation evidence as evidence about the training procedure, not direct evaluation of that exact final snapshot.
6. Exclude malformed CoNLL-U rows with an audited reason. Interpret integer IDs as syntactic words, ranges as multiword-token surfaces, and decimal IDs as empty nodes. Basic dependency evaluation must not silently mix enhanced dependencies. [CoNLL-U specification](https://universaldependencies.org/format.html)

### Learned segmentation and tagging

Raw input needs a segmentation lattice. Train exact surface-to-segment candidates from multiword-token examples, plus explicit language-specific finite-state affix rules only when reviewed or induced from training data. A conservative baseline uses Unicode-aware punctuation/word segmentation and learned exact multiword expansions, records unresolved segmentation, and publishes its errors. Arabic clitics make this a substantive part of the model, not preprocessing to hide. The Quranic Arabic Corpus explicitly models prefixes, stems and attached pronouns; it also distinguishes roots from lemmas, and particles can lack root annotations. [Morphology documentation](https://corpus.quran.com/documentation/morphologicalfeatures.jsp)

Use learned sparse emissions and POS transitions. For tag `t` and surface `w`, a simple owned log score is

\[
e_\ell(t,w)=\lambda_0\log \hat P_\ell(t)
+\lambda_1\log\hat P_\ell(t\mid w)
+\sum_{a\in affixes(w)}\lambda_a\log\hat P_\ell(t\mid a)
+\lambda_s\log\hat P_\ell(t\mid shape(w)).
\]

This is a feature score, not a calibrated probability. Estimate each conditional by smoothed counts, e.g.

\[
\hat P(t\mid f)=\frac{c(f,t)+\alpha\hat P(t)}{c(f)+\alpha}.
\]

Use a finite list of prefixes/suffixes in Unicode code points, digit/case/script shape, and a language ID. Do not let casing infer personality or ethnicity. Prevent rare-word memorization from overwhelming the backoff features. Learn POS transitions with add-alpha smoothing. Decode the whole tag sequence by Viterbi:

\[
\delta_i(t)=e_\ell(t,w_i)+\max_u\{\delta_{i-1}(u)+\lambda_T\log\hat P_\ell(t\mid u)\}.
\]

Time is `O(n |T|²)` for a fixed tokenization. Joint lattice tagging requires states indexed by character boundary as well as tag; truncating the lattice must produce a diagnostic. A later discriminative sparse perceptron/CRF is a legitimate upgrade but must have its own version and evaluation. A count model is learned even without neural weights; the key evidence is that held-out predictions depend on fitted counts and survive absence of API access.

### Learned dependency scores and tree inference

For candidate head `h`, child `i`, and relation `r`, use a sparse score with observed counts/features:

\[
s(h,i,r)=\theta^\top\phi(\ell,w_h,w_i,\hat t_h,\hat t_i,direction,bin(|h-i|),r).
\]

Feature families: head/child tags and relation; head lemma or surface plus child tag; child surface plus head tag; adjacent tag context; direction; distance bins `1,2,3–5,6–10,11+`; possible root. Lemmas at inference must be predicted from learned mappings or remain surface forms. Gold test lemmas, features, POS tags, or dependency heads are prohibited in an end-to-end score. A diagnostic experiment may supply gold POS but must be labeled as an oracle-input score.

Start with smoothed conditional count log scores, then train a structured averaged perceptron if time permits:

\[
\theta\leftarrow\theta+\eta\big(\phi(x,y_{gold})-\phi(x,\hat y)\big).
\]

The update only improves a specified structured prediction objective; it is not automatically semantic learning. Predict a maximum-scoring directed arborescence:

\[
\hat T=\arg\max_{T\in\mathcal T_{single-root}}\sum_{(h,i,r)\in T}s(h,i,r).
\]

For arc-factored scores, choose the highest scoring label for each candidate arc then use Chu–Liu/Edmonds, with a genuine single-root constraint. A straightforward correct method enumerates the root child, forbids other artificial-root edges, decodes and chooses the best valid tree. Exact implementation complexity depends on the chosen spanning-tree algorithm; do not advertise a bound from a more optimized implementation. This formulation follows established graph parsing; Hikmah owns its feature model, fitting implementation, and downstream compiler, not the invention of MST parsing. [Graph parsing primary paper](https://aclanthology.org/H05-1066/)

A simpler approximate decoder is acceptable only when labeled accurately: select one root candidate, attach a new unconnected token to an already connected node at each step, explore a bounded beam, and return the best complete acyclic tree. Its construction guarantees one root and no cycles but not the global maximum. Record beam width and truncation. Never remove arbitrary cycles after greedy prediction while presenting the output as exact optimal inference.

### Honest graph lift from syntax

A syntactic prediction always remains available as syntax. The semantic lift adds only licensed constructions:

- An active transitive construction may map `nsubj` and `obj` to candidate actor/theme roles if voice and predicate class are supported; otherwise preserve them as syntax.
- Negation cues identify possible negation, not complete scope. Attach a `scope: unresolved` annotation when the construction cannot determine the target.
- `ccomp` can provide a structural complement candidate, but “says,” “knows,” “wants,” and “fails to” do not share truth behavior. Preserve predicate-specific attribution/modality candidates.
- `conj` records a structural coordination relation. It does not automatically mean temporal succession or logical conjunction of committed facts.
- A pronoun becomes an unresolved referent until an antecedent rule passes accessibility and ambiguity checks. Do not map every “it” to the last noun.
- Unknown senses remain `language:lemma` candidates. An Arabic translation association is metadata and cannot convert such a node into a reviewed concept.

The initial output can therefore be useful for inspecting relationships, forming clarification questions, and indexing bounded context while still returning `semanticCompleteness: partial`. It must not directly authorize tool execution.

## Stage B: train composition rather than annotate it with prompts

The next learned component takes reviewed tuples `(language, raw text, context, gold graph, alignments)` and adds grammar rules. This requires meaning-labeled data, not just PUD. The learned parser remains standalone; an external model may propose labels into a quarantined queue, but candidate output is not a gold graph.

1. Extract typed connected fragments from gold graphs; normalize local variable IDs by alpha-renaming.
2. Align spans with fragments using reviewed alignments first. With only sentence-to-graph pairs, enumerate bounded spans/fragments and retain competing alignments; do not collapse ambiguous co-occurrence to a single sense.
3. Anti-unify paired examples: replace differing compatible subgraphs with typed holes and replace their aligned spans with corresponding syntactic variables. Retain fixed operators such as negation, attribution and quantifiers.
4. A rule is `(language, input pattern, feature constraints, output graph expression, evidence IDs)`. Repeated independent examples increase counts; exact duplicates do not create independent support.
5. Reparse training data with the candidate rules. Reject rules that emit a contradicted meaning on known negative/minimal-pair examples or violate type/scope constraints. Prune over-general hypotheses using the counterexample.
6. Fit sparse rule weights on permitted training examples. For derivation `d`, use `score(d)=sum_r w_r count_r(d) + lexicalScore(d)`. With fully supervised derivations, smoothed rule counts are a baseline. With latent derivations, a log-linear likelihood sums compatible parses and needs exact or explicitly approximate inference.
7. Decode with a chart whose entries carry type, span, feature bindings and a packed graph fragment. Type-checked application composes fragments; variables are freshly renamed; incompatible identity bindings fail. Deduplicate alpha-equivalent graphs, not graph strings with arbitrary IDs.

The scope algebra is supplied architecture. The learned choices are which language constructions instantiate it and which senses attach to lexical forms. A generic composition engine should handle a construction learned in one sentence with previously learned words in a new combination. Do not count just memorizing a whole long sentence as compositional learning.

Example induction: paired reviewed examples “Sara did not send the letter” and “Ali did not send the parcel” can support `NP did not VP → NOT(VP(NP))` only if aligned fragments establish that the differing spans are NP arguments. A single example cannot determine whether “did not” is a negation operator, part of an idiom, or accidental text. Scope boundaries must be represented in the supervision.

## Context as an executable state transition

Let `D_t` contain discourse referents, attributed propositions, temporal anchors, unresolved questions and salience features. An utterance is interpreted as a relation over context states, not just an isolated fact:

\[
\llbracket u\rrbracket_M:D\rightarrow\{(G,D',score,evidence)\}.
\]

Context alternatives remain separate when materially different. A top-level affirmative indefinite can introduce an accessible referent. A referent introduced only inside negation must not automatically become an accessible existing object outside it. A hypothetical consequent does not become a world fact. A quotation has its own speaker/deictic frame. Pronoun candidates must pass scope accessibility, number/type compatibility where known, and non-contradiction with explicit identity evidence. Gender is only a grammatical constraint when the language and annotations warrant it.

Use a sparse trained antecedent score over distance, same-speaker, repeated name, grammatical compatibility, subject continuity and discourse accessibility. Score only accessible candidates. Until trained and calibrated on coreference annotations, call this a heuristic with unresolved output on ambiguity. CorefUD harmonizes multilingual coreference resources and is a suitable separate supervision/evaluation source; its currently listed release is 1.4, February 2026. [CorefUD](https://ufal.mff.cuni.cz/corefud)

Temporal reasoning stores partial orders. Validate an added `before` relation for cycles; a contradiction becomes a diagnostic with source IDs. A graph of propositions is not a collection of proven facts. Factual endorsement requires a separate evidence status, with quoted/hypothetical/inferred claims distinguished from direct user assertions and tool observations.

## Stage C: Arabic pivots and multilingual sense learning

A language-neutral identifier is not an English origin claim. It can have Arabic labels and reviewed Quranic-root associations while remaining an arbitrary stable ID. A root family can connect several distinct senses. Some concepts will have no attested Quranic lexicalization. Keep an extension namespace for mathematical, scientific and modern technical concepts.

To learn surface alignment from parallel data without embeddings, fit IBM Model 1 style lexical alignment distributions with an explicit NULL position. For target form `a_j` and source forms `w_0=NULL,w_1,...,w_n`, use posterior responsibilities

\[
q(i\mid a_j,w)=\frac{t(a_j\mid w_i)}{\sum_{k=0}^{n}t(a_j\mid w_k)}.
\]

Accumulate expected counts over **training pairs only**, normalize per source form, and iterate with fixed convergence criteria. Run both directions; use intersection/symmetric agreement as evidence, not truth. Add POS compatibility only as a declared feature. NULL prevents every function word being forced onto a content word. Word alignment learning is established statistical MT, not a new historical-linguistic discovery. [Brown et al.](https://aclanthology.org/J93-2003/)

For Hikmah, these probabilities create `TranslationCandidate` records. They do not create `sameSense` edges automatically. Polysemous “bank,” “right,” and “charge” demonstrate why surface translation cannot be the semantic identifier. Learn contextual sense assignments from reviewed sense annotations and construction context. Multiword expressions need span-level entries. Do not generate roots by deleting letters or map all words to the closest sounding Arabic token.

Open Multilingual Wordnet links language-specific lexical resources through an interlingual index and is useful as an external sense registry and candidate source. Its project page currently lists 60 wordnets for 49 languages. Import provenance and per-resource licenses; avoid inventing universal coverage. [OMW](https://omwn.org/)

Test the Arabic-root hypothesis as two separate questions:

1. **Representational utility:** do reviewed root/sense links improve task performance or annotation efficiency over equivalent arbitrary concept IDs, equal-capacity non-root ontologies, and shuffled-root controls? Split by held-out concepts and constructions; measure both benefits and forced-merger errors.
2. **Historical ancestry:** does independently collected comparative evidence establish systematic sound correspondences, inherited morphological paradigms and chronological pathways after controlling for borrowings? A translation pivot or high alignment score cannot answer this question. This implementation does not establish that every language derives from Quranic Arabic.

If replacing Arabic root labels with random stable IDs leaves inference unchanged, the labels are presentation/ontology metadata in that experiment. If a root prior improves a result, isolate its structural content from extra supervision and parameter capacity. Stop, revise, or reject hypotheses when the evidence fails them; repeatedly searching until a preferred conclusion appears is not a valid research loop.

## Stage D: complete-message realization without autoregressive LLM generation

The owned model can first choose a supported meaning/program graph, check it, and then realize it through weighted synchronous rules. A realization rule maps `(language, graph constructor, agreement features)` to an ordered sequence of lexical forms and child realizations. The graph is the unit of planning; transport may still stream chunks for a responsive UI.

```ts
fit(batch, manifest, parent): { candidate, trainingReceipt }
infer(text, language, discourse, snapshot): {
  status: 'complete' | 'partial' | 'ambiguous' | 'unsupported';
  graph: ContextGraph | null; alternatives: ContextGraph[];
  syntax: SyntaxTree | null;
  diagnostics: Diagnostic[]; evidence: Evidence[];
  snapshotId: string; // always the model that actually ran
}
realize(graph, language, snapshot): {
  status: 'realized' | 'missing_grammar' | 'ambiguous' | 'semantic_loss';
  text: string | null; ruleIds: string[]; coveredNodeIds: string[];
  missingNodeIds: string[]; roundTripEquivalent: boolean | null;
}
```

Realization must refuse silently omitting negation, modality, attribution, a role, or a scope operator. For the supported fragment, verify `parse(realize(G))` contains a graph equivalent to `G`, allowing only declared meaning-preserving normalization. Round-trip consistency is a construction check, not proof of naturalness or external correctness; mutually wrong parser and realizer can agree. Independent human comprehension and held-out translations remain necessary.

This core does not need BPE embeddings, attention layers, or next-token neural decoding. It still processes lexical segments and uses established NLP mathematics. The claim “humans do not generate token by token” is not established by choosing this software architecture. Do not present a research implementation as a model of human thought without cognitive evidence.

## Evaluation that can support capability growth

### Keep these measurements separate

| Layer | Required evidence | What it cannot establish |
|---|---|---|
| Segmentation | Boundary F1, multiword expansion accuracy, raw-text recovery; per language and OOV | Full meaning |
| POS | Token accuracy and macro tag F1 on predicted/raw and gold-segmented tracks | Correct dependencies |
| Syntax | UAS, LAS, exact sentence-tree rate; non-punctuation and all-token variants | Scope, coreference, factual correctness |
| Meaning | Alpha-equivalent exact graph rate; event/role/scope error slices; abstention coverage and selective accuracy | General dialogue/agency |
| Coreference | Mention detection plus link/cluster scores; ambiguous-case abstention | Speaker trust or truth |
| Realization | Graph round trip, semantic omission/insertion, human adequacy and grammaticality | General creative writing |
| Agent tasks | Task success, regression rate, user corrections, tool effects, cost, latency | AGI or 100-fold improvement |

Syntax UAS is `correct predicted heads / scored gold words`; LAS additionally requires the relation label. A production arbitrary-text parser should preserve raw segmentation failures rather than quietly skip hard sentences. Report the denominator, excluded counts, language, model hash and data hash. Use sentence-group bootstrap confidence intervals for cross-validation and paired model differences; do not pretend each dependent word is an independent sample.

Calibrate uncertainty on development data. POS Viterbi margins, parser arc margins and rule counts are diagnostic scores, not probabilities of semantic truth. If calibration is absent, display “uncalibrated score.” Set an abstention threshold using measured risk versus coverage. `complete` requires full declared semantic coverage, no unresolved critical reference/scope, and no search truncation. A high syntactic score is insufficient.

Construct a frozen contrast suite across languages and scripts for role reversal, negation scope, quantifier scope, passive voice, quotation, questions, possibility vs actuality, anaphora, code-switching, unknown technical terms, script variants, and contradictory context. Keep all translations and paraphrases of each scenario in one split. Add explicit tests where “not every” differs from “every ... not,” “Ali said P” does not assert P, and an unknown clause cannot disappear into an otherwise complete interpretation.

Train semantic models using available meaning-labeled corpora such as PMB, then evaluate on held-out documents and languages/constructions. PMB distinguishes human-verified gold, partially corrected silver, and machine-produced bronze. Its listed 5.1.0 release has 11,987 English, 3,179 German, 1,958 Italian and 1,557 Dutch gold instances. These are available corpus counts, not counts trained in Hikmah. Preserve the distinction in ingestion manifests and dashboards. [PMB data](https://pmb.let.rug.nl/data.php)

### Automatic learning and promotion

An automatic job can fit a candidate when new admissible examples or verified outcomes arrive. New data must have rights/provenance, reviewer or executable-check status, split assignment and a schema migration path. Fit changes actual model parameters. Replay existing tests; score new held-out capability examples; reject critical regressions; record candidate/promotion decisions; allow rollback. Model-authored self-labels stay candidates until independently checked. User approval means a label is authorized supervision, not that it is universally true.

For a promotion record, store `{parentHash, candidateHash, trainingDataHash, evaluationDataHash, algorithmVersion, changedParameterCounts, perLanguageMetrics, criticalFailures, decision, reasons}`. A newly approved model should run first in shadow mode if the graph will affect tool planning. Delegation is per tested capability and language; the learner cannot change its execution permissions or upgrade its own label from partial to general.

Use bounded counterexample-guided research rounds: choose a failure class, add targeted data or a typed rule hypothesis, fit, evaluate, compare, and checkpoint. Continue while independent held-out gains justify additional work. A plateau or invalid hypothesis is a result to report, not a reason to loop indefinitely. The output of this research pass is a falsifiable implementation program and a real-data path, not completion of general intelligence.

## Product observability and comparison contract

The user-facing trace should say, for example: “Hikmah syntax model v6: analyzed 2 sentences; 1 pronoun unresolved. Provider: selected model X, drafting answer. Verifier: model Y, checking source coverage.” Raw `No supported parse` JSON belongs in an expandable developer inspector, accompanied by an explanation and next action. A fallback result must explicitly say which component completed the work.

Comparison cards need actual provider/model IDs, mode, calls, status, elapsed time and token use for each branch. Distinguish `Direct provider`, `Provider + Hikmah context`, and `Hikmah local only`. Same-model comparisons should use the same input, provider configuration and frozen evaluation prompt. Match compute/cost when evaluating efficiency; allow different compute only when labeling a total-system benefit. Human quality ratings should be blind where possible. Do not imply a local parser produced the provider's fluent prose.

Display actual streamed provider text and only the reasoning summaries or reasoning fields that the provider makes available. Show deterministic local events—tagging complete, graph partial, source linked, candidate rejected—as public activity. This provides meaningful inspection without fabricating hidden internal thoughts or confusing debug payloads with an answer.

## Recommended implementation order

1. Frozen data manifest and aligned PUD cross-validation; independently fitted sparse tagging/parsing model with exportable parameters and no network dependence at inference.
2. UI model identity, true streaming, explicit direct/context/local comparison cards, and a context inspector with visible unknowns.
3. Conservative graph lift with source spans, multiple events, attribution and unresolved scope/reference; never advertise partial graphs as complete semantics.
4. PMB/UMR semantic data adapters plus manually checked Arabic/Hindi/Urdu construction sets; chart composition and supervised rule induction.
5. Independent coreference training and controlled realization with semantic preservation tests.
6. Application-specific verified programs, outcome learning and capability-based delegation. A general-purpose base model remains a subsequent empirical milestone.

The architectural contribution worth testing is the integration: a provenance-carrying, context-sensitive, multilingual compiler whose learned construction/lexical parameters can be promoted and used independently of the provider, with graph-level planning and explicitly loss-checked realization. Sparse parsing, DRT, grammar induction, statistical alignment, and realization already have substantial prior art. Novelty requires an ablation-supported capability or mechanism beyond renaming them.
