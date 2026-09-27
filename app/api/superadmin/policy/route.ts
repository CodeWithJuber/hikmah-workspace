import { getStorage } from '@/server/storage.mjs';
import { createWorkflowStore } from '@/lib/workflow/store';
import { ownerIdentity } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

/** The v5 workflow policy's learned state, for the superadmin policy-inspection
 * tab. Owner only: the A_a diagonals and propensity log are the deployment's
 * own learning, not the person's data — but they are shown only to the owner
 * regardless.
 *
 * Honesty contract: A_a diagonals are sufficient statistics of observed
 * feedback, and the propensity log replays what the policy actually scored.
 * Nothing here is P(correct).
 */
export async function GET() {
  await ownerIdentity();
  const store = createWorkflowStore(getStorage().raw);
  const policy = store.loadPolicyState();
  const arms: Record<string, { aDiag: number[]; b: number[] }> = {};
  for (const [arm, stats] of Object.entries(policy.arms)) {
    arms[arm] = {
      // The A_a diagonal. The prior is λ=1 on the diagonal, so a diagonal
      // above 1.0 is observed feedback; exactly 1.0 is "no updates yet".
      aDiag: stats.A.map((row, i) => row[i] ?? 0),
      b: [...stats.b],
    };
  }
  return Response.json(
    {
      version: policy.version,
      arms,
      recentUpdates: store.recentUpdates(25),
      recentPropensities: store.recentPropensities(25),
    },
    { headers },
  );
}
