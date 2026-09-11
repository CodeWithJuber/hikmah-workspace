/** The process-wide run service.
 *
 * One worker per process, created on first use and reused. Kept off the module
 * top level so importing a route does not start a worker, and stored on
 * globalThis so Next's dev-mode module reloading cannot end up with two workers
 * racing for the same queue.
 */
import { randomUUID } from 'node:crypto';
import { createAgentUIStream, readUIMessageStream } from 'ai';
import { getStorage } from '@/server/storage.mjs';
import { buildRunAgent } from '../ai/run-agent.ts';
import { sshRunContext } from '../ssh/run-context.ts';
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
  run: { id: string; user_id?: string; config: string };
  messages: unknown[];
  signal: AbortSignal;
  emit: (chunk: unknown) => number;
}) {
  const config = JSON.parse(run.config) as RunConfig;
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
    signal,
  });

  const stream = await createAgentUIStream({ agent, uiMessages: messages, abortSignal: signal });

  // Tee the chunks: one copy into the durable log, one into the fold that
  // produces the final message row.
  const recorded: unknown[] = [];
  const replay = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream as AsyncIterable<unknown>) {
        emit(chunk);
        recorded.push(chunk);
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  let message: unknown;
  for await (const value of readUIMessageStream({ stream: replay as never })) message = value;
  return { message };
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

export const newRunId = () => 'run_' + randomUUID();
export const newConversationId = () => 'conv_' + randomUUID();
export const newMessageId = () => 'msg_' + randomUUID();
