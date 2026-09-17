# Agentic workspace: validation and release record

Validation date: 17 September 2026. Base: `d44149d7ab1c62ee027ea8033edd56b9740e0c93`.

This change adds a usable agentic chat surface, a consent-based exchange review pipeline, local syntax training, and an inspectable research experiment. It is a reviewable implementation, not a certification that the deployed service meets every commercial release requirement.

## Delivered behavior

- Centered chat, searchable conversation navigation, command search, recoverable drafts, transcript export, observed tool activity, and optional files/agents/memory/settings panels. Mobile navigation uses dismissible dialogs with focus containment. Chat and visited learning views remain mounted while switching between them.
- Successful server-owned model exchanges can enter a personal review queue after explicit consent. Capture defaults off; syntax collection has separate consent. Completion, current consent revision, ownership, bounded size, attachment exclusion, and secret redaction are checked server-side.
- Users can correct, approve, reject, delete and export captured examples, or clear their queue. Relevant approved examples supply bounded reference context to later requests. This changes request context, not provider weights. Retention applies to captured examples and syntax candidates when storage is accessed; original conversations and trained checkpoints have separate lifecycles.
- The co-model workspace imports reviewed annotations, runs the existing real browser training worker, asks the server to evaluate and save candidates, and exposes checkpoint activation and baseline restore. Its development gate remains a reused development gate, not fresh held-out evaluation.
- The shared-episode engine exposes supplied evidence, queries, witnesses, retraction, stale receipts and ambiguity. Completed Stage 31/32 artifacts were not established. See [research provenance](research-episode-integration.md).
- Durable run credential snapshots are encrypted using AES-256-GCM with run/owner/provider binding and a key derived from the existing vault master. Credentials are decrypted for execution and redaction, then removed from terminal runs. Startup upgrades legacy live records; provider diagnostic paths redact echoed keys before persistence.

## Automated verification

Final results: 1,022 tests passed, none failed or skipped. Production compilation and TypeScript passed. ESLint completed with zero errors and 54 warnings; formatting, style, reachability and generated-palette checks passed. The standalone production restart smoke passed. The final browser run passed 21 workflow checks with zero uncaught errors.

Commands used:

```sh
npm ci --no-audit --no-fund
npm --prefix workbench ci --no-audit --no-fund
NO_PROXY=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=0 npm test
npm run format:check
npm run lint
npm run lint:styles
npm run lint:reach
npm run design:check
npm run build
NO_PROXY=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=0 npm run test:production
```

Loopback proxy exclusions are needed by this test environment. They are not a product change. The standalone smoke test creates a disposable account/database, checks authenticated HTTP behavior, and verifies persistence across a real process restart. Its existing hosted-provider probe uses a dummy credential and cancellation; it does not establish successful live-model behavior.

Research tests independently compare 2,694 finite queries with a complete-table oracle and validate 3,492 proof certificates. These are software/finite-model checks, not natural-language accuracy measurements. Credential tests cover encryption, tenant/run/endpoint binding, wrong masters, tampering, pause/resume, terminal removal, physical live database/WAL scanning and diagnostic redaction.

## Browser verification

Playwright with local Chromium tested the built standalone application using a disposable authenticated owner and a clearly labelled local OpenAI-compatible streaming fixture. Normal browser origin checks remained enabled. Browser automation through the connected preview could not reach the local server, so the checks used local Chromium. No production account or real provider secret was used.

The recorded workflow checks:

1. Capture remains off initially; a draft survives navigating into learning and back.
2. Keyboard command search opens Learning Studio.
3. Capture requires the visible settings/consent action and persists the policy.
4. The durable worker streams a fixture response and captures the completed exchange.
5. Correction and approval preserve the exchange and its source; approved JSONL export contains the correction.
6. A later request received by the provider fixture includes the approved correction as reference context.
7. A failed provider request remains visible as a recoverable failure and does not enter the capture queue.
8. Research shows conditional entailment; retracting supporting evidence marks the receipt stale; rerunning shows ambiguity.
9. The owner training workspace loads. Downloaded example annotations run through the real training worker and server checkpoint save/evaluation. The sample candidate is held by the development gate and remains inactive. The training draft and selected tab survive switching to chat and back.
10. Chat and review queue have no page overflow at 320, 360, 390, 768, 1024, 1440 and 1920 CSS pixels. Training and research also reflow at 320, 390 and 768 pixels.
11. The mobile drawer contains keyboard focus and closes with Escape; theme switching changes the real theme; no uncaught browser errors occur.

The two generated concepts are visual references, not screenshots. Actual browser captures in `validation/` show the implemented screens with synthetic data. Visual review found and fixed a double-translated switch thumb. Existing functional controls, status/error messages and mobile layouts intentionally extend the concepts. Viewport checks do not constitute a full accessibility audit or physical mobile-keyboard test.

## Deployment and remaining release gates

Keep the existing stable `HIKMAH_VAULT_KEY`, or the existing `BETTER_AUTH_SECRET` fallback, across deploys and restores. Losing that master prevents paused runs from decrypting their original credential snapshot. Live legacy SQLite/WAL records are upgraded; historical external backups are outside this migration. Back up the database and stable master through the operator's existing secure process before deployment.

Before calling the hosted platform commercially ready, record successful calls to the intended real providers, production-like reconnect/restart/cancel/approval journeys, load and concurrency results, subscription/webhook behavior, backup restore, and deployed privacy/retention behavior. No live deployment, billing event, load test or provider weight-training job was performed here. Stage 31/32 integration remains dependent on authoritative completed artifacts. Detailed acceptance requirements and primary research sources are in [agentic-platform-research.md](agentic-platform-research.md).
