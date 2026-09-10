# A trainable meaning layer for the Hikmah playground

This is an executable research component. It learns lexical associations and sentence templates from explicitly supplied examples. It does not recognize arbitrary language, infer facts about the world, understand speech, or implement a general intelligence. Its narrow size makes the learning process inspectable and falsifiable.

The source is a TypeScript port of the earlier frozen Python learner. The core induction algorithm is unchanged. The browser version adds bounded input, explicit alignment diagnostics, workspace and snapshot checks, training/development overlap checks, and a pure candidate-selection receipt. It does not introduce a new scientific learning algorithm merely by moving that algorithm into a browser.

## 1. The supplied meaning space

Each utterance has one labeled frame:

\[
f=(a,v,p,\sigma,\tau,\mu)
\]

Here \(a\) is an agent, \(v\) an action, \(p\) a patient, \(\sigma\in\{\mathrm{true},\mathrm{false}\}\) polarity, \(\tau\in\{\mathrm{past},\mathrm{present},\mathrm{future}\}\) tense and \(\mu\in\{\mathrm{assertion},\mathrm{question},\mathrm{hypothesis}\}\) modality. Agent and patient are restricted to `person:` symbols. An action may use a reviewed root-and-sense identifier such as `action:qroot:ش-ك-ر#thank`.

The schema is supplied by the designer. The example labels are supplied supervision. Neither is discovered from raw text. The `#thank` distinction is meaningful only insofar as the annotation and later tests support it. The algorithm does not derive a sense from the root characters.

The interface deliberately cannot express multiple events, quantified statements, nested negation, conditional scope, exact event times, obligations, or non-person objects. Outside-schema examples are reported separately in evaluation. Unknown language constructions can still accidentally fit a known template; abstention is a bounded mechanism, not a perfect detector of unsupported meaning.

## 2. Deterministic normalization

Let \(T(x)=(w_1,\ldots,w_k)\) normalize Unicode to NFC, apply a frozen Python Unicode 14.0 case-fold table, remove supplied terminal punctuation, and split on whitespace. The segmentation and normalization are supplied operations; they are not learned. The frozen case-fold table preserves the original experiment's case-fold behavior. NFC and whitespace use the JavaScript runtime's Unicode implementation; the frozen English, Arabic and Hindi corpus is tested for parity.

Language labels separate lexicons. Identical spellings in `en` and `ar` therefore do not automatically become the same item. No claim is made about untested scripts or segmentation systems.

## 3. Lexical induction by cross-situational intersection

For a training row \(i\), define the set of its role symbols:

\[
A_i=\{f_i[a],f_i[v],f_i[p]\}.
\]

For a word \(w\) in language \(\ell\), its surviving candidates are:

\[
C_{\ell,w}=\bigcap_{i:w\in T(x_i),\,\ell_i=\ell} A_i.
\]

The learned lexicon emits an association only when \(|C_{\ell,w}|=1\). With zero candidates the word has no surviving role symbol. With more than one, the supervision has not isolated its meaning. Both cases remain visible in `lexical_diagnostics`.

For example, if `Zoya` appears in `Zoya thanked Sara` and `Zoya helped Mira`, and the supplied labels vary the action and other participant, their atom-set intersection isolates `person:zoya`. A later known template can place Zoya in the patient role, even if her teaching examples put her in the agent role. This behavior is tested; it is not a built-in list of names.

There are strong limitations. Correlated symbols may survive together, so more examples are necessary. A polysemous word associated with different actions can lose all candidates. One wrong annotation can erase a previously valid association. Function words may remain literal or accidentally acquire a role symbol if the small training distribution confounds them. The algorithm does not model probabilistic ambiguity, morphology, compositional subwords, or causal semantics.

## 4. Role alignment and template induction

For each token with an isolated lexical symbol, align it to the one role with that symbol in the current gold frame. Replace the token by that role slot. Preserve unaligned words as literal tokens.

An example might produce:

```text
slot(agent), literal(did), literal(not), slot(action), slot(patient)
constants: polarity=false, tense=past, modality=assertion
```

A row yields a rule only if all three roles are covered and every assigned symbol aligns to exactly one role. If the agent and patient have the same symbol, that token-to-role alignment is ambiguous. The training row is then reported as `ambiguous_roles`; this is a limitation of the current alignment procedure, not a claim that people cannot act on themselves.

Each distinct language, pattern and constant tuple is one rule \(r\). Its observation count is:

\[
n(r)=\sum_i\mathbf{1}[\operatorname{align}(x_i,f_i)=r].
\]

This is a support count. It is **not** a calibrated confidence, a probability of truth, a speaker's intention, or an acoustic frequency. Repeating the same labeled construction can increase the count without increasing independent evidence. The prediction procedure does not break ambiguity by choosing the most frequent rule.

## 5. Prediction as constrained substitution

A rule matches an utterance if their lengths agree, every literal agrees, every role slot receives a correctly typed lexical symbol, and repeated appearances of the same role receive the same symbol. Each successful substitution produces a candidate frame.

Let \(\mathcal{F}(x)\) be the set of distinct frames produced by all matching rules. Then:

\[
\operatorname{predict}(x)=
\begin{cases}
f & \mathcal{F}(x)=\{f\},\\
\operatorname{abstain}(\mathrm{no\ supported\ parse}) & |\mathcal{F}(x)|=0,\\
\operatorname{abstain}(\mathrm{ambiguous\ parse}) & |\mathcal{F}(x)|>1.
\end{cases}
\]

The interface exposes alternatives and rule indices. It preserves assertion, question and hypothesis as labels; none of these labels proves that an action happened. The wider architecture must separately observe and verify tools or external outcomes.

## 6. Reversible model growth

Model \(M_j\) is an immutable snapshot of an explicit permitted training set. A new lesson creates a candidate by refitting from the allowed examples. This is supervised refitting, not an implemented online gradient or continually adapting neural model.

The SHA-256 training digest identifies the normalized row records used by the engine. The model identity includes schema, algorithm, tokenizer, scope, optional parent identity and training digest. Hashes make records comparable; they do not authenticate a user's labels or confer permission to act.

A candidate can be compared only with an active model in the same workspace scope. If a parent is declared, it must match the active snapshot. Development IDs, declared semantic families and normalized utterances must be disjoint from both training sets. The gate rejects final-test rows. Users can still falsely relabel provenance or split fields; this browser check is not a secure benchmark registry.

Let \(c_j\) be exact correct frames on development rows, and \(W_j\) the incorrectly emitted frames. Define a regression set \(R\) containing every previously correct development row that becomes incorrect or abstained. Approval is:

\[
\operatorname{approve}(M_{j+1})
\iff(c_{j+1}>c_j)\land(|R|=0)\land(|W_{j+1}|=0).
\]

The gate returns a receipt and the selected model without mutating either input. A bad update leaves the active model unchanged. This demonstrates a development gate, not a guarantee that unobserved behavior is safe or correct. Repeated development-set selection can overfit that set. Once inspected in an interactive playground, the published final set is a regression reference rather than a fresh blind benchmark for future research claims.

## 7. Evaluation denominators

There are 53 frozen final examples: 51 have representable gold frames, and 2 explicitly mark a schema boundary with `gold: null`. Exact match is correct frames divided by all 51 frame-scored examples, including abstentions in the denominator. Coverage counts all emitted frames over all 53 examples. Selective accuracy is correct frames divided by emitted frames. Boundary abstention is reported separately and is never awarded a correct-frame point.

The browser port reproduces all 53 base-model predictions and all 53 selected-model predictions from the Python oracle. Initial training obtains 36/51 exact frames, and the accepted update obtains 41/51. This is an AI-authored controlled synthetic experiment with supplied labels, not a multilingual population estimate.

## 8. The root-label control

Let \(\pi\) bijectively rename the action symbols while preserving their types. Apply it consistently to every training action and invert it on predictions. Because the learner uses equality and types, not Arabic character semantics, it obeys:

\[
\operatorname{predict}(\operatorname{train}(\pi D),x)
=\pi\bigl(\operatorname{predict}(\operatorname{train}(D),x)\bigr)
\]

for this implemented algorithm. The frozen 53-example control tests this property. It demonstrates that Arabic labels alone provide no measured performance advantage. A substantive root-informed extension must change reviewed sense distinctions, relations, compositions or learning priors, and then beat equally expressive neutral controls under a fair experiment.

## 9. Finite computational bounds

Let \(N\) be training rows, \(L\) maximum tokens per row, \(V\) unique language-token pairs, \(R\) induced rules, and \(E\) evaluation rows. With three role symbols per row, the intersection work is bounded by \(O(NL)\) symbol comparisons, excluding bounded string hashing and sorting. Template induction also performs \(O(NL)\) role work. Sorting lexical/rule records adds ordinary comparison-sort cost. A direct prediction scans up to \(R\) patterns and costs \(O(RL)\), plus dictionary construction when invoked alone. Evaluation reuses one dictionary and costs \(O(V+ERL)\). The implementation stores bounded row identities, token candidates and templates; \(R\leq N\).

These are finite-operation bounds, not measured hardware savings. String length, JavaScript allocations, hashing, Unicode normalization and UI updates also cost time. Input is capped at 1,000 rows, 512 characters per utterance, 64 whitespace tokens, 96 characters per token and 500,000 UTF-8 bytes per JSON import. These caps are local responsiveness limits, not production rate limiting.

## 10. Next experiments with a scientific question

| Extension | Question | Required control |
|---|---|---|
| Reviewed root-sense lattice | Does a semantic relation improve held-out compositions? | Equally expressive neutral relation graph; randomly assigned relations |
| Probabilistic lexical alternatives | Can ambiguity be retained without confident false output? | Current intersection learner; calibrated held-out risk/coverage |
| Scope-aware graph frames | Does explicit negation/condition scope reduce distinct meaning collisions? | Same data with flattened frames; minimal scope contrast pairs |
| Morphological features | Do root, lemma and inflection annotations improve sample efficiency? | Character/form-only features and independently reviewed morphology |
| Acoustic features | Do sound features improve a defined speech task across speakers? | Transcript-only, acoustic-only and matched linguistic/context features |
| More selective candidate gates | Can new constructions be adopted without regressions outside the narrow development set? | Unseen task families, honest version history and independent labels |

These are proposed experiments. The shipped executable supports the small intersection/template baseline and its local training and evaluation gates; it does not claim these extensions have been built.
