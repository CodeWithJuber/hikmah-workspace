// PR-24 — commercial beta: invite cohort, trial lifecycle, stub subscriptions.
//
// The beta is money-shaped but charges nothing: invites are single-use,
// trials never auto-convert, and every receipt is $0 and says it is a stub.
// These tests pin that: the trial/cancel/renewal scenarios, the redeem gate,
// and the stub provider's honesty.
// Run: node --test tests/billing-beta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySchema } from './schema.mjs';

const dir = await mkdtemp(join(tmpdir(), 'hikmah-billing-beta-'));
await build({
  entryPoints: ['lib/billing/beta.ts', 'lib/billing/beta-store.ts', 'lib/billing/provider-stub.ts'],
  outdir: dir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const beta = await import(pathToFileURL(join(dir, 'beta.mjs')));
const { createBetaStore } = await import(pathToFileURL(join(dir, 'beta-store.mjs')));
const providerStub = await import(pathToFileURL(join(dir, 'provider-stub.mjs')));

const {
  BETA_TRIAL_DAYS,
  DAY_MS,
  makeInviteCode,
  inviteExpired,
  redeemCheck,
  startTrial,
  trialState,
  trialDaysLeft,
  expireTrial,
  cancelTrial,
  convertTrial,
  cancelStubSubscription,
  renewStubSubscription,
  subscriptionEffectiveEnd,
} = beta;
const { StubPaymentProvider, stubReceipt, paymentProvider } = providerStub;

function freshDb(base = '2026-09-30T07:00:00.000Z') {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  // The clock ticks one second per read, so ordering assertions see distinct
  // timestamps the way production rows would.
  let tick = 0;
  return createBetaStore(db, () => new Date(at(base) + tick++ * 1000).toISOString());
}

const at = (iso) => new Date(iso).getTime();

// ---- invite codes ----

test('invite codes are unique and recognizable', () => {
  const codes = new Set(Array.from({ length: 100 }, makeInviteCode));
  assert.equal(codes.size, 100, 'no collisions in 100 codes');
  for (const code of codes) assert.match(code, /^beta-[a-z0-9]{12}$/);
});

test('a valid issued invite redeems', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'Ada@Example.com', invitedBy: 'owner-1' });
  assert.equal(invite.email, 'ada@example.com', 'emails are normalized on the way in');
  assert.equal(invite.status, 'issued');
  assert.equal(invite.cohort, 'beta-1', 'the default cohort');
  // Check at the store's pinned clock, not the wall clock, or the invite
  // "expires" 30 days after the fixed base date and the test rots.
  assert.deepEqual(redeemCheck(invite, {}, at(invite.created_at)), { ok: true });
  assert.equal(store.redeemInvite(invite.code, 'user-1'), true);
  assert.equal(store.inviteByCode(invite.code).status, 'redeemed');
});

test('double redeem fails: the code is single-use', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1' });
  assert.equal(store.redeemInvite(invite.code, 'user-1'), true);
  assert.equal(store.redeemInvite(invite.code, 'user-2'), false, 'second redeem matches zero rows');
  const reread = store.inviteByCode(invite.code);
  assert.deepEqual(redeemCheck(reread, {}), { ok: false, reason: 'already_redeemed' });
});

test('an expired invite does not redeem', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1', ttlDays: 1 });
  const after = at(invite.expires_at) + DAY_MS;
  assert.equal(inviteExpired(invite, after), true);
  assert.deepEqual(redeemCheck(invite, {}, after), { ok: false, reason: 'expired' });
  assert.equal(
    inviteExpired(invite, at(invite.created_at)),
    false,
    'fresh invites are not expired',
  );
});

test('a revoked invite does not redeem', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1' });
  assert.equal(store.revokeInvite(invite.code), true);
  const reread = store.inviteByCode(invite.code);
  assert.equal(reread.status, 'revoked');
  assert.deepEqual(redeemCheck(reread, {}), { ok: false, reason: 'not_issued' });
});

