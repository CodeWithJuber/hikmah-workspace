# Hikmah v5: implementable middle architecture and independent co-model

Research note, 2026-09-10. This is a proposed implementation, not a report of newly measured Hikmah performance. No Site checkout was read or changed; no remote model inference was run. The recovered architecture, trainable-core design and Python learner in `/workspace/scratch/605a19983f99/recovered-hikmah/` were inspected. This revision preserves Hikmah's existing symbolic learning architecture instead of proposing a replacement neural network.

## Decision

Operationalize the existing owned compositional model and extend it with learned probabilities and procedures around an inspectable controller:

1. **Hikmah co-model:** its own learned lexicon, composition rules, rule/outcome parameters, bounded procedures, competence estimates, versioned training datasets and checkpoints. The existing `intersection-template.v1` supervised learner is the foundation. It already interprets explicitly supported expressions without a provider call; broader independent task completion must be earned separately.
2. **Hikmah policy model:** its own learned weights selecting how to spend a fixed inference budget on direct answering, verification/repair, decomposition, or exploration/consensus.

The selected OpenRouter language model remains the proposal and language engine for tasks outside measured local competence. Neither component changes provider model weights. Local memory is a separate source of contextual information, not by itself neural training. The design provides a path toward broader local competence; it does not imply that unrestricted self-training, general intelligence, or eventual independence will emerge automatically.

## The independent co-model: preserve and extend the actual learner

The recovered architecture already specifies `M = (O, L, Gamma, w, H, T)`: ontology, lexicon, composition rules, learned rule parameters, procedures and outcome predictions. The existing learner implements a small part of this with genuine supervised structural learning. It is neither mere prompt storage nor a trained foundation language model.

What the inspected code actually does:

- A supplied Unicode/whitespace tokenizer processes each training utterance. The six-field target frame is `(agent, action, patient, polarity, tense, modality)`; participants must currently be `person:` symbols and actions `action:` symbols.
- For language/token pair `u`, let `A_i` be the set of the three role symbols in a labeled frame. It learns `C(u) = intersection_{i: u occurs in utterance i} A_i`, and emits a lexical entry only when `|C(u)| = 1`.
- Each training utterance is aligned using that lexicon; tokens become either role slots or literal tokens. A valid learned rule must cover all three roles, with no ambiguous role assignment. Its constants preserve polarity, tense and modality. The learner counts observations per rule.
- At prediction time, only exact length/literal/type-compatible rules apply. One unique resulting frame is emitted; zero or conflicting candidate frames cause abstention. A high-count rule does not override semantic ambiguity.
- `fit` stores explicit training IDs and a data hash. `choose_candidate` takes development-only rows; it promotes only a positive exact-frame gain with no formerly correct regression and no incorrect emitted frame.

These are real changes in a predictive model's learned structure. A structural model does not need dense neural weights to qualify as a trained model. Show actual lexical/rule counts and learned probability parameters, not a fabricated neural parameter count or optimizer loss.

The recovered report documents 144 initial training utterances and a six-example update, with 36 then 41 exact frames on 51 representable cases. These are the prior report's tiny synthetic-task results, not newly reproduced numbers or a general language accuracy estimate. The recovered Python source was inspected, but its experiments were not rerun here.

Concrete extensions for this iteration:

