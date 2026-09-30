import { z } from 'zod';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { entitlementsForUser } from '@/lib/billing/server';
import { betaStore } from '@/lib/billing/beta-server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

async function requireOwner() {
  const user = await getChatGPTUser();
  if (!user) return { error: 'Sign in to your private workspace.', status: 401 as const };
  if (entitlementsForUser(user).tier !== 'owner')
    return { error: 'Only the workspace owner can manage beta invites.', status: 403 as const };
  return { user };
}

/**
 * The controlled cohort.
 *
 * The owner creates single-use, cohort-tagged, expiry-dated invite codes and
 * delivers them out-of-band — by hand, in a chat, however they like. This
 * deployment sends no invite email: the row records the invitation, it does
 * not deliver it. That is the honest boundary: delivery is the owner's action,
 * reported here, never implemented.
 */

/** The owner's invite ledger: newest first. */
export async function GET() {
  const auth = await requireOwner();
  if ('error' in auth)
    return Response.json({ error: auth.error }, { status: auth.status, headers });
  return Response.json({ invites: betaStore().listInvites(100) }, { headers });
}

const bodySchema = z.object({
  email: z.string().email().max(320),
  cohort: z.string().min(1).max(64).optional(),
  ttlDays: z.number().int().min(1).max(365).optional(),
});

/** Mint one invite code. The response carries the code for the owner to send
 * themselves — nothing leaves this deployment. */
export async function POST(request: Request) {
  const auth = await requireOwner();
  if ('error' in auth)
    return Response.json({ error: auth.error }, { status: auth.status, headers });

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: 'The invite needs an email address.' }, { status: 400, headers });
  }

  const invite = betaStore().createInvite({
    email: parsed.email,
    cohort: parsed.cohort,
    invitedBy: auth.user.userId,
    ttlDays: parsed.ttlDays,
  });
  return Response.json(
    {
      code: invite.code,
      email: invite.email,
      cohort: invite.cohort,
      expires_at: invite.expires_at,
      // Said out loud, because "the code is created" is easily misread as
      // "the invite was sent": it was not. The owner sends it themselves.
      delivered: false,
      delivery: 'out_of_band',
      delivery_note:
        'No email was sent. Share this code with the person yourself — this record only proves the code exists.',
    },
    { headers },
  );
}
