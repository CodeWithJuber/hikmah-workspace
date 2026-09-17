# Agentic workspace and controlled learning: design evidence

Research and source inspection date: 17 September 2026.

This report translates primary-source guidance into decisions for Hikmah Workspace. It is a design and release-review document, not a claim that the decisions are implemented, tested or deployed. Some paths below are being changed concurrently. Source presence establishes an integration point; only the release's recorded tests can establish its behavior.

The existing architecture is a Next.js interface over a server-owned run worker, SQLite state, model-provider adapters, per-user memory, and a local syntax co-model. The most useful change is to make those capabilities understandable and recoverable from the conversation, with a distinct place to review learning and research evidence.

## Decisions and integration points

### 1. Keep the conversation as the primary work surface

An answer should contain its useful result, citations, artifacts and concise activity summary. Tools, approvals and worker status should expand in place. Keep previews closed until a valid artifact exists or the user opens one. Describe visible actions and findings; do not manufacture a transcript of a model's private reasoning.

Map to `components/chat/chat-view.tsx`, `message-parts.tsx`, `chat-receipt.tsx`, `approval-card.tsx`, `agents-panel.tsx`, `lib/ai/run-agent.ts`, and `lib/chat/artifact.ts`.

Anthropic recommends composable systems, transparent planning and tool feedback. The chat layout is our design inference, not a layout prescribed by that source. More tools should improve completion rather than add navigation. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

### 2. Recover a run instead of making the user restart the task

Expose queued, running, waiting, completed, failed and cancelled states consistently. Reconnecting should replay persisted events and recover the current answer. Keep cancellation separate from undo: stopping a run does not reverse a completed external action. Only offer resume or retry when the backend can honor it without duplicating side effects.

Map to `lib/runs/store.ts`, `worker.ts`, `service.ts`, `sse.ts`, `resume.ts`, `lib/chat/durable-transport.ts`, `app/api/runs/[id]/stream/route.ts`, and `app/api/runs/[id]/cancel/route.ts`.

LangGraph distinguishes durable thread checkpoints from cross-thread memory and warns that in-memory state is lost on restart. Its interrupt guidance also explains replay hazards: side effects before a resumed interruption must be idempotent or moved into separate steps. Hikmah can apply these principles without adopting LangGraph. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

### 3. Make parallel workers accountable and bounded

Group worker tasks beneath their parent request. Show task, status, source links, artifact and failure reason; expose usage when measured. Set concurrency, iteration and cost limits. Use independent workers for independent investigations, then reconcile evidence in the parent answer. Ordinary requests should not automatically become multi-agent runs.

Map to `lib/ai/tools/deep-research.ts`, `lib/agents/store.ts`, `lib/agents/availability.ts`, `components/chat/agents-panel.tsx`, and `components/playground/agents-home.tsx`.

Anthropic's research architecture benefits from independent parallel investigation but incurs greater token usage and coordination overhead. Its measured gains and costs belong to its workload; they are not Hikmah performance estimates. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

### 4. Name each kind of learning accurately

Use the following distinctions everywhere, including the landing page, privacy copy, receipts and Learning Studio:

| Capability               | What changes                                            | Required evidence                                                          |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Interaction capture      | A separate record of an actual completed exchange       | Server run identity, provider/model, capture consent, redaction record     |
| Reviewed-example reuse   | Context supplied to a later request                     | Accepted example and whether reuse is enabled                              |
| Memory                   | A stored preference, reference or episode               | Source, scope, review state and retrieval provenance                       |
| Local syntax training    | Parameters of Hikmah's local syntax model               | Reviewed dependency annotations, fit result and syntax evaluation          |
| Provider weight training | A provider-hosted or separately operated model artifact | Actual supported training job, dataset version and returned model identity |

Map to `lib/learning/types.ts`, `store.ts`, `privacy.ts`, `lib/memory/store.ts`, `lib/context-model/training.ts`, `train-worker.ts`, and `components/context-model/studio.tsx`.

