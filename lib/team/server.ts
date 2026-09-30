/** The Next-facing layer over ./store.ts.
 *
 * Same shape as lib/authz/server.ts: the store is built once over the raw
 * storage handle and cached; the handle, not this module, is what tests
 * drive. Routes import teamStore() and enforcement helpers, never sqlite.
 */
import { getStorage } from '@/server/storage.mjs';
import { createTeamStore, type TeamStore } from './store.ts';

let cached: TeamStore | undefined;

export function teamStore(): TeamStore {
  cached ??= createTeamStore(getStorage().raw);
  return cached;
}
