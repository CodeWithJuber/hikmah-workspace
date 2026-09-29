import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { getStorage } from '@/server/storage.mjs';
import type { RunRow } from '../runs/store.ts';
import { completedExchange } from './capture.ts';
import { createLearningStore } from './store.ts';
import { executionRunConfig } from '../../server/run-credentials.mjs';
import { enqueueAutomaticLearning } from './automatic-server.ts';
import { retryDeferredMemories } from '../memory/triage-retry.ts';

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
  const stored = JSON.parse(input.run.config) as {
    learning?: { enabled?: boolean };
    task?: { kind?: string };
    incognito?: boolean;
  };
  // A finished background task gives deferred triage items a second look:
  // triage may have deferred while Jev was unreachable, and the task's
  // report is the moment the person is reading Memory anyway. Fire-and-forget
  // and best-effort — a retry that cannot run must not fail the completion —
  // and never for an incognito run, which writes nothing at all.
  if (stored.task?.kind === 'learn' && stored.incognito !== true)
    void retryDeferredMemories({ userId: input.run.user_id }).catch(() => {});
  const store = createLearningStore(getStorage().raw);
  if (!stored.learning?.enabled || !store.policy(input.run.user_id).enabled) return;
  const config = executionRunConfig(input.run) as {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    learning?: { enabled?: boolean; revision?: number };
  };
  const secrets = await learningSecrets(input.run.user_id, [config.apiKey ?? '']);
  const captured = completedExchange({
    messages: input.messages,
    message: input.message,
    model: config.model ?? '',
    baseUrl: config.baseUrl ?? '',
    secrets,
  });
  if (captured && store.capture(input.run.user_id, input.run.id, captured)) {
    const policy = store.policy(input.run.user_id);
    if (policy.automatic)
      enqueueAutomaticLearning({
        userId: input.run.user_id,
        runId: input.run.id,
        revision: config.learning?.revision ?? -1,
        exchange: captured,
        config,
      });
  }
}