test('the wrong cohort does not redeem', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1', cohort: 'beta-2' });
  const now = at(invite.created_at);
  assert.deepEqual(redeemCheck(invite, { cohort: 'beta-1' }, now), {
    ok: false,
    reason: 'wrong_cohort',
  });
  assert.deepEqual(redeemCheck(invite, { cohort: 'beta-2' }, now), { ok: true });
  assert.deepEqual(
    redeemCheck(invite, {}, now),
    { ok: true },
    'no cohort asked, no cohort checked',
  );
});

test('an unknown code is not an invite', () => {
  const store = freshDb();
  assert.equal(store.inviteByCode('beta-000000000000'), null);
  assert.equal(store.redeemInvite('beta-000000000000', 'user-1'), false);
});

test('the owner can list the cohort, newest first', () => {
  const store = freshDb();
  store.createInvite({ email: 'one@x.test', invitedBy: 'owner-1' });
  store.createInvite({ email: 'two@x.test', invitedBy: 'owner-1', cohort: 'beta-2' });
  const listed = store.listInvites();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].email, 'two@x.test');
  assert.equal(listed[1].cohort, 'beta-1');
});

// ---- trial lifecycle ----

test('a trial starts at 14 days by default, honest about the end', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  assert.equal(trial.status, 'active');
  assert.equal(trial.ends_at, '2026-10-14T07:00:00.000Z');
  assert.equal(trialDaysLeft(trial, at('2026-09-30T07:00:00Z')), BETA_TRIAL_DAYS);
  assert.equal(BETA_TRIAL_DAYS, 14);
});

test('trial days count down and hit zero at the end', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  assert.equal(trialDaysLeft(trial, at('2026-10-07T07:00:00Z')), 7);
  assert.equal(trialDaysLeft(trial, at('2026-10-14T07:00:00Z')), 0);
  assert.equal(trialState(trial, at('2026-10-14T07:00:00Z')), 'expired');
  assert.equal(trialState(trial, at('2026-10-13T23:59:59Z')), 'active');
});

test('expiry never converts: the trial just ends', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  const expired = expireTrial(trial, new Date('2026-10-15T07:00:00Z'));
  assert.equal(expired.status, 'expired');
  assert.equal(expired.converted_to, null, 'no subscription id: nothing converted');
  // An active trial is untouched by the expiry pass.
  assert.equal(expireTrial(trial, new Date('2026-10-01T07:00:00Z')), trial);
});

test('canceling a trial is immediate and lands nowhere paid', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  const canceled = cancelTrial(trial, new Date('2026-10-02T07:00:00Z'));
  assert.ok(canceled);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceledDaysLeft(canceled), 0);
  assert.equal(cancelTrial(canceled), null, 'a dead trial cannot be canceled again');

  function canceledDaysLeft(t) {
    return trialDaysLeft(t, at('2026-10-02T07:00:00Z'));
  }
});

test('terminal states win over the clock', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  const canceled = cancelTrial(trial, new Date('2026-10-01T07:00:00Z'));
  assert.ok(canceled);
  assert.equal(
    trialState(canceled, at('2026-11-01T07:00:00Z')),
    'canceled',
    'not resurrected as expired',
  );
});

test('one active trial per person in the store', () => {
  const store = freshDb();
  store.startTrial(startTrial({ userId: 'u1', planId: 'pro' }));
  const active = store.activeTrialFor('u1');
  assert.ok(active);
  assert.equal(active.status, 'active');
  assert.equal(store.activeTrialFor('nobody'), null);
  assert.equal(store.trialsFor('u1').length, 1);
});

test('the store persists trial transitions', () => {
  const store = freshDb();
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  store.startTrial(trial);
  const canceled = cancelTrial(store.trialById(trial.id), new Date('2026-10-02T07:00:00Z'));
  assert.ok(canceled);
  store.saveTrial(canceled);
  assert.equal(store.trialById(trial.id).status, 'canceled');
  assert.equal(store.activeTrialFor('u1'), null, 'a canceled trial is not active');
});

