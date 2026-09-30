import { validateUIMessages, type UIMessage } from 'ai';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin, parseChatRequest } from '@/lib/ai/chat-request';
import { conversationTitle } from '@/lib/chat/title';
import { newConversationId, newMessageId, newRunId, runService } from '@/lib/runs/service';
import { enqueueRun, enqueueCap, EnqueueFullError } from '@/lib/runs/enqueue';
import { createWorkflowStore } from '@/lib/workflow/store';
import { knowledgeFor, resolveRunAccess } from '@/lib/runs/prepare';
import { phaseChunk } from '@/lib/runs/telemetry';
import { LEARNER_BRIEF, TASK_TITLE_PREFIX } from '@/lib/runs/learner';
import { getStorage } from '@/server/storage.mjs';
import { createChatSettingsStore } from '@/lib/chat/settings-store';
import { composePrompt } from '@/lib/ai/compose-prompt';
import { principleDigest } from '@/lib/kernel/principles';
import { createTaskContinuityStore } from '@/lib/tasks/continuity-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
/** Idempotency keys are client-generated per start-dialog opening, so a retry
 * of the same start replays the same task instead of dispatching a duplicate. */
const MAX_IDEMPOTENCY_KEY = 128;

const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** A brief is a paragraph, not a document: what to learn, not the material. */
const MAX_BRIEF = 4000;
/** Below every chat on every tier, so a task never makes a conversation wait
 * in the queue — the worker keeps a slot for chat as well, but the order
 * matters when the queue is longer than the slots. */
const TASK_PRIORITY = -1;

