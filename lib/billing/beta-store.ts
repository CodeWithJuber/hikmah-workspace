/** Beta invites, trials and stub subscriptions, over the raw sqlite handle.
 *
 * Same shape and the same reasons as lib/billing/store.ts: prepared once, no
 * Next imports, so a test can drive it without a server. The state-transition
 * rules live in ./beta.ts; this file only persists their outcomes.
 */
import { makeInviteCode, type BetaInvite, type StubSubscription, type Trial } from './beta.ts';
import type { SqliteHandle } from '../runs/store.ts';

export function createBetaStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    insertInvite: db.prepare(
      `INSERT INTO beta_invites
         (id, code, email, cohort, status, invited_by, expires_at, redeemed_at, redeemed_by, created_at)
       VALUES (?, ?, ?, ?, 'issued', ?, ?, NULL, NULL, ?)`,
    ),
    inviteByCode: db.prepare('SELECT * FROM beta_invites WHERE code = ?'),
    listInvites: db.prepare('SELECT * FROM beta_invites ORDER BY created_at DESC LIMIT ? OFFSET ?'),
    // Single-use is enforced by the write itself: only an `issued` row moves
    // to `redeemed`, so a double redeem matches zero rows and fails.
    redeemInvite: db.prepare(
      `UPDATE beta_invites SET status = 'redeemed', redeemed_at = ?, redeemed_by = ?
       WHERE code = ? AND status = 'issued'`,
    ),
    revokeInvite: db.prepare(
      `UPDATE beta_invites SET status = 'revoked' WHERE code = ? AND status = 'issued'`,
    ),
    insertTrial: db.prepare(
      `INSERT INTO trials
         (id, user_id, plan_id, started_at, ends_at, status, converted_to, canceled_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?)`,
    ),
    trialById: db.prepare('SELECT * FROM trials WHERE id = ?'),
    activeTrialFor: db.prepare(
      `SELECT * FROM trials WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
    ),
    trialsFor: db.prepare('SELECT * FROM trials WHERE user_id = ? ORDER BY started_at DESC'),
    updateTrialStatus: db.prepare('UPDATE trials SET status = ? WHERE id = ?'),
    cancelTrial: db.prepare('UPDATE trials SET status = ?, canceled_at = ? WHERE id = ?'),
    markConverted: db.prepare('UPDATE trials SET status = ?, converted_to = ? WHERE id = ?'),
    insertSubscription: db.prepare(
      `INSERT INTO subscriptions_stub
         (id, user_id, plan_id, status, current_period_start, current_period_end,
          cancel_at_period_end, canceled_at, amount_cents, currency, last_receipt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'usd', ?, ?, ?)`,
    ),
    subscriptionById: db.prepare('SELECT * FROM subscriptions_stub WHERE id = ?'),
    latestSubscriptionFor: db.prepare(
      `SELECT * FROM subscriptions_stub WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    subscriptionsFor: db.prepare(
      'SELECT * FROM subscriptions_stub WHERE user_id = ? ORDER BY created_at DESC',
    ),
    updateSubscription: db.prepare(
      `UPDATE subscriptions_stub
       SET status = ?, current_period_start = ?, current_period_end = ?,
           cancel_at_period_end = ?, canceled_at = ?, last_receipt = ?, updated_at = ?
       WHERE id = ?`,
    ),
  };

  const rowToTrial = (row: Record<string, unknown>): Trial => ({
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    started_at: String(row.started_at),
    ends_at: String(row.ends_at),
    status: row.status as Trial['status'],
    converted_to: (row.converted_to as string) ?? null,
    canceled_at: (row.canceled_at as string) ?? null,
    created_at: String(row.created_at),
  });

  const rowToSubscription = (row: Record<string, unknown>): StubSubscription => ({
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    status: row.status as StubSubscription['status'],
    current_period_start: String(row.current_period_start),
    current_period_end: String(row.current_period_end),
    cancel_at_period_end: Number(row.cancel_at_period_end) === 1,
    canceled_at: (row.canceled_at as string) ?? null,
    amount_cents: 0,
    currency: String(row.currency ?? 'usd'),
    last_receipt: (row.last_receipt as string) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  });

  return {
    /** The owner creates a code and delivers it out-of-band. This deployment
     * sends no email: the row records the invitation, it does not deliver it. */
    createInvite(input: {
      email: string;
      cohort?: string;
      invitedBy: string;
      ttlDays?: number;
    }): BetaInvite {
      const created = now();
      const expires = new Date(
        new Date(created).getTime() + (input.ttlDays ?? 30) * 24 * 60 * 60 * 1000,
      ).toISOString();
      const invite: BetaInvite = {
        id: 'binv_' + makeInviteCode().slice(5),
        code: makeInviteCode(),
        email: input.email.trim().toLowerCase(),
        cohort: input.cohort?.trim() || 'beta-1',
        status: 'issued',
        invited_by: input.invitedBy,
        expires_at: expires,
        redeemed_at: null,
        redeemed_by: null,
        created_at: created,
      };
      statements.insertInvite.run(
        invite.id,
        invite.code,
        invite.email,
        invite.cohort,
        invite.invited_by,
        invite.expires_at,
        invite.created_at,
      );
      return invite;
    },

    inviteByCode(code: string): BetaInvite | null {
      const row = statements.inviteByCode.get(code) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        code: String(row.code),
        email: String(row.email),
        cohort: String(row.cohort),
        status: row.status as BetaInvite['status'],
        invited_by: String(row.invited_by),
        expires_at: String(row.expires_at),
        redeemed_at: (row.redeemed_at as string) ?? null,
        redeemed_by: (row.redeemed_by as string) ?? null,
        created_at: String(row.created_at),
      };
    },

    /** Owner view: newest first. */
    listInvites(limit = 50, offset = 0): BetaInvite[] {
      return (statements.listInvites.all(limit, offset) as Record<string, unknown>[]).map(
        (row) =>
          ({
            id: String(row.id),
            code: String(row.code),
            email: String(row.email),
            cohort: String(row.cohort),
            status: row.status,
            invited_by: String(row.invited_by),
            expires_at: String(row.expires_at),
            redeemed_at: (row.redeemed_at as string) ?? null,
            redeemed_by: (row.redeemed_by as string) ?? null,
            created_at: String(row.created_at),
          }) as BetaInvite,
      );
    },

    /** Redeem a code: returns true when the row moved issued → redeemed, false
     * when the code was unknown, already used, or revoked. */
    redeemInvite(code: string, userId: string): boolean {
      const result = statements.redeemInvite.run(now(), userId, code) as {
        changes: number | bigint;
      };
      return Number(result.changes) === 1;
    },

    revokeInvite(code: string): boolean {
      const result = statements.revokeInvite.run(code) as { changes: number | bigint };
      return Number(result.changes) === 1;
    },

    startTrial(trial: Trial): void {
      statements.insertTrial.run(
        trial.id,
        trial.user_id,
        trial.plan_id,
        trial.started_at,
        trial.ends_at,
        trial.created_at,
      );
    },

    trialById(id: string): Trial | null {
      const row = statements.trialById.get(id) as Record<string, unknown> | undefined;
      return row ? rowToTrial(row) : null;
    },

    /** The person's live trial, or null. One active trial per person: the
     * route refuses a second while one is active. */
    activeTrialFor(userId: string): Trial | null {
      const row = statements.activeTrialFor.get(userId) as Record<string, unknown> | undefined;
      return row ? rowToTrial(row) : null;
    },

    trialsFor(userId: string): Trial[] {
      return (statements.trialsFor.all(userId) as Record<string, unknown>[]).map(rowToTrial);
    },

    /** Persist a transitioned trial: the status plus whichever companion field
     * the new status needs. One write per transition, not two. */
    saveTrial(trial: Trial): void {
      if (trial.status === 'canceled') {
        statements.cancelTrial.run(trial.status, trial.canceled_at ?? now(), trial.id);
      } else if (trial.status === 'converted' && trial.converted_to) {
        statements.markConverted.run(trial.status, trial.converted_to, trial.id);
      } else {
        statements.updateTrialStatus.run(trial.status, trial.id);
      }
    },

    cancelTrial(trial: Trial): void {
      statements.cancelTrial.run('canceled', trial.canceled_at ?? now(), trial.id);
    },

    markConverted(trialId: string, subscriptionId: string): void {
      statements.markConverted.run('converted', subscriptionId, trialId);
    },

    createSubscription(sub: StubSubscription): void {
      statements.insertSubscription.run(
        sub.id,
        sub.user_id,
        sub.plan_id,
        sub.status,
        sub.current_period_start,
        sub.current_period_end,
        sub.cancel_at_period_end ? 1 : 0,
        sub.canceled_at,
        sub.last_receipt,
        sub.created_at,
        sub.updated_at,
      );
    },

    subscriptionById(id: string): StubSubscription | null {
      const row = statements.subscriptionById.get(id) as Record<string, unknown> | undefined;
      return row ? rowToSubscription(row) : null;
    },

    latestSubscriptionFor(userId: string): StubSubscription | null {
      const row = statements.latestSubscriptionFor.get(userId) as
        Record<string, unknown> | undefined;
      return row ? rowToSubscription(row) : null;
    },

    saveSubscription(sub: StubSubscription): void {
      statements.updateSubscription.run(
        sub.status,
        sub.current_period_start,
        sub.current_period_end,
        sub.cancel_at_period_end ? 1 : 0,
        sub.canceled_at,
        sub.last_receipt,
        sub.updated_at,
        sub.id,
      );
    },
  };
}

export type BetaStore = ReturnType<typeof createBetaStore>;
