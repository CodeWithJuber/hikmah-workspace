# Shared episode evidence integration

This integration ports the verified, standalone **shared episode identity** Python prototype to a browser-compatible TypeScript module. Its engine identifier is `shared-episode-v1`. It is an experimental finite constraint solver, not a trained language model or a verified Stage 31/32 checkpoint.

## Provenance checked on 17 September 2026

| Source                                                                                                     | Available evidence                                                                                                                                               | Boundary                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `meaning-model-stage30-update.md`, `stage30-research-report.md`, `meaning-model-stage30-verification.json` | Saved source contents read; the report defines existential partial observations and conditional entailment                                                       | The full Stage 30 archive could not be retrieved in this integration attempt; its download returned HTTP 502   |
| `meaning-model-stage30.zip`                                                                                | Expected SHA-256 `43484ef701f164755dbc61a91581ce8c9394eb825fa2bdb7f41216b770016de9`, expected 10,958,978 bytes, from the saved verification/continuation records | Expected identity only; archive bytes, original audio, QAC data, and parent code were not verified or run here |
| Standalone `meaning-research-episode-identity/episode_model.py`                                            | Actual source inspected; supplied demo rerun; SHA-256 `2f71cfec834b28ac295578248b5d0aa2364304a596ac4331ed896eaa2ce83199`                                         | Its own report and protocol explicitly say this is not Stage 31 and not an integrated replacement checkpoint   |
| Standalone `REPORT.md`                                                                                     | Actual content inspected; SHA-256 `713876900d22a700fe2daf90ade4d4f737e85f7b73a6c5f4d6720b0081f9bb42`                                                             | Authored finite tests, not independent natural-language evaluation                                             |
| `stage31-preflight-review.md`                                                                              | Actual content inspected; SHA-256 `b9e6c0eee823074401137894ad3220b26355b0e9df4b4c0d6b092fb425f89163`                                                             | Explicitly a proposed, unexecuted token-to-root evaluation protocol                                            |
| Stage 32                                                                                                   | No authoritative matching artifact established during retrieval                                                                                                  | No implementation or completion claim is made                                                                  |

The standalone package's `MODEL_CARD.md`, `CONTINUATION.md`, `PROTOCOL.md`, independent mathematical review, and recorded `results/summary.json` were also inspected. This TypeScript port preserves that package's finite semantics. The new browser bundle and independent oracle tests exercise the port; they are not a regression run against the unavailable Stage 30 source.

## What the solver means

For each supplied symbol key `k` and complete context cell `c`, there is a shared deterministic table `f(k, c)`. Its values belong to the explicitly supplied sense inventory for `k`. An observation supplies a label and a set of possible context cells. It means the label held in at least one of those cells.

Observations with the same explicit episode identity must share one context witness. For every episode `e`, the solver chooses a cell `c_e` from the intersection of its observations' allowed cells and requires every observation in that episode to agree with `f(k, c_e)`.

- Missing identity gives an observation its own existential witness. It does not assert that physical events differ.
- Distinct episode IDs may have identical context values.
- One episode means a fixed complete context snapshot. A whole conversation or story can contain changing times, perspectives, and intentions; its records cannot automatically be collapsed to one snapshot.
- No parser, coreference detector, source authenticator, or world-perception system produces these inputs. Contexts, labels, inventories, and identity links are supplied annotations.

The query projects every compatible table/witness assignment onto the requested cells or recorded episode:

| Result           | Meaning                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `ENTAILED`       | At least one compatible assignment exists and all agree on one supplied sense               |
| `AMBIGUOUS`      | Multiple senses remain possible; the output includes a complete-model witness for each      |
| `INCONSISTENT`   | No compatible assignment exists; contradiction is not vacuous entailment                    |
| `RESOURCE_LIMIT` | The search or proof-output budget was exhausted; value, candidates, and proofs are withheld |

`ENTAILED` means entailed **under the supplied assumptions**. It does not certify that an observation, identity link, source, or inventory is correct. A false SAME link can produce a consistent but wrong singleton answer. The tests preserve this counterexample. No output is automatically stored as a world fact.

## API and example

```ts
import { EpisodeModel } from '@/lib/research/episode-model';

const evidence = new EpisodeModel(
  ['scene-1', 'scene-2'],
  { anchor: ['RED', 'BLUE'], symbol: ['CUP', 'BALL'] },
  { scopeId: 'tenant-1:workspace-1:research-example' },
);

evidence.add({
  rowId: 'anchor1',
  key: 'anchor',
  sense: 'RED',
  allowed: ['scene-1'],
  source: 'reviewed-annotation:1',
});
evidence.add({
  rowId: 'anchor2',
  key: 'anchor',
  sense: 'BLUE',
  allowed: ['scene-2'],
  source: 'reviewed-annotation:2',
});
evidence.add({
  rowId: 'partial-anchor',
  key: 'anchor',
  sense: 'RED',
  allowed: evidence.cells,
  episode: 'recorded-instant',
  source: 'reviewed-annotation:3',
});
evidence.add({
  rowId: 'partial-symbol',
  key: 'symbol',
  sense: 'CUP',
  allowed: evidence.cells,
  episode: 'recorded-instant',
  source: 'reviewed-annotation:4',
});

const result = evidence.query('symbol', { allowed: ['scene-1'] });
// ENTAILED, CUP. Without the supplied link between the partial observations:
// AMBIGUOUS, BALL/CUP. This binds an already supplied sense to a context.

evidence.retract('partial-anchor');
evidence.receiptIsCurrent(result); // false
evidence.query('symbol', { allowed: ['scene-1'] }); // AMBIGUOUS

const snapshot = evidence.snapshot();
const restored = EpisodeModel.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
// Alternatively query within a recorded episode:
restored.query('symbol', { episode: 'recorded-instant' });
```