/**
 * Start a background learning task.
 *
 * A task is its own conversation with `mode = 'task'`, never a run inside the
 * chat it was started from: that would refuse the person's next message for
 * the task's whole duration, attach a reload to the task's stream, and land
 * /chat on the task. The run is queued unattended (no question, no tool that
 * waits for approval — see `buildRunAgent`) and the person stays where they
 * were; the list shows the task under its own heading, and its report is
 * there when they come back.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    assertSameOrigin(request, publicOrigin(request));
  } catch (error) {
    if (error instanceof ChatRequestError) return fail(error.message, error.status);
    throw error;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail('Expected a JSON request body.', 400);
  }
  const brief = typeof body?.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return fail('Say what to learn.', 400);
  if (brief.length > MAX_BRIEF) return fail('Keep the brief under 4,000 characters.', 400);

  const rawKey = body?.idempotencyKey;
  const idempotencyKey = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : null;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY)
    return fail('That start key is too long.', 400);

  const continuity = createTaskContinuityStore(getStorage().raw);
  if (idempotencyKey) {
    // Idempotent replay: this key already started a task. Return its ids
    // instead of dispatching a duplicate — a retried start (lost response,
    // reload mid-flight) must not spend twice or create a second task.
    const existing = continuity.findByKey(user.userId, idempotencyKey);
    if (existing) {
      return Response.json(
        { conversationId: existing.conversationId, runId: existing.runId, resumed: true },
        { headers },
      );
    }
  }

  // The brief is the task's first and only user turn, so the run configuration
  // is validated exactly as a chat turn's is.
  const turn = { id: newMessageId(), role: 'user', parts: [{ type: 'text', text: brief }] };
  let parsed;
  try {
    parsed = parseChatRequest({ ...body, messages: [turn], trigger: undefined });
  } catch (error) {
    if (error instanceof ChatRequestError) return fail(error.message, error.status);
    return fail('The task could not be read.', 400);
  }
  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: parsed.messages as UIMessage[] });
  } catch {
    return fail('The task could not be read.', 400);
  }

  const worker = runService();
  const store = worker.store;
  if (store.countActive(user.userId) >= enqueueCap())
    return fail('Too many runs are already in progress. Wait for one to finish.', 429);

  const { access, refused } = await resolveRunAccess(user, parsed);
  if (refused) return fail(refused, 400);
  const entitlements = access.entitlements;

  // Timed as the run's `preparation` segment (PR-07): who may spend what and
  // the saved knowledge — everything the task is prepared with before it is
  // queued. The co-model's notes are not part of a task's preparation.
  const preparationStarted = Date.now();
  const chatSettings = createChatSettingsStore(getStorage().raw).read(user.userId);
  const conversationId = newConversationId();
  // What the person has saved and said before, so the task builds on it rather
  // than starting from nothing. The co-model's notes are left out: they are
  // about the shape of a conversation, and a task is not one.
  //
  // Incognito: the session opts out entirely, server-side. Skipping the
  // lookup here is what makes the toggle honest — no block, no recall, no
  // used-count marks — and the run below is created with the remember tool
  // withheld and learning capture disabled.
  const saved = parsed.incognito
    ? { block: '', recall: '', used: [], conversations: [] }
    : await knowledgeFor(user.userId, messages, {
        conversationId,
        recall: chatSettings.memory.recallConversations,
      });

  const runId = newRunId();
  try {
    store.createConversation({
      id: conversationId,
      userId: user.userId,
      mode: 'task',
      model: parsed.model,
      // Two tasks that start the same way share an opening line; the suffix
      // keeps their sidebar rows distinct.
      title: store.uniqueTitle(user.userId, TASK_TITLE_PREFIX + conversationTitle(turn.parts)),
    });
    store.appendMessage(conversationId, {
      id: turn.id,
      role: 'user',
      parts: turn.parts,
      metadata: undefined,
    });
  } catch {
    return fail('The task could not be started. Try again.', 503);
  }
  // The continuity row is what makes a retried start replay this task instead
  // of dispatching a duplicate (PR-16b). Written after the conversation exists
  // (foreign key) and before the run is queued, so the row always names a
  // real task.
  try {
    continuity.create({
      conversationId,
      userId: user.userId,
      idempotencyKey,
      runId,
    });
  } catch (error) {
    const raced =
      idempotencyKey &&
      /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
    if (raced) {
      // A racing POST with the same key won: replay the winner rather than
      // queue a second run. The winner's row is the dedupe arbiter.
      const winner = continuity.findByKey(user.userId, idempotencyKey as string);
      if (winner) {
        return Response.json(
          { conversationId: winner.conversationId, runId: winner.runId, resumed: true },
          { headers },
        );
      }
    }
    // Degraded but working: the task exists and will run; only the
    // retry-safety record is missing. Failing the start here would be worse —
    // the client would retry and create the very duplicate this prevents.
    console.error('[hikmah] task continuity row not recorded:', error);
  }
  try {
    enqueueRun({
      runId,
      userId: user.userId,
      conversationId,
      priority: TASK_PRIORITY,
      selection: {
        promptText: brief,
        taskCategory: 'task',
        hasProviderKey: access.apiKey !== '',
        localFrame: null,
      },
      store,
      workflowStore: createWorkflowStore(getStorage().raw),
      config: {
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        freeOnly: parsed.freeOnly,
        apiKey: access.apiKey,
        metered: access.metered,
        execution: access.execution,
        media: entitlements.media,
        operator: entitlements.tier === 'owner',
        instructions: composePrompt({
          base: parsed.instructions + '\n\n' + LEARNER_BRIEF,
          principles: principleDigest(),
          knowledge: saved.block,
          recall: saved.recall,
          contextNotes: '',
        }),
        memories: saved.used,
        recalled: saved.conversations,
        // Nothing a task keeps is saved without review.
        remember: { autoSave: false },
        task: { kind: 'learn', brief },
        // Incognito narrows the server-owned learning consent to disabled and
        // withholds the remember tool entirely (see service.ts): a task that
        // cannot read memory must not write it either.
        learning: parsed.incognito ? { enabled: false, revision: -1 } : undefined,
        incognito: parsed.incognito,
        maxSteps: parsed.maxSteps,
        contextCharacters: parsed.contextCharacters,
        contextWindow: parsed.contextWindow,
        disabledTools: parsed.disabledTools,
        enabledTools: parsed.enabledTools,
      },
    });
  } catch (error) {
    // The task never started, so its continuity row must not outlive it:
    // otherwise a retry with the same key would replay a task that does not
    // exist. Removing our own just-written row is cleanup, not deletion of
    // user data.
    try {
      continuity.remove(conversationId);
    } catch {
      /* best effort — the row is harmless without a queued run */
    }
    if (error instanceof EnqueueFullError)
      return fail('Too many runs are already in progress. Wait for one to finish.', 429);
    return fail('The task could not be started. Try again.', 503);
  }

  // The preparation segment closes at the queue, like a chat turn's. Announced
  // on the task's event stream so the whole sequence is replayable (PR-07).
  store.recordSegment(runId, 'preparation', Date.now() - preparationStarted);
  const queuedChunk = phaseChunk(runId, 'queued');
  const queuedSeq = store.appendEvent(runId, queuedChunk);
  worker.bus.emit(runId, { seq: queuedSeq, payload: queuedChunk });

  void worker.tick();
  return Response.json({ conversationId, runId }, { headers, status: 202 });
}
