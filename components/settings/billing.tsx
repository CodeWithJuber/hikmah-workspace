'use client';
/** Beta billing: the trial and stub-subscription screen.
 *
 * Everything money-shaped on this screen is a stub and says so. The banner at
 * the top is not decoration: it is the honesty contract — no real payment is
 * connected, every amount is $0, and the trial never converts without the
 * person's own explicit confirmation.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';

type TrialView = {
  id: string;
  plan_id: string;
  state: string;
  days_left: number;
  started_at: string;
  ends_at: string;
};

type SubscriptionView = {
  id: string;
  plan_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  effective_end: string;
  last_receipt: string | null;
};

const STUB_BANNER =
  'Test billing — no real payment is connected to this deployment. ' +
  'Every amount here is $0 and no card can be charged.';

async function call(path: string, init?: RequestInit) {
  const response = await clientFetch(path, init);
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error ?? 'That did not work.');
  return parsed;
}

const jsonInit = (method: string, body?: object): RequestInit => ({
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}

export function BetaBilling() {
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [code, setCode] = useState('');
  /** The explicit conversion tick: without it the confirm call refuses. */
  const [confirmed, setConfirmed] = useState(false);

  /** The fetch, shared by the mount effect and the action handler. Returns the
   * payload instead of setting state: the React Compiler lint treats a
   * component-scope function containing setState as a synchronous setState
   * when an effect calls it, so the effect below wires the promise with
   * inline callbacks, the way billing-panel.tsx does. */
  const fetchBetaBilling = useCallback(async (): Promise<{
    trial: TrialView | null;
    subscription: SubscriptionView | null;
  }> => {
    const [trialRes, subRes] = await Promise.all([
      call('/api/billing/trial'),
      call('/api/billing/subscription'),
    ]);
    return { trial: trialRes.trial ?? null, subscription: subRes.subscription ?? null };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { trial: nextTrial, subscription: nextSub } = await fetchBetaBilling();
      setTrial(nextTrial);
      setSubscription(nextSub);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load billing.');
    } finally {
      setLoading(false);
    }
  }, [fetchBetaBilling]);

  useEffect(() => {
    let live = true;
    void fetchBetaBilling()
      .then(({ trial: nextTrial, subscription: nextSub }) => {
        if (!live) return;
        setTrial(nextTrial);
        setSubscription(nextSub);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!live) return;
        toast.error(error instanceof Error ? error.message : 'Could not load billing.');
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [fetchBetaBilling]);

  const act = useCallback(
    async (label: string, path: string, init: RequestInit, doneNote?: string) => {
      setBusy(label);
      try {
        const result = await call(path, init);
        toast.success(doneNote ?? result.note ?? 'Done.');
        setConfirmed(false);
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'That did not work.');
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const activeTrial = trial && trial.state === 'active' ? trial : null;
  const activeSub = subscription && subscription.status === 'active' ? subscription : null;

  return (
    <section aria-label="Beta trial and test billing" className="beta-billing">
      <div className="beta-billing__stub" role="note">
        <FlaskConical size={16} aria-hidden />
        <p>
          <strong>Test billing.</strong> {STUB_BANNER}
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="beta-billing__status">
          {activeTrial ? (
            <p>
              <strong>Trial:</strong> {activeTrial.plan_id} —{' '}
              <strong>
                {activeTrial.days_left} day{activeTrial.days_left === 1 ? '' : 's'} left
              </strong>{' '}
              (ends {formatDate(activeTrial.ends_at)}).
            </p>
          ) : activeSub ? (
            <p>
              <strong>Test subscription:</strong> {activeSub.plan_id} — active until{' '}
              {formatDate(activeSub.effective_end)}
              {activeSub.cancel_at_period_end ? ' (cancels at period end)' : ''}. $0, no charge.
              {activeSub.last_receipt ? (
                <>
                  {' '}
                  Last stub receipt: <code>{activeSub.last_receipt}</code>.
                </>
              ) : null}
            </p>
          ) : (
            <p>
              <strong>Free tier.</strong> No trial running, no test subscription.
            </p>
          )}
        </div>
      )}

      <div className="beta-billing__actions">
        {!activeTrial && !activeSub && !loading && (
          <Button
            disabled={busy !== ''}
            onClick={() => act('trial', '/api/billing/trial', jsonInit('POST', { planId: 'pro' }))}
          >
            {busy === 'trial' ? <Loader2 className="animate-spin" size={16} /> : null}
            Start 14-day trial ($0, test)
          </Button>
        )}

        {activeTrial && (
          <>
            <label className="beta-billing__confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Yes, start the paid plan as a $0 test subscription. I understand no real payment is
              connected and nothing will be charged.
            </label>
            <Button
              disabled={!confirmed || busy !== ''}
              onClick={() =>
                act(
                  'confirm',
                  '/api/billing/subscription',
                  jsonInit('POST', {
                    action: 'confirm',
                    trialId: activeTrial.id,
                    confirmed: true,
                  }),
                )
              }
            >
              {busy === 'confirm' ? <Loader2 className="animate-spin" size={16} /> : null}
              Convert trial (explicit, $0 test)
            </Button>
            <Button
              variant="outline"
              disabled={busy !== ''}
              onClick={() => act('cancel-trial', '/api/billing/trial', jsonInit('DELETE'))}
            >
              {busy === 'cancel-trial' ? <Loader2 className="animate-spin" size={16} /> : null}
              Cancel trial
            </Button>
          </>
        )}

        {activeSub && (
          <>
            <Button
              variant="outline"
              disabled={busy !== ''}
              onClick={() =>
                act(
                  'renew',
                  '/api/billing/subscription',
                  jsonInit('POST', { action: 'renew', subscriptionId: activeSub.id }),
                )
              }
            >
              {busy === 'renew' ? <Loader2 className="animate-spin" size={16} /> : null}
              Renew test period ($0)
            </Button>
            <Button
              variant="outline"
              disabled={busy !== ''}
              onClick={() =>
                act(
                  'cancel-eop',
                  '/api/billing/subscription',
                  jsonInit('POST', {
                    action: 'cancel',
                    subscriptionId: activeSub.id,
                    mode: 'at_period_end',
                  }),
                )
              }
            >
              {busy === 'cancel-eop' ? <Loader2 className="animate-spin" size={16} /> : null}
              Cancel at period end
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== ''}
              onClick={() =>
                act(
                  'cancel-now',
                  '/api/billing/subscription',
                  jsonInit('POST', {
                    action: 'cancel',
                    subscriptionId: activeSub.id,
                    mode: 'immediate',
                  }),
                )
              }
            >
              {busy === 'cancel-now' ? <Loader2 className="animate-spin" size={16} /> : null}
              Cancel immediately
            </Button>
          </>
        )}
      </div>

      <form
        className="beta-billing__redeem"
        onSubmit={(event) => {
          event.preventDefault();
          if (!code.trim()) return;
          void act('redeem', '/api/beta/redeem', jsonInit('POST', { code: code.trim() })).then(() =>
            setCode(''),
          );
        }}
      >
        <label htmlFor="beta-invite-code">
          Have an invite code? The owner sends it to you directly.
        </label>
        <div className="beta-billing__redeem-row">
          <Input
            id="beta-invite-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="beta-…"
            autoComplete="off"
          />
          <Button type="submit" disabled={busy !== '' || !code.trim()}>
            {busy === 'redeem' ? <Loader2 className="animate-spin" size={16} /> : null}
            Redeem
          </Button>
        </div>
      </form>
    </section>
  );
}
