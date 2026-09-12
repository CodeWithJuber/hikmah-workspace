/** What one run is allowed, decided once where the key is resolved.
 *
 * Pulled out of the route because this is the rule that has to be right before
 * a stranger can sign up, and a rule embedded in a request handler can only be
 * tested through an HTTP round trip against a built server. Here it is four
 * inputs and a plain object.
 */
import type { Entitlements } from './entitlements.ts';

export type RunAccess = {
  /** The key the run will use. Empty means it has none. */
  apiKey: string;
  /** Whether the deployment paid for it, and so whether it counts against an
   * allowance and is recorded as metered. */
  metered: boolean;
  /** Whether this run may reach a machine. */
  execution: boolean;
};

/**
 * Resolve the key for a run.
 *
 * The person's own saved key always wins: someone who has supplied one is
 * paying their own provider, and a deployment that quietly spent its own budget
 * instead would be charging them twice.
 *
 * The deployment's key is the fallback **only** for a tier entitled to it. It
 * used to be the fallback for everyone, which is invisible with one account and
 * an open bar the moment there are two.
 */
export function runAccess(input: {
  entitlements: Entitlements;
  /** Resolved from the person's own secret vault. */
  savedKey: string;
  /** HIKMAH_PROVIDER_KEY, or '' when the deployment has none. */
  deploymentKey: string;
}): RunAccess {
  const { entitlements, savedKey, deploymentKey } = input;
  if (savedKey) return { apiKey: savedKey, metered: false, execution: entitlements.execution };
  if (entitlements.managedKey && deploymentKey)
    return { apiKey: deploymentKey, metered: true, execution: entitlements.execution };
  return { apiKey: '', metered: false, execution: entitlements.execution };
}

/** Why a run cannot start, in words the person can act on, or '' when it can.
 *
 * `needsKey` stays where it is (lib/ai/endpoint.ts): whether an endpoint needs
 * a key at all is a property of the endpoint, not of who is asking.
 */
export function refusal(input: {
  access: RunAccess;
  entitlements: Entitlements;
  /** From lib/ai/endpoint.ts needsKey(baseUrl, apiKey). */
  keyless: boolean;
  meteredThisMonth: number;
}): string {
  if (input.keyless)
    return input.entitlements.tier === 'owner'
      ? 'No API key for this provider. Add one under Settings → Connection in the chat, or set HIKMAH_PROVIDER_KEY on the server.'
      : 'No API key for this provider. Add your own under Settings → Connection in the chat, or upgrade to a plan that includes models.';
  if (
    input.access.metered &&
    input.entitlements.monthlyTokenCap !== null &&
    input.meteredThisMonth >= input.entitlements.monthlyTokenCap
  )
    return 'You have used this month’s included tokens. They reset on the first of the month, or you can add your own provider key under Settings → Connection to keep going now.';
  return '';
}
