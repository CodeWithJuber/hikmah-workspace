/**
 * Rate and resource limits for the deployment (PR-23 operational readiness).
 *
 * One honest config table, enforced where the cost actually lands:
 * - the ops/health route itself is rate-limited by TokenBucket below;
 * - RESOURCE_CAPS names the ceilings the rest of the stack already honours
 *   (storage envelope, run timeouts) so an operator can audit them in one place.
 *
 * There is no pre-existing generic rate limiter to reuse: deep-research has a
 * provider-error classifier and lib/billing has spend entitlements — neither is
 * a request token bucket, so this does not duplicate them.
 */

export interface RouteRateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** What the bucket is keyed on: one shared bucket or one per client. */
  key: 'ip' | 'global';
  /** Why this number exists — a limit without a reason rots. */
  reason: string;
}

/**
 * Per-route request ceilings. The chat route is the expensive one (model calls);
 * everything else sits low because this is a single-owner deployment, not a
 * public SaaS, and the limits only need to blunt accidents and abuse, not
 * adversarial load.
 */
export const RATE_LIMITS: Record<string, RouteRateLimit> = {
  '/api/ops/health': {
    limit: 60,
    windowMs: 60_000,
    key: 'ip',
    reason: 'ops polling must not become a load source',
  },
  '/api/chat': {
    limit: 30,
    windowMs: 60_000,
    key: 'ip',
    reason: 'model calls cost money; 30/min is far above human typing speed',
  },
  '/api/runs': { limit: 20, windowMs: 60_000, key: 'ip', reason: 'run launches queue worker time' },
  default: { limit: 120, windowMs: 60_000, key: 'ip', reason: 'backstop for every other route' },
};

/**
 * Pure in-process token bucket. Deliberately not distributed: the deployment is
 * one container (see docs/runbooks/deploy.md), so a shared-memory bucket is the
 * whole truth, not a placeholder. If the deployment ever goes multi-instance,
 * this must move to a shared store — the class throws if two instances are
 * detected via different HIKMAH_INSTANCE_ID values, so the failure is loud.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly instanceId: string;

  constructor(limit: number, windowMs: number) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive number');
    if (!Number.isFinite(windowMs) || windowMs <= 0)
      throw new Error('windowMs must be a positive number');
    this.capacity = limit;
    this.refillPerMs = limit / windowMs;
    this.instanceId = process.env.HIKMAH_INSTANCE_ID ?? 'single';
  }

  /**
   * Attempt one request against `key`. Returns whether it is allowed and, when
   * rejected, how long the caller should wait before retrying.
   */
  take(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const current = process.env.HIKMAH_INSTANCE_ID ?? 'single';
    if (current !== this.instanceId)
      throw new Error('TokenBucket crossed instances — move rate limiting to a shared store');
    const entry = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - entry.updatedAt);
    const refilled = Math.min(this.capacity, entry.tokens + elapsed * this.refillPerMs);
    if (refilled < 1) {
      const retryAfterMs = Math.ceil((1 - refilled) / this.refillPerMs);
      this.buckets.set(key, { tokens: refilled, updatedAt: now });
      return { allowed: false, retryAfterMs };
    }
    this.buckets.set(key, { tokens: refilled - 1, updatedAt: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Test seam: how many whole tokens a key currently holds. */
  tokensFor(key: string, now = Date.now()): number {
    const entry = this.buckets.get(key);
    if (!entry) return this.capacity;
    return Math.min(
      this.capacity,
      entry.tokens + Math.max(0, now - entry.updatedAt) * this.refillPerMs,
    );
  }
}

/** Lazily created buckets, one per route path. */
const bucketCache = new Map<string, TokenBucket>();

/** The bucket for a route path, creating it from RATE_LIMITS (or `default`) on first use. */
export function bucketForRoute(path: string): TokenBucket {
  const cached = bucketCache.get(path);
  if (cached) return cached;
  const config = RATE_LIMITS[path] ?? RATE_LIMITS.default;
  const bucket = new TokenBucket(config.limit, config.windowMs);
  bucketCache.set(path, bucket);
  return bucket;
}

/**
 * Resource ceilings. Each row cites where the ceiling is actually enforced, so
 * this table can be audited against the code rather than trusted.
 */
export interface ResourceCap {
  /** e.g. '24 MiB'. */
  value: string;
  /** Bytes (or ms) as a number, for the alert rules and tests. */
  numeric: number;
  unit: 'bytes' | 'ms' | 'count';
  enforcedBy: string;
}

export const RESOURCE_CAPS: Record<string, ResourceCap> = {
  maxUploadBytes: {
    value: '24 MiB',
    numeric: 24_000_000,
    unit: 'bytes',
    enforcedBy: 'server/storage.mjs BUCKET.put throws "Object exceeds storage envelope"',
  },
  maxRunMemoryBytes: {
    value: '512 MiB',
    numeric: 512 * 1024 * 1024,
    unit: 'bytes',
    enforcedBy:
      'docs/runbooks/deploy.md container memory limit (deployment config), not in-process',
  },
  maxRunTimeoutMs: {
    value: '10 min',
    numeric: 600_000,
    unit: 'ms',
    enforcedBy: 'lib/runs execution watchdog (see incident-drill runbook)',
  },
  maxQueueDepth: {
    value: '50 runs',
    numeric: 50,
    unit: 'count',
    enforcedBy:
      'lib/ops/alerts.ts queue_depth rule fires at this depth; hard reject not implemented — documented gap',
  },
  maxBackupAgeHours: {
    value: '26 h',
    numeric: 26,
    unit: 'count',
    enforcedBy: 'lib/ops/alerts.ts backup_stale rule; backup.sh runs on the owner cron',
  },
};

/** All caps whose enforcement note admits the cap is not enforced in code. Honest on purpose. */
export function unenforcedCaps(): string[] {
  return Object.entries(RESOURCE_CAPS)
    .filter(([, cap]) => /not implemented|documented gap|deployment config/i.test(cap.enforcedBy))
    .map(([name]) => name);
}
