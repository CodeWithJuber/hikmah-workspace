/** The process-wide run service.
 *
 * One worker per process, created on first use and reused. Kept off the module
 * top level so importing a route does not start a worker, and stored on
 * globalThis so Next's dev-mode module reloading cannot end up with two workers
 * racing for the same queue.
 */
import { randomUUID } from 'node:crypto';
import { createAgentUIStream, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { getStorage } from '@/server/storage.mjs';
import { createMediaAssets } from '../server/media-assets.ts';
import { createFileStore } from '../files/store.ts';
import { buildRunAgent } from '../ai/run-agent.ts';
import { runComparison } from '../ai/compare.ts';
import { sshRunContext, workbenchReady } from '../ssh/run-context.ts';
import { mcpForUser } from '../mcp/app-context.ts';
import { initialModel } from '../playground/session.ts';
import { ASK_USER_PART } from './resume.ts';
import { answered, NO_ANSWER } from './failure.ts';
import { mediaKeyFor } from './media.ts';
import { executionAllowed } from './execution.ts';
import { workbenchUserKey } from '../workbench/user-key.ts';
import { createMemoryStore } from '../memory/store.ts';
import { triageCandidate } from '../memory/triage.ts';
import { recentUserText } from '../context-model/run-brief.ts';
import type { MemoryToolContext } from '../ai/tools/memory.ts';
import { withClosingStep } from '../ai/closing-step.ts';
import { nameAnswer } from './answer-id.ts';
import { createLanguageModel } from '../ai/models.ts';
import { createBillingStore } from '../billing/store.ts';
import { createWorker, type Worker } from './worker.ts';
import { runConcurrency } from './concurrency.ts';
import { createChatSettingsStore } from '../chat/settings-store.ts';
import { grantsFor } from '../chat/approvals.ts';
import { captureCompletedRun } from '../learning/server.ts';
import type { LearningConsent } from '../learning/types.ts';
import { executionRunConfig } from '../../server/run-credentials.mjs';
import { safeDiagnostic } from './safe-error.ts';
import { jevLane, applyJevLane } from './jev-lane.ts';
import { withFirstByteLimit } from '../ai/first-byte.ts';
import { createRunBudgetLedger, asBudget } from '../workflow/ledger.ts';
import { withRunBudget, BudgetExhaustedError } from '../ai/budget-middleware.ts';

declare global {
  var __hikmahRunService: Worker | undefined;
}

/** How long a free-tier run waits for the provider's first byte.
 *
 * Free models queue server-side, and the SDK retries quietly, so one slow
 * upstream call used to become minutes of "Planning the answer…" with zero
 * tokens and nothing to act on. Past this bound the run fails with a sentence
 * the person can act on instead of stalling silently. Paid and BYOK runs keep
 * the patient default: their providers answer, they just sometimes think. */
const FREE_FIRST_BYTE_MS = 90_000;

/** Stored on the run and shown on the failure card when the bound above trips.
 * A plain sentence, because the failure path passes a plain Error's message
 * through untouched — and because "your message is saved, try again" is the
 * whole difference between a dead end and a queue. */
const FREE_QUEUE_BUSY =
  'The free model queue is busy — no answer started within 90 seconds. ' +
  'Your message is saved; wait a moment and try again, or add your own key for instant answers.';

/** Per-request configuration. The durable row replaces apiKey with an
 * authenticated encrypted snapshot; it is decrypted only while executing. */
export type RunConfig = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKey: string;
  learning?: LearningConsent;
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
  /** Whether this run may generate pictures and speech.
   *
   * Absent means yes, which keeps every run row written before this existed
   * behaving as it did — the same convention `execution` uses. */
  media?: boolean;
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
  /** Offer `deep_research` this turn. */
  deepResearch?: boolean;
  /** Search the web this turn: the composer's Search switch. */
  webSearch?: boolean;
  /** The saved memories this run's prompt drew on, decided at creation. Streamed
   * as a `data-memories` part so the answer can say what it used. */
  memories?: UsedMemory[];
  /** The earlier conversations the prompt carried excerpts from. */
  recalled?: RecalledConversation[];
  /** Whether `remember` may save a verbatim preference without review. Absent
   * means yes, the default the setting has. */
  remember?: { autoSave: boolean };
  /** Session incognito: this run reads and writes no memory. The runs route
   * sets it from the request flag; here it withholds the `remember` tool
   * entirely (suggestions would still write rows), and the stored config's
   * learning consent is narrowed to disabled in the store. Absent means a
   * normal run. */
  incognito?: boolean;
  /** Set on a background task: a run nobody is watching. It is driven
   * unattended — no question, no tool that waits for approval — and claimed
   * only while no other task is running. `brief` is what the person asked it
   * to learn, kept here so the list and the report can say so. */
  task?: { kind: 'learn'; brief: string };
  /** v5 workflow plan, stamped by enqueueRun (lib/runs/enqueue.ts): which arm
   * the policy chose and why, and the budget the run may spend. Streamed as a
   * `data-workflow` part when the run starts so the run card can show it.
   * Structural, not the lib/workflow types: this crosses the sealed-config
   * JSON boundary, and the seal spreads unknown keys through untouched. */
  workflow?: {
    arm: string;
    budget: { maxCalls: number; maxTokens: number; maxCost: number; deadlineMs: number };
    selection:
      | { scores: Record<string, number>; propensity: number; featureVersion: number }
      | { overridden: true };
    terminalState?: string;
  };
};

