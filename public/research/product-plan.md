# Hikmah: a useful AI workspace with a focused path to revenue

Research and implementation plan · 10 September 2026

The proposed starting business is **client deliverables for small English/Hindi web and content agencies**. Sell a repeatable outcome: turning approved client material into a proposal, content pack or performance report that takes less time to review. The broad workspace supports this offer, but the offer needs payment and retention evidence before expanding into a large platform.

This is a product hypothesis, not validated demand or a promise of profit. The current release is a private personal workspace. It includes functional provider adapters and controls, but authenticated generation, broad device usability, multi-tenant security and commercial operations still need launch validation.

## 1. The product available in this release

| Area | Implemented behavior | Practical boundary |
|---|---|---|
| Chat | Streaming Markdown, code blocks, edit, regenerate, copy, download, saved conversations, search and feedback | Work saves on this device; feedback does not silently train a provider model |
| Coding | Editable workspace files, local file tools and explicit HTML/CSS/JavaScript preview | No general Python runtime, shell or package installation; previews cannot access the network |
| Agents | Public plan, actual tool receipts, continuous requests, response continuation, stop and saved checkpoints | Tab must remain active; browser checkpoints are not a durable server job service |
| Models | Search, free/paid filters, input/output prices, advertised context/output limits, tools and reasoning capabilities | Missing metadata stays unknown; public route rates are estimates, not an account quote |
| Provider controls | OpenRouter, Experiential Labs and custom OpenAI-compatible chat URLs; model and optional parameter controls | Custom URLs need browser CORS; compatible chat does not imply all provider features |
| Media | Image generation, speech output, WAV/MP3 transcription and saved video job retrieval in chats | OpenRouter adapters; provider defaults for image/video size and duration; actual account/model access required |
| Connectors | HTTP MCP discovery and tool calls, own credentials and per-call approval or explicit allow mode | CORS-capable servers; no built-in OAuth, stdio host, MCP Apps, sampling or interactive elicitation |
| Skills | Six editable instruction templates, custom skills, import/export of configuration | Instruction bundles are not executable plugins or automatic access to ChatGPT connectors |
| Admin | Models, media, connectors, skills, local usage overview and this product plan | Personal configuration panel; not yet an organization RBAC or billing console |
| Research | Existing meaning, agent and sound experiments plus the optional controlled-language co-model | Limited experimental coverage; no demonstrated general intelligence or universal language representation |

To start: open **Workspace admin → Models → Connection settings**, enter a provider key there and load models. Use **Workspace admin → Media** for OpenRouter media models. In a chat, **Create** chooses image, video, speech or transcription. In **Connectors**, add and connect your own HTTP MCP server; use Agent or Coding mode to expose connected tools. Enable the relevant skill under **Skills**.

Keys stay in memory for the current session and are excluded from exports. Re-enter them after refresh. Conversations and checkpoints save in IndexedDB, with a legacy local-storage fallback for sessions. Generated files save separately in IndexedDB; download them separately from a session export. Storage failure is surfaced in the UI.

## 2. Market evidence and the opening to test

Feature breadth alone is a weak differentiator. The following are vendor-advertised capabilities and prices checked for this plan; they are not independent performance comparisons.

