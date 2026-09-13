/** The process-wide run service.
 *
 * One worker per process, created on first use and reused. Kept off the module
 * top level so importing a route does not start a worker, and stored on
 * globalThis so Next's dev-mode module reloading cannot end up with two workers
 * racing for the same queue.
 */
import { randomUUID } from 'node:crypto';
import { createAgentUIStream, readUIMessageStream, type UIMessage } from 'ai';
import { getStorage } from '@/server/storage.mjs';
import { createMediaAssets } from '../server/media-assets.ts';
import { createFileStore } from '../files/store.ts';
import { buildRunAgent } from '../ai/run-agent.ts';
import { runComparison } from '../ai/compare.ts';
import { sshRunContext, workbenchReady } from '../ssh/run-context.ts';
import { mcpForUser } from '../mcp/app-context.ts';
import { initialModel } from '../playground/session.ts';
import { ASK_USER_PART } from './resume.ts';
import { answered } from './failure.ts';
import { createBillingStore } from '../billing/store.ts';
import { createWorker, type Worker } from './worker.ts';

declare global {
  var __hikmahRunService: Worker | undefined;
}

/** Configuration stored on a run, written when it is created. */
export type RunConfig = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKey: string;
  /** Whether the deployment's own key is paying for this run, decided at
   * creation from the person's tier. Recorded so usage can be charged against
   * an allowance without re-deriving who was entitled to what. */
  metered?: boolean;
  /** Whether this run belongs to the operator.
   *
   * Only used to decide how much of a failure they are shown: the person who
   * can read the server log should not be told to go and read it. Decided at
   * creation like the other two, so it cannot change under a run in flight. */
  operator?: boolean;
  /** Whether this run may reach a machine: the workbench shell and SSH.
   *
   * Decided at creation rather than per step, so a plan change mid-run cannot
   * widen a run already in flight. Absent means yes, which keeps every run row
   * written before this existed behaving as it did.
   */
  execution?: boolean;
  instructions: string;
  maxSteps?: number;
  /** How much earlier conversation the run may carry, in characters. */
  contextCharacters?: number;
  /** The model's window in tokens. The run budgets history against this rather
   * than against a flat number, so the system prompt and the tool schemas
   * cannot be squeezed out by the transcript. */
  contextWindow?: number;
  disabledTools?: string[];
  enabledTools?: string[];
  /** Compare mode: also answer directly, with no tools, for contrast. */
  compare?: { model?: string };
};

/**
 * Drive one run with the same agent the request-scoped chat route uses.
 *
 * Every streamed chunk is appended to the run's event log before it is fanned
 * out, so a client that connects late or reconnects gets the same bytes in the
 * same order as one that was there from the start.
 */