/** One memory an answer drew on, as the receipt names it. */
export type UsedMemory = { id: string; title: string; kind: 'preference' | 'reference' };
/** One earlier conversation an answer was written with an excerpt from. */
export type RecalledConversation = { id: string; title: string };

/**
 * Drive one run with the same agent the request-scoped chat route uses.
 *
 * Every streamed chunk is appended to the run's event log before it is fanned
 * out, so a client that connects late or reconnects gets the same bytes in the
 * same order as one that was there from the start.
 */
/** The workbench's opaque name for this run's owner, or '' when there is no
 * owner — in which case `available` above is false and it is never sent. */
function shellUserKey(userId: string | undefined): string {
  const secret = process.env.HIKMAH_WORKBENCH_TOKEN ?? '';
  return userId && secret ? workbenchUserKey(userId, secret) : '';
}

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
  const config = executionRunConfig(run) as RunConfig;
  // Absent means no. This read used to be `!== false`, so a config that simply
  // did not carry the key was granted the workbench shell and SSH — a gate
  // failing in the one direction a gate must not. See lib/runs/execution.ts.
  const execution = executionAllowed(config);
  // Jev preflight: the safest execution lane for this task, proposed by
  // TypeSafe System One. Kicked off before the connects below so a slow Jev
  // overlaps them instead of adding to the wait; null on any failure, and
  // the run then behaves exactly as it did before the preflight existed.
  const lanePromise = jevLane(recentUserText(messages as Turn[], 1)).catch(() => null);
  // Connected per run and released in the finally below. A worker that lives
  // for the life of the process would otherwise accumulate one set of
  // connections per run it has ever driven.
  const mcp = run.user_id ? await mcpForUser(run.user_id, signal) : undefined;
  const mediaKey = mediaKeyFor(config);
  // Built once here rather than inside buildRunAgent, because the closing step
  // below talks to the same model after the agent loop has finished with it.
  const provider = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    freeOnly: config.freeOnly,
  };
  const model = createLanguageModel(provider);

  // PR-04: the stored budget enters the execution path here. One durable
  // ledger per run, shared by the agent, every research lane, the closing
  // step and the compare lane: each provider dispatch reserves capacity
  // before it goes out and settles actual usage after. The wrapped model is
  // passed everywhere the raw one went, so lanes cannot bypass it. Runs
  // stamped before the workflow budget existed carry no budget and behave
  // exactly as before.
  const storedBudget = asBudget(config.workflow?.budget);
  const ledger = storedBudget
    ? createRunBudgetLedger(getStorage().raw, run.id, storedBudget)
    : undefined;
  // The agent loop swallows a refused dispatch into an error chunk, so this
  // flag (not the throw) is how the drive knows the budget — rather than the
  // provider or the tools — cut the run short. Only the main answer's model
  // sets it: the compare lane's exhaustion is captured on its own card.
  let budgetError: BudgetExhaustedError | null = null;
  const callModel = ledger
    ? withRunBudget(model, ledger, {
        onExhausted: (error) => {
          budgetError = error;
        },
      })
    : model;

  // Where a tool's data parts go. Until the stream is open they can only be
  // logged; once it is, `push` below routes them into the fold as well, so the
  // research card is persisted on the message and not only replayed.
  let sink: (chunk: unknown) => void = emit;

  // The lane Jev proposed, mapped onto the existing options. A null proposal
  // — Jev unreachable, keyless, or slow — leaves every option exactly as the
  // config set it: Jev proposes, it never blocks.
  const routed = applyJevLane(
    { instructions: config.instructions, deepResearch: config.deepResearch === true },
    await lanePromise,
    { unattended: Boolean(config.task) },
  );

  const agent = buildRunAgent({
    provider,
    model: callModel,
    instructions: routed.instructions,
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
    onData: (chunk) => sink(chunk),
    // Each research lane is its own agent with its own usage; the message's
    // metadata carries only the parent's, so without this the lanes would be
    // the one thing the run did that nobody was charged for.
    onLaneUsage: (_lane, usage) => recordLaneUsage(run, config, usage),
    deepResearch: routed.deepResearch,
    webSearch: config.webSearch === true,
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
      // The workbench gives each account its own Unix user and directory, and
      // refuses a run that does not say whose it is. A run with no user cannot
      // name one, so it gets no shell rather than a shared one.
      userKey: shellUserKey(run.user_id),
      available: execution && Boolean(run.user_id) && workbenchReady(),
    },
    mcp,
    files: run.user_id
      ? { userId: run.user_id, files: createFileStore(getStorage().raw) }
      : undefined,
    // `remember` may only quote the last user turn — not the last message,
    // which on a resume is the assistant's — and knows whether that turn
    // carried files, because a pasted document is not the person's own words.
    // Withheld entirely for an incognito run: even a suggestion writes a row.
    memory:
      run.user_id && !config.incognito ? memoryContext(run, config, messages as Turn[]) : undefined,
    // A task cannot stop on a card nobody is watching.
    unattended: Boolean(config.task),
    // What the owner has already said yes to, read now rather than at
    // creation: a grant made on the card while this run was paused has to
    // apply the moment it resumes, and a resume is this function again.
    approvals: run.user_id
      ? grantsFor(
          createChatSettingsStore(getStorage().raw).read(run.user_id).approvals,
          run.conversation_id ?? run.id,
        )
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
    // The free tier queues server-side: bound the wait for the provider's
    // first byte. A linked controller, so the person's own stop still aborts
    // through the same path and the run is recorded cancelled, not failed.
    const byteController = config.freeOnly ? new AbortController() : null;
    if (byteController) {
      if (signal.aborted) byteController.abort(signal.reason);
      else
        signal.addEventListener('abort', () => byteController.abort(signal.reason), { once: true });
    }
    const stream = await createAgentUIStream({
      agent,
      uiMessages: messages,
      abortSignal: byteController?.signal ?? signal,
      // What the answer cost, recorded on the answer itself. Without it the
      // composer can show a context meter for the conversation it is about to
      // send and nothing at all for the one already written, and a reload
      // loses the figures entirely because they were never a row.
      messageMetadata: ({ part }) =>
        part.type === 'finish'
          ? {
              model: config.model,
              usage: part.totalUsage,
              finishedAt: Date.now(),
              finishReason: part.finishReason,
            }
          : undefined,
      // Without this the SDK redacts every failure to "An error occurred." and
      // emits that as the error chunk — so a missing key, a rejected model and
      // a provider outage all reached the owner identically, with the real
      // reason discarded before it was ever written down.
      //
      // This is a single-owner deployment talking to a provider the owner
      // configured, so the provider's own words are theirs to see. It is the
      // only way to tell "you have no key" from "that model does not exist".
      onError: (error) => safeDiagnostic(error, [config.apiKey]),
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
        sink = push;
        // The answer's id, decided here and told to the browser on the first
        // chunk. A fresh turn's `start` carries no id, so the browser made one
        // up while the worker stored the answer as `<run>-answer`; the two
        // never met, and answering an approval on a live stream — which
        // re-sends the message by id — was refused every time with "no longer
        // matches the paused turn". A resumed turn's `start` already names the
        // stored message; that is kept.
        const name = (chunk: unknown) => nameAnswer(chunk, run.id);
        // The comparison runs alongside rather than after: the point of the
        // mode is watching the two answers arrive together, and running them in
        // sequence would double the wait for no gain.
        await Promise.all([
          (async () => {
            // With one forced answering step appended when the loop ends on a
            // tool result and no words — the small free models' habit that
            // reached the owner as "stopped without writing an answer". See
            // lib/ai/closing-step.ts.
            let started = false;
            const answerChunks = withClosingStep(stream as AsyncIterable<UIMessageChunk>, {
              model: callModel,
              tools: agent.tools,
              instructions: config.instructions,
              messages: messages as UIMessage[],
              signal,
              contextCharacters: config.contextCharacters,
              onError: (error) =>
                console.error(
                  '[hikmah] closing step failed:',
                  safeDiagnostic(error, [config.apiKey]),
                ),
            });
            // Free-tier only: fail fast with an honest sentence when the
            // provider's first byte never comes, instead of stalling for
            // minutes. The abort kills the hung provider call; the thrown
            // error becomes the run's failure reason.
            const bounded = byteController
              ? withFirstByteLimit(
                  answerChunks,
                  FREE_FIRST_BYTE_MS,
                  () => byteController.abort(),
                  () => new Error(FREE_QUEUE_BUSY),
                )
              : answerChunks;
            for await (const chunk of bounded) {
              push(name(chunk));
              // Right after the message opens, so the fold has a message to
              // attach it to: which memories this answer was written with.
              // Not an answer in itself — failure.ts and the closing step both
              // leave it out of the "did the turn say anything" test.
              if (!started && chunk.type === 'start') {
                started = true;
                if (config.memories?.length || config.recalled?.length)
                  push({
                    type: 'data-memories',
                    id: 'memories',
                    data: { used: config.memories ?? [], conversations: config.recalled ?? [] },
                  });
                // The v5 workflow plan for this run: which arm the policy
                // chose and why, and the budget it may spend. Right after the
                // message opens, so the fold has a message to attach it to —
                // the same placement as data-memories above. Skipped when the
                // resumed turn already carries one, so a resume does not stack
                // a second card. Read by the run card in
                // components/chat/message-parts.tsx. A model judgment about
                // how to work, never a promise about the answer.
                if (config.workflow && !workflowPartPresent)
                  push({ type: 'data-workflow', id: 'workflow-plan', data: config.workflow });
              }
            }
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
                // The contrast answer is a provider call like any other: it
                // draws from the same durable budget rather than beside it.
                // Wrapped separately because it may name a different model
                // than the main answer.
                model: ledger
                  ? withRunBudget(
                      createLanguageModel({
                        ...provider,
                        model: config.compare.model || config.model,
                      }),
                      ledger,
                    )
                  : undefined,
              })
            : Promise.resolve(),
        ]);
        controller.close();
      },
    });

    // A resumed run continues the assistant turn that paused, and the fold has
    // to start from that turn: the chunks that follow are a tool output for a
    // call that lives on it and then the words. Folded from nothing, the
    // first of those names a call the fold has never seen, the SDK throws
    // "tool invocation not found", and the run that the person just allowed
    // ended with no parts and the "stopped without writing an answer" card.
    // A fresh turn's transcript ends with the person's message, so nothing is
    // handed in and the fold opens a new turn as before.
    const last = messages[messages.length - 1] as UIMessage | undefined;
    const paused = last?.role === 'assistant' ? structuredClone(last) : undefined;
    // Whether the resumed turn already carries its workflow plan card, so the
    // start-chunk push above does not stack a second one. See the data-memories
    // precedent: the same resume would otherwise duplicate that part too.
    const workflowPartPresent = (
      paused as { parts?: { type?: string }[] } | undefined
    )?.parts?.some((p) => p?.type === 'data-workflow');
    let message: unknown = paused;
    for await (const value of readUIMessageStream({ stream: replay as never, message: paused }))
      message = value;
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
    // PR-04: the budget — not the provider, not the tools — cut this run
    // short mid-loop. The agent loop swallowed the refusal into an error
    // chunk, so without this the run would be recorded as a generic failure
    // or as "stopped without writing an answer". Throwing the typed error
    // records the explicit exhaustion state and sentence instead.
    if (budgetError && !awaitingApproval && !awaitingClient) throw budgetError;
    // Into the stream, not only onto the run row. The worker records the
    // reason after the stream has closed, so a tab that watched the whole run
    // live saw a clean ending and showed nothing at all — the reason only
    // appeared on a reload, which is not where the person is looking. This
    // chunk reaches them where they are watching.
    if (silent) emit({ type: 'error', errorText: NO_ANSWER });
    return { message, awaitingApproval, awaitingClient, silent };
  } catch (error) {
    // The budget — not a provider fault — ended the run. Stamp the explicit
    // terminal state onto the workflow stamp so the exhaustion is queryable,
    // not just readable in the failure sentence. The worker still finishes
    // the run 'failed' with that sentence; this catch only records the state
    // and rethrows.
    if (error instanceof BudgetExhaustedError)
      stampBudgetTerminalState(run.id, error.terminalState);
    throw error;
  } finally {
    await mcp?.close();
  }
}

