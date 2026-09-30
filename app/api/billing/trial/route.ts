import { z } from 'zod';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { billingStore } from '@/lib/billing/server';
import { betaStore } from '@/lib/billing/beta-server';
import {
  BETA_TRIAL_DAYS,
  cancelTrial,
  expireTrial,
  startTrial,
  trialDaysLeft,
  trialState,
} from '@/lib/billing/beta';
import { planById } from '@/lib/billing/plans';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };

const startSchema = z.object({
  planId: z.string().min(1).max(64).default('pro'),
});

/**
 * The honest 14-day trial.
 *
 * GET returns the person's trial state with days left — the same clock the
 * routes enforce, so the UI cannot show "3 days left" while the API has
 * already expired it. POST starts one trial per person; a trial moves the
 * person to the managed tier while it is active and back to free when it
 * ends, and it NEVER converts to a subscription on its own.
 */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  const store = betaStore();
  const raw = store.activeTrialFor(user.userId);
  if (!raw) return Response.json({ trial: null, is_stub: true }, { headers });

  // The clock is enforced on read: an active row past its end is expired
  // before it is reported, so nothing downstream sees a zombie trial.
  const settled = expireTrial(raw);
  if (settled !== raw) {
    store.saveTrial(settled);
    billingStore().setTier(user.userId, 'byok');
    return Response.json({ trial: { ...settled, state: 'expired' }, is_stub: true }, { headers });
  }
  return Response.json(
    {
      trial: { ...raw, state: trialState(raw), days_left: trialDaysLeft(raw) },
      is_stub: true,
    },
    { headers },
  );
}

/** Start the trial. One active trial per person; 14 days by default. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  let parsed: z.infer<typeof startSchema>;
  try {
    parsed = startSchema.parse(await request.json().catch(() => ({})));
  } catch {
    return Response.json({ error: 'The request was not valid.' }, { status: 400, headers });
  }
  const plan = planById(parsed.planId);
  if (!plan || plan.tier !== 'managed')
    return Response.json({ error: 'Trials are for the paid plan only.' }, { status: 400, headers });

  const store = betaStore();
  const existing = store.activeTrialFor(user.userId);
  if (existing)
    return Response.json(
      { error: 'You already have an active trial.', trial_id: existing.id },
      { status: 409, headers },
    );

  const trial = startTrial({ userId: user.userId, planId: plan.id });
  store.startTrial(trial);
  // The point of the trial is that it works: managed tier while active.
  billingStore().setTier(user.userId, 'managed');
  return Response.json(
    {
      trial: { ...trial, state: 'active', days_left: BETA_TRIAL_DAYS },
      is_stub: true,
      note: `A ${BETA_TRIAL_DAYS}-day trial. It ends on its own — it never converts to a paid plan without your explicit confirmation, and there is no card to charge anyway.`,
    },
    { headers },
  );
}

/** Cancel the active trial: immediate, because a trial bills nothing and has
 * no period to run out. The person lands back on the free tier. */
export async function DELETE() {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json({ error: 'Sign in to your private workspace.' }, { status: 401, headers });

  const store = betaStore();
  const raw = store.activeTrialFor(user.userId);
  if (!raw) return Response.json({ error: 'No active trial to cancel.' }, { status: 404, headers });

  const canceled = cancelTrial(raw);
  if (!canceled)
    return Response.json({ error: 'That trial is already over.' }, { status: 400, headers });
  store.cancelTrial(canceled);
  billingStore().setTier(user.userId, 'byok');
  return Response.json(
    { ok: true, trial: { ...canceled, state: 'canceled' }, is_stub: true },
    { headers },
  );
}
