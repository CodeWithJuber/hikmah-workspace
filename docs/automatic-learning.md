# Automatic co-model learning

The main learning flow is one opt-in followed by ordinary chat. Enabling **Automatic learning** permits bounded additional requests to the same provider and model used by a successful chat. The server prepares syntax annotations, fits the local co-model in a background worker, checks the candidate and activates it only when its development syntax score improves without per-sentence LAS or POS regression. Neutral, invalid and failed candidates keep the active checkpoint unchanged.

This trains the existing local syntax model. Provider-generated annotations are proposals, not human-reviewed ground truth. It does not change a provider's model weights, automatically approve response examples, or establish semantic understanding. The evaluation is the existing **reused development syntax gate**, not fresh held-out evidence. Research-stage claims remain subject to their own provenance and validation.

## What happens automatically

1. Capture only a completed successful text exchange whose server-owned run and current learning consent revisions match. Files, tool-derived conversations, failed or interrupted answers and exchanges with detected sensitive content are excluded from automatic fitting. A later follow-up to a tool/file conversation remains excluded because source dependencies cannot yet be separated reliably.
2. Select at most two short sentences in one supported language. Already queued or annotated sentences are skipped. Each sentence has at most 280 characters and 24 surface tokens. Available released syntax models cover English, Arabic, Hindi, Spanish and Turkish; unsupported or mixed-language annotations are rejected.
3. Ask that same configured provider/model to annotate exact token forms. No tools or co-model self-labels are supplied. Validate language, token alignment, UPOS, dependency heads, one root, acyclicity and morphology bounds. Reject source/evaluation-corpus overlaps by normalized surface fingerprint before fitting.
4. Fit the licensed base training split, retained teacher annotations and any existing human-reviewed training rows in a Node worker thread. Recompute the candidate and current-model scores on the development gate.
5. Save the provenance and gate receipt. Activate only a passing candidate whose original active checkpoint and consent are still current. A manual checkpoint change always wins a race. The new co-model is used by future prepared chat requests; already prepared runs retain their previous context.

## Limits and lifecycle

| Limit                        | Enforced behavior                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Additional provider requests | At most 3 per user per UTC day; reservation precedes the request and survives Reset/source deletion                                        |
| Provider request             | At most 2 short sentences, 3,840 requested output tokens, 60-second deadline, zero retries, 96 KB streamed-response cap, redirects refused |
| Local fitting                | One automatic job globally, separate Node worker, 90-second deadline, 256 MB old-generation limit                                          |
| Retained teacher corpus      | At most 200 sentences per user/language                                                                                                    |
| Pending work                 | At most 6 queued/in-progress jobs per user; queued samples expire after 24 hours                                                           |
| Exchange queue               | At most 300; automatic mode rotates old unreviewed copies while preserving approved examples and in-progress sources                       |
| Checkpoint history           | Active checkpoint plus at most 5 inactive automatic candidates per language; manual checkpoints retained                                   |

The teacher uses the run's encrypted credential snapshot, bound to job, user and provider endpoint. Keys are erased from the job after annotation or any terminal outcome. Errors shown to users do not contain raw provider errors, source text or credentials. Current vault secrets are checked before sending, after annotation, before fitting/resuming and before publishing. Included-provider usage is recorded against the user and checked against current entitlements; existing chat/provider concurrency can still make metering approximate at the allowance boundary.

Pausing cancels outstanding automatic work. A request already received by a provider can still be billed. The worker checks consent during execution and again at publication; a revoked job cannot activate a checkpoint.

Source retention removes captured exchanges, their queued jobs and teacher annotations. Parameters already fitted into a checkpoint remain until reset; deleting one example is not parameter unlearning. **Reset** turns capture and automatic learning off, cancels work, removes captured examples and automatically produced checkpoints, and restores the last pre-automatic human checkpoint or the released model. Speculative and deleted checkpoint objects have durable cleanup markers, so failed object deletion is retried after restart.

After restart, a persisted annotation resumes local fitting without another provider request. A request whose result was lost is held as an error and never repeated automatically. A fenced database lease prevents multiple app processes from fitting or publishing automatic jobs concurrently.

## API and deployment

`POST /api/learning` with `{"action":"configure","automatic":true}` is the explicit additional-request consent. It also enables exchange capture and local context notes. `automatic:false` pauses automatic work; `{"action":"clear"}` resets automatic learning and its captured data. Existing review/correction actions remain optional and never run automatically.

`GET /api/learning` returns `policy.automatic` and a concise `automatic` status: `paused`, `waiting`, `preparing`, `training`, `evaluating`, `updated`, `held` or `error`, with request count, reason, last time and qualified development metric where one exists. It never returns job credentials.

Migration `0018_automatic_learning.sql` adds the policy, jobs, annotation corpus, request budget, global lease and cleanup tables. The normal worker build produces `public/research/v6/automatic-fit-worker.mjs`; the existing standalone/Docker public-directory copy includes it. The Node-only instrumentation hook starts and stops the automatic service. The stable vault master remains required across restarts and restores.

## Verification

`tests/automatic-learning.test.mjs` covers explicit consent, tenant isolation, encrypted credentials, revocation, global lease/restart behavior, retained daily budget, source deletion, privacy changes, gate outcomes, manual activation races, checkpoint cleanup, reset restoration, teacher validation and evaluation leakage.

`tests/automatic-learning-runtime.test.mjs` runs the actual provider adaptor against a local HTTP fixture, validates the provider/model/key/path and bounded no-tools request, fits the real bundled corpus in a Node worker, saves the resulting checkpoint/receipt and records usage. It also checks streamed-response limits and that already annotated text does not buy another annotation. This is actual local execution with a fixture provider; it is not a live-provider quality or billing validation.
