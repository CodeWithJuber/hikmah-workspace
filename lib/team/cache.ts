/** A per-user namespaced in-memory cache.
 *
 * Cache entries are an isolation boundary the backlog names explicitly, so
 * the namespace is structural: `scope(userId)` returns an accessor whose
 * keys are prefixed with that user id, and there is NO accessor that takes
 * another user's key. A caller physically cannot read, write or clear
 * someone else's entries — the API has no parameter for it.
 *
 * Used by the team support-view routes to cache metadata listings; entries
 * are metadata-shaped and TTL-bound, never content.
 */

export type TeamCacheScope = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  del(key: string): void;
  /** Clear only this user's entries. */
  clear(): void;
};

export function createTeamCache(now: () => number = () => Date.now()) {
  const data = new Map<string, { value: unknown; expiresAt: number }>();

  return {
    /** The scope for one user. An empty user id is a programmer error and
     * throws: silently scoping to nobody would mix everyone's entries. */
    scope(userId: string): TeamCacheScope {
      if (!userId) throw new Error('team cache scope needs a user id');
      const prefix = `team-cache:u:${userId}:`;
      const namespaced = (key: string) => {
        if (!key) throw new Error('team cache key must not be empty');
        return `${prefix}${key}`;
      };
      const read = <T>(full: string): T | undefined => {
        const entry = data.get(full);
        if (!entry) return undefined;
        if (entry.expiresAt <= now()) {
          data.delete(full);
          return undefined;
        }
        return entry.value as T;
      };
      return {
        get<T>(key: string): T | undefined {
          return read<T>(namespaced(key));
        },
        set<T>(key: string, value: T, ttlMs: number = 60_000): void {
          data.set(namespaced(key), { value, expiresAt: now() + Math.max(ttlMs, 1) });
        },
        del(key: string): void {
          data.delete(namespaced(key));
        },
        clear(): void {
          for (const full of [...data.keys()]) {
            if (full.startsWith(prefix)) data.delete(full);
          }
        },
      };
    },
  };
}

export type TeamCache = ReturnType<typeof createTeamCache>;
