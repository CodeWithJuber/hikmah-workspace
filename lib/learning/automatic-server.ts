import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { generateText } from 'ai';
import { getStorage } from '../../server/storage.mjs';
import { createLanguageModel } from '../ai/models.ts';
import { createBillingStore } from '../billing/store.ts';
import { entitlementsFor } from '../billing/entitlements.ts';
import { researchDirectory, loadReleasedField } from '../context-model/server.ts';
import { validateField, type Sentence } from '../context-model/field-model.ts';
import { learningSecrets } from './server.ts';
import { createAutomaticStore, type AutomaticJob } from './automatic-store.ts';
import {
  teacherPrompt,
  automaticSamples,
  type AutomaticFitInput,
  type AutomaticFitResult,
} from './automatic-training.ts';
import { AUTOMATIC_OUTPUT_TOKENS } from './automatic-types.ts';
import { processAutomaticJob, type AutomaticDependencies } from './automatic-worker.ts';
import type { CapturedExchange } from './store.ts';
import { boundedAnnotationFetch } from './automatic-fetch.ts';

const PROVIDER_TIMEOUT_MS = 60_000;
const FIT_TIMEOUT_MS = 90_000;

/** The model and labelled corpus live only in this bounded worker thread. A
 * training fit never occupies the main chat/streaming event loop. */
export function runAutomaticFit(
  input: AutomaticFitInput,
  signal: AbortSignal,
  stage: (value: 'training' | 'evaluating') => void,
): Promise<AutomaticFitResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('Learning was paused.'));
    const worker = new Worker(join(researchDirectory(), 'v6', 'automatic-fit-worker.mjs'), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (error?: Error, value?: AutomaticFitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const abort = () => finish(Error('Learning was paused.'));
    const timer = setTimeout(
      () => finish(Error('Local training reached its time limit.')),
      FIT_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.on(
      'message',
      (message: { stage?: string; error?: string; value?: AutomaticFitResult }) => {
        try {
          if (message.stage === 'training' || message.stage === 'evaluating') stage(message.stage);
          else if (message.error) finish(Error(message.error));
          else if (message.value) finish(undefined, message.value);
        } catch {
          finish(Error('The local learning progress could not be saved.'));
        }
      },
    );
    worker.on('error', () => finish(Error('Local training worker failed.')));
    worker.on('exit', () => {
      if (!settled) finish(Error('Local training stopped.'));
    });
  });
}

