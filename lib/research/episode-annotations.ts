/** Reviewed-learning annotations → episode-solver training observations (§3.6).
 *
 * The episode solver (`episode-model.ts`) reasons over supplied annotations; it
 * used to train on synthetic/placeholder inputs because nothing wired it to the
 * annotation store. This module is the bridge: human-reviewed learning
 * examples become `EpisodeObservation` rows, each carrying provenance back to
 * the annotation it came from.
 *
 * WHAT THIS MODULE DOES NOT DO:
 * - It does not touch the solver's search/proof math (`episode-model.ts` is
 *   read-only). It only prepares inputs.
 * - It never promotes anything to knowledge by itself. Promotion stays on the
 *   existing human review path; this module only labels eligibility.
 * - It never accepts pending or rejected examples — status 'approved' only.
 *
 * V5 IMAGINATION DISCIPLINE (loud, because it matters):
 * Synthetic practice episodes — invented inputs used to exercise the solver —
 * are NEVER eligible for knowledge promotion, no matter what flag a caller
 * passes. `markSynthetic` brands an observation synthetic; `isPromotable`
 * returns false for synthetic rows unconditionally. A synthetic row that found
 * its way into a promoted store would launder imagination as evidence, so the
 * guard is a hard false, not a default.
 *
 * CALLER HOOK: a future caller lists the reviewed annotations, converts them,
 * strips the provenance wrapper (the solver's `add()` only accepts its six
 * known fields), adds them to an `EpisodeModel` whose cell inventory includes
 * the outcome vocabulary below, and queries through `queryEpisodes`:
 *
 *   import { createLearningStore } from '../learning/store.ts';
 *   import { EpisodeModel } from './episode-model.ts';
 *   import { trainingEpisodes, stripObservation, queryEpisodes } from './episode-annotations.ts';
 *
 *   const store = createLearningStore(db);
 *   const { episodes, skipped } = trainingEpisodes(
 *     store.snapshot(userId, { status: 'approved' }).examples,
 *   );
 *   const model = new EpisodeModel(['approved', 'corrected'], senses, { scopeId: 'learning:episodes' });
 *   for (const episode of episodes) model.add(stripObservation(episode));
 *   const { result } = queryEpisodes(model, someKey, { allowed: ['approved'] });
 */
import type { LearningExample } from '../learning/types.ts';
import type {
  EpisodeModel,
  EpisodeObservation,
  EpisodeQuery,
  EpisodeResult,
} from './episode-model.ts';
import { contentKey } from '../text/normalise.ts';
import { sha256 } from '../engines/meaning-engine.ts';

/** Provenance every bridged observation carries. The solver's `add()` accepts
 * only its six known fields, so this rides alongside the observation and is
 * stripped by `stripObservation` before adding. */
export type EpisodeProvenance = Readonly<{
  /** Learning-example id this observation came from; null for synthetic rows. */
  annotationId: string | null;
  /** When a human reviewed the annotation; null for synthetic rows. */
  reviewedAt: string | null;
  /** V5 imagination discipline: true means NEVER promotable. See module docs. */
  synthetic: boolean;
}>;

/** An `EpisodeObservation` with its annotation provenance attached. Assignable
 * to `EpisodeObservation` wherever the plain solver input type is expected. */
export type AnnotatedEpisodeObservation = EpisodeObservation &
  Readonly<{ provenance: EpisodeProvenance }>;

/** The reviewed-outcome vocabulary every bridged observation uses for `allowed`.
 * A consuming `EpisodeModel` must include these cells in its cell inventory.
 * 'approved' is always present; 'corrected' marks annotations where the human
 * reviewer supplied a correction (effectiveResponse ≠ raw model response). */
export const OUTCOME_CELLS = Object.freeze(['approved', 'corrected'] as const);

/** The solver's `name()` limit for keys/senses (episode-model.ts, 256 bytes).
 * Slicing by characters could still exceed it on multibyte text, so truncate
 * by bytes without splitting a surrogate pair. */
function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && encoder.encode(text.slice(0, end)).byteLength > maxBytes) end--;
  // Never leave a dangling high surrogate.
  while (end > 0 && /[\ud800-\udbff]$/.test(text.slice(0, end))) end--;
  return text.slice(0, end);
}

function isAnnotated(
  observation: EpisodeObservation | AnnotatedEpisodeObservation,
): observation is AnnotatedEpisodeObservation {
  return (
    typeof observation === 'object' &&
    observation !== null &&
    'provenance' in observation &&
    typeof (observation as { provenance?: unknown }).provenance === 'object'
  );
}