`add` validates an observation atomically; `retract` removes it and advances the revision. `rows`, `cells`, and `senses` are immutable copies/views. `snapshot()` is JSON-serializable and `fromSnapshot()` validates the complete snapshot before exposing an instance. The module performs no storage, network, provider, or tool actions.

`fingerprint()` uses the existing portable SHA-256 implementation over a versioned tuple encoding containing scope, revision, inventories, and sorted observations. Insertion order of sense-object keys and observation rows does not change the receipt. Every successful mutation invalidates prior receipts, including a retraction followed by re-adding identical data. Reloading an unchanged snapshot preserves the receipt. This encoding is intentionally versioned for the TypeScript port; it does not promise byte-identical Python receipts. A receipt checks content freshness, not source authenticity or access authorization.

Keys and sense labels are exact strings. A caller should use an unambiguous encoding of language and symbol identity, for example `JSON.stringify(['ar', expression])`, rather than automatically merging matching spellings across languages. No normalization or synonym merging is inferred.

## Bounds and runtime

| Resource                     | Hard limit |
| ---------------------------- | ---------: |
| Context cells                |         64 |
| Symbol keys                  |         16 |
| Observations                 |        128 |
| Senses per key               |         32 |
| Identifier/label UTF-8 bytes |        256 |
| Source reference UTF-8 bytes |      2,048 |
| Serialized snapshot bytes    |    524,288 |
| Search nodes                 |    100,000 |
| Counted work units           |  2,000,000 |
| Proof-output byte allowance  |  1,048,576 |

Queries can lower `budget` or `workBudget`; they cannot raise the hard bounds. Counted work covers grouping, candidate checks, search visits, and witness construction. The proof-byte accounting is conservative. Exhaustion discards all partial answers even if an earlier branch found a singleton. Input rejection leaves the previous state unchanged.

The node and work budgets are deterministic software limits, not wall-clock guarantees or exact CPU instruction counts. Validation and fingerprinting operate over the bounded snapshot. Run substantial or untrusted workloads in an isolated worker with a deadline and cancellation at the integration boundary; do not place repeated maximum-size searches on the UI thread. An API must also bound raw request-body bytes before JSON parsing and enforce tenant access independently. `scopeId` separates content identities; it is not an authorization mechanism.

## Validation performed for this port

Run `node --test tests/episode-model.test.mjs`. The test compiles a browser bundle with esbuild, then tests it under Node without external providers or credentials.

- Independent complete-table enumeration checks all 301 ordered tiny ledgers from the standalone protocol: empty ledger, 12 singletons, 144 independent ordered pairs, and 144 shared-episode ordered pairs. Deliberate duplicates/order variations remain disclosed.
- All 2,694 cell/episode queries agree: 776 entailed, 1,358 ambiguous, 560 inconsistent. All 3,492 emitted candidate proof certificates satisfy the full supplied evidence and query.
- Additional checks cover context binding, explicit retraction, stale receipts, source/scope changes, snapshot reload, contradiction recovery, equal context values across distinct episodes, identity/row-ID collisions, immutable inputs, prototype-like keys, accessor rejection, Unicode validation, byte/row/sense caps, partial-search exhaustion, and proof-output limits.
- The false-identity paired case remains a wrong-world-answer counterexample, not a hidden success. These checks do not establish natural-language accuracy, human learning, biological hypotheses, broad hearing, or universal meaning.

The standalone report separately records 24 successful authored context bindings, 24 abstentions without identity, 24 abstentions after anchor retraction, and 24 wrong paired answers with false identity. Those are repetitions of one structural construction, not 24 independent language discoveries. They are reported source results; this port's independent tiny-domain test is the new verification.

## Connection to learning from live model exchanges

Provider request/response capture, memory learning, procedure learning, and model-weight training are distinct operations. Capturing an exchange supplies an observation of what the model said; it does not establish that its content is true. A generation or source identifier helps trace the origin without proving correctness.

An integration should retain actual provider/model identifiers, message/source references, timestamps, scope, corrections, and independently available outcome evidence. Proposed semantic annotations remain distinguishable from accepted annotations. Only explicit, scoped structured evidence should enter this solver; do not manufacture shared identity from a desired target answer or treat provider consensus as independent ground truth.

Present the result, competing interpretations, supporting evidence, and retraction actions together. Promote reusable procedures through evaluation, counterexamples, versioning, and rollback. Actual adapter/weight training needs its own dataset and training/evaluation process. This module does not claim to perform that training or to complete the unavailable research stages.
