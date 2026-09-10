> Historical v5 report. Update 10 September 2026: the original 191-file package has since been recovered and hash-checked. See the v6 research audit for current coverage.

# Implemented release and verification

## Delivered behavior

- Recovered and preserved the existing `intersection-template.v1` symbolic architecture and source-derived registry.
- Added owner-authenticated D1 persistence for co-model state, reviewed training examples, development supplements, checkpoints, gate receipts, feedback and run metadata.
- Automatic event-driven retraining on reviewed batches; full replay on correction; gate promotion only for positive development gain without observed regression/wrong emission; rollback restores actual learned behavior.
- Separate task-family workflow preference learning from explicit feedback; retractions/replacements replay once; unrated, incomplete and comparison outputs are excluded.
- Connected the co-model to the central chat, provider tool runtime, optional review/repair and visible run receipts.
- Direct-versus-Hikmah comparison preserves the direct output with usage and latency; extra compute and endpoint-routing limitations are explicit.
- Added actual structured clarification interactions, inline isolated HTML previews, expand/source pane, file editing in the same conversation, mobile focus-managed sheets, coordinated custom icons and a light design system.
- Added a distinct Super Admin with owner controls, training, version history, telemetry and inspectable source/architecture coverage. Workspace admin retains provider/media/connector/skill configuration.
- Cloud workspace sessions now preserve conversations and files per authenticated user with optimistic revisions. Existing browser sessions are used only on first cloud migration. Reviewed legacy model additions are offered to the same gate on first model migration. Input drafts remain device-local.

## Evidence collected

All 158 tests passed on 10 September 2026: 143 prior tests plus 15 new learning, artifact, question and authenticated persistence checks. The new tests exercise real model induction, correct before/after interpretation, corrupt-label rejection, rollback, automatic-training pause, train/development leakage rejection, idempotent feedback, preference changes, evaluation exclusion, resume telemetry, session round-trip, same-origin checks, fixed owner identity, cloud persistence, tenant isolation and stale writes. Server tests execute the actual route code against SQLite with a test adapter; they do not call production APIs.

TypeScript checking passed. The production Worker/client build passed, with the existing large-bundle warning. The generated schema-only D1 migration was inspected; no earlier applied migration is rewritten.

No real provider credential was available for this release's verification, so live generation and comparative quality gains are untested. Mock provider/relay tests still cover the existing transport contracts. Browser visual/end-to-end QA was not run in this turn; the selected image concept was inspected, and responsive/focus behavior was implemented in source using the existing UI primitives. Do not describe the app as independently audited or fully production-certified on that basis.

## Scope and next engineering gate

The co-model is a small supervised symbolic model plus a preference learner, not a foundation language model. General procedure induction, broad local generation, a learned world-transition model, scheduled background training, public SaaS onboarding, billing and multi-tenant owner analytics remain unimplemented research/product work. Media APIs and MCP connectors still depend on user configuration and upstream capability. Provider credentials remain memory-only.

The old corpus first-pass records are preserved with their stated coverage; the original full ledger remains unrecovered. Source inspiration and algorithm correctness are separate evidence categories.
