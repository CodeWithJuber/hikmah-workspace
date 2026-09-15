/** Page vitals: what the site felt like, kept where everything else is kept.
 *
 * Deliberately tiny. The route writes one row per metric and nothing reads it
 * yet but the owner console; the value of this table is entirely in there being
 * a real number from a real phone to compare a release against, which is the
 * thing this repo has never had.
 */
import type { DatabaseSync } from 'node:sqlite';

/** The five web-vitals metrics worth keeping, and nothing else.
 *
 * An allowlist rather than a length check: this route is reachable without a
 * session, so the only defence against it becoming a general-purpose write
 * endpoint is that every field is either a number or one of a fixed set of
 * strings. */
export const VITAL_METRICS = ['CLS', 'INP', 'LCP', 'FCP', 'TTFB'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

export const VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type VitalRating = (typeof VITAL_RATINGS)[number];

export const VITAL_WIDTHS = ['phone', 'desktop'] as const;
export type VitalWidth = (typeof VITAL_WIDTHS)[number];

export type VitalSample = {
  userId: string | null;
  route: string;
  metric: VitalMetric;
  value: number;
  rating: VitalRating;
  width: VitalWidth;
  release: string;
};

/** A summary row for the owner console: one metric on one route.
 *
 * p75 rather than a mean, because that is the number Core Web Vitals is defined
 * at and because one 12-second load on a train would move a mean and tell
 * nobody anything. */
export type VitalSummary = {
  route: string;
  metric: VitalMetric;
  width: VitalWidth;
  samples: number;
  p75: number;
  poor: number;
};

export function createVitalsStore(db: DatabaseSync) {
  const insert = db.prepare(
    'INSERT INTO page_vitals (user_id, route, metric, value, rating, width, release)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  return {
    record(sample: VitalSample): void {
      insert.run(
        sample.userId,
        sample.route,
        sample.metric,
        sample.value,
        sample.rating,
        sample.width,
        sample.release,
      );
    },
    /** p75 per route/metric/width over the last `days` days.
     *
     * Nearest-rank: the smallest value at or below which 75% of the samples
     * fall, which is `ceil(3n/4)` and, in integer arithmetic, `(3n+3)/4`. A
     * mean would be the obvious thing and the wrong one — one twelve-second
     * load on a train moves a mean and tells nobody anything, which is why
     * Core Web Vitals is defined at p75 in the first place.
     *
     * The first draft took the offset inside a correlated subquery and SQLite
     * refused it — "misuse of aggregate function COUNT()" — because the outer
     * COUNT is not available there. A window function is both correct and one
     * pass. */
    summary(days = 7): VitalSummary[] {
      return db
        .prepare(
          `WITH ranked AS (
             SELECT route, metric, width, value, rating,
                    ROW_NUMBER() OVER (PARTITION BY route, metric, width ORDER BY value) AS rn,
                    COUNT(*) OVER (PARTITION BY route, metric, width) AS n
               FROM page_vitals
              WHERE created_at >= datetime('now', ?)
           )
           SELECT route, metric, width,
                  n AS samples,
                  SUM(rating = 'poor') AS poor,
                  MAX(CASE WHEN rn = (n * 3 + 3) / 4 THEN value END) AS p75
             FROM ranked
            GROUP BY route, metric, width
            ORDER BY route, metric, width`,
        )
        .all(`-${days} days`) as unknown as VitalSummary[];
    },
  };
}