// ---- conversion: explicit confirmation only ----

test('conversion without confirmation is refused', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro' });
  const result = convertTrial(trial, { confirmed: false });
  assert.deepEqual(result, { error: 'confirm_required' });
});

test('an expired or canceled trial cannot convert', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  const expired = expireTrial(trial, new Date('2026-10-15T07:00:00Z'));
  assert.deepEqual(convertTrial(expired, { confirmed: true }), { error: 'trial_not_active' });
  const canceled = cancelTrial(trial, new Date('2026-10-01T07:00:00Z'));
  assert.ok(canceled);
  assert.deepEqual(convertTrial(canceled, { confirmed: true }), { error: 'trial_not_active' });
});

test('a confirmed conversion writes a $0 stub subscription', () => {
  const store = freshDb();
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  store.startTrial(trial);
  const result = convertTrial(trial, { confirmed: true, now: new Date('2026-10-01T07:00:00Z') });
  assert.ok(!('error' in result));
  const sub = result.subscription;
  assert.equal(sub.user_id, 'u1');
  assert.equal(sub.plan_id, 'pro');
  assert.equal(sub.status, 'active');
  assert.equal(sub.amount_cents, 0, 'the stub never carries an amount');
  assert.equal(sub.current_period_start, '2026-10-01T07:00:00.000Z');
  assert.equal(sub.current_period_end, '2026-10-31T07:00:00.000Z', '30-day stub periods');
  store.createSubscription(sub);
  store.markConverted(trial.id, sub.id);
  assert.equal(store.trialById(trial.id).status, 'converted');
  assert.equal(store.trialById(trial.id).converted_to, sub.id);
  assert.equal(store.latestSubscriptionFor('u1').id, sub.id);
});

test('a converted trial cannot convert twice', () => {
  const trial = startTrial({ userId: 'u1', planId: 'pro' });
  const first = convertTrial(trial, { confirmed: true });
  assert.ok(!('error' in first));
  const again = convertTrial({ ...trial, status: 'converted' }, { confirmed: true });
  assert.deepEqual(again, { error: 'trial_already_converted' });
});

// ---- cancel: immediate vs at period end ----

function activeSubscription(now = new Date('2026-10-01T07:00:00Z')) {
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  const result = convertTrial(trial, { confirmed: true, now });
  assert.ok(!('error' in result));
  return result.subscription;
}

test('cancel at period end keeps access until the period ends', () => {
  const sub = activeSubscription();
  const result = cancelStubSubscription(sub, {
    mode: 'at_period_end',
    now: new Date('2026-10-10T07:00:00Z'),
  });
  assert.ok(!('error' in result));
  const next = result.subscription;
  assert.equal(next.status, 'active', 'still active: the flag is the cancellation');
  assert.equal(next.cancel_at_period_end, true);
  assert.equal(subscriptionEffectiveEnd(next), '2026-10-31T07:00:00.000Z');
  assert.equal(next.canceled_at, null, 'no end date yet');
});

test('immediate cancel ends the subscription now', () => {
  const sub = activeSubscription();
  const result = cancelStubSubscription(sub, {
    mode: 'immediate',
    now: new Date('2026-10-10T07:00:00Z'),
  });
  assert.ok(!('error' in result));
  const next = result.subscription;
  assert.equal(next.status, 'canceled');
  assert.equal(next.canceled_at, '2026-10-10T07:00:00.000Z');
  assert.equal(subscriptionEffectiveEnd(next), '2026-10-10T07:00:00.000Z');
});

test('canceling a canceled subscription is an error, not a second row', () => {
  const sub = activeSubscription();
  const first = cancelStubSubscription(sub, { mode: 'immediate' });
  assert.ok(!('error' in first));
  assert.deepEqual(cancelStubSubscription(first.subscription, { mode: 'immediate' }), {
    error: 'already_canceled',
  });
});

