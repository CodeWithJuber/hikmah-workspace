import { evaluateField, type FieldModel, type Sentence } from './field-model.ts';
export type Metrics = ReturnType<typeof evaluateField>;
export function checkContextGate(
  model: FieldModel,
  data: { sentences: Sentence[]; baseline: Metrics; excludedGroups: string[] },
) {
  if (model.training.groups.some((g) => data.excludedGroups.includes(g)))
    throw Error('Candidate metadata includes an evaluation document group.');
  const current = evaluateField(model, data.sentences),
    before = data.baseline;
  const regressions = current.perSentence
    .filter((row) => {
      const b = before.perSentence.find((p) => p.id === row.id);
      return !b || row.las < b.las || row.pos < b.pos;
    })
    .map((r) => r.id);
  const gain = current.las - before.las,
    approved =
      current.tokenCount > 0 &&
      gain > 0 &&
      regressions.length === 0 &&
      current.posAccuracy >= before.posAccuracy;
  return {
    approved,
    scope: 'Reused development syntax gate; not semantic or new held-out proof',
    origin: 'server-recomputed',
    gain,
    regressions,
    current,
    baseline: { las: before.las, posAccuracy: before.posAccuracy },
    reason: approved
      ? 'Development syntax improved with no per-sentence LAS/POS regressions.'
      : gain <= 0
        ? 'No measured development syntax improvement.'
        : 'Regression found; candidate stays inactive.',
  };
}