/** Record the explicit exhaustion state on the run row's workflow stamp.
 *
 * Best effort on purpose, like the usage rows below: accounting must never
 * break the failure path it is annotating. json_set creates the path when a
 * pre-policy row has no workflow stamp at all.
 */
function stampBudgetTerminalState(
  runId: string,
  terminalState: 'budget_exhausted' | 'timeout',
): void {
  try {
    getStorage()
      .raw.prepare(
        `UPDATE runs SET config = json_set(config, '$.workflow.terminalState', ?) WHERE id = ?`,
      )
      .run(terminalState, runId);
  } catch (error) {
    console.error(
      '[hikmah] budget terminal state not stamped:',
      error instanceof Error ? error.message : error,
    );
  }
}

/** A stored message as far as the memory context reads it. */
type Turn = { role?: string; parts?: { type?: string; text?: string }[] };

/** What the `remember` tool needs to know about this run. */
function memoryContext(
  run: { user_id?: string; conversation_id?: string },
  config: RunConfig,
  messages: Turn[],
): MemoryToolContext {
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  const title = run.conversation_id
    ? (
        getStorage()
          .raw.prepare('SELECT title FROM conversations WHERE id = ?')
          .get(run.conversation_id) as { title?: string } | undefined
      )?.title
    : undefined;
  return {
    userId: run.user_id ?? '',
    store: createMemoryStore(getStorage().raw),
    // The raw handle, for triage: it writes its own tables beside the store.
    db: getStorage().raw,
    latestUserText: recentUserText(messages, 1),
    hasAttachments: (lastUser?.parts ?? []).some((part) => part?.type === 'file'),
    conversationId: run.conversation_id,
    conversationTitle: title || undefined,
    // A task never auto-saves a verbatim quote: its candidates go through
    // the standing triage policy (see the `remember` tool), which decides
    // what is saved outright, surfaced, or discarded.
    autoSaveQuotes: !config.task && config.remember?.autoSave !== false,
    unattended: Boolean(config.task),
    // The run's consent state, for triage: incognito writes nothing at all.
    incognito: config.incognito === true,
    // The learner's only way into the memories table: triage decides, the
    // tool never writes directly. Wired here, the one place the context is
    // built, so no caller can forget it.
    triage: triageCandidate,
  };
}