1. **Operational structural training:** retain immutable seed examples, collect validated new frame labels, refit a candidate from the eligible full corpus, and apply the existing development gate. This can happen automatically after a bounded number of verified examples. Corrections supersede prior labels and trigger reconstruction, not an append of conflicting gold labels.
2. **Learned reliability parameters:** for each stable rule identity and task/language context, keep independent verified-success and verified-failure counts. `rho_r = (s_r + a)/(s_r + f_r + a + b)` is a Beta-Bernoulli posterior mean with documented priors. These parameters can adjust acceptance/delegation or prioritize validation. Counts from a rule's own training rows are not independent evidence of its predictive reliability.
3. **Learned grammar weights:** where alternatives genuinely share a defined grammar context `A`, estimate `w(r|A) = (c_r + alpha_r)/sum_{r': context(r')=A}(c_r' + alpha_r')`. Frequency means observed usage, not truth or correctness. Do not introduce a probability over incomparable templates or use frequency to erase a polarity conflict. This is an extension, not something the current intersection code already implements.
4. **Learned outcome model:** define a small state abstraction with task category, known/unknown interpretation, available evidence and observed failure status. Update `T(o|s,a) = (N(s,a,o)+beta_o)/(sum_u N(s,a,u)+sum_u beta_u)` from actual operation receipts, where `o` is `verified_success`, `verified_failure`, `unknown`, or an explicit finite outcome vocabulary. Never count predicted outcomes as observations. Rank short bounded workflow continuations by `V_h(s)=max_a sum_o T(o|s,a)[r(s,a,o)+gamma*V_{h-1}(next(s,a,o))]`, with `V_0=0`, zero continuation at terminal states, and reward such as verified completion minus normalized cost. Small-sample uncertainty keeps the default workflow eligible. This is a conditional finite prediction model, not a general causal world model.
5. **First procedure learner:** enumerate a tiny allowlisted DSL over typed frames and bounded collections, such as exact match, role projection, polarity conflict detection, filter, and presentation. Generate/test/prune candidates against verified input-output examples and explicit counterexamples. Minimize `J(p)=lambda*length(p)+sum_i loss(p,e_i)+mu*executionCost(p)`, with invalid programs excluded and a strict search cap. A successful retrieved answer is not automatically a new procedure. Promote a program only when it performs on new compositions. This part is a concrete expansion beyond the current template learner and can remain a candidate module until it passes tests.

