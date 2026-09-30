# Smart Dispatcher — DESIGN.md

**Ticket:** `ticket/smart-dispatcher` · **Status:** spec + implementation
**Problem (user's words):** "smart nahi hai kab kya use karna hai" — every run
sent everything (24 tool definitions ~15.6k tokens, all retrieval, the full
prompt) and the model figured it out. No layer decided per query what the turn
actually needed.

This is the "middle workflow" — the product's missing brain, between the
composer and the model.

## Lanes (v1)

| Lane       | Trigger                                                                                                       | Tools                                                                                                 | Retrieval | Budget* |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- | ------- |
| `direct`   | greeting/filler (deterministic `isFillerQuery` signal, reused from the greeting-tokens-v2 ticket); empty turn | **none** (`toolFree`)                                                                                 | no        | 2,500   |
| `standard` | default — nothing specific matches                                                                            | full (today's behavior)                                                                               | yes       | 32,000  |
| `research` | explicit Search switch / deep research, or detected research intent                                           | web only: `search_web`, `search_reference`, `read_webpage`                                            | yes       | 48,000  |
| `quran`    | quran signals (names, `surah:ayah` refs, Arabic script) without freshness words                               | quran only: `research_quran`, `search_reference` (+ `mcp__quran__*`, which always pass the allowlist) | yes       | 32,000  |

\* Budgets are telemetry targets stamped for the receipt, not hard caps.

**Precedence (stated, tested):** explicit tool request > filler > quran-signal
(without freshness) > research-intent/freshness > quran-signal (bare) >
ambiguous → Jev.

Freshness words (`latest`, `news`, `today`…) beat a quran signal into the
research lane: "latest news about quran translations" wants the live web, not
the quran index. A bare `2:255` reads as surah:ayah — the quran server is
connected, and the lens requires grounding either way.

## Classifier

`classifyDispatch(query, flags)` in `lib/runs/dispatch.ts` — **pure**:
no I/O, no model, no clock. Deterministic rules first: fast, zero model cost,
and the whole matrix is unit-testable (`tests/smart-dispatcher.test.mjs`).

## Jev advisory (ambiguous turns only)

`adviseLane()` asks TypeSafe System One a typed **choice** question over the
four lanes, via the in-process `systemOne` client (`lib/integrations/jev-client.ts`)
— the same client `lib/runs/jev-lane.ts` uses, with the same contract: **Jev
proposes, never blocks**. 3s timeout; unreachable / slow / keyless / nonsense
→ `null` → deterministic fallback to `standard`. The turn is never blocked on
Jev. (The `jev-ask` CLI is the agent's own decision tool; the hot path uses
the in-process client — spawning a subprocess per chat turn would be the wrong
engineering.)

Note: the worker already runs a Jev preflight (`jevLane`: clarify/standard/
deep-research — the _safest execution_ lane). The dispatcher answers a
different question (_what does this turn need_), earlier (at creation, so
retrieval can be skipped). Both fail open; both are stamped.

## Quran-lane constraint (the lens, as code)

From the owner's `quran_lens.md`
(`forgekit/research/cognitive-substrate/quranic-lens/`):

- **lā taqfu (17:36)** — no assertion without knowledge → never quote a verse,
  translation, or tafsir from memory; answer only from what the quran tools
  return.
- **tabayyun (49:6)** — verify before acting → verify every verse reference
  with the tools before answering.
- **amāna (33:72)** — stewardship of the trust → preserve each source's
  stated verification status; say plainly when something is AI-authored
  research notes rather than scripture or verified tafsir.

This restates for the turn what the core prompt already requires (scripture
from the canonical tools, never from memory) and what `research_quran`'s own
description enforces. It is injected as a named `lane` prompt part, placed
with the principles — it says how to treat the material below it and must
survive a truncating provider like they do.

## Tool narrowing

Narrowed lanes pass an `enabledTools` allowlist; `run-agent.ts` already
honors it (MCP `mcp__*` tools always pass — that is how the quran lane keeps
the canonical quran server tools). Composition rules, tested:

- `direct` → `toolFree: true` (the greeting-tokens-v2 mechanism: zero
  definitions reach the provider).
- An **explicit allowlist on the run wins** over the lane: the lane narrows,
  never widens past what was asked for, never silently empties the set.
- The research lane does **not** set `webSearch: true` — that flag carries the
  "the person switched Search on" guidance and the must-search gate, which
  would be a lie for a dispatcher-routed turn. The explicit switch keeps its
  stronger semantics.

## Telemetry

`lane` + `jevAdvised` are stamped on the run config at creation (extending the
`toolFree` pattern) and sealed onto the run row's config JSON — queryable via
`json_extract(config, '$.lane')`, shown on the receipt later. `promptBudget`
rides the dispatch decision for the same purpose.

## Extension point: `lib/research/`

His maths/research (Ruh model, Quranic Arabic analysis) is **not productized
code yet** — v1 ships the honest stub, no invented math:

- `tool-slot.ts`: `ResearchToolSlot` — `{ name, description, lanes, build() }`
  — plus a registry (`register` / `unregister` / `researchSlotNames(lane)`).
- The dispatcher exposes `researchSlots` on its decision; the route merges
  them into the lane allowlist. v1: empty, tested as empty.
- **Next plug-in:** Ruh inference (Mizan track) registers a slot on the
  `quran` lane; the Quranic Arabic analysis from the lemma work registers on
  `research`. No dispatcher changes needed when they land.

## Decision inputs (standing mandate)

- **JEV judges** the ambiguous calls (lane choice) and the merge decision.
- **Quran lens constrains** the quran lane (above).
- **Wisdom playbook guides**: deterministic-first, fail-open, never invent —
  the stub stays a stub until the maths is real.

## What is deliberately NOT in v1

- No LLM in the hot path for clear cases (cost + latency).
- No learned router / training loop — the deterministic matrix + Jev advisory
  is the baseline a learned router must beat, with measurements.
- No prompt-budget enforcement — budgets are observed first.
- `incognito` is accepted by the dispatcher but not routed on: it is a
  consent flag, honored downstream exactly as today.
