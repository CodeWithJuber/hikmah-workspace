/** What a given person may do, decided in one place.
 *
 * Every question the run route has to answer about money or blast radius goes
 * through here: may this run fall back to the deployment's own provider key,
 * may it reach a machine, and how much of the deployment's budget has it spent
 * this month. Scattering those checks is how one of them ends up missing.
 *
 * Pure over its inputs and importing nothing from Next, so the rules can be
 * driven directly by a test rather than through an HTTP round trip.
 */
import { planById, type Tier } from './plans.ts';

export type Entitlements = {
  tier: Tier;
  /** May a run fall back to the deployment's own provider key when the person
   * has saved none of their own. */
  managedKey: boolean;
  /** Tokens a month on that key. Null means no limit. Meaningless when
   * `managedKey` is false: nothing the person runs costs the deployment. */
  monthlyTokenCap: number | null;
  /** May a run reach a machine. */
  execution: boolean;
  /** May a run generate pictures and speech.
   *
   * A paid feature because the plan says so, and because the deployment pays
   * for it: media goes through the same OpenRouter account as a managed run.
   * This *removes* something a free bring-your-own-key user had — the media key
   * was derived from their own provider key, so both tools were quietly theirs
   * — and the Free plan's feature list never promised them, so no copy has to
   * change. The change is real though, and the PR says so rather than letting
   * it be discovered. */
  media: boolean;
  /**
   * Where this person's runs sit in the queue. Higher is claimed first.
   *
   * The plan sells "priority on the run queue" and `claim()` was strict FIFO
   * with no such column, so the sentence was untrue from the day it was
   * written. What it can honestly mean here is bounded and stated on the
   * pricing page: there is one worker and it is busy-gated, so this decides who
   * is claimed *next* and never interrupts a run already streaming.
   */
  queuePriority: number;
};

const OWNER: Entitlements = {
  tier: 'owner',
  managedKey: true,
  monthlyTokenCap: null,
  execution: true,
  media: true,
  // Above the paid tier: the operator's own work should not queue behind a
  // customer's on a deployment with one worker.
  queuePriority: 20,
};

export function entitlementsFor(tier: Tier): Entitlements {
  if (tier === 'owner') return OWNER;
  if (tier === 'managed')
    return {
      tier,
      managedKey: true,
      // From the plan rather than a second constant, so raising the allowance
      // on the pricing page raises the one the route enforces.
      monthlyTokenCap: planById('pro')?.monthlyTokenCap ?? null,
      execution: false,
      media: true,
      queuePriority: 10,
    };
  return {
    tier: 'byok',
    managedKey: false,
    monthlyTokenCap: null,
    execution: false,
    media: false,
    queuePriority: 0,
  };
}

/** Which tier a person is on.
 *
 * The owner is whoever the `kernel_owners` row names — a user id, not an email,
 * so changing HIKMAH_OWNER_EMAIL later cannot hand the deployment to someone
 * else. Before that row exists the configured email stands in, which is the
 * same rule `ownerIdentity` bootstraps with; this read never writes it.
 */
export function resolveTier(input: {
  userId: string;
  email: string;
  /** From `kernel_owners`, or null before the owner has ever signed in. */
  ownerUserId: string | null;
  /** From HIKMAH_OWNER_EMAIL. */
  ownerEmail: string;
  /** From `user_tiers`, or null when the person has never been moved off the
   * default. Absence is the free tier, so a new account needs no backfill. */
  saved: Tier | null;
}): Tier {
  if (input.ownerUserId) {
    if (input.ownerUserId === input.userId) return 'owner';
  } else if (
    input.ownerEmail &&
    input.email.toLowerCase() === input.ownerEmail.trim().toLowerCase()
  ) {
    return 'owner';
  }
  // The owner is never demoted by a stale row, so the saved tier is consulted
  // only after that question is settled.
  return input.saved === 'managed' ? 'managed' : 'byok';
}

/** Whether a run may start, given what the person has already spent.
 *
 * Only a managed run can be refused: a run on the person's own key costs the
 * deployment nothing, so there is nothing to ration.
 */
export function overCap(entitlements: Entitlements, usedThisMonth: number): boolean {
  if (!entitlements.managedKey) return false;
  if (entitlements.monthlyTokenCap === null) return false;
  return usedThisMonth >= entitlements.monthlyTokenCap;
}

/** The first day of the month a timestamp falls in, as an ISO string.
 *
 * Usage is summed from here. UTC deliberately: a cap that moves with the
 * server's local time would reset twice a year.
 */
export function periodStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
