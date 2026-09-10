# Hikmah v7: attributable memory, reviewed learning, and testable creativity

Research note, 10 September 2026. Read-only audit of source revision `5d00560f8834823556377978f0ada440bf9d0976`; implementation changes may be in progress. This is a design proposal, not a claim that all components below are implemented. Equations are engineering choices, not equations found in the Quran or a biological model of human memory.

## Contextual Quran research

The original `public/research/v6/original/ayah-ledger.jsonl` and context memberships were checked against `docs/v6/research.md`. The ledger retains AI-first-pass and not-independently-scholarly-verified labels. Live Quran.com pages were opened for all eight selections below. Four returned resource 20/Saheeh International; four working `/en/` pages displayed The Clear Quran. The table therefore paraphrases context and does not claim eight exact translation-string matches or a new full tafsir audit. Original context spans and cautionary dispositions remain intact.

| Ayah and retained context | What the passage concerns | Proposed application and excluded inference |
|---|---|---|
| [96:1–5](https://quran.com/96/1-5?translations=20) | Recitation in relation to the Creator; teaching through the pen; a transition from not knowing to knowing. Ledger span 96:1–5. | Preserve learning as attributable records with an explicit prior gap and a later result. This does not prescribe a memory algorithm, training corpus, or universal language ancestry. |
| [2:282](https://quran.com/2/282?translations=20), context 2:282–283 | Written deferred debt obligations, accurate terms, witnesses, accommodations and an immediate-exchange exception. | Version commitments, deadlines, authorizations and corrections. Preserve the original legal/religious context; do not transfer gendered witness rules or treat this as an AI database specification. |
| [49:6](https://quran.com/49/6?translations=20), context 49:6–8 | Investigating a consequential report to avoid harming a community through ignorance. | A claim enters reference memory with its source and verification state; harmful or consequential action requires relevant evidence. Reliability is assessed from evidence, not a source's religious identity. |
| [17:36](https://quran.com/en/al-isra/36), context 17:31–39 | A command against following what one lacks knowledge of, within a wider set of accountable conduct instructions. | Distinguish observed events, user assertions, inferences and unresolved claims. Unsupported propositions remain marked uncertain; this does not justify a manufactured numerical truth score. |
| [18:23–24](https://quran.com/en/al-kahf/23-24) | Future intention qualified by divine will and remembrance after forgetting. | Store commitments with dependencies and make correction of an omitted qualification visible. This is an analogy for recoverable plans, not evidence for a particular forgetting curve. |
| [39:18](https://quran.com/en/az-zumar/18), context 39:17–20 | Listening and following the best in a passage about worship and guidance. | Compare proposals against stated criteria and supporting evidence. Majority votes or repeated model agreement are not thereby established as truth. |
| [21:78–79](https://quran.com/21/78-79?translations=20), ledger span 21:78–80 | David and Solomon judging damage to a field; a specific understanding attributed to Solomon while both retain acknowledged judgment and knowledge. | Update a procedure or case-level conclusion without globally discrediting its contributor. Preserve the ledger's deeper-review status for transferring remedies from 21:78; do not infer a modern legal remedy or numerical ensemble rule. |
| [3:190–191](https://quran.com/en/ali-imran/190-191), ledger span 3:190–194 | Remembrance and reflection on creation, within a devotional passage. | Inspiration for an observation–question–hypothesis–test workspace. The ledger marks 3:190 context-only; keep that status. This passage does not specify the scientific method or prove generated ideas are valid. |

The useful design connection is accountability of claims and actions. Root letters alone do not retain who asserted a fact, whether it is negated, its time, or its scope. Memory must retain that context separately. These eight selections deepen relevant anchors; they do not replace the 6,236-row corpus review or establish its completeness as scholarship.

## Three records with different update rules

**Episodic records** describe an actual event: user request, tool call, observed result, time, run ID and source IDs. The existing conversation/checkpoint/receipt system already provides a limited event history. Record completion only after an actual result; interrupted external actions can have unknown outcomes. Automatically recording a private event does not verify every factual claim inside it.

**Semantic records** hold user-curated preferences and reference claims. Minimum fields are `id`, `owner`, `scope`, `kind`, `content`, `source`, `createdAt`, `updatedAt`, `revision`, `enabled` and optional `project`, `validUntil`, `supersedes`, `conflictsWith`. Store actor, negation and temporal qualifications in the content even when structured extraction is uncertain. A preference is authoritative about the user's stated preference, not evidence about the external world.

**Procedural records** are recipes: preconditions, ordered actions or a DAG, expected observations, verification checks, failure handling and a version. A proposed recipe remains a proposal until executed tests produce receipts. A successful recipe can be retrieved without changing any provider model weights.

Real-time behavior means a newly saved private item is eligible for the next request immediately and is visibly synchronized durably. It does not mean a background system silently converts every utterance into a verified fact. A future automatic extractor should produce inspectable candidates; deletion, editing and disabling must remain direct user actions.

## Scope precedes retrieval

Before computing relevance, apply an access predicate:

\[
A(m,u,p)=\operatorname{enabled}(m)\land\neg\operatorname{deleted}(m)\land
\big[(m.owner=u\land m.scope=private)\lor(m.scope=shared\land m.publication=approved\land u\in m.audience)\big]
\land(m.project=\varnothing\lor m.project=p).
\]

Unapproved shared drafts, another user's private items and deleted records never enter scoring, prompt construction or exports for a different audience. A server enforces identity and audience; a client-provided `scope` cannot authorize publication. For the current private application, “global” should mean owner-published shared knowledge with an explicit audience, not automatic pooling of all users' private conversations. Personal information needs an explicit publication decision before entering a shared record.

Private preferences override shared defaults; the current user request overrides earlier preferences. Explicit supersession selects the active revision for one record. Two independently sourced conflicting claims are preserved as a conflict instead of silently choosing the newer timestamp. Delete/forget excludes the record from every later retrieval and any derived candidate needing that source.

## Transparent mathematics and falsifiable tests

The current in-progress `knowledge.ts` uses Unicode lexical overlap, an IDF-like weight, length normalization and a bounded selection. It is a legitimate transparent baseline, not learned semantic understanding. Sparse sets/counts and graph checks do not require transformers or dense embeddings.

For eligible references, a more extensible lexical baseline is:

\[
B(q,m)=\sum_{w\in q\cap m}\log\left(1+\frac{N-df(w)+0.5}{df(w)+0.5}\right)
\frac{tf(w,m)(k_1+1)}{tf(w,m)+k_1(1-b+b|m|/\overline{|m|})}.
\]

This is established BM25-style lexical scoring with a positive IDF variant, not a claim of original NLP invention. Parameters such as `k1=1.2`, `b=0.75` would be initial experimental settings, not discovered constants. Term-frequency saturation, length normalization and separate development tuning are described in the authors' [Introduction to Information Retrieval, BM25 chapter](https://nlp.stanford.edu/IR-book/html/htmledition/okapi-bm25-a-non-binary-model-1.html). An owner-reviewed multilingual alias table can expand queries with a lower weight, preserving the original query; automatic Arabic associations remain candidate paths rather than confirmed meaning equivalence. Negation and exact numbers must survive retrieval verbatim.

Separate explicit preferences from reference ranking and give each a bounded allocation. Then select useful nonredundant records:

\[
S^*=\arg\max_{S\subseteq M_A}\left[\sum_{m\in S} B(q,m)-\lambda\sum_{i<j\in S}J(T_i,T_j)\right],
\quad\sum_{m\in S}\operatorname{bytes}(m)\le C.
\]

`J` is Jaccard overlap of lexical term sets. A deterministic greedy approximation is sufficient for a small private collection; document the approximation. References require positive query relevance, while the user may explicitly pin preferences. Age is a reason to recheck a time-sensitive fact, not proof it is false. A ranking score must never be labeled probability of truth.

For a procedural recipe version tested on a defined task family, a simple outcome model is:

\[
\theta_j\mid D\sim\operatorname{Beta}(1+s_j,1+f_j).
\]

Count independent executed test cases, not votes, repeated model claims or duplicated source reports. A promotion proposal may require `P(theta_j > target) > 0.95`, zero failures of critical checks, and a fresh held-out gate. This is a proposed reliability criterion under an exchangeable-outcome assumption; it is neither semantic truth nor a humanlike score. Keep every failure and reset version-specific statistics after meaningful recipe changes.

No automatic rule should keep changing the test until its desired result passes. Freeze evaluation cases before choosing parameters, separate source/translation/duplicate groups, report uncertainty, and evaluate fresh cases when the development set has influenced design.

## Creativity beyond verbatim recall

Represent a candidate solution as a typed graph of entities, constraints, actions and expected observations. Generate candidates by composing two compatible recipes, replacing one mechanism, reversing an assumption, or adding a missing constraint. Preserve source links to the ingredients and mark every unsupported new claim as a hypothesis. This can yield a combination not stored previously; it does not establish an idea unknown to the world or reasoning unconstrained by training.

Measure novelty against the available archive only:

\[
N(h)=1-\max_{g\in\mathcal A}J(\operatorname{atoms}(h),\operatorname{atoms}(g)).
\]

Keep novelty separate from validity and utility. Compare candidates on observed acceptance-test pass rate, user-rated usefulness, cost and latency. A high novelty score with failed checks is not a better answer. Only tested results are candidates for procedural memory; speculative concepts can be stored in a clearly labeled ideas collection. Provider generation continues to supply broad language and coding proposals while the owned core earns responsibility on measured task families.

## Immediate extension points and acceptance gates

1. `lib/playground/knowledge.ts`: bounded schema, pure retrieval, explicit source IDs, disabled/deleted exclusion; precompute document frequencies rather than recomputing them for every match.
2. `lib/playground/session.ts` and `components/playground/context.tsx`: include private curated records in serialization, restore and durable autosave. The existing whole-session D1 CAS is sound for a bounded private collection, but 500 records × 12,000 characters exceed the current 1.8 MB endpoint limit. Enforce an aggregate byte allowance and surface sync failures before claiming Saved.
3. `components/playground/chat.tsx`: Remember action opens an editable draft with conversation/message provenance; retrieve once per request and record exact IDs/revisions used. Add the same relevant user knowledge to both Compare arms when assessing workflow differences.
4. A knowledge view should expose Add, Edit, Disable, Forget and source links. Keep reviewed parameter training in the context-model view, with a clear link rather than an implication that remembering trains weights.
5. Shared owner-published memory needs its own authenticated route/table, append-only revisions and explicit audience. It does not belong in a user-private session blob if it will be read across users. Root owns the migration and implementation decision.

Minimum factual acceptance tests: save/reload/retrieve/edit/forget; unrelated reference exclusion; negation and exact-literal preservation; source attribution; outdated/conflicting records; cross-user and cross-project isolation; shared-draft exclusion; current-instruction precedence; aggregate-byte overflow; concurrent-edit conflict; Compare context parity. For multilingual retrieval, report precision/recall separately for each language, transliteration and code switching against a no-memory baseline. For procedures, compare actual task completion and failure recovery at matched provider/compute budgets.

The product can provide useful continuity, accountable reuse and tested adaptation now. Neither this design nor the Quranic analogies establish 100% human equivalence, universal language origins, autonomous unrestricted learning or a guaranteed path to AGI.
