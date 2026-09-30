import { z } from 'zod';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { redeemCheck } from '@/lib/billing/beta';
import { betaStore } from '@/lib/billing/beta-server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const bodySchema = z.object({
  code: z.string().min(1).max(64),
  cohort: z.string().min(1).max(64).optional(),
});

const REASON_MESSAGE: Record<string, string> = {
  not_issued: 'That code is not a live invite (it was revoked or never issued).',
  expired: 'That invite code has expired. Ask the owner for a fresh one.',
  already_redeemed: 'That invite code has already been used. Codes are single-use.',
  wrong_cohort: 'That code belongs to a different beta cohort.',
};

/**
 * Redeem an invite code into the beta cohort.
 *
 * The code is single-use: the redeem write only lands on an `issued` row, so
 * racing two redeems still grants one. Redemption registers the person in the
 * cohort — it does not grant a tier; the trial is what moves them to managed.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: 'The request needs an invite code.' }, { status: 400, headers });
  }

  const store = betaStore();
  const invite = store.inviteByCode(parsed.code.trim());
  if (!invite)
    return Response.json({ error: 'No invite matches that code.' }, { status: 404, headers });

  const check = redeemCheck(invite, { cohort: parsed.cohort });
  if (!check.ok)
    return Response.json(
      {
        error: REASON_MESSAGE[check.reason] ?? 'That code cannot be redeemed.',
        reason: check.reason,
      },
      { status: 400, headers },
    );

  // The atomic write: `redeemInvite` only flips `issued` rows, so a double
  // redeem — same person twice, or two people racing one code — fails here
  // even if both passed the check above.
  const redeemed = store.redeemInvite(invite.code, user.userId);
  if (!redeemed)
    return Response.json(
      {
        error: 'That invite code has already been used. Codes are single-use.',
        reason: 'already_redeemed',
      },
      { status: 409, headers },
    );

  return Response.json(
    {
      ok: true,
      cohort: invite.cohort,
      email: invite.email,
      message:
        'Welcome to the beta cohort. Start the 14-day trial whenever you are ready — nothing is charged, ever, while billing is a stub.',
    },
    { headers },
  );
}
