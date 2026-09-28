/** How many runs the worker drives at once.
 *
 * Shared by the worker (lib/runs/service.ts) and the single run pipeline
 * (lib/runs/enqueue.ts), so the queue cap is always the number of slots the
 * worker actually drives. A home of its own because enqueue.ts must stay
 * importable without the worker's heavyweight dependencies.
 */
export const DEFAULT_RUN_CONCURRENCY = 2;

/** The configured concurrency, or the default for anything that is not a
 * positive whole number. */
export function runConcurrency(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_CONCURRENCY;
}
