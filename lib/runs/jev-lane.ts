/** Jev preflight lane routing for the run pipeline.
 *
 * TypeSafe System One is asked, per run, which execution lane is safest for
 * the person's task: `clarify` | `standard` | `deep-research`. The answer is a
 * typed proposal, never a verdict:
 *
 * - Jev is unreachable, slow, or keyless → `systemOne` returns null and the
 *   run proceeds exactly as it would have without this module. Jev proposes,
 *   it never blocks.
 * - Deterministic gates still apply after the proposal: `clarify` only lands
 *   when the run can actually ask (an unattended run has no `ask_user`, so it
 *   falls back to standard), and `deep-research` only switches on the existing
 *   `deepResearch` option — the composer's per-turn switch and
 *   `disabledTools` keep working as before.
 */
import { systemOne } from '../integrations/jev-client.ts';

export type JevLane = 'clarify' | 'standard' | 'deep-research';

/** The one question the preflight asks, shared with the /api/agentic/jev route. */
const LANE_QUESTION: { id: string; type: 'choice'; prompt: string; options: string[] } = {
  id: 'route',
  type: 'choice',
  prompt: 'Choose the safest execution lane.',
  options: ['clarify', 'standard', 'deep-research'],
};

const isLane = (value: unknown): value is JevLane =>
  value === 'clarify' || value === 'standard' || value === 'deep-research';

export type JevLaneOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/** Ask Jev for the safest lane for this task. Null when Jev cannot answer. */
export async function jevLane(task: string, options: JevLaneOptions = {}): Promise<JevLane | null> {
  const trimmed = task.trim().slice(0, 8_000);
  if (!trimmed) return null;
  try {
    const decision = await systemOne(
      { task: trimmed, gate: 'preflight' },
      [LANE_QUESTION],
      options,
    );
    const lane = decision?.answers.find((answer) => answer.id === 'route')?.value;
    return isLane(lane) ? lane : null;
  } catch {
    return null;
  }
}

/** Guidance prepended when Jev proposes the clarify lane. The `ask_user`
 * tool does the asking — this only tells the model to ask before acting. */
const CLARIFY_GUIDANCE =
  "Jev's preflight routing flags this request as ambiguous: before acting, ask the person one clarifying question with the ask_user tool, then proceed with their answer.";

export type LaneRouting = { instructions: string; deepResearch: boolean };

/** Map a Jev lane onto the existing run options. Null (or standard) leaves the
 * base untouched — the run behaves exactly as it did before the preflight. */
export function applyJevLane(
  base: LaneRouting,
  lane: JevLane | null,
  opts: { unattended: boolean },
): LaneRouting {
  if (lane === 'clarify' && !opts.unattended)
    return {
      instructions: `${CLARIFY_GUIDANCE}\n\n${base.instructions}`,
      deepResearch: base.deepResearch,
    };
  if (lane === 'deep-research') return { instructions: base.instructions, deepResearch: true };
  return base;
}
