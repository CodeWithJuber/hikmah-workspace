# Hikmah architecture refinement — v0.2

9 September 2026. This note distinguishes implemented mechanisms from the next research algorithms. The UI is a working experiment, not evidence of AGI or a replacement foundation model.

## System contract

The system owns the interface, session, typed meaning records, tool boundary, workspace, experimental learner, and verification logic. A configured OpenAI-compatible provider supplies general language and coding capabilities. Provider responses are proposals; local checks decide which actions or model changes are admissible.

Represent each task as T = (goal, scope, observations, permissions, resource budget, stop rule). A result is complete only when its goal predicate is supported by the applicable observation or deterministic check. A narrated plan alone is not completion. In the current task simulator, observations and checks are explicitly simulated. The chat agent has real browser-file tools, not real infrastructure-control tools.

The data paths are: user → typed task and relevant context → provider or local solver → proposed action → tool validation → observed result → scoped receipt → user answer. Training is a separate path: paired examples → candidate model → independent development checks → approved version. Provider text cannot directly rewrite the active learner.

## 1. Meaning and composition

The implemented frame is y = (actor, action sense, recipient, polarity, tense, modality). Tokenization and the ontology are supplied. For token w, C(w) is the intersection of role atoms in the labels of all training sentences containing w. A singleton C(w) gives an alignment; ambiguity is preserved. Aligned role positions become typed variables, and remaining tokens are literal grammatical cues. Inference applies compatible templates. Exactly one distinct resulting frame permits output; no frame or competing frames produces abstention.

This separates stable reusable identity from grammatical composition. A root family is a useful reference namespace, but the sense suffix, participant roles and grammatical operators carry essential distinctions. The Arabic labels can be bijectively renamed without changing this toy's predictions. That control rules out claiming the current results establish a special mathematical advantage of Arabic labels.

The next representation should be an explicitly typed directed event graph with event identity, argument roles, quantifiers, time interval, modality, negation scope, provenance and unknown values. This is proposed. The six-field current learner does not already implement arbitrary graph parsing. Preserve unknown senses rather than forcing every expression into an available Quranic root.

## 2. Learning reusable grammar

A candidate extension is minimum-description-length grammar selection:

    G* = argmin_G [L(G) + Σ_i L(y_i | parse_G(x_i))]

Here L(G) charges for rules, lexical choices and exceptions; the second term charges wrong or unresolved labels. The desired effect is reusable composition with an explicit penalty for memorized exceptions. A practical first experiment can enumerate a bounded set of typed templates and select among them on independent development data. No transformer or dense embedding is required for that restricted experiment, but existing grammar-induction and program-learning research remains relevant prior art.

Do not turn observation counts into confidence percentages. To produce a probability, define a prediction event, estimate it from held-out outcomes and check calibration. Language, construction family, entity composition and acquisition time need grouped splits. All three currently supported controlled languages receive their own supervision; the results do not demonstrate zero-shot transfer.

A candidate passes only when it produces a measurable gain, introduces no observed regression, emits no wrong development frames under the current strict gate, and respects data/scope/version checks. The import path also rejects known regressions. A no-gain proposal needs independent development cases; it is not automatically adopted. This conservative gate is appropriate for the small toy and can later be replaced with an explicitly specified statistical trade-off.

## 3. Planning, uncertainty and action authority

The implemented planner is finite uniform-cost search. A state is an explicit Boolean fact assignment. An action declares preconditions, success/failure effects, permission and positive cost. Maintain best_cost[state]; expand the cheapest unexplored state; reject missing permissions and unmet preconditions; stop at the budget, expansion limit or verified goal. The least-cost guarantee applies only to the declared success model.

Execution rechecks each transition. A configured failure consumes the action cost, applies only its declared failure effects and stops. Replanning starts from the resulting facts with the remaining budget. This is stronger than simply asking a language model to repeat a plan because the resource and state changes are actually enforced.

Outcome learning uses p_a ~ Beta(alpha_a,beta_a). Comparable successes and failures update its parameters. For one further Bernoulli observation, the exact expected posterior-variance reduction is Var(p_a)/(alpha_a+beta_a+1). Divide that reduction by action cost to rank information-oriented experiments. It is not Shannon information gain, a utility for all tasks, or calibrated real-world reliability.

The next planner should optimize expected task loss plus observation cost while distinguishing knowledge-gathering actions from world-changing actions. Counterfactual branches remain simulations until externally verified. A language-model proposal never expands tool permissions. The current chat loop permits at most 16 local tool executions and a configurable request count, with cancellation and visible receipts.

## 4. Context, disagreement and resource use

Each claim belongs to an exact tenant/project/context and optional event time. Support and refutation give four states: unknown, supported, refuted and both. Source disagreement is retained; counting model votes does not make a claim true. Compare & review currently performs two proposals and one review using the selected provider model, so correlated error remains a material limitation.

Context selection takes the transitive closure of declared dependencies. A claim requiring evidence, negation and scope cannot be delivered with a missing dependency. If the closure exceeds the budget, return a budget failure and request a narrower task or a larger budget. The implementation counts whitespace words, not provider tokens. Chat retains whole recent turns with their available receipts. Output-token usage is displayed only when reported by the provider.

A production research extension should optimize a dependency-constrained subset under the actual provider tokenizer and measure task-quality loss at matched cost. The current UI makes no measured token-saving claim. A short prompt can be more expensive if it removes a necessary condition and causes retries.

## 5. Sound and graph channels

The sound channel retains the complex Fourier transform and short-time frame information. The reversal experiment demonstrates that near-identical global magnitudes can conceal opposite temporal order. An acoustic encoder should preserve speaker/channel information, timing and uncertainty until empirical evidence establishes what can safely be removed.

Graph eigenvalues of L = D - A describe variation over a specified graph. They are not acoustic hertz. Heat diffusion exp(-tL) is an exact numerical experiment on small undirected graphs, with eigen residual, energy and signal-sum diagnostics. It does not infer semantic truth or replace directed event roles. A sound-to-meaning research program needs annotated recordings, speaker/language controls, held-out concepts and competing baselines; a frequency-to-root law is not presumed.

## 6. Path from co-model to more responsibility

Promote by capability rather than by a single “AGI” score. First measure the restricted learner and tool controller; next broaden ontology and independently label data; then learn transition models from verified outcomes; then assess longer tasks and transfer. Retain a frozen reference system and rollback path. Log model version, task distribution, abstention, wrong emissions, goal completion, cost and latency separately.

Useful ablations are: roots versus neutral labels; template induction versus exact-match memory; meaning graph versus raw task text; dependency closure versus unconstrained truncation; shared-provider review versus diverse independently checked evidence; and acoustic magnitude versus phase/time-preserving features. Match information and compute budgets. Improvement must survive grouped unseen cases, not only examples used to invent the algorithm.

The verified implementation currently passes 101 automated checks and the recorded browser workflows. This supports those tested mechanisms, not general intelligence. The strongest immediate research improvement is better independent data and outcome measurement, followed by richer compositional representations—not a larger number of unconstrained agents.
