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
  instructions: string;
  maxSteps?: number;
  disabledTools?: string[];
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
    meaningModel: initialModel,
    disabledTools: config.disabledTools ?? [],
    // Only when the deployment actually has a workbench: without one, ssh_exec
    // would be offered and then fail on every call.
    ssh: run.user_id ? sshRunContext(run.user_id) : undefined,
    shell: { conversationId: run.conversation_id ?? run.id, available: workbenchReady() },
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
    const stream = await createAgentUIStream({ agent, uiMessages: messages, abortSignal: signal });

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
    // A tool that needs the owner's say-so leaves its part in
    // 'approval-requested'. The run is not finished, it is waiting for a person,
    // and the worker has to tell those apart or the answer arrives too late to
    // matter.
    const parts = (message as { parts?: { state?: string }[] } | undefined)?.parts ?? [];
    const awaitingApproval = parts.some((part) => part?.state === 'approval-requested');
    return { message, awaitingApproval };
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