These extensions create owned learned structures and numerical parameters, without substituting an unrelated MLP or claiming changes to OpenRouter weights. Procedure induction has prior art in generate/test/constrain systems such as Popper; its guarantees depend on stated hypothesis and data assumptions and do not automatically apply to noisy teacher labels. [Learning programs by learning from failures](https://arxiv.org/abs/2005.02259). DreamCoder is further prior art for compositional libraries and imagined/replayed program tasks, but its neural search system is not Hikmah's present implementation. [DreamCoder](https://arxiv.org/abs/2006.08381).

Specific current limitations: the intersection lexicon assumes one unambiguous symbol per language/token; a wrong label can empty an intersection; the supplied tokenizer does not learn segmentation; same-entity agent/patient examples can create ambiguous role alignment; unseen literal constructions abstain; the frame is single-event and cannot represent unrestricted negation scope, multi-event causal reasoning or arbitrary discourse. Fix these through explicit schema/algorithm versions and independent tests, not by relabeling them as solved.

### How it learns from interactions and outcomes

Every interaction may create a **candidate training example**. Only usable labels become supervised updates:

- A verified frame annotation within the current schema, or an executable task with independently computed reference output and valid program labels: eligible for the corresponding learner.
- Failed local answer followed by a verified correction: eligible; preserve the failure and corrected label together.
- Explicit user preference or acceptance: eligible for preference/policy learning, not automatically a factual truth label.
- Provider proposal that passes an independent executable validator: eligible for narrow skill transfer; preserve provider identity and validation evidence.
- Provider prose, self-rated confidence, repeated consensus, or unverified reflection: memory/proposal only; not factual supervision.

If only a final answer is known, do not invent a semantic-frame annotation: a correct final response can follow an incorrect intermediate parse. Train only the component for which the observation supplies a valid target. For the small finite DSL, enumerate valid bounded programs and retain programs matching independent examples/counterexamples; reject ambiguous or underdetermined program supervision. A schema-valid teacher label is still only a proposal until its meaning has been checked.

Automated cycle: collect validated examples -> deduplicate by canonical task and provenance -> create candidate checkpoint -> refit structural components from the eligible corpus and update outcome statistics -> evaluate -> promote or reject -> retain rollback pointer. For the tiny intersection learner, full retraining is preferable to sampling because intersections depend on all relevant examples. For later larger learners, balanced recent/old/failure replay is a tunable design; the existing seed corpus and mandatory counterexamples must remain represented.

**Imagination** has two distinct uses:

1. For current semantic learning, generate combinations only through an independently reviewed frame-to-surface generator and preserve the authored generator's provenance. This produces synthetic labeled practice within its grammar, not evidence of learning new natural language constructions. For procedure learning, generate bounded valid DSL programs and varied inputs, then execute the interpreter for exact labels. Do not generate a target by asking the same parser to label its own output.
2. For open-ended tasks, ask the selected provider for alternatives or counterfactuals. Keep their claims hypothetical until independently checked. Imagined success is never an observed outcome.

When no eligible new labels exist, the trainer becomes `collecting`; the runner should not increment a “learned” count simply because time passed. Browser work only runs while the app/worker is alive unless a real backend scheduler is present.

### Promotion, delegation, and rollback

Keep `incumbent`, `candidate`, and `previous` checkpoints distinct. Each contains schema/tokenizer/algorithm versions, the actual induced lexicon and rules, reliability/outcome/policy parameters, seed, data IDs/hash, training-run count, metrics by skill, and gate result. Do not claim gradient steps for a count/intersection learner. Promotion is one atomic pointer update after evaluation, never overwriting an incumbent in place. Each serving task pins one version until completion.

Use three data purposes: training, development for tuning/thresholds, and a sealed release audit. Split by task/template family, entity/value regime, and source lineage **before** augmentation, rather than randomly splitting near-identical generated sentences. A paraphrase of a training template should not be counted as novel held-out skill. Repeatedly using one gate set to select candidates turns it into development data; periodically use a fresh audit set and preserve untouched cases.

Retain the current exact development gate now: no formerly correct regressions, no incorrect emitted frames, and positive exact-frame gain. It is a useful engineering gate, not a statistical generalization guarantee. Broader autonomous skill delegation should later meet explicitly chosen targets such as the following, none of which are current measured claims:

- At least 100 independent representative held-out tasks, with exact final answers and coverage reported.
- Wilson 95% lower confidence bound for accuracy among accepted local cases at least 0.95; report accepted-case count, not total count, in that bound.
- At least 60% coverage on the declared supported test distribution, so rejecting everything cannot pass.
- No new failures in a small mandatory critical/boundary regression set.
- Separate results for unfamiliar templates, multi-step compositions, and out-of-scope rejection; do not hide a failed slice inside an average.

For accuracy `p = correct/n`, the two-sided Wilson lower bound is `(p + z²/(2n) - z*sqrt(p(1-p)/n + z²/(4n²))) / (1 + z²/n)`, with `z = 1.96`. A bound applies to the tested sampling distribution, not arbitrary future language. Zero failures on 100 cases does not prove perfection.

At runtime, delegate only within a promoted skill's input contract and its evaluated acceptance rule. Log local answers and externally observed failures. A verified critical regression or repeated error threshold can atomically revert to `previous` and disable the affected local skill. Use held-out error versus coverage rather than treating a rule's training frequency or posterior mean as a universal certainty. CFQ provides a relevant primary precedent for testing compositional separation; it does not establish Hikmah's performance. [Measuring Compositional Generalization](https://arxiv.org/abs/1912.09713).

## The middle controller: adaptive but bounded

The controller owns state transitions, budgets, memory inclusion, program validation, evidence status, and durable commits. Models propose typed objects. The UI shows short decision summaries, constraints, candidate artifacts, evidence and test results; it does not need private model reasoning transcripts to make the system inspectable.

Finite workflow arms:

| Arm               | Executed behavior                                                                             | Limit                                      |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Local skill       | Co-model predicts a supported frame or executes a separately promoted bounded procedure       | Zero remote calls                          |
| Direct            | One selected-model answer                                                                     | One call                                   |
| Verify/repair     | Draft, independent check records, one targeted repair if needed                               | Three remote calls                         |
| Decompose         | Typed dependency plan, execute leaves, merge, check, optional repair                          | Four leaves; depth two; eight remote calls |
| Explore/consensus | Three independently prompted candidates, compare evidence/checks, synthesize, optional repair | Six remote calls                           |

These are starting caps. Every call, retry and hidden provider reasoning token that is exposed in usage counts toward the declared budget. One invalid-JSON retry also consumes budget. Cancel, timeout, credential failure, and exhausted budget are explicit terminal states. Independent leaves can execute concurrently; dependent leaves wait for validated outputs. Reject cyclic or over-budget plans before execution.

“Independent” here means isolated prompts/contexts, not statistically independent model errors. All same-model lanes may share a blind spot.

### Evidence, critique, consensus, repair

- A source record owns the fetched/attached content, URI, timestamp, content hash and provenance. A generated URL is only a proposed source until retrieved.
- A claim points to source spans and has distinct statuses such as `unverified`, `quoted_span_present`, `model_assessed_support`, `externally_verified`, `contradicted`. A working link proves neither entailment nor truth.
- A critic reports concrete failed acceptance criteria, counterexamples, or unsupported claims. The same generator may propose the critique, but cannot manufacture an external check's success status.
- Hard constraint failures disqualify candidates. Among valid candidates prefer external correctness checks, then evidence coverage and the user's rubric. Keep same-model subjective scores explicitly labeled as model judgments.
- For tasks with a canonical answer, calculate `agreement = largest answer cluster / number of candidates`. It is descriptive agreement, not a probability of correctness. For open prose preserve substantive disagreement instead of forcing a unanimous label.
- Repair only named defects, then rerun the affected checks. Stop if the budget is consumed or no independently measured improvement occurs. Preserve the pre-repair candidate because revision can damage a correct answer.

Self-consistency improved the studied models on specific arithmetic and commonsense benchmarks by sampling multiple paths, but it spends extra inference and is not evidence of a Hikmah gain. [Self-Consistency](https://arxiv.org/abs/2203.11171). Tree of Thoughts reported 74% versus 4% for GPT-4 chain-of-thought on its Game of 24 setup; this is a narrow search task result, not general intelligence superiority. [Tree of Thoughts](https://arxiv.org/abs/2305.10601). Intrinsic self-correction without external feedback can fail and sometimes reduce reasoning accuracy. [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798).

## The policy learner: real updates, separate from skill training

Keep this small and inspectable. Use a disjoint linear contextual-bandit model per eligible workflow arm. Features may include normalized prompt length, code/numeric indicators, explicit task category, number of constraints, available sources, budget, prior verified failure tags, and local skill competence. Feature extraction is a heuristic; expose its version.

For arm `a`, initialize `A_a = lambda I`, `b_a = 0`. Then:

`theta_a = inverse(A_a) b_a`

`score_a(x) = theta_aᵀ x + alpha sqrt(xᵀ inverse(A_a) x)`

Choose the highest-scoring eligible arm, with a fixed fallback prior while feedback is sparse. Optional epsilon exploration may run only within the already allowed budget/skill constraints. If used, log exact probability `p(a|x) = epsilon/K + (1-epsilon) 1[a = best]`. A seeded PRNG makes selection replayable; it does not create deterministic provider outputs.

On one eligible final outcome per run, update:

`A_a <- A_a + w x xᵀ`

`b_a <- b_a + w x r`

Use explicit user quality `q` in `[0,1]`, or independently graded task correctness. Suggested utility `r = q - lambda_cost min(cost/budget,1) - lambda_time min(latency/deadline,1)`. Keep the quality, cost and latency components visible. Do not combine subjective preference and objective correctness into one unlabelled accuracy statistic. A missing rating does not mean success. Replaced feedback supersedes the earlier update by replaying eligible feedback from the event log; duplicate feedback IDs must be idempotent.

This is a learned episode-level policy, not reinforcement learning of every internal reasoning transition. LinUCB originated in recommendation, where the paper reported a 12.5% click lift against a context-free bandit on Yahoo data; that result does not predict an LLM improvement. [Contextual-bandit research](https://arxiv.org/abs/1003.0146). Historical selected-action averages are biased comparisons; without randomized support and logged propensities do not claim causal off-policy improvement. [Doubly Robust Policy Evaluation](https://arxiv.org/abs/1103.4601).

## Same-model experiment that can support an honest claim

Maintain three distinct comparisons:

1. **System benefit:** selected model directly versus Hikmah using that same model, with extra calls disclosed.
2. **Compute allocation benefit:** Hikmah versus a strong same-model multi-sample/verify baseline under the same total token/cost cap and evidence access. Report actual consumption as well as the cap.
3. **Learning benefit:** frozen initial controller/co-model versus promoted controller/co-model on new held-out tasks, with the provider model, evidence snapshot and budget held fixed.

Do not weaken the direct baseline: use a competent task prompt and the same necessary user context. Supply the same evidence corpus to both evidence-enabled arms. If only Hikmah can retrieve additional memory, label that as a memory/system advantage and also run a memory-matched ablation. In the strict middle-controller comparison, disable local answer delegation or expose the same local tools to the baseline; otherwise the test measures the entire hybrid system.

Freeze dataset, prompts, model/provider endpoint, sampling and reasoning parameters, retrieval snapshot, scorer, budget and failure handling before evaluation. Randomize run order and answer display labels. Never allow the two candidates to see each other except in a specifically declared aggregation baseline. No-key runs must show `remote_inference_untested`; mock/symbolic evaluation belongs to a separate panel and cannot increment remote comparison counts.

Prefer exact answers, hidden tests, constraint checks and source-backed answer keys. For open outputs, use blinded human pairwise ratings with randomized ordering and a fixed rubric. If using an LLM judge, disclose it, reverse the order for consistency checks and audit a sample with humans. Position, verbosity and self-enhancement biases are documented. [MT-Bench and Chatbot Arena judgment study](https://arxiv.org/abs/2306.05685).

Report `n`, paired task-level quality difference, a paired bootstrap interval, wins/ties/losses for subjective ratings, regressions by task family, total calls/tokens/cost, and median/p95 latency. Include failures in the main denominator; separately show answer quality conditional on completed runs. A claim needs actual held-out results and a defined scope. Safe example: “On 120 held-out constraint tasks, checkpoint C with model M improved exact success by X percentage points versus direct M, at Y times the cost.” Until measured, say “comparison ready; improvement not yet established.”

Adaptive test-time allocation is a research-supported hypothesis: Snell et al. found prompt difficulty affected the best compute strategy and reported more than 4x efficiency over best-of-N in their setup. The effect used their models, verifiers, tasks and compute definition; it is not a prospective Hikmah number. [Scaling LLM Test-Time Compute Optimally](https://arxiv.org/abs/2408.03314).

## Suggested API and state contracts

These are suggested app interfaces, not claims that a backend already exists. A browser implementation can expose the same methods locally and persist versioned records in its existing store.

```ts
type RunMode = 'local' | 'remote' | 'evaluation';
type VerificationKind = 'executable' | 'human' | 'source_span' | 'model_judgment';

interface CognitiveRun {
  id: string;
  mode: RunMode;
  status: string;
  inputHash: string;
  modelLock?: { model: string; endpoint: string; sampling: object; reasoning: object };
  versions: {
    controller: string;
    policy: string;
    coModel: string;
    feature: string;
    memory: string;
  };
  budget: { maxCalls: number; maxTokens: number; maxCost: number; deadlineMs: number };
  decision: {
    features: number[];
    eligibleArms: string[];
    chosenArm: string;
    scores: object;
    propensity: number | null;
  };
  graph: {
    nodes: Array<{ id: string; dependsOn: string[]; status: string; acceptanceCriteria: string[] }>;
  };
  candidates: Candidate[];
  checks: Check[];
  claims: Claim[];
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cost?: number;
    latencyMs: number;
  };
  final?: { candidateId: string; answer: string; unresolved: string[] };
  learningEligibility: 'pending_feedback' | 'verified_outcome' | 'excluded_eval' | 'none';
}
interface Candidate {
  id: string;
  origin: 'local' | 'remote';
  answer: string;
  program?: object;
  claimIds: string[];
  checkIds: string[];
}
interface Check {
  id: string;
  candidateId: string;
  kind: VerificationKind;
  status: 'pass' | 'fail' | 'unknown';
  verifierVersion: string;
  evidenceIds: string[];
}
interface Claim {
  id: string;
  text: string;
  status: string;
  sourceIds: string[];
  supersedes?: string;
  proposedBy: string;
  reviewedBy?: string;
}
interface Feedback {
  id: string;
  runId: string;
  kind: 'quality' | 'correctness' | 'correction';
  value?: number;
  correctedLabel?: object;
  source: 'user' | 'executable';
  verificationId?: string;
  supersedes?: string;
  timestamp: string;
}
interface TrainingExample {
  id: string;
  runId?: string;
  taskFamily: string;
  input: string;
  target: object;
  origin: string;
  validatorId: string;
  provenanceIds: string[];
  split: 'train' | 'dev' | 'audit';
  eligible: boolean;
}
interface Checkpoint {
  id: string;
  parentId?: string;
  createdAt: string;
  status: 'candidate' | 'incumbent' | 'rejected' | 'retired';
  architectureVersion: string;
  schemaVersion: string;
  lexicon: object[];
  rules: object[];
  parameters: {
    ruleReliability: object;
    grammarWeights: object;
    outcomeCounts: object;
    policy: object;
  };
  procedures: object[];
  dataHash: string;
  trainingRunCount: number;
  metricsBySkill: object;
  gate: object;
  rollbackTo?: string;
}
```

Suggested operations: `POST /cognition/runs`, `GET /cognition/runs/:id/events`, `POST /cognition/runs/:id/cancel`, `POST /cognition/feedback`, `GET /co-model/status`, `POST /co-model/train` (bounded batch), `GET /co-model/checkpoints`, `POST /co-model/checkpoints/:id/evaluate`, `POST /co-model/checkpoints/:id/promote`, `POST /co-model/rollback`, `POST /evaluations`, `GET /evaluations/:id`. Internal automatic promotion uses the same validated transition as manual promotion. Keep provider credentials out of this durable state.

OpenRouter adapter: use the user's exact model slug and exact endpoint slug, one shared parameter lock for comparisons, `provider.only: [endpoint]`, `allow_fallbacks: false`, and `require_parameters: true` when supported. A base provider slug may include multiple endpoint variants; use the full endpoint slug for a tighter comparison. [Provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection). `seed` is best effort and does not guarantee determinism across all models. Explicitly set supported sampling parameters because omitted values use upstream defaults. [API parameters](https://openrouter.ai/docs/api_reference/parameters). Use schema-constrained outputs where supported and validate all responses locally regardless. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

## What the visible co-model center should say

Show the actual architecture; learned lexical entries, surface rules, outcome parameters and procedures; incumbent/candidate IDs; last real model update; examples accepted/rejected with reasons; exact-frame and end-to-end held-out accuracy/coverage separately; learned workflow choices; memory corrections; validation failures; next scheduled bounded training run; and rollback status. Separate “structure learned,” “parameters updated,” “memory recorded,” “policy updated,” and “provider called.” Display zero/unmeasured honestly. A live animation is not a learning event.

A useful user-facing description once those modules are implemented: “Hikmah learns its own meaning rules, procedures and outcome predictions from verified examples and your feedback. It earns local skills through held-out tests, while the selected language model handles broader language tasks. Each promoted version can be inspected and rolled back.” Until then, list the existing meaning learner as available and the unfinished procedure/outcome modules as planned.

## Roadmap from co-model to more independent responsibility

The truthful target is an increasing **verified share of tasks completed without material teacher assistance**, measured per task family. Stage 1: independent supported semantic interpretation and correction learning. Stage 2: local read-only frame/record procedures and learned outcome prediction. Stage 3: new compositions of procedures with held-out environment tests. Stage 4: reversible multi-step task families with observed results and bounded local realization. Broader open-language generation, larger semantic scope, speech and genuinely new procedures are separate training/evaluation projects. Counting time, chat messages or provider agreement does not establish progress through these stages.

The co-model can be central from the first release because it owns interpretation proposals, persistent learned state, predictions and delegation decisions. “Central” need not mean that it already supplies every answer. Training opportunities can come from all eligible experiences; every experience is not automatically a correct training target, and general capability is not an inevitable consequence of accumulation.
