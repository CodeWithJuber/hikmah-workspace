/** The deferred-triage retry hook (Agent B's side of lib/memory/triage.ts).
 *
 * `retryDeferred` lives in triage.ts; this module is the server's small
 * wrapper around it: resolve the storage handle, run the retry for one user,
 * and return a summary. Called post-turn from the learner completion path
 * (lib/learning/server.ts) and from POST /api/memory/triage-retry.
 *
 * A deferred row carries its owner's userId (see triage.ts); retryDeferred
 * skips any defer that belongs to a different user, so a cross-user call can
 * never misattribute. Only call this with the owning user's id.
 */
import { getStorage } from '../../server/storage.mjs';
import { retryDeferred } from './triage.ts';
import type { SqliteHandle } from './store.ts';

/** Re-run due deferred triage items for one user. Best effort by design: a
 * retry that cannot run must not fail the turn that triggered it. The
 * optional handle is a test seam — production always uses the real storage. */
export async function retryDeferredMemories(options: {
  userId: string;
  incognito?: boolean;
  handle?: SqliteHandle;
}): Promise<{ retried: number; surfaced: number; saved: number }> {
  // Incognito: zero writes, not even a retry.
  if (options.incognito) return { retried: 0, surfaced: 0, saved: 0 };
  try {
    const decisions = await retryDeferred(options.handle ?? getStorage().raw, {
      incognito: false,
      userId: options.userId,
    });
    return {
      retried: decisions.length,
      surfaced: decisions.filter((decision) => decision.action === 'surface').length,
      saved: decisions.filter((decision) => decision.action === 'save').length,
    };
  } catch {
    return { retried: 0, surfaced: 0, saved: 0 };
  }
}
