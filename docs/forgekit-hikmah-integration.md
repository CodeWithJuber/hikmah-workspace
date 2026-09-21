# ForgeKit research integration

ForgeKit was read recursively before this integration. Its research is useful as a design review, but it also contains explicit negative results: the early impact oracle and router claims did not reproduce outside their fixtures. Hikmah therefore adopts the mechanisms that remain testable and keeps the failed metrics out of product claims.

## What is now in Hikmah

- `lib/agentic/preflight.ts` is a bounded assumption gate. It scores input, output, scope, success criteria, and constraints, then produces at most three clarifying questions. It is advisory so a normal chat stays fast.
- `lib/integrations/jev-client.ts` is a fail-safe TypeSafe System One client. It calls the native `/v1/systemone` contract and validates typed answers. JEV can propose a route or confidence; deterministic gates remain authoritative. A missing key, timeout, or invalid answer returns `null`.
- Research and co-scientist flows already produce durable evidence and editable briefs. These are the product-level equivalent of ForgeKit's receipt and provenance ideas without pretending that a graph oracle has been proven.

## What is deliberately not copied

The impact oracle, automatic router savings, and Quranic framing are not treated as technical proof. The research itself says those early claims failed replication. The ethical lens can guide product decisions, but it cannot substitute for tests, evidence, or user consent. Hikmah's automatic learning remains opt-in, inspectable, pausable, and resettable.

## JEV configuration

Set `TYPESAFE_API_KEY` and optionally `TYPESAFE_BASE_URL` on the server. The default model is `jev-latest`; `jev-1.13` can be passed by an integration caller. The OpenRouter page is useful for model discovery, but this adapter does not guess that a catalog model supports chat completions. It uses the documented native System One endpoint and fails closed when the contract is unavailable.

## Next extension points

The context-assembly and UI-quality-gate research can be added behind measured fixtures: select context by required definitions, first-order dependencies, tests, contracts, and valid lessons under a token budget; then compare the rendered surface against Hikmah's existing design tokens. Both should begin as advisory telemetry and become enforcement only after real project fixtures exist.
