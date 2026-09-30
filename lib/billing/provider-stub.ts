/** The payment-provider interface, and the stub that stands in for it.
 *
 * A real provider (Stripe, Lemon Squeezy, whoever the owner picks later)
 * implements `PaymentProvider`: create a subscription, cancel it, renew it.
 * This deployment has no provider connected, so the stub implements the same
 * interface and does everything except move money. Every method logs
 * "STUB: no charge" and returns an honest test receipt: amount $0, flagged
 * as a stub, never shaped like a real charge.
 *
 * The owner-side action this leaves open — connecting a real provider and
 * implementing this interface against it — is reported, not done here.
 */
import { randomUUID } from 'node:crypto';

export type StubReceipt = {
  receipt_id: string;
  provider: 'stub';
  action: 'create' | 'cancel' | 'renew';
  user_id: string;
  plan_id: string;
  /** STUB: always 0. This is the whole point of the field existing. */
  amount_cents: 0;
  currency: 'usd';
  note: string;
  created_at: string;
};

export type CreateSubscriptionInput = {
  userId: string;
  planId: string;
  /** The explicit confirmation the UI collected before calling. */
  confirmed: boolean;
};

export type CancelSubscriptionInput = {
  userId: string;
  subscriptionId: string;
  mode: 'immediate' | 'at_period_end';
};

export type RenewSubscriptionInput = {
  userId: string;
  subscriptionId: string;
};

export type LogFn = (message: string) => void;

/** What a payment provider must do, so a real one can be slotted in later
 * without the routes or the store changing shape. */
export interface PaymentProvider {
  readonly name: string;
  /** True while no real money can move. The UI and the API both render it. */
  readonly isStub: true;
  createSubscription(input: CreateSubscriptionInput): Promise<StubReceipt>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<StubReceipt>;
  renewSubscription(input: RenewSubscriptionInput): Promise<StubReceipt>;
}

export function stubReceipt(
  action: StubReceipt['action'],
  input: { userId: string; planId: string },
  now = new Date(),
): StubReceipt {
  return {
    receipt_id: 'stub_' + randomUUID().replace(/-/g, '').slice(0, 16),
    provider: 'stub',
    action,
    user_id: input.userId,
    plan_id: input.planId,
    amount_cents: 0,
    currency: 'usd',
    note: 'STUB — no charge. No payment provider is connected to this deployment.',
    created_at: now.toISOString(),
  };
}

/** The stand-in provider. Does everything except move money, and says so. */
export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  readonly isStub = true as const;

  constructor(private log: LogFn = (message) => console.warn(message)) {}

  async createSubscription(input: CreateSubscriptionInput): Promise<StubReceipt> {
    if (!input.confirmed)
      throw new Error('STUB: refusing to create a subscription without explicit confirmation.');
    this.log(
      `STUB: no charge — would create subscription for user ${input.userId} on plan ${input.planId}.`,
    );
    return stubReceipt('create', { userId: input.userId, planId: input.planId });
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<StubReceipt> {
    this.log(
      `STUB: no charge — would cancel subscription ${input.subscriptionId} (${input.mode}) for user ${input.userId}.`,
    );
    return stubReceipt('cancel', { userId: input.userId, planId: '' });
  }

  async renewSubscription(input: RenewSubscriptionInput): Promise<StubReceipt> {
    this.log(
      `STUB: no charge — would renew subscription ${input.subscriptionId} for user ${input.userId}.`,
    );
    return stubReceipt('renew', { userId: input.userId, planId: '' });
  }
}

/** The provider this deployment uses: the stub, until the owner connects a
 * real one and implements the interface above against it. */
export function paymentProvider(log?: LogFn): PaymentProvider {
  return new StubPaymentProvider(log);
}
