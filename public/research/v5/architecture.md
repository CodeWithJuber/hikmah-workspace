# Hikmah: owned co-model and cognitive middle layer

Implementation and research plan, 10 September 2026.

Hikmah now has a durable, genuinely trainable symbolic co-model connected to the chat workspace. Its structure learning and workflow learning are distinct from provider inference. Neither operation modifies the external provider's weights. This release is a bounded learning system; it does not establish AGI or a gain over the selected foundation model.

## Executed architecture

1. **Interpret:** run the owned `intersection-template.v1` learner when the sentence falls within its supported scope. A six-field frame records actor, action, recipient, polarity, tense and modality. Ambiguous and unsupported inputs abstain.
2. **Select:** classify a task into conversation, coding, research or analysis using an explicitly heuristic classifier. Apply owner-selected direct/verify strategy, or a learned preference when both strategies have sufficient feedback.
3. **Propose and act:** use the user's selected provider/model with declared tools and workspace permissions. Structured questions collect real user decisions. Tool descriptions and outputs remain untrusted data.
4. **Review:** the verify workflow asks the same requested model for schema-validated concrete defects. It may make one additional repair call. This is a model judgment; it is not independent evidence. Invalid, unavailable, empty or truncated reviews/repairs preserve the original answer. Named defects and the pre-repair draft are inspectable, with bounded trace excerpts.
5. **Learn:** approved semantic labels trigger a full candidate refit, development comparison and automatic promotion when the gate passes. Explicit quality feedback updates a separate workflow preference distribution. Corrections replace earlier contributions; they do not accumulate contradictory votes.
6. **Persist:** authenticated cloud records preserve co-model checkpoints, approved examples, candidate decisions, owner controls and run metadata. Workspace conversations, files and configuration synchronize separately. Optimistic concurrency rejects stale writes.

The original architecture is `M = (O, L, Γ, w, H, T)`: reviewed ontology, learned lexicon, composition grammar, rule parameters, procedures and transition/outcome predictions. This release operationalizes **L, Γ, template observation counts and workflow preference parameters**. General procedure induction and a learned world-transition model remain research work. It does not silently label those unfinished components as running.

## Mathematics implemented

For word `w` appearing in labeled examples `(x_i, y_i)`, compute the candidate lexical set:

`C(w) = intersection { atoms(y_i) : w in tokens(x_i) }`.

A singleton surviving semantic atom becomes a lexical mapping. Resolved actor, action and recipient positions become variable slots in surface templates; literal words retain construction cues. Training changes the mappings and templates themselves. The tokenizer, frame schema and matching interpreter are supplied code.

Candidate promotion uses:

`gain = correct_frames(candidate, D_dev) - correct_frames(active, D_dev)`

`promote iff gain > 0 AND regressions = 0 AND wrong_emissions = 0`.

Training IDs, semantic-family IDs and normalized utterance hashes must remain separate from development data. Reusing a development set for repeated selection does not create a new independent test set. Owner-added labels are human assertions, not proven objective truth; the gate only establishes the measured development behavior.

For task family `f` and eligible workflow `a`, the preference distribution is:

`α_fa = 1 + positive_ratings_fa`

`β_fa = 1 + negative_ratings_fa`

`preference_mean_fa = α_fa / (α_fa + β_fa)`.

Adaptive selection uses these means only after at least three ratings exist for each workflow in that family; otherwise it uses a visible bootstrap rule. This is a task-family preference learner, not a calibrated correctness probability, causal performance estimate, contextual neural network or general reinforcement learner. Counts are replayed from the retained 500-run window so edits and retractions are idempotent. Comparison runs and incomplete runs are excluded from quality learning. No rating means no quality label.

## Automatic learning contract

Submitting reviewed examples automatically runs training when enabled. Every fitted candidate receives a gate receipt; a failed or no-gain candidate is retained in the pending example set while the active checkpoint stays unchanged. The owner can correct matching example IDs, add independent development examples, train explicitly, pause automatic training or roll back.

The seed and eleven most recent promoted checkpoints remain available in this bounded release. Exported checkpoints contain actual learned structures and training data. The seed has 144 supervised examples; its initial version entry is identified as bundled data, not a fictitious online training event. The current engine has explicit finite data and text limits; expanding scale is a separate architecture/migration task.