The new learning contract declares `providerWeightsChanged: false`; its collection defaults are off. `trainReviewed` fits a syntax model from reviewed annotations. A response record is not a weight update. Google distinguishes fine-tuning, which changes parameters, from retrieval, which supplies external context. [Fine-tuning and RAG](https://cloud.google.com/use-cases/fine-tuning-ai-models)

### 5. Curate before reuse or training

Capture only eligible, completed server-side exchanges. Retain per-user scope and source run identity. Review, correction and rejection should be reversible. Separate collection from use of already-approved examples; disabling new capture must not misleadingly appear to erase existing examples. Syntax collection needs its own opt-in, and syntax fitting needs reviewed annotations and a deliberate training action.

Map to `lib/learning/store.ts`, `privacy.ts`, `drizzle/0017_learning_exchanges.sql`, `lib/runs/prepare.ts`, `lib/context-model/candidates.ts`, `candidate-store.ts`, and the learning UI. Verify the completion hook and every entry point before release; the existence of a policy field does not prove consent is enforced.

For any future provider training, create immutable dataset versions and separate training, validation and final evaluation sets. Google requires representative inputs and correct output labels and recommends validation data. Model-generated responses are candidate examples, not automatically correct labels. Redaction is a best-effort safeguard and must not be advertised as a guarantee that all sensitive material is detected. [Prepare supervised fine-tuning data](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning/prepare-data)

### 6. Evaluate outcomes and preserve the scope of the evidence

Test task completion, source grounding, correct tool outcomes, recoverability, latency, cost and regressions. Use deterministic checks where possible; calibrate model judges against human assessment for subjective quality. Retain traces that explain failures. Start with real user failures and a frozen baseline, including cases where a tool should and should not run.

Map to `lib/context-model/gate.ts`, `frozen-gates.json`, `app/api/context-model/route.ts`, `lib/ai/compare.ts`, `tests/context-*.test.mjs`, and the run/chat tests under `tests/`.

The inspected syntax gate explicitly identifies itself as a reused development gate. Its POS/LAS result does not prove semantic understanding, universal language coverage, fresh held-out generalization or overall response quality. Anthropic recommends separate capability and regression evaluations, outcome checks and calibrated graders; a single successful run is insufficient evidence of reliability. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

### 7. Version promotion and recovery separately from training

Keep a candidate inactive until its gate passes. Record the base version, dataset identity, evaluation scope, artifact digest and activation decision. Reject stale activation when the active model changed during evaluation. A restore control must state what it restores: a released baseline is different from arbitrary rollback to a previous custom version.

Map to `app/api/context-model/route.ts`, `lib/context-model/active-store.ts`, `server.ts`, and `components/context-model/studio.tsx`. The inspected route has save, activate and reset operations, a server-recomputed development receipt, and a check against the version used as its baseline. Those source observations do not establish a complete model-deployment lifecycle.

MLflow's version metadata, validation tags and movable aliases provide a useful design pattern for future provider checkpoints. Applying it to prompts, tools and memory snapshots is an architectural recommendation; Hikmah does not acquire those facilities merely by referencing MLflow. [Model registry workflows](https://mlflow.org/docs/latest/ml/model-registry/workflow/)

### 8. Make remembered context inspectable

Show which memories or approved examples influenced an answer. Preserve source conversation, provenance, review state, timestamps and user scope. Let the user disable, edit or remove them. Keep background research findings pending until accepted. Changes made after a run starts must not silently rewrite that run's original evidence.

Map to `lib/memory/store.ts`, `recall.ts`, `lib/ai/tools/memory.ts`, `lib/runs/learner.ts`, `prepare.ts`, `components/chat/memory-panel.tsx`, and `chat-receipt.tsx`.

LangChain distinguishes semantic, episodic and procedural memory, and explains the latency/freshness tradeoff between immediate and background updates. Detailed provenance controls are our application design choice. A stored item can remain wrong; storage and retrieval do not verify its content. [Memory overview](https://docs.langchain.com/oss/python/concepts/memory)

### 9. Verify mobile behavior and accessible progress as product behavior

Keep the reading area centered with a bounded width; allow tools and artifacts to use more room when opened. Reflow the shell at 320 CSS pixels. Confine necessary horizontal scrolling to code, tables or deliberately designed card groups; each card's readable content must fit its viewport. Keep the composer usable with the mobile keyboard open and avoid obscuring focused controls.

Map to `app/styles/chat.css`, `app/styles/memory.css`, `components/chat/chat-shell.tsx`, `chat-view.tsx`, `tools-menu.tsx`, `model-picker.tsx`, and `components/playground/learning-home.tsx`.

Use semantic status announcements for meaningful state changes without moving focus or reading every token aloud. WCAG's minimum pointer target is generally 24 by 24 CSS pixels with specified exceptions; larger primary touch controls are a design choice. These checks cover selected criteria, not complete accessibility certification. [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [Target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [Unobscured focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

## Research-stage integration boundary

Use actual recovered artifacts, their hashes and their stated limitations to establish provenance. A stage number is not an acceptance test. The inspected `lib/research/episode-model.ts` identifies a finite evidence solver with supplied annotations, resource bounds and explicit ambiguous, inconsistent and resource-limit outcomes. Its provenance marks completed stage 31/32 verification as false.

Treat that extension as experimental unless the recovered research and integration tests establish more. Preserve the distinction between conditional entailment inside a supplied finite model, extraction of annotations from natural language, and factual truth in the world. None implies the others. Do not describe the solver as automatic universal meaning discovery or permit an entailed result to create an unreviewed factual memory.

The syntax co-model's runtime integration belongs in `lib/context-model/run-brief.ts`, `lib/runs/prepare.ts`, and `lib/context-model/server.ts`. Research-engine integration should have its own visible provenance and capability boundary. A bounded research prototype can be useful without being presented as a replacement for a trained language model.

## Commercial release gates

These are acceptance requirements. This report does not mark any as passed. The release owner should attach the tested commit, environment, commands or browser steps, results and unresolved defects to the release record.

| Gate                            | Minimum release evidence                                                                                                                                                                                                                                                        | Relevant integration points                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Critical conversation journey   | A real configured provider request completes; sources/artifacts render; a failed provider call preserves the user's draft and offers an accurate next step; empty and offline states are usable.                                                                                | Chat view, model connection, run API and provider adapters                                   |
| Durable execution               | Disconnect and reconnect during streaming; restart the worker during a supported run; pause on approval and resume; cancel during tool work. Each has one consistent final state and no duplicated external mutation.                                                           | Run store, worker, transport, approval/resume flow                                           |
| Tenant and secret boundaries    | Two-account tests cannot list, retrieve, export, review or activate each other's data. Provider/workspace keys do not appear in client payloads, learning exports or terminal run records.                                                                                      | Auth, `server/workspace-secrets.mjs`, learning/memory stores, context-model API              |
| Learning consent                | No default capture; valid opt-in captures eligible runs; switching off during a run and an off/on cycle cannot revive stale consent. Rejected examples are not reused; clear/delete cannot immediately repopulate from an older run. Verify separate syntax collection control. | Learning policy revision, completion hook, reuse path, syntax candidate queue                |
| Learning quality and isolation  | Corrected examples preserve provenance; accepted/rejected filters work; unsupported, oversized and sensitive-data cases have bounded behavior. Evaluation data does not enter fitting. Review cannot be bypassed through a client-supplied successful-run claim.                | Learning API/store, privacy filter, training validator and gate                              |
| Checkpoint activation           | Valid candidate, failing gate, stale baseline, concurrent activation, missing checkpoint bytes and reset are exercised. The UI reflects the active model used by the next run and does not promise arbitrary rollback if only baseline reset is available.                      | Context-model route, active store, runtime loader and Studio                                 |
| Research truthfulness           | Artifact hashes and provenance are recorded; test contradictory inputs, retraction and resource exhaustion; show ambiguity and unsupported scope. Completed stages are claimed only with recovered evidence.                                                                    | Research extension and research controls                                                     |
| Mobile and accessibility        | Browser checks at 320, 360, 390, 768, 1024 and 1440 CSS pixels, keyboard navigation and zoom. No unexplained page overflow; message actions, approval controls and composer remain reachable; status changes are announced without stealing focus.                              | Chat shell/styles, dialogs, controls and Learning Studio                                     |
| Operational recovery and limits | Successful migration on an existing database and clean install; backup restore on a disposable environment; configured worker/concurrency limits; measured latency/error behavior under the intended load; actionable health and failure logs without secrets.                  | `server/storage.mjs`, `drizzle/`, worker/start scripts, health route and deployment workflow |
| Commercial promises             | Verify the deployed provider list, plan entitlements and allowance enforcement, subscription behavior, operator contact, retention controls and actual backup practice. Confirm public privacy copy matches the deployed collection behavior.                                   | Billing configuration, `components/marketing/landing.tsx`, `legal.tsx`, operator setup       |

A build, attractive interface, development syntax score or synthetic test run cannot alone satisfy these gates. External provider jobs, billing callbacks and live deployment behavior must be labelled unverified when the required credentials or environment were unavailable.
