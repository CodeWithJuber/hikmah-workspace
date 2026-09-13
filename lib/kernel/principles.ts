/** The 22 principles, as something a run can actually read.
 *
 * `lib/kernel/principles.json` holds them — an id, a name, an abstract
 * instruction, the situation that triggers it, and how it would be enforced.
 * They are the generic rules this project derived from its own research, and
 * until now exactly one thing read them: the screen at
 * `components/kernel/center.tsx` that renders the list. They reached a page and
 * never a run.
 *
 * Meanwhile `HIKMAH_CORE` carried a hand-written paraphrase of roughly seven of
 * them — "verify before asserting; preserve the provenance of facts; …" — which
 * could drift from the file with nothing to notice. So the digest below is
 * *generated* from the file and the paraphrase is deleted, rather than the two
 * being kept side by side.
 *
 * Names only, by the owner's choice: all 22 instructions are 5,274 characters,
 * which is a meaningful slice of a small free model's window spent on rules
 * most turns do not touch. The model sees what exists and fetches the full text
 * of the one it needs with `read_principle`.
 */
import principles from './principles.json' with { type: 'json' };

export type Principle = {
  id: string;
  name: string;
  instruction: string;
  trigger: string;
  enforcement: string;
  status: string;
};

export const PRINCIPLES = principles as Principle[];

/**
 * How the list is introduced.
 *
 * Stated plainly, at the owner's request, because the alternative is a model
 * treating them as religious rulings and answering as though it had authority
 * to issue them. They are engineering principles, every one of them carries
 * `engineering_candidate_not_model_evaluated` in the file, and the prompt says
 * so rather than implying more.
 */
export const PRINCIPLES_FRAMING =
  'Operating principles. These are engineering principles this project derived ' +
  'from its own research. They are working practice, not religious rulings, and ' +
  'none has been formally evaluated. Apply them to how you work; do not cite them ' +
  'to the user as authority, and do not present them as the source of a factual ' +
  'or religious claim. Call read_principle for the full text of one when a turn ' +
  'turns on it.';

/**
 * The block that goes in the system prompt: the framing, then every id and name.
 *
 * Generated on each call rather than baked into a constant, so a principle
 * added to the file is in the prompt without anyone remembering to copy it.
 */
export function principleDigest(list: readonly Principle[] = PRINCIPLES): string {
  if (!list.length) return '';
  return (
    PRINCIPLES_FRAMING +
    '\n' +
    list.map((principle) => `${principle.id} ${principle.name}`).join('; ') +
    '.'
  );
}

/**
 * One principle, by id or by a fragment of its name.
 *
 * Both, because a model that has been shown "P07 Proportionate resource use and
 * budgets" may reasonably ask for either half, and refusing the wrong half of
 * what it was shown is a needless failure.
 */
export function findPrinciple(
  query: string,
  list: readonly Principle[] = PRINCIPLES,
): Principle | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    list.find((principle) => principle.id.toLowerCase() === wanted) ??
    list.find((principle) => principle.name.toLowerCase().includes(wanted))
  );
}