/** Re-exported for any importer that reached for it on the service. */
export { DEFAULT_RUN_CONCURRENCY, runConcurrency } from './concurrency.ts';

export function runService(): Worker {
  if (globalThis.__hikmahRunService) return globalThis.__hikmahRunService;
  const storage = getStorage();
  const worker = createWorker({
    db: storage.raw,
    drive: driveWithAgent,
    onCompleted: captureCompletedRun,
    // Two by default: a chat and, beside it, one background task. The last
    // slot is always a chat's, so a task never makes a conversation wait.
    concurrency: runConcurrency(process.env.HIKMAH_RUN_CONCURRENCY),
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

/** One usage row for one finished research lane. Best effort, as above. */
function recordLaneUsage(
  run: { id: string; user_id?: string },
  config: RunConfig,
  usage: { inputTokens: number; outputTokens: number },
): void {
  if (!run.user_id) return;
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return;
  try {
    createBillingStore(getStorage().raw).recordUsage({
      id: 'use_' + randomUUID(),
      userId: run.user_id,
      runId: run.id,
      model: config.model,
      metered: config.metered === true,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  } catch (error) {
    console.error(
      '[hikmah] lane usage not recorded:',
      error instanceof Error ? error.message : error,
    );
  }
}

export const newRunId = () => 'run_' + randomUUID();
export const newConversationId = () => 'conv_' + randomUUID();
export const newMessageId = () => 'msg_' + randomUUID();
