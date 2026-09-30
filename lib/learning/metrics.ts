/** Per-language holdout metrics and provider-weight provenance for releases.
 *
 * Two honesty rules live here:
 *
 * 1. A release reports per-language numbers, never a single blended score
 *    that could hide a regressing language. Nothing in this module computes
 *    an average, a mean, or an "overall" — the shape of the report makes the
 *    blend unrepresentable.
 * 2. Wherever provider/model weights are shown or used, they carry a
 *    provenance label: source, evaluation timestamp, and the holdout they
 *    were evaluated on. Unlabeled weights are refused with a named error.
 */
import { LearningReleaseError } from './releases.ts';

export type LanguageMetrics = {
  language: string;
  /** Accuracy (or the primary metric) on the independent holdout, 0..1. */
  accuracy: number;
  /** Optional secondary metrics, e.g. uas / las for syntax models. */
  secondary: Record<string, number>;
  /** Holdout items scored for this language. Small holdouts are visible, not hidden. */
  sampleCount: number;
};

export type PerLanguageReport = {
  /** Languages keyed explicitly: no blended aggregate exists anywhere. */
  perLanguage: Record<string, LanguageMetrics>;
  /** Sorted language codes, so two reports over the same languages compare. */
  languages: string[];
  evaluatedAt: string;
  /** "weights from <provider>, evaluated <ts> on holdout <id>". */
  weights: string;
};

/** "weights from X, evaluated Y on holdout Z" — the label every weights
 * surface must carry so provider weights are never misrepresented. */
export function weightProvenance(input: {
  provider: string;
  evaluatedAt: string;
  holdoutId: string;
}): string {
  const { provider, evaluatedAt, holdoutId } = input;
  if (!provider.trim() || !evaluatedAt.trim() || !holdoutId.trim())
    throw new LearningReleaseError(
      'weights-unlabeled',
      'Provider weights need a source, an evaluation time and a holdout id — refusing unlabeled weights.',
      422,
    );
  return `weights from ${provider.trim()}, evaluated ${evaluatedAt.trim()} on holdout ${holdoutId.trim()}`;
}

/** Refuse unlabeled weights: a weights surface without a provenance label
 * naming source, evaluation time and holdout is a misrepresentation. */
export function formatWeights(display: { weights: unknown; provenance?: string | null }): {
  weights: unknown;
  label: string;
} {
  const provenance = display.provenance;
  if (
    typeof provenance !== 'string' ||
    !/^weights from .+, evaluated .+ on holdout .+$/.test(provenance.trim())
  )
    throw new LearningReleaseError(
      'weights-unlabeled',
      'Refusing to display provider weights without a provenance label (source, evaluation time, holdout).',
      422,
    );
  return { weights: display.weights, label: provenance.trim() };
}

/** Build the per-language holdout report a release (and each canary stage)
 * must carry. Throws weights-unlabeled when the provenance is missing. */
export function metricsReport(input: {
  metrics: readonly LanguageMetrics[];
  evaluatedAt?: string;
  weights: unknown;
  provenance?: string | null;
}): PerLanguageReport {
  if (!input.metrics.length)
    throw new LearningReleaseError(
      'metrics-empty',
      'A holdout report needs at least one language.',
      422,
    );
  const { label } = formatWeights({ weights: input.weights, provenance: input.provenance });
  const perLanguage: Record<string, LanguageMetrics> = {};
  for (const metric of input.metrics) {
    if (!metric.language.trim())
      throw new LearningReleaseError('metrics-empty', 'Every metric row needs a language.', 422);
    if (!(metric.accuracy >= 0 && metric.accuracy <= 1) || metric.sampleCount < 0)
      throw new LearningReleaseError(
        'metrics-invalid',
        `Metric for ${metric.language} is out of range: accuracy must be 0..1 and sampleCount non-negative.`,
        422,
      );
    if (perLanguage[metric.language])
      throw new LearningReleaseError(
        'metrics-duplicate',
        `Duplicate metric row for language ${metric.language}.`,
        422,
      );
    perLanguage[metric.language] = metric;
  }
  return {
    perLanguage,
    languages: Object.keys(perLanguage).sort(),
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    weights: label,
  };
}

/** Per-language no-regression check: each language must stay within
 * maxRegression of its baseline. Returns the regressing languages by name —
 * never a blended pass/fail. */
export function checkNoRegression(
  baseline: Readonly<Record<string, LanguageMetrics>>,
  candidate: Readonly<Record<string, LanguageMetrics>>,
  maxRegression = 0.01,
): { ok: boolean; failures: { language: string; baseline: number; candidate: number }[] } {
  const failures: { language: string; baseline: number; candidate: number }[] = [];
  for (const language of Object.keys(baseline).sort()) {
    const base = baseline[language];
    const next = candidate[language];
    if (!next)
      throw new LearningReleaseError(
        'metrics-missing-language',
        `The candidate report is missing language ${language} present in the baseline.`,
        422,
      );
    if (next.accuracy < base.accuracy - maxRegression)
      failures.push({ language, baseline: base.accuracy, candidate: next.accuracy });
  }
  return { ok: failures.length === 0, failures };
}
