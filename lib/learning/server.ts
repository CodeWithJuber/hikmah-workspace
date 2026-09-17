import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { getStorage } from '@/server/storage.mjs';
import type { RunRow } from '../runs/store.ts';
import { completedExchange } from './capture.ts';
import { createLearningStore } from './store.ts';
import { executionRunConfig } from '../../server/run-credentials.mjs';

/** Never return these values from a route. If a saved credential cannot be
 * resolved, fail closed rather than silently make a less-redacted copy. */
export async function learningSecrets(userId: string, extra: string[] = []): Promise<string[]> {
  const vault = createSecretStore();
  const entries = await vault.list(userId);
  const saved = await Promise.all(
    entries.map((entry) => vault.resolve(userId, entry.name, entry.destination)),
  );
  const deployment = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)/i.test(name) &&
        typeof value === 'string' &&
        value.length > 0,
    )
    .map(([, value]) => value!);
  return [...new Set([...extra, ...saved, ...deployment].filter(Boolean))];
}

/** Called only after the worker has persisted the answer and marked it done. */
export async function captureCompletedRun(input: {
  run: RunRow;
  messages: unknown[];
  message: unknown;
}) {
  const stored = JSON.parse(input.run.config) as { learning?: { enabled?: boolean } };
  const store = createLearningStore(getStorage().raw);
  if (!stored.learning?.enabled || !store.policy(input.run.user_id).enabled) return;
  const config = executionRunConfig(input.run) as {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    learning?: { enabled?: boolean };
  };
  const secrets = await learningSecrets(input.run.user_id, [config.apiKey ?? '']);
  const captured = completedExchange({
    messages: input.messages,
    message: input.message,
    model: config.model ?? '',
    baseUrl: config.baseUrl ?? '',
    secrets,
  });
  if (captured) store.capture(input.run.user_id, input.run.id, captured);
}
