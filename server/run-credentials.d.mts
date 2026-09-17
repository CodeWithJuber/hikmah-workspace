type RunBinding = { id: string; user_id?: string };
export function sealRunConfig(value: unknown, run: RunBinding): Record<string, unknown>;
export function executionRunConfig(
  run: RunBinding & { config: string },
): Record<string, unknown> & { apiKey: string };
export function migrateRunCredentials(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}): number;
