/** The commercial-beta lifecycle, as pure rules.
 *
 * Invites, trials and stub subscriptions, with no database and no Next
 * imports: the state transitions are asserted directly by
 * tests/billing-beta.test.mjs, and the routes call the same functions so the
 * rules the UI shows are the rules the API enforces.
 *
 * Honesty anchors, because this is the money-shaped surface:
 * - a trial NEVER auto-converts; conversion needs explicit confirmation;
 * - every receipt is $0 and says it is a stub;
 * - an invite code is single-use, cohort-tagged and expiry-dated.
 */
import { randomUUID } from 'node:crypto';

export const BETA_TRIAL_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type InviteStatus = 'issued' | 'redeemed' | 'revoked' | 'expired';

export type BetaInvite = {
  id: string;
  code: string;
  email: string;
  cohort: string;
  status: InviteStatus;
  invited_by: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  created_at: string;
};

export type TrialStatus = 'active' | 'expired' | 'canceled' | 'converted';

export type Trial = {
  id: string;
  user_id: string;
  plan_id: string;
  started_at: string;
  ends_at: string;
  status: TrialStatus;
  converted_to: string | null;
  canceled_at: string | null;
  created_at: string;
};

export type StubSubscriptionStatus = 'active' | 'canceled';

export type StubSubscription = {
  id: string;
  user_id: string;
  plan_id: string;
  status: StubSubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  /** STUB: always 0. No payment provider is connected. */
  amount_cents: 0;
  currency: string;
  last_receipt: string | null;
  created_at: string;
  updated_at: string;
};

/** A code the owner can read over the phone: `beta-` + 12 base-36 chars. */
export function makeInviteCode(): string {
  return 'beta-' + randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

/** Whether the code is already too old to redeem. */
export function inviteExpired(invite: BetaInvite, nowMs = Date.now()): boolean {
  return new Date(invite.expires_at).getTime() <= nowMs;
}

export type RedeemCheck =
  | { ok: true }
  | { ok: false; reason: 'not_issued' | 'expired' | 'already_redeemed' | 'wrong_cohort' };

/** The redeem gate, in one place: single-use, not expired, cohort-tagged. */
export function redeemCheck(
  invite: BetaInvite,
  input: { cohort?: string },
  nowMs = Date.now(),
): RedeemCheck {
  if (invite.status === 'redeemed') return { ok: false, reason: 'already_redeemed' };
  if (invite.status !== 'issued') return { ok: false, reason: 'not_issued' };
  if (inviteExpired(invite, nowMs)) return { ok: false, reason: 'expired' };
  if (input.cohort !== undefined && input.cohort !== invite.cohort)
    return { ok: false, reason: 'wrong_cohort' };
  return { ok: true };
}

/** Start a trial: 14 days by default, honest about what ends and when. */
export function startTrial(input: {
  userId: string;
  planId: string;
  days?: number;
  now?: Date;
}): Trial {
  const now = input.now ?? new Date();
  const days = input.days ?? BETA_TRIAL_DAYS;
  const ends = new Date(now.getTime() + days * DAY_MS);
  const iso = now.toISOString();
  return {
    id: 'trial_' + randomUUID(),
    user_id: input.userId,
    plan_id: input.planId,
    started_at: iso,
    ends_at: ends.toISOString(),
    status: 'active',
    converted_to: null,
    canceled_at: null,
    created_at: iso,
  };
}

/** What the trial is now: terminal states win over the clock, and the clock
 * only ever moves active → expired — never active → converted. */
export function trialState(trial: Trial, nowMs = Date.now()): TrialStatus {
  if (trial.status !== 'active') return trial.status;
  return new Date(trial.ends_at).getTime() <= nowMs ? 'expired' : 'active';
}

/** Whole days left, floored; 0 once ended or terminal. */
export function trialDaysLeft(trial: Trial, nowMs = Date.now()): number {
  if (trialState(trial, nowMs) !== 'active') return 0;
  return Math.max(0, Math.floor((new Date(trial.ends_at).getTime() - nowMs) / DAY_MS));
}

/** The expiry write: active and past the end becomes expired, everything else
 * is left alone — in particular nothing here converts. */
export function expireTrial(trial: Trial, now = new Date()): Trial {
  if (trialState(trial, now.getTime()) !== 'expired') return trial;
  return { ...trial, status: 'expired' };
}

/** Cancel a trial: immediate, because a trial bills nothing and so has no
 * period to run out. Returns null when there is nothing to cancel. */
export function cancelTrial(trial: Trial, now = new Date()): Trial | null {
  if (trial.status !== 'active') return null;
  return { ...trial, status: 'canceled', canceled_at: now.toISOString() };
}

export type ConversionError = 'confirm_required' | 'trial_not_active' | 'trial_already_converted';

/** Trial → stub subscription, on explicit confirmation only.
 *
 * `confirmed` is the person's own tick on the "yes, start the paid plan (test,
 * $0)" agreement — without it this returns an error rather than a row, so no
 * code path can ever "helpfully" convert on their behalf. */
export function convertTrial(
  trial: Trial,
  input: { confirmed: boolean; now?: Date },
): { subscription: StubSubscription } | { error: ConversionError } {
  if (!input.confirmed) return { error: 'confirm_required' };
  if (trial.status === 'converted') return { error: 'trial_already_converted' };
  if (trial.status !== 'active') return { error: 'trial_not_active' };
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const periodEnd = new Date(now.getTime() + 30 * DAY_MS).toISOString();
  return {
    subscription: {
      id: 'stubsub_' + randomUUID(),
      user_id: trial.user_id,
      plan_id: trial.plan_id,
      status: 'active',
      current_period_start: iso,
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      canceled_at: null,
      amount_cents: 0,
      currency: 'usd',
      last_receipt: null,
      created_at: iso,
      updated_at: iso,
    },
  };
}

export type CancelMode = 'immediate' | 'at_period_end';

/** Cancel a stub subscription. `at_period_end` keeps it active until the
 * period ends (the flag the UI renders); `immediate` ends it now. A canceled
 * subscription stays canceled: canceling twice is an error, not a second
 * row. */
export function cancelStubSubscription(
  sub: StubSubscription,
  input: { mode: CancelMode; now?: Date },
): { subscription: StubSubscription } | { error: 'already_canceled' } {
  if (sub.status === 'canceled') return { error: 'already_canceled' };
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  if (input.mode === 'immediate') {
    return {
      subscription: { ...sub, status: 'canceled', canceled_at: iso, updated_at: iso },
    };
  }
  return {
    subscription: { ...sub, cancel_at_period_end: true, updated_at: iso },
  };
}

/** The stub renewal: the period rolls forward 30 days and the receipt is $0,
 * because no money moved. A canceled subscription cannot renew — there is no
 * card on file to retry, stub or otherwise. */
export function renewStubSubscription(
  sub: StubSubscription,
  input: { receipt: string; now?: Date },
): { subscription: StubSubscription } | { error: 'not_active' } {
  if (sub.status !== 'active') return { error: 'not_active' };
  const now = input.now ?? new Date();
  const start = new Date(sub.current_period_end);
  const end = new Date(start.getTime() + 30 * DAY_MS);
  return {
    subscription: {
      ...sub,
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
      cancel_at_period_end: false,
      last_receipt: input.receipt,
      updated_at: now.toISOString(),
    },
  };
}

/** When `cancel_at_period_end` was set, the period end is when access lapses. */
export function subscriptionEffectiveEnd(sub: StubSubscription): string {
  return sub.status === 'canceled'
    ? (sub.canceled_at ?? sub.current_period_end)
    : sub.current_period_end;
}