async function driveWithAgent({
  run,
  messages,
  signal,
  emit,
}: {
  run: { id: string; user_id?: string; conversation_id?: string; config: string };
  messages: unknown[];
  signal: AbortSignal;
  emit: (chunk: unknown) => number;
}) {
  const config = JSON.parse(run.config) as RunConfig;
  // Absent on runs written before tiers existed, and on a single-owner
  // deployment that has never had a second account. Both mean the run behaves
  // as it always did.
  const execution = config.execution !== false;
  // Connected per run and released in the finally below. A worker that lives
  // for the life of the process would otherwise accumulate one set of
  // connections per run it has ever driven.
  const mcp = run.user_id ? await mcpForUser(run.user_id, signal) : undefined;
  // Media goes through OpenRouter. When the run is already on OpenRouter its
  // key is the same key, so media works without configuring anything twice; on
  // any other provider it needs its own, and without one the tools are simply
  // not offered rather than offered and failing.
  const mediaKey = /(^|\.)openrouter\.ai$/.test(hostOf(config.baseUrl))
    ? config.apiKey
    : (process.env.HIKMAH_MEDIA_KEY ?? '');

  const agent = buildRunAgent({
    provider: {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      freeOnly: config.freeOnly,
    },
    instructions: config.instructions,
    maxSteps: config.maxSteps,
    // buildRunAgent has accepted this since it was written and nothing passed
    // it, so the setting existed with nowhere to land.
    contextCharacters: config.contextCharacters,
    contextWindow: config.contextWindow,
    // Likewise. The plan steps went into the tool's own result and no further,
    // so a multi-step run showed a JSON payload where a checklist belonged.
    // Emitted as a chunk, it joins the durable log like any other: it replays
    // to a reconnecting tab and persists on the finished message.
    onPlan: (steps) => emit({ type: 'data-plan', id: 'plan', data: { steps } }),
    meaningModel: initialModel,
    disabledTools: config.disabledTools ?? [],
    enabledTools: config.enabledTools ?? [],
    // Only when the deployment actually has a workbench: without one, ssh_exec
    // would be offered and then fail on every call. And only for a run entitled
    // to reach a machine — the workbench is one container with one /workspace
    // volume shared by everyone, so with more than one account these are the
    // operator's tools until execution is per-tenant.
    ssh: execution && run.user_id ? sshRunContext(run.user_id) : undefined,
    shell: {
      conversationId: run.conversation_id ?? run.id,
      available: execution && workbenchReady(),
    },
    mcp,
    files: run.user_id
      ? { userId: run.user_id, files: createFileStore(getStorage().raw) }
      : undefined,
    media: run.user_id
      ? {
          userId: run.user_id,
          assets: createMediaAssets(getStorage().BUCKET),
          key: mediaKey,
          imageModel: process.env.HIKMAH_IMAGE_MODEL,
          speechModel: process.env.HIKMAH_SPEECH_MODEL,
          speechVoice: process.env.HIKMAH_SPEECH_VOICE,
        }
      : undefined,
    signal,
  });

  try {
    const stream = await createAgentUIStream({
      agent,
      uiMessages: messages,
      abortSignal: signal,
      // What the answer cost, recorded on the answer itself. Without it the
      // composer can show a context meter for the conversation it is about to
      // send and nothing at all for the one already written, and a reload
      // loses the figures entirely because they were never a row.
      messageMetadata: ({ part }) =>
        part.type === 'finish'
          ? { model: config.model, usage: part.totalUsage, finishedAt: Date.now() }
          : undefined,
      // Without this the SDK redacts every failure to "An error occurred." and
      // emits that as the error chunk — so a missing key, a rejected model and
      // a provider outage all reached the owner identically, with the real
      // reason discarded before it was ever written down.
      //
      // This is a single-owner deployment talking to a provider the owner
      // configured, so the provider's own words are theirs to see. It is the
      // only way to tell "you have no key" from "that model does not exist".
      onError: (error) =>
        error instanceof Error && error.message ? error.message : 'The run failed.',
    });

    // Tee the chunks: one copy into the durable log, one into the fold that
    // produces the final message row. Both halves matter — the log is what a
    // reconnecting client replays, the fold is what becomes the stored message.
    const replay = new ReadableStream({
      async start(controller) {
        const push = (chunk: unknown) => {
          emit(chunk);
          controller.enqueue(chunk);
        };
        // The comparison runs alongside rather than after: the point of the
        // mode is watching the two answers arrive together, and running them in
        // sequence would double the wait for no gain.
        await Promise.all([
          (async () => {
            for await (const chunk of stream as AsyncIterable<unknown>) push(chunk);
          })(),
          config.compare
            ? runComparison({
                provider: {
                  baseUrl: config.baseUrl,
                  model: config.compare.model || config.model,
                  apiKey: config.apiKey,
                  freeOnly: config.freeOnly,
                },
                instructions: config.instructions,
                messages: messages as UIMessage[],
                signal,
                write: push,
              })
            : Promise.resolve(),
        ]);
        controller.close();
      },
    });

    let message: unknown;
    for await (const value of readUIMessageStream({ stream: replay as never })) message = value;
    // What the answer cost, as a row rather than only as JSON on the message.
    // A cap has to be a SUM over an index, and the spend survives the person
    // deleting the conversation that caused it.
    recordRunUsage(run, config, message);
    // A tool that needs the owner's say-so leaves its part in
    // 'approval-requested'. The run is not finished, it is waiting for a person,
    // and the worker has to tell those apart or the answer arrives too late to
    // matter.
    const parts =
      (message as { parts?: { type?: string; state?: string }[] } | undefined)?.parts ?? [];
    const awaitingApproval = parts.some((part) => part?.state === 'approval-requested');
    // ask_user has no execute, so the SDK leaves its call in input-available and
    // ends the stream there. That is not a finished answer either: the person is
    // the implementation, and the run resumes when they supply the output.
    const awaitingClient =
      !awaitingApproval &&
      parts.some((part) => part?.type === ASK_USER_PART && part?.state === 'input-available');
    // Neither waiting nor answering: the loop ended with tool calls and no
    // words. Reported rather than recorded as success, because success with
    // nothing to show is indistinguishable from the app being broken.
    const silent = !awaitingApproval && !awaitingClient && !answered(parts);
    return { message, awaitingApproval, awaitingClient, silent };
  } finally {
    await mcp?.close();
  }
}

export function runService(): Worker {
  if (globalThis.__hikmahRunService) return globalThis.__hikmahRunService;
  const storage = getStorage();
  const worker = createWorker({
    db: storage.raw,
    drive: driveWithAgent,
    onError: (error) => {
      // Surfaced on the run row as well; this is for the operator's log.
      console.error('[hikmah] run failed:', error instanceof Error ? error.message : error);
    },
  });
  globalThis.__hikmahRunService = worker;
  return worker;
}

/** Write one usage row for a finished drive.
 *
 * Best effort on purpose: a run that produced an answer must not be reported as
 * failed because the accounting row could not be written. A missing row
 * undercounts one run; a thrown error loses the answer.
 */
function recordRunUsage(
  run: { id: string; user_id?: string },
  config: RunConfig,
  message: unknown,
): void {
  if (!run.user_id) return;
  const usage = (
    message as
      { metadata?: { usage?: { inputTokens?: number; outputTokens?: number } } } | undefined
  )?.metadata?.usage;
  const inputTokens = Number(usage?.inputTokens ?? 0);
  const outputTokens = Number(usage?.outputTokens ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return;
  if (inputTokens <= 0 && outputTokens <= 0) return;
  try {
    createBillingStore(getStorage().raw).recordUsage({
      id: 'use_' + randomUUID(),
      userId: run.user_id,
      runId: run.id,
      model: config.model,
      metered: config.metered === true,
      inputTokens,
      outputTokens,
    });
  } catch (error) {
    console.error('[hikmah] usage not recorded:', error instanceof Error ? error.message : error);
  }
}

/** The host of a base URL, or '' when it is not a URL at all. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const newRunId = () => 'run_' + randomUUID();
export const newConversationId = () => 'conv_' + randomUUID();
export const newMessageId = () => 'msg_' + randomUUID();