test('the store round-trips subscription transitions', () => {
  const store = freshDb();
  const sub = activeSubscription();
  store.createSubscription(sub);
  const flagged = cancelStubSubscription(store.subscriptionById(sub.id), { mode: 'at_period_end' });
  assert.ok(!('error' in flagged));
  store.saveSubscription(flagged.subscription);
  const reread = store.subscriptionById(sub.id);
  assert.equal(reread.cancel_at_period_end, true);
  assert.equal(reread.status, 'active');
});

// ---- renewal: the stub scenario ----

test('a stub renewal rolls the period forward 30 days at $0', () => {
  const store = freshDb();
  const sub = activeSubscription();
  store.createSubscription(sub);
  const receipt = stubReceipt('renew', { userId: 'u1', planId: 'pro' });
  const renewed = renewStubSubscription(sub, { receipt: receipt.receipt_id });
  assert.ok(!('error' in renewed));
  const next = renewed.subscription;
  assert.equal(
    next.current_period_start,
    '2026-10-31T07:00:00.000Z',
    'starts where the old period ended',
  );
  assert.equal(next.current_period_end, '2026-11-30T07:00:00.000Z');
  assert.equal(next.last_receipt, receipt.receipt_id);
  assert.equal(next.amount_cents, 0);
  assert.equal(next.cancel_at_period_end, false, 'a renewal clears a pending cancel flag');
  store.saveSubscription(next);
  assert.equal(store.subscriptionById(sub.id).current_period_end, '2026-11-30T07:00:00.000Z');
});

test('a canceled subscription cannot renew', () => {
  const sub = activeSubscription();
  const canceled = cancelStubSubscription(sub, { mode: 'immediate' });
  assert.ok(!('error' in canceled));
  assert.deepEqual(renewStubSubscription(canceled.subscription, { receipt: 'stub_x' }), {
    error: 'not_active',
  });
});

// ---- the stub provider: honest receipts ----

test('the stub provider is a stub and says so on every receipt', async () => {
  const logged = [];
  const provider = new StubPaymentProvider((message) => logged.push(message));
  assert.equal(provider.name, 'stub');
  assert.equal(provider.isStub, true);

  const created = await provider.createSubscription({
    userId: 'u1',
    planId: 'pro',
    confirmed: true,
  });
  assert.equal(created.provider, 'stub');
  assert.equal(created.action, 'create');
  assert.equal(created.amount_cents, 0);
  assert.equal(created.currency, 'usd');
  assert.match(created.receipt_id, /^stub_/);
  assert.match(created.note, /no charge/i);
  assert.ok(
    logged.some((m) => m.includes('STUB: no charge')),
    'every method logs STUB: no charge',
  );

  const canceled = await provider.cancelSubscription({
    userId: 'u1',
    subscriptionId: 'stubsub_x',
    mode: 'at_period_end',
  });
  assert.equal(canceled.action, 'cancel');
  assert.equal(canceled.amount_cents, 0);

  const renewed = await provider.renewSubscription({ userId: 'u1', subscriptionId: 'stubsub_x' });
  assert.equal(renewed.action, 'renew');
  assert.equal(renewed.amount_cents, 0);
  assert.equal(logged.length, 3, 'one STUB log per money-shaped call');
});

test('the stub refuses to create a subscription without confirmation', async () => {
  const provider = new StubPaymentProvider(() => {});
  await assert.rejects(
    provider.createSubscription({ userId: 'u1', planId: 'pro', confirmed: false }),
    /without explicit confirmation/,
  );
});

test('stub receipts are unique test receipts', () => {
  const ids = new Set(
    Array.from(
      { length: 50 },
      () => stubReceipt('create', { userId: 'u', planId: 'pro' }).receipt_id,
    ),
  );
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^stub_[a-f0-9]{16}$/);
});

test('paymentProvider() hands out the stub', async () => {
  const provider = paymentProvider(() => {});
  assert.equal(provider.isStub, true);
  const receipt = await provider.createSubscription({
    userId: 'u1',
    planId: 'pro',
    confirmed: true,
  });
  assert.equal(receipt.amount_cents, 0);
  assert.match(receipt.note, /STUB/);
});

