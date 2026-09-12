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

/** Tools that reach a machine the deployment owns.
 *
 * The workbench is one container with one /workspace volume shared by every
 * conversation on the deployment (workbench/src/server.ts). With one person
 * that is a feature. With two it is a shared filesystem and a shell handed to
 * whoever signed up last, so these stay with the operator until execution is
 * per-tenant. Named here rather than in the run agent so the list and the
 * reason live together.
 */
export const EXECUTION_TOOLS = ['bash', 'sandbox_run', 'ssh_exec', 'list_ssh_hosts'];

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
};

const OWNER: Entitlements = {
  tier: 'owner',
  managedKey: true,
  monthlyTokenCap: null,
  execution: true,
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
    };
  return { tier: 'byok', managedKey: false, monthlyTokenCap: null, execution: false };
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
