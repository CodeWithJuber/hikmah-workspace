import { randomUUID, createHash } from 'node:crypto';
import type { ModelRequest } from '../ai/models.ts';
import { executionRunConfig } from '../../server/run-credentials.mjs';
import {
  validateTeacherAnnotations,
  type AutomaticFitInput,
  type AutomaticFitResult,
} from './automatic-training.ts';
import type {
  AutomaticJob,
  AutomaticReceipt,
  AutomaticSentence,
  AutomaticStore,
} from './automatic-store.ts';
import { redactLearningText } from './privacy.ts';

export type AutomaticDependencies = {
  store: AutomaticStore;
  annotate(
    config: ModelRequest,
    language: string,
    samples: AutomaticSentence[],
    signal: AbortSignal,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; finishReason: string }>;
  secrets(userId: string, extra: string[]): Promise<string[]>;
  canSpend(job: AutomaticJob, config: Record<string, unknown>): boolean;
  recordUsage(
    job: AutomaticJob,
    config: Record<string, unknown>,
    usage: { inputTokens: number; outputTokens: number },
  ): void;
  load(
    job: AutomaticJob,
  ): Promise<{ input: AutomaticFitInput; basedOn: string; restoreVersion: string }>;
  fit(
    input: AutomaticFitInput,
    signal: AbortSignal,
    stage: (value: 'training' | 'evaluating') => void,
  ): Promise<AutomaticFitResult>;
  bucket: {
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
};

/** One request at most per job. Annotation proposals are saved before fitting,
 * so a process restart can resume CPU work without buying annotations again. */
export async function processAutomaticJob(
  job: AutomaticJob,
  holder: string,
  signal: AbortSignal,
  deps: AutomaticDependencies,
) {
  const { store } = deps;
  const current = () => !signal.aborted && store.live(job, holder);
  let phase: 'preparing' | 'training' | 'evaluating' = 'preparing';
  let credential = '';
  try {
    if (!current()) return;
    if (!job.annotations) {
      const config = executionRunConfig(job);
      credential = config.apiKey;
      if (!deps.canSpend(job, config)) {
        store.finish(
          job,
          holder,
          'held',
          'There is no included provider budget available for automatic learning. Your chat and current co-model are unchanged.',
        );
        return;
      }
      const samples = JSON.parse(job.sentences) as AutomaticSentence[];
      // Check again against the current vault before sending or persisting any
      // annotation. A newly saved secret must not slip through an older job.
      const secrets = await deps.secrets(job.user_id, [config.apiKey]);
      if (samples.some((sample) => redactLearningText(sample.text, secrets).redactions.length)) {
        store.finish(job, holder, 'held', 'This sample was excluded by the privacy filter.');
        return;
      }
      if (!current() || !store.reserveRequest(job, holder)) return;
      const response = await deps.annotate(config as ModelRequest, job.language, samples, signal);
      // Record real usage even if the user paused while the request was in
      // flight. Never claim the request was free because its output is unused.
      deps.recordUsage(job, config, response);
      if (!current()) return;
      const currentSecrets = await deps.secrets(job.user_id, [credential]);
      if (
        response.finishReason !== 'stop' ||
        redactLearningText(response.text, currentSecrets).redactions.length ||
        samples.some((sample) => redactLearningText(sample.text, currentSecrets).redactions.length)
      ) {
        store.finish(
          job,
          holder,
          'held',
          'The annotation was incomplete or contained sensitive text. It was not used.',
        );
        return;
      }
      let rows;
      try {
        rows = validateTeacherAnnotations(response.text, job.language, samples, job.example_id);
      } catch {
        store.finish(
          job,
          holder,
          'held',
          'The model’s syntax annotations did not pass validation. Learning will try a future chat.',
        );
        return;
      }
      if (!store.saveAnnotations(job, holder, rows)) return;
    }
    if (!current()) return;
    phase = 'training';
    const loaded = await deps.load(job);
    if (!current()) return;
    const rows = [...loaded.input.reviewedRows, ...loaded.input.automaticRows];
    const sensitiveCorpus = async () => {
      const secrets = await deps.secrets(job.user_id, [credential]);
      return rows.some(
        (row) =>
          redactLearningText(row.text, secrets).redactions.length ||
          redactLearningText(JSON.stringify(row), secrets).redactions.length,
      );
    };
    if (await sensitiveCorpus()) {
      store.finish(
        job,
        holder,
        'held',
        'A training sample now matches sensitive data. It was excluded from this fit; reset learning to remove earlier learned parameters.',
      );
      return;
    }
    if (!current()) return;
    const result = await deps.fit(loaded.input, signal, (stage) => {
      phase = stage;
      store.stage(job, holder, stage);
    });
    if (!current()) return;
    const id = randomUUID();
    const key = 'context/' + job.user_id + '/' + id + '.json';
    const receipt: AutomaticReceipt = {
      ...result.gate,
      automatic: true,
      basedOn: loaded.basedOn,
      restoreVersion: loaded.restoreVersion,
      annotationSource:
        'Same configured provider; machine-generated syntax, not human-reviewed ground truth',
      providerWeightsChanged: false,
      sha256: createHash('sha256').update(JSON.stringify(result.model)).digest('hex'),
    };
    const bytes = JSON.stringify({
      model: result.model,
      receipt,
      reviewedRows: result.reviewedRows,
      source:
        'Server-trained local syntax co-model. Provider-generated annotations and a reused development gate do not prove semantic understanding or fresh held-out accuracy.',
    });
    if (Buffer.byteLength(bytes) > 4_000_000) {
      store.finish(
        job,
        holder,
        'held',
        'The candidate exceeded the checkpoint storage limit. Your current co-model is unchanged.',
      );
      return;
    }
    if (!store.stageCheckpoint(job, holder, key)) return;
    let published = false;
    try {
      await deps.bucket.put(key, bytes);
      if (current() && (await sensitiveCorpus())) {
        store.finish(
          job,
          holder,
          'held',
          'A training sample now matches sensitive data. This candidate was not activated.',
        );
      } else if (current()) published = store.publish(job, holder, { id, key, receipt });
    } finally {
      if (!published) {
        store.abandonCheckpoint(key);
        try {
          await deps.bucket.delete(key);
          store.cleaned(key);
        } catch {
          /* Durable garbage marker retries a failed object removal. */
        }
      }
    }
    if (published) store.pruneCheckpoints(job.user_id, job.language);
  } catch {
    // No raw provider error or local corpus text is ever persisted in a status.
    if (current())
      store.finish(
        job,
        holder,
        'error',
        phase === 'preparing'
          ? 'The provider could not prepare this learning sample. Your current co-model is unchanged; future chats can still be learned from.'
          : 'Local training or evaluation could not complete. Your current co-model is unchanged.',
      );
  }
}