| Product | Relevant existing offer | Implication for Hikmah |
|---|---|---|
| [Open WebUI](https://docs.openwebui.com/) | Self-hosted local/cloud models, knowledge retrieval and extensible tools | Owning a chat UI and supporting multiple models is already available |
| [LibreChat](https://github.com/danny-avila/LibreChat) | Open-source multi-provider chat, agents, artifacts and MCP | MCP support and artifacts should be treated as expected capabilities |
| [TypingMind](https://www.typingmind.com/) | Custom endpoints, agents, plugins, prompt chains, media and local storage | A configurable personal workspace is a competitive category |
| [Dify](https://dify.ai/workflows) | Visual AI workflows, knowledge retrieval and integrations | A workflow canvas by itself is unlikely to create a lasting advantage |
| [n8n](https://n8n.io/pricing/) | Automation and AI workflows with hosted and self-hosted options | Competing on connector count would require substantial maintenance |

For context, TypingMind lists one-time licenses with separate API costs; n8n lists hosted plans including €20/month and €50/month when billed annually; Dify offers a free entry tier and paid workspace plans. Current terms should be checked at purchase. Sources: [TypingMind pricing](https://www.typingmind.com/buy), [n8n pricing](https://n8n.io/pricing/), [Dify pricing](https://dify.ai/pricing).

**Inference:** a small team has a more plausible initial route through workflow quality, customer knowledge and distribution than through matching every platform feature. The suggested segment is 2–10 person agencies in India serving English/Hindi clients. This choice comes from the founder's stated interests and language context; customer interviews must confirm it.

### Three offers to test

| Offer | Customer supplies | Deliverable | Acceptance check |
|---|---|---|---|
| Brief to proposal | Real brief, approved rate card, constraints | Scope, milestones, assumptions, open questions and priced proposal | Every price reconciles; no invented commitments; owner can send after review |
| One source to content pack | Approved source, audience, brand glossary | Landing copy, one email and five captions in English/Hindi | Facts and promises remain consistent; human checks meaning and tone |
| Campaign to client report | Campaign CSV, reporting period, previous report and notes | Reconciled metrics, changes and concise commentary | Numbers reproduce from source; causal explanations are labeled hypotheses |

The six current skill templates support these tasks. Their output still depends on the selected model and supplied evidence. A future packaged workflow should add structured intake, required fields, acceptance checks and branded exports after one offer proves useful.

## 3. Product experiences worth testing

1. **Brief completion assistant:** detect missing scope, audience and approval criteria before drafting. Ask only the questions that materially change the deliverable.
2. **Evidence beside claims:** link proposal promises and report numbers to supplied material; show a visible “needs confirmation” queue. Initial implementation can use source filenames and line references before adding a knowledge database.
3. **Meaning-preserving bilingual review:** compare entities, quantities, negation, dates and promises across language versions. Treat a clean comparison as a check, not proof of perfect translation.
4. **Creative alternatives with constraints:** produce three different concepts, explain differences, then develop the selected one. Novelty is judged by users; it is not inferred from agent agreement.
5. **Deliverable history:** keep the approved brief, generated artifact, corrections and next revision together. Customer-specific corrections can improve future instructions with explicit consent.
6. **Cost-aware depth:** allow a quick draft, a checked draft or a second review, with measured extra cost and review time. Keep continuous execution available to the owner; use disclosed account spending controls for paid customers.

The strongest potential differentiator is a combination of reliable bilingual delivery, visible evidence and the agency's own workflow knowledge. Whether customers prefer it to existing products remains an experiment.

## 4. Architecture: what we own and what providers supply

| Layer | Current responsibility | Commercial extension |
|---|---|---|
| Workspace UI | Chat, files, settings, media, task activity | Projects, collaborators, accessible onboarding and role-specific navigation |
| Run controller | Execute declared tools, continue output, pause, checkpoint and compact older context | Durable queue workers, job leases, resumable events and explicit idempotency keys |
| Provider adapter | Normalize requests, errors, catalogs and capabilities | Per-provider conformance tests, metering and account-level routing policy |
| Tool boundary | Local declared tools and discovered HTTP MCP tools | OAuth installation, scoped credentials, isolated browser/code workers and allowlisted outbound access |
| Knowledge and learning | Optional limited co-model; editable skills and experiments | Versioned evidence store, correction review, evaluation datasets and promotion gates |
| Commercial control | Owner-private access and session-only keys | Tenant isolation, RBAC, secrets vault, usage ledger, billing, refunds and operational support |

These boundaries keep the controller, prompts, policies and stored state independent from a particular model provider. OpenRouter and other providers still control their model weights, account quotas, available context and prices. Owning the UI does not give control over hidden model reasoning or eliminate provider limits.

### Execution algorithm

Maintain a run state containing the current goal, messages, aggregate output, request count, tool count, completed tool cursor and recent action signatures.

1. Save a checkpoint before requesting the next step.
2. Send the current goal, retained context and only enabled tool definitions.
3. Parse a valid complete response; do not execute incomplete streamed tool arguments.
4. For tool calls, check permission, execute the declared action, append its receipt and advance the cursor after completion.
5. If visible output ended at the provider's length limit, request continuation when enabled. If no visible output was produced, pause with a useful setting change instead of repeating billable requests.
6. Stop when the model completes, the user stops, an explicit review interval is reached, context cannot fit, or repeated identical actions indicate no progress.

There is no fixed four-request or sixteen-action stop in continuous mode. Three identical consecutive tool-call batches pause before executing the third batch. This is a heuristic and may pause a legitimate repeated poll; durable job polling should use a dedicated state-aware adapter. Video status retrieval already uses saved job IDs instead of resubmitting generation.

Resume avoids replaying actions recorded as completed in the saved checkpoint. It cannot guarantee exactly-once external effects if a tab crashes after an external service acts but before the receipt is saved. Commercial workers need idempotency keys where supported and reconciliation before retrying ambiguous writes.

### Context and token economy

The current controller uses a conservative character estimate, not an exact tokenizer. It preserves the system instructions, current goal and complete recent tool-call/result groups. Older intermediate results become a short receipt note. This is lossy reduction: exact facts may need to be read again from files.

Current operational bounds include 300 seconds per provider request, up to 131,072 configured output tokens subject to provider/model support, approximately 170,000 retained run-context characters, 200,000 visible characters per provider response and a 2,000,000-character aggregate response guard. Text uploads allow three files up to 40 KB each; audio uploads allow WAV/MP3 up to 8 MB. Provider limits and browser storage still apply.

A proposed retrieval objective is:

`maximize Σ_i x_i (relevance_i + evidence_value_i + freshness_i − redundancy_i)`

`subject to Σ_i x_i token_cost_i ≤ available_context, x_i ∈ {0,1}`

Mandatory items—current goal, active constraints and pending tool linkage—must be included first. A greedy approximation is sufficient initially. Evaluate answer quality and missed constraints before claiming token savings. Current MCP integration exposes two compact discovery/call tools, then retrieves the selected tool schema on demand rather than sending every server schema on every request. File reads are paginated.

### Routing and review mathematics

For a task class, estimate success probability and cost from labeled historical outcomes. A proposed routing score is:

`score(model) = wq × estimated_acceptance − wc × expected_cost − wt × expected_latency − wr × measured_failure_risk`

Weights are product choices and should be configurable. Estimates require samples; advertised context length does not establish quality. The initial release uses explicit user model selection rather than pretending to have trained an optimal router.

Use an additional reviewer when its expected reduction in costly errors exceeds its model cost and added review time. Agreement among two agents is not independent verification, especially when both calls use the same model. Current Compare mode makes two proposals and one review with the selected model; it does not establish consensus truth.

## 5. Quranic inspiration, language roots and the co-model

The engineering principles below are our interpretations for this product, not claims that scripture specifies a software algorithm. The user's original 114-surah ZIP and its claimed validation were not available for a complete new audit here. This release does **not** represent a completed 6,236-ayah study in revelation order or a full tafsir review.

| Inspiration | Engineering interpretation | Concrete product expression |
|---|---|---|
| Verification of reports, [49:6](https://quran.com/al-hujurat/6) | Establish evidence before important assertions | Actual tool receipts, explicit uncertainty, no invented checks |
| Consultation, [42:38](https://quran.com/ash-shuraa/38) | Examine credible alternatives and retain disagreement | Optional comparison and concise decision rationale |
| Trust and just judgment, [4:58](https://quran.com/an-nisa/58) | Treat entrusted information and authority carefully | Separate credentials, explicit tool permissions and source-aware review |

The shared Hikmah prompt implements practical verification, provenance, alternative approaches, proportionate actions, correction and outcome checks in the user's language. User-facing experiences remain general purpose. Private chain-of-thought is not exposed; supported reasoning-effort controls, public plans, tool receipts and concise explanations provide inspectable behavior.

The proposed universal Arabic-root representation and a universal sound-to-meaning relationship are research hypotheses, not established results. The current app uses ordinary hosted language models plus a small controlled-language experiment. It does not replace transformers, tokenization or all language understanding with a new proven architecture.

### A testable path toward a larger independent co-model

Represent an observed statement as a typed record such as:

`(predicate, agent, patient, polarity, tense, modality, quantities, source_id, confidence, valid_time)`

Arabic roots may provide one indexing view over predicates. Keep language-specific surface forms and alternatives rather than forcing every word into an Arabic equivalent. A root does not encode all syntax, negation, context or pragmatic meaning by itself.

For every proposed memory, keep evidence, inference and permission separate. A suggested event schema is:

`(event_id, task_id, source_id, observation, claim, confidence, authorized_action, outcome, supersedes_id)`

Corrections append a new event and supersede a prior claim. Confidence never creates permission to act. Contradictions remain queryable. Promote learning only after a fixed development gate; evaluate the frozen candidate on held-out tasks not used to tune it. The existing experimental co-model already has a development gate for imported training examples, but it does not autonomously learn from all chats.

Compare at least four conditions on the same tasks: provider only; provider plus retrieval; provider plus current co-model; provider plus a root-based representation. Measure accepted deliverables, unsupported claims, role/negation errors, human review time, coverage, latency and total provider cost. Report abstentions and failures. Split by client and linguistic construction to reduce leakage; keep a locked test set.

For the sound hypothesis, collect consented multilingual recordings with speaker, language, recording and text metadata. Compare acoustic features against simpler baselines while controlling for speaker, channel, duration and lexical overlap. Hold out speakers and languages; test shuffled labels and same-meaning/different-sound controls. A frequency correlation alone cannot demonstrate shared meaning or a common language origin. Expand coverage only when results replicate.

## 6. A commercial launch requires more than the present UI

| Gate | Evidence required before selling self-service access |
|---|---|
| Provider behavior | Real account tests for chat, tool calls, stop/continue and each offered media model; supported-parameter errors remain actionable |
| Usability | First-time users complete connection, a useful task and export on desktop/mobile; keyboard and screen-reader checks |
| Isolation | Cross-tenant access tests for every record, file, credential and job; server-enforced roles |
| Durable work | Worker restarts and network interruptions tested; ambiguous external writes reconciled without blind retry |
| Metering | Per-request ledger reconciles provider usage; price changes and media charges represented honestly |
| Operations | Secret rotation, deletion/export, restore drill, alerting and incident ownership |
| Payments | Paid pilot terms, usage allowance, cancellation/refund behavior and payment reconciliation tested |

A browser tool server can be connected through MCP, but this release does not include a hosted browser fleet. Adding one requires isolated sessions, authenticated tool endpoints and explicit permissions for external actions. Connectors available inside ChatGPT are not automatically transferable to this app.

## 7. Thirty-day validation plan

These are proposed decision gates, not statistical proof of market fit.

| Period | Work | Decision evidence |
|---|---|---|
| Days 1–7 | Interview 12 agency owners. Ask them to show their last real proposal/report workflow and review effort | At least six describe the same costly problem and four provide redacted samples |
| Days 8–14 | Produce six founder-assisted examples; offer a ₹2,999, 30-day pilot for one clearly scoped workflow and usage allowance | At least three customers pay; compliments or survey interest do not count as payment |
| Days 15–23 | Focus on the best workflow. Record drafting plus human review time and actual costs | At least 70% accepted with minor edits, median total time 30% lower, no critical factual errors in the pilot sample |
| Days 24–30 | Request renewal and observe repeat use | At least two of three customers renew or commit to another paid cycle, with positive contribution after support |

If the payment gate fails, revise the segment, problem or offer before adding more platform features. If review time remains high, improve evidence intake and acceptance checks before adding more agents. Add a commercial connector when several paying customers require the same one.

## 8. Unit economics and pricing discipline

Measure all calls, including proposal generation, reviews, continued output, failed billable requests, reasoning tokens where charged, media and tool execution.

`model_cost = Σ_m (input_tokens_m × input_rate_m + output_tokens_m × output_rate_m) / 1,000,000 + non-token provider charges`

`contribution = collected_price − model_cost − gateway_fees − tools/runtime − support − payment/refund costs`

OpenRouter advertises a 5.5% platform fee for pay-as-you-go credit purchases, with terms described on its pricing page. Allocate actual fees from purchase records and avoid counting the same inference charge twice. [OpenRouter pricing](https://openrouter.ai/pricing).

The example below uses invented planning assumptions, not vendor quotes or a revenue forecast:

| Monthly item | Assumption | Amount |
|---|---|---:|
| Collected subscription | One pilot account | ₹2,999.00 |
| Input inference | 3 million tokens at ₹100/million | ₹300.00 |
| Output inference | 0.5 million tokens at ₹300/million | ₹150.00 |
| Gateway allocation | 5.5% of this illustrative inference spend | ₹24.75 |
| Tools/runtime | Assumption | ₹250.00 |
| Support | 0.5 hours at ₹600/hour | ₹300.00 |
| Payments and refunds | 3% payment assumption plus 2% reserve | ₹149.95 |
| Contribution | Before acquisition, fixed costs and taxes | **₹1,824.30** |

The illustrative contribution margin is 60.8%. Doubling the model spend and corresponding gateway allocation lowers it to about 45.0%. If monthly fixed costs and founder compensation total ₹45,000, this example requires 25 comparable accounts before acquisition costs. Actual taxes, gateway fees and support effort must replace the assumptions before pricing a launch.

Do not sell literally unlimited paid inference at a fixed low price without understanding its cost distribution. The owner can use continuous mode, while a commercial offer should disclose included usage and optional additional usage. Long answers can continue across requests; every provider still has limits and charges.

## 9. Prioritized next work

**First:** validate the three offers with real briefs, test the configured provider accounts, and complete browser usability QA. Record accepted output and total review time in a simple pilot ledger.

**After paid demand:** implement one structured deliverable flow, branded export, server-side identity and usage accounting. Move runs to durable workers before promising background completion after a tab closes.

**After repeat usage:** add the most requested connector, projects with evidence/correction history, and consented learning evaluation. Compare the co-model against simpler baselines before extending it.

**Later, if measured improvements justify it:** richer voice interaction, controlled browser execution, a workflow editor, reusable agent packages and a larger independent model. These are separate milestones, not capabilities already proven by the current release.

## Technical source notes

The adapters were checked against official documentation: [OpenRouter model metadata](https://openrouter.ai/docs/guides/overview/models), [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [speech](https://openrouter.ai/docs/guides/overview/multimodal/tts), [transcription](https://openrouter.ai/docs/guides/overview/multimodal/stt), [video generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), [Experiential models](https://platform.experientiallabs.ai/docs/models), [Experiential API reference](https://platform.experientiallabs.ai/docs/reference), [MCP 2026 HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), and [MCP 2025 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

Provider documentation and catalogs can change. Catalog presence does not establish that a particular account can invoke a model. Automated tests use controlled fixtures; paid live media generation and authenticated inference are separate verification steps.