function dependencies(): AutomaticDependencies {
  const storage = getStorage();
  const store = createAutomaticStore(storage.raw);
  const billing = createBillingStore(storage.raw);
  return {
    store,
    bucket: storage.BUCKET,
    secrets: learningSecrets,
    async annotate(config, language, samples, signal) {
      const result = await generateText({
        model: createLanguageModel(config, boundedAnnotationFetch()),
        ...teacherPrompt(language, samples),
        maxOutputTokens: AUTOMATIC_OUTPUT_TOKENS,
        maxRetries: 0,
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
      });
      return {
        text: result.text,
        finishReason: result.finishReason,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      };
    },
    canSpend(job, config) {
      if (!config.metered) return true;
      const tier =
        billing.ownerUserId() === job.user_id
          ? 'owner'
          : (billing.savedTier(job.user_id) ?? 'byok');
      const entitlement = entitlementsFor(tier);
      if (!entitlement.managedKey) return false;
      // Reserve room for this small request, not merely one remaining token.
      // This is independent of the explicit daily request cap.
      return (
        entitlement.monthlyTokenCap === null ||
        billing.meteredThisMonth(job.user_id) + AUTOMATIC_OUTPUT_TOKENS + 2_000 <=
          entitlement.monthlyTokenCap
      );
    },
    recordUsage(job, config, usage) {
      billing.recordUsage({
        id: 'usage_' + job.id,
        userId: job.user_id,
        runId: job.id,
        model: String(config.model),
        metered: config.metered === true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    },
    async load(job) {
      const active = store.active(job.user_id, job.language);
      const [baseText, released, activeText] = await Promise.all([
        readFile(
          join(researchDirectory(), 'v6', 'data', 'ud-pud-' + job.language + '.json'),
          'utf8',
        ),
        loadReleasedField(job.language),
        active
          ? storage.BUCKET.get(active.blob_key).then(
              (object: { text(): Promise<string> } | null) => {
                if (!object) throw Error('Active checkpoint is unavailable.');
                return object.text();
              },
            )
          : Promise.resolve(null),
      ]);
      const previous = activeText
        ? (JSON.parse(activeText) as { model: unknown; reviewedRows?: Sentence[] })
        : null;
      const receipt = active
        ? (JSON.parse(active.receipt) as { automatic?: boolean; restoreVersion?: string })
        : null;
      const reviewedRows = previous?.reviewedRows ?? [];
      const humanSurfaces = new Set(
        reviewedRows.map((row) => row.text.normalize('NFC').toLowerCase().replace(/\s+/gu, '')),
      );
      return {
        basedOn: active?.id ?? 'released',
        restoreVersion: receipt?.automatic
          ? (receipt.restoreVersion ?? 'released')
          : (active?.id ?? 'released'),
        input: {
          base: JSON.parse(baseText).sentences as Sentence[],
          released,
          current: previous ? validateField(previous.model) : released,
          reviewedRows,
          automaticRows: store
            .annotations(job.user_id, job.language)
            .filter(
              (row) =>
                !humanSurfaces.has(row.text.normalize('NFC').toLowerCase().replace(/\s+/gu, '')),
            ),
        },
      };
    },
    fit: runAutomaticFit,
  };
}

type AutomaticService = { start(): void; stop(): Promise<void>; wake(): void };
const globalService = globalThis as typeof globalThis & {
  __hikmahAutomaticLearning?: AutomaticService;
};

/** One polling loop per process and one fenced fit across all processes. */
export function automaticLearningService(): AutomaticService {
  if (globalService.__hikmahAutomaticLearning) return globalService.__hikmahAutomaticLearning;
  const deps = dependencies();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let stopped = true;
  let cleanup: Promise<void> | null = null;
  let lastPurge = 0;
  const tick = () => {
    if (stopped || active) return;
    const holder = randomUUID();
    let job: AutomaticJob | null;
    try {
      if (!cleanup) {
        cleanup = Promise.all(
          deps.store.garbage().map(async (key) => {
            try {
              await deps.bucket.delete(key);
              deps.store.cleaned(key);
            } catch {
              /* retry next tick */
            }
          }),
        )
          .then(() => {})
          .finally(() => {
            cleanup = null;
          });
      }
      if (Date.now() - lastPurge > 60_000) {
        deps.store.purge();
        lastPurge = Date.now();
      }
      job = deps.store.claim(holder);
    } catch {
      return;
    }
    if (!job) return;
    const signalController = new AbortController();
    controller = signalController;
    const runningJob = job;
    const heartbeat = setInterval(() => {
      try {
        if (!deps.store.live(runningJob, holder) || !deps.store.heartbeat(holder))
          signalController.abort();
      } catch {
        signalController.abort();
      }
    }, 1_000);
    heartbeat.unref();
    active = processAutomaticJob(job, holder, signalController.signal, deps)
      .catch(() => {
        // Storage may be temporarily unavailable even for the failure status.
        // The durable lease recovery handles this job after the connection heals.
      })
      .finally(() => {
        clearInterval(heartbeat);
        try {
          deps.store.release(holder);
        } catch {
          /* the lease expires */
        }
        active = null;
        controller = null;
      });
  };
  globalService.__hikmahAutomaticLearning = {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(tick, 3_000);
      timer.unref();
      tick();
    },
    wake: tick,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      controller?.abort();
      await active;
      await cleanup;
    },
  };
  return globalService.__hikmahAutomaticLearning;
}

export function enqueueAutomaticLearning(input: {
  userId: string;
  runId: string;
  revision: number;
  exchange: CapturedExchange;
  config: Record<string, unknown>;
}) {
  const storage = getStorage();
  const example = storage.raw
    .prepare('SELECT id FROM learning_examples WHERE user_id=? AND run_id=?')
    .get(input.userId, input.runId) as { id: string } | undefined;
  if (!example) return;
  const known = storage.raw
    .prepare(
      `SELECT fingerprint FROM automatic_learning_annotations WHERE user_id=?
     UNION SELECT json_extract(s.value,'$.fingerprint') AS fingerprint
     FROM automatic_learning_jobs j,json_each(j.sentences) s WHERE j.user_id=?
       AND j.status IN ('queued','preparing','training','evaluating')`,
    )
    .all(input.userId, input.userId) as { fingerprint: string }[];
  const samples = automaticSamples(input.exchange, new Set(known.map((row) => row.fingerprint)));
  if (!samples) return;
  createAutomaticStore(storage.raw).enqueue({
    userId: input.userId,
    exampleId: example.id,
    revision: input.revision,
    ...samples,
    config: {
      baseUrl: input.config.baseUrl,
      model: input.config.model,
      apiKey: input.config.apiKey,
      freeOnly: input.config.freeOnly,
      metered: input.config.metered,
    },
  });
  automaticLearningService().wake();
}