/** Convert reviewed-learning annotations into solver training episodes.
 *
 * Input: learning examples; only status 'approved' is converted. Pending and
 * rejected examples are skipped (counted in `skipped`), as are approved
 * examples with empty prompts or responses — an empty key or sense would be
 * rejected by `EpisodeModel.add()`, so skipping keeps every returned episode
 * consumable by the solver.
 *
 * Each approved example becomes ONE observation:
 * - rowId: `learning:<id>` (unique per example)
 * - key: sha256(contentKey(prompt)) — the stable content hash of the prompt,
 *   canonicalised by lib/text/normalise.ts so prompts that differ only in
 *   spacing, case or Arabic vowel marks share one key
 * - sense: a slice of the reviewed effectiveResponse (the text a human signed
 *   off on, not the raw model output), truncated to the solver's 256-byte
 *   sense limit
 * - allowed: the reviewed-outcome vocabulary (OUTCOME_CELLS subset)
 * - episode: null — each annotation is its own row group; a future caller may
 *   group by conversation into episodes instead
 * - source: `learning:<id>`
 * - provenance: { annotationId, reviewedAt, synthetic: false }
 */
export function trainingEpisodes(examples: readonly LearningExample[]): {
  episodes: AnnotatedEpisodeObservation[];
  skipped: number;
} {
  const episodes: AnnotatedEpisodeObservation[] = [];
  let skipped = 0;
  for (const example of examples) {
    if (example.status !== 'approved') {
      skipped++;
      continue;
    }
    const promptKey = contentKey(example.prompt);
    const response = example.effectiveResponse;
    if (!promptKey || !response || !response.trim()) {
      skipped++;
      continue;
    }
    const allowed: string[] = ['approved'];
    if (example.correction != null) allowed.push('corrected');
    episodes.push(
      Object.freeze({
        rowId: `learning:${example.id}`,
        key: sha256(promptKey),
        sense: truncateBytes(response.trim(), 256),
        allowed: Object.freeze(allowed) as readonly string[],
        episode: null,
        source: `learning:${example.id}`,
        provenance: Object.freeze({
          annotationId: example.id,
          reviewedAt: example.reviewedAt,
          synthetic: false,
        }),
      }),
    );
  }
  return { episodes, skipped };
}

/** Brand an observation as synthetic practice data.
 *
 * V5 IMAGINATION DISCIPLINE: synthetic === NEVER PROMOTABLE. `isPromotable`
 * returns false for synthetic rows even when a caller passes
 * `allowPromotion: true`. Synthetic rows exist to exercise the solver's search;
 * they must never be mistaken for reviewed evidence and must never reach a
 * knowledge store. Marking is one-way: this function never clears the flag.
 */
export function markSynthetic(
  observation: EpisodeObservation | AnnotatedEpisodeObservation,
): AnnotatedEpisodeObservation {
  const existing = isAnnotated(observation) ? observation.provenance : null;
  const { provenance: _dropped, ...plain } = observation as AnnotatedEpisodeObservation;
  void _dropped;
  return Object.freeze({
    ...plain,
    provenance: Object.freeze({
      annotationId: existing?.annotationId ?? null,
      reviewedAt: existing?.reviewedAt ?? null,
      synthetic: true,
    }),
  });
}

/** Eligibility guard for knowledge promotion.
 *
 * - `allowPromotion` defaults to false: promotion is opt-in, never automatic.
 * - Synthetic rows are NEVER promotable, even with `allowPromotion: true`.
 *   (V5 imagination discipline — see module docs.)
 * - Rows without provenance (unknown origin) are not promotable either:
 *   eligibility requires a traceable reviewed annotation.
 * - Returning true does NOT promote. It only says the row is a reviewed
 *   annotation that a caller may hand to the EXISTING human review/promotion
 *   path. There is no automatic path from a solver result to knowledge.
 */
export function isPromotable(
  observation: EpisodeObservation | AnnotatedEpisodeObservation,
  options: { allowPromotion?: boolean } = {},
): boolean {
  const { allowPromotion = false } = options;
  if (!allowPromotion) return false;
  if (!isAnnotated(observation)) return false;
  if (observation.provenance.synthetic) return false;
  return observation.provenance.annotationId !== null;
}

/** Drop the provenance wrapper so the row fits `EpisodeModel.add()`, which
 * rejects unknown fields. The annotation id survives in `source`. */
export function stripObservation(observation: AnnotatedEpisodeObservation): EpisodeObservation {
  const { provenance: _dropped, ...plain } = observation;
  void _dropped;
  return plain;
}

/** The proof/search entry point for annotation-trained models.
 *
 * Accepts the solver's `EpisodeQuery` plus an `allowPromotion` flag defaulting
 * to false (stripped before calling `model.query`, which rejects unknown
 * fields). The flag declares the caller's intent to use the result in a
 * knowledge-promotion path; it does NOT authorise promotion by itself:
 * every contributing row must still pass `isPromotable(row,
 * { allowPromotion: true })` — synthetic rows always fail — and actual
 * promotion goes through the existing human review path, never automatically
 * from a solver result.
 */
export function queryEpisodes(
  model: EpisodeModel,
  key: string,
  options: EpisodeQuery & { allowPromotion?: boolean } = {},
): { result: EpisodeResult; allowPromotion: boolean } {
  const { allowPromotion = false, ...query } = options;
  return { result: model.query(key, query), allowPromotion };
}
