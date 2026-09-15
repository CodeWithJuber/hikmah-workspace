/** Which account a workbench request is for, without telling it who they are.
 *
 * The workbench assigns one Unix user per account, so it needs a stable name
 * for each. It does not need — and must not have — the account id: it holds no
 * sessions, does nothing with identity, and is the one container that hands out
 * shells. A keyed hash gives it exactly what it needs and nothing else.
 *
 * Keyed by the shared workbench token, which both sides already hold, so:
 *
 *  - the workbench never learns a real user id;
 *  - an id on its own is not a slot, so knowing someone's account id does not
 *    let a forged request land in their directory;
 *  - the value is stable, so a person keeps their files across restarts.
 *
 * This is the same shape `lib/workbench/ticket.ts` already uses for terminal
 * tickets, deliberately: one idea in the codebase rather than two.
 */
import { createHmac } from 'node:crypto';

/** Long enough that a collision is not a thing that happens, short enough to
 * read in a log line. `workbench/src/slots.ts` accepts 16–64 of these. */
const LENGTH = 32;

/**
 * The opaque, stable name for an account.
 *
 * The `user:` prefix is domain separation: the same secret signs terminal
 * tickets, and a value derived for one purpose should never be usable as the
 * other even if the inputs ever coincide.
 */
export function workbenchUserKey(userId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('user:' + userId)
    .digest('base64url')
    .slice(0, LENGTH);
}