// ---- the honest offer shape ----

test('every stub subscription row carries $0: the money fields cannot drift', () => {
  const store = freshDb();
  const sub = activeSubscription();
  store.createSubscription(sub);
  const reread = store.latestSubscriptionFor('u1');
  assert.equal(reread.amount_cents, 0);
  assert.equal(reread.currency, 'usd');
});

test('invite expiry is read off the stored row, not recomputed optimistically', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1', ttlDays: 30 });
  const stored = store.inviteByCode(invite.code);
  const expected = new Date(at(invite.created_at) + 30 * DAY_MS).toISOString();
  assert.equal(stored.expires_at, expected);
  assert.equal(inviteExpired(stored, at(expected) - 1), false);
  assert.equal(inviteExpired(stored, at(expected)), true, 'expiry is inclusive at the boundary');
});

test('a trial can be shorter or longer than the 14-day default', () => {
  const short = startTrial({
    userId: 'u1',
    planId: 'pro',
    days: 7,
    now: new Date('2026-09-30T07:00:00Z'),
  });
  assert.equal(short.ends_at, '2026-10-07T07:00:00.000Z');
  assert.equal(trialDaysLeft(short, at('2026-09-30T07:00:00Z')), 7);
});

test('revoking an unknown code is a no-op, not an error', () => {
  const store = freshDb();
  assert.equal(store.revokeInvite('beta-000000000000'), false);
  assert.equal(store.trialById('trial_nope'), null);
});

test('invite listing paginates for the owner', () => {
  const store = freshDb();
  for (let i = 0; i < 5; i++) store.createInvite({ email: `u${i}@x.test`, invitedBy: 'owner-1' });
  assert.equal(store.listInvites(2, 0).length, 2);
  assert.equal(store.listInvites(2, 2).length, 2);
  assert.equal(store.listInvites(2, 4).length, 1);
});

test('the expiry pass leaves converted trials alone', () => {
  const store = freshDb();
  const trial = startTrial({ userId: 'u1', planId: 'pro', now: new Date('2026-09-30T07:00:00Z') });
  store.startTrial(trial);
  const result = convertTrial(trial, { confirmed: true, now: new Date('2026-10-01T07:00:00Z') });
  assert.ok(!('error' in result));
  store.createSubscription(result.subscription);
  store.markConverted(trial.id, result.subscription.id);
  const converted = store.trialById(trial.id);
  const after = expireTrial(converted, new Date('2026-12-01T07:00:00Z'));
  assert.equal(after.status, 'converted', 'long past the trial end, still converted');
  assert.equal(trialState(after, at('2026-12-01T07:00:00Z')), 'converted');
});

test("conversion keeps the trial's person and plan on the subscription", () => {
  const trial = startTrial({ userId: 'person-9', planId: 'pro' });
  const result = convertTrial(trial, { confirmed: true });
  assert.ok(!('error' in result));
  assert.equal(result.subscription.user_id, 'person-9');
  assert.equal(result.subscription.plan_id, 'pro');
});

test('a canceled subscription without a cancel timestamp falls back to the period end', () => {
  const sub = { ...activeSubscription(), status: 'canceled', canceled_at: null };
  assert.equal(subscriptionEffectiveEnd(sub), sub.current_period_end);
});

test('the cancel receipt names the stub too', async () => {
  const provider = new StubPaymentProvider(() => {});
  const receipt = await provider.cancelSubscription({
    userId: 'u1',
    subscriptionId: 'stubsub_x',
    mode: 'immediate',
  });
  assert.equal(receipt.amount_cents, 0);
  assert.match(receipt.note, /STUB.*no charge/i);
});

test('invites default to a 30-day life', () => {
  const store = freshDb();
  const invite = store.createInvite({ email: 'a@x.test', invitedBy: 'owner-1' });
  const expected = new Date(at(invite.created_at) + 30 * DAY_MS).toISOString();
  assert.equal(invite.expires_at, expected);
});