Automatic means **event-driven training when reviewed data arrives**. There is no claimed background worker training on everything, and raw generated text is not promoted into trusted training targets. User chats are not sent to third parties for provider training by this implementation.

## Source-informed operating rules

Recovered project records document an AI contextual first pass across 6,236 ayahs and 114 surahs. They record 1,541 candidate ayahs, 2,180 with no direct analogy, 2,048 context-only and 467 needing deeper review. The recovered registry has 22 patterns, with 2,866 overlapping memberships over 1,541 unique candidate ayahs. The original full ledger and review shards were referenced but not recovered; coverage metadata and preserved candidate memberships were audited for consistency.

The registry's original IDs are preserved. Verification, uncertainty, consultation, correction, entrusted authority, fairness and proportionate effort become generic engineering requirements. They are our engineering interpretations, not claims that the source literally specifies a software algorithm. Some are enforced by code (tool scope, role checks, data validation, promotion); others remain prompt guidance requiring behavioral evaluation.

The separate root study is bounded: seven root families, eighteen word examples and fifteen ayahs, with three preserved review flags. A root label can serve as one semantic symbol across languages. It does not prove that all languages derive from Arabic or that a word's sound frequency universally determines meaning. Arabic morphology resources support linguistic analysis, not those universal hypotheses. [Quranic Arabic Corpus documentation](https://corpus.quran.com/documentation/).

## Evidence and comparison

The chat Compare mode shows a direct one-generation baseline and the Hikmah workflow using the same requested model, configuration and starting context. The baseline does not execute tools. Hikmah may use clarification, tool actions and review/repair. Its additional calls are included in total usage. Upstream provider endpoint routing is not pinned, and the baseline panel reports the model returned by the provider.

This measures a proposed **system comparison**; it is not a matched-compute experiment. Live gains have not been established. The next evaluation must freeze tasks, provider endpoint, evidence access, sampling, scorer, time/cost caps and failure policy, then compare:

- Direct provider versus the full Hikmah system.
- Hikmah versus a strong multi-sample/verify baseline at matched compute and evidence access.
- Frozen versus updated co-model/controller on unseen task families.

Adaptive test-time allocation has empirical support in specific studied settings, not a promised Hikmah multiplier. [Snell et al.](https://arxiv.org/abs/2408.03314). Same-model self-correction can fail or degrade an answer without external feedback; keeping the original answer and exposing model judgment is deliberate. [Huang et al.](https://arxiv.org/abs/2310.01798). No near-AGI, 100× improvement, guaranteed profitability or inevitable autonomy claim follows from these studies.

## Product experience and ownership

Chat remains central. Code responses produce isolated inline previews; an expandable pane offers source inspection and interaction. Editing a generated bundle requires an explicit action before matching workspace files are replaced. Mobile panes use a focus-managed sheet. Questions appear as actual answerable cards. Composer mode, tools, attachments and model controls remain available in the same workspace. Provider credentials stay in memory and out of cloud sessions and exports.

Co-model shows learned mappings, rules, development results, training decisions, versions and rollback. Super Admin is distinct from Workspace admin. Every Super Admin endpoint checks server identity. The first owner binding requires the exact configured owner email obtained from the Site access record; subsequent authorization uses its immutable site-scoped user ID. No client role flag, URL or user-supplied identity grants access.

Workspace cloud state is scoped by authenticated user ID, with optimistic revisions. This remains an owner-private application. Multi-tenant owner analytics, billing, subscription entitlements and public onboarding are not implemented by adding the Super Admin screen.

## Progression toward a main model

**Available now:** owned symbolic interpretation, actual structural training, preference updates, persistent checkpoints, gated promotion, rollback and provider-backed agent workflows.

**Next gate:** induct bounded executable procedures using generate/test/prune, with outcome checks in an isolated environment and task-family-held-out evaluation. Successful terminal answers alone cannot validate every intermediate representation.

**Then:** delegate particular local task families when independent tests establish reliability, including abstention, failure recovery and regression tracking. Measure the share completed without material teacher help.

**Longer-term:** expand semantic coverage, independent realization, multimodal representations and world transitions. This requires curated data, compute, stronger evaluation and algorithm work. General capability is not an inevitable result of accumulating chats.
