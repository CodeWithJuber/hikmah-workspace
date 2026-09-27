# Everyday chat, automatic learning and research

This change responds to a concrete usability problem: the same destinations appeared in the sidebar, header and panel tabs, while connecting a private model could require a model selection before its catalogue was available. Learning also required users to understand separate capture, review, training and evaluation screens before accomplishing anything.

## Daily flow

- Start a chat, attach a file, choose a model and send. Optional search, parallel research and comparison live in one Tools menu. Starter suggestions only fill a draft; they do not silently enable extra model calls.
- Learning has one front door with automatic status, Enable/Pause and Reset. Saved examples and manual training/research controls remain available behind disclosures.
- Settings has one provider/key/model flow. A key can be saved before loading a private catalogue. Errors remain errors and unsaved drafts survive unrelated preference changes or closing the panel.
- Terminal and connected services open their actual destinations. Files and agents stay in contextual panels. The learning return action preserves the current conversation.
- Research brief asks for a question and a useful outcome: review evidence, challenge an idea or plan a test. It prepares an editable brief and uses the existing research tools after the user sends it. Tool progress and results remain in the conversation.

The design decisions are informed by official documentation, rather than a claim that Hikmah reproduces these products exactly:

| Decision                                                              | Primary references                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the conversation central and disclose optional capabilities      | [Claude getting started](https://support.claude.com/en/articles/8114491-get-started-with-claude), [Open WebUI conversations](https://docs.openwebui.com/features/chat-conversations/)                                                                                   |
| Consolidate model controls and contextual message actions             | [Claude model controls](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings), [LibreChat message actions](https://www.librechat.ai/docs/features/message_actions)                                                              |
| Review a research plan, follow progress and inspect sources           | [ChatGPT deep research](https://help.openai.com/en/articles/10500283-deep-research), [Gemini Deep Research](https://support.google.com/gemini/answer/15719111), [Perplexity Research](https://www.perplexity.ai/help-center/en/articles/10738684-what-is-research-mode) |
| Keep history, remembered context and learning controls understandable | [Perplexity Memory](https://www.perplexity.ai/help-center/en/articles/10968016-memory), [LibreChat memory](https://www.librechat.ai/docs/features/memory)                                                                                                               |

## What automatic learning actually does

Automatic learning is a separate, explicit opt-in. Existing capture consent does not enable additional provider requests. Enabling it also enables the local co-model context feature; the server reads that setting for each run.

1. A successful server-owned text-only exchange is captured under the current consent revision. File and tool-dependent conversations are excluded, including later turns that still carry those dependencies. Redacted samples are excluded from automatic training.
2. At most two short sentences are sent to the same configured provider for syntax annotation. There are at most three annotation requests per user per UTC day, no retries, bounded response size, a deadline and an output-token ceiling. These are extra provider calls and may cost money.
3. Validated, source-aligned annotations train the existing local syntax co-model in a bounded Node worker thread. They remain machine proposals, not human-reviewed ground truth. Supported training languages are English, Arabic, Hindi, Spanish and Turkish.
4. The server evaluates a candidate against the current checkpoint using the existing development gate. Only a strict gain that satisfies the gate can activate a new checkpoint. The active checkpoint must still match the training parent, and consent must still be current.
5. A failed, interrupted, neutral or regressing candidate leaves the current co-model in place. Durable jobs, leases, request reservations and cleanup records handle restart, cancellation and storage cleanup.

The gate is reused development syntax evidence. It does **not** establish fresh held-out accuracy, general semantic understanding or improved answer quality. No upstream model weights are changed. Source examples are not automatically approved for answer-context reuse.

Pause stops new automatic work and invalidates jobs under the old consent revision. A provider request already sent may still be billed. Reset clears examples and automatic training state/checkpoints, restoring the preceding manual/released checkpoint. Deleting one example removes its retained source and pending work; removing influence from an already trained checkpoint requires Reset. Original conversations have their own deletion lifecycle.

## Typeform

Super Admin → Integrations stores a Typeform personal access token in the existing encrypted, destination-bound vault. The connection uses the official fixed API host. The application requests forms and completed responses with bounded pagination and never returns the token to the browser, tool arguments or prompts.

The owner can share an individual form with an existing Hikmah account. Ordinary users see only forms granted to them; token replacement invalidates old grants. Access is rechecked after in-flight requests so revocation discards the result. Reading responses through chat requires permission because respondent data is sent to the selected model. Unattended tasks and research lanes do not receive that tool. Typeform/tool-dependent content is excluded from learning capture.

This integration reads forms and responses. It does not create or publish forms, install webhooks, send invitations or train on respondent data. Real account validation requires an operator-supplied token. JEV is available only as an optional typed routing proposal through the native TypeSafe System One adapter. It never generates the answer, and a missing key or unavailable endpoint fails closed.

## Release verification

The new code includes regression checks for connection onboarding, stale settings reads and writes, consent and reset, annotation validation, real worker fitting, research briefs, response-access approval and Typeform isolation. Validation results are recorded separately once the final combined tree has been tested.

Browser preview access was blocked for the local app in this environment. Source review and passing automated checks must not be described as desktop/mobile visual acceptance. Live model-provider credentials, a real Typeform account, production load, billing and backup-restore checks remain distinct release evidence.

The previous Stage 31 proposal and missing authoritative Stage 32 artifact retain their existing evidence status. This change does not invent completed stages or relabel finite research tests as broader validated capabilities.
