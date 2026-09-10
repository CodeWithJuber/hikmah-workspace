# Hikmah v7 implementation and evidence

10 September 2026. Experimental application, not a claim of AGI or human equivalence.

## Executable architecture

The UI uses one tool/permission resolver across Chat, Coding, Agent and the tool-assisted Compare arm. The direct Compare arm deliberately makes one call with no tools. Both receive the same user-curated knowledge. Shared knowledge is refreshed before each new run; unavailable shared data is excluded rather than treating a stale cache as current. All live responses carry requested/returned model identity, execution stages, provider-supplied explanations when available, usage and independent error state.

The provider boundary accepts valid OpenAI-style completion objects, concatenated JSON records and SSE by inspecting actual framing. MIME labels cannot force the wrong decoder. It does not retry a billed generation automatically. Total SSE wire bytes are uncapped; an individual buffered record is bounded at 16 million characters, buffered catalog JSON at 16 MB, request JSON at 4 MB, visible response content at 2 million characters, model input at 200,000 characters, and transport inactivity at five minutes. Provider context/output limits still apply. Existing continuation preserves completed work and stops repeated unproductive tool loops.

Known OpenRouter and Experiential URLs use the authenticated same-origin relay. Custom provider and MCP URLs use browser CORS. SSH is a connected MCP/HTTP bridge capability, not a raw TCP executor in the hosted Worker. Browser and search similarly require real connected services. Tool annotations cannot grant permissions. No connector is displayed as ready without an enabled discovered catalog. Cached discovery is not a guarantee of continued service availability.

## Memory paths

1. Episodic memory: conversations, checkpoints, and tool receipts automatically saved during work. These preserve observations without verifying all claims in them.
2. Personal knowledge: exact user-curated preferences/references with provenance and timestamps. Remember, edit, disable, forget and undo are available.
3. Realtime candidates: `suggest_memory` accepts an exact substring of the current user message. The item is stored as suggested and excluded from retrieval until reviewed. It cannot publish globally or train parameters.
4. Shared knowledge: separate D1 records, read by authenticated app users, published/edited/deleted only by the pinned owner. Personal conversations never auto-publish.
5. Workflow preference: existing Beta-count feedback updates on actual ratings; preference is not accuracy.
6. Parameter learning: existing reviewed count/graph models train and pass frozen development gates before activation. Five released language checkpoints remain available. No unattended training from unreviewed user chats is claimed.

Large transcripts move from inline D1 to R2 objects with a compare-and-swap D1 pointer. Only the newest committed snapshot is used; old snapshots are deleted after successful replacement. A racing reader retries the current pointer. Failed and ambiguous writes preserve the authoritative object. Client device-backup failure does not block cloud persistence. Current whole-session envelope limit is 24 MB; this is not infinite storage. Whole-session writes and per-user CAS remain a scale limitation; partitioned conversation storage and server job recovery are future work.

## Retrieval mathematics actually implemented

On eligible personal and owner-published records, Unicode normalized lexical sets define a transparent sparse baseline:

`score(q,m) = sum_{t in q intersect m} log(1 + (N - df(t) + 0.5)/(df(t) + 0.5)) / sqrt(|terms(m)|)`.

Explicit preferences rank first. References require a shared query term. At most eight whole items are selected under an 8,000-character estimated context allowance. No record is truncated; an oversized item is skipped. The prompt retains the exact text, negation, literals and source. Current user instructions take priority. This is lexical relevance, not a probability of truth, neural embedding, universal language pivot or trained semantic-memory model. Multilingual semantic retrieval, stale-claim detection, conflict reasoning, source-dependent memory invalidation and tested procedural recipes are proposed research, not implemented capabilities.

The Quran-context research note preserves verse context and explicitly labels engineering analogies. It supplies inspiration for attributable records, verification, correction and hypothesis testing. It does not establish Arabic as the ancestor of every language or derive a biological memory system.

## Verification

See verification.md for exact automated and browser evidence. Synthetic provider/MCP fixtures are not a live provider account test. Broad creativity and responsibility transfer from provider to owned model require new held-out task evidence; they have not been established by these changes.
