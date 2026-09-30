import { getChatGPTUser } from '../../../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { ChatRequestError, assertSameOrigin } from '@/lib/ai/chat-request';
import { runService } from '@/lib/runs/service';
import { getStorage } from '@/server/storage.mjs';
import {
  auditEntry,
  continueTask,
  ensurePrompt,
  recordOutcome,
  replaceOutcome,
  resolvePrompt,
  type AuditEntry,
  type TaskOutcome,
} from '@/lib/tasks/continuity';
import { createTaskContinuityStore } from '@/lib/tasks/continuity-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** Input bounds: prompts and outcomes are short, human-written records. */
const MAX_PROMPT_ID = 128;
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 10;
const MAX_OPTION = 500;
const MAX_RESOLUTION = 2000;
const MAX_SUMMARY = 4000;

const OUTCOME_STATUSES = ['done', 'failed', 'cancelled', 'stopped'] as const;
type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return typeof value === 'string' && (OUTCOME_STATUSES as readonly string[]).includes(value);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The task's reload-safe state: the continue decision, its pending
 * disambiguation prompts, its recorded outcome, and the audit trail.
 *
 * A reload renders from this, so it re-binds to the run in flight
 * (`decision.action === 'rebind'`) and re-renders the same pending prompt
 * instead of asking again — it never dispatches new work on its own.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const { id: conversationId } = await context.params;
  const continuity = createTaskContinuityStore(getStorage().raw);
  const row = continuity.get(conversationId);
  // Ownership is checked on the continuity row rather than the conversation
  // id, so naming someone else's task reveals nothing about whether it exists.
  if (!row || row.userId !== user.userId) return fail('Task not found.', 404);

  const store = runService().store;
  const activeRunId = store.activeForConversation(conversationId);
  const active = activeRunId ? store.getRun(activeRunId) : null;
  const last = continuity.newestRun(conversationId);
  const decision = continueTask({
    activeRunId: active && active.user_id === user.userId ? active.id : null,
    activeStatus: active?.status ?? null,
    lastRunId: last?.id ?? null,
    lastStatus: last?.status ?? null,
  });

  return Response.json(
    {
      conversationId,
      runId: row.runId,
      decision,
      prompts: row.prompts.filter((prompt) => !prompt.resolvedAt),
      outcome: row.outcome,
      audit: row.audit,
    },
    { headers },
  );
}

/**
 * Mutate the task's continuity state. Every action is explicit and audited:
 * - ensure-prompt: register a disambiguation prompt idempotently (ask once);
 * - resolve-prompt: answer one, by explicit user action;
 * - record-outcome: write the first outcome;
 * - replace-outcome: replace it, only with explicit: true, leaving an audit entry.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    assertSameOrigin(request, publicOrigin(request));
  } catch (error) {
    if (error instanceof ChatRequestError) return fail(error.message, error.status);
    throw error;
  }

  const { id: conversationId } = await context.params;
  const body = await readBody(request);
  if (!body) return fail('Expected a JSON request body.', 400);

  const continuity = createTaskContinuityStore(getStorage().raw);
  const row = continuity.get(conversationId);
  if (!row || row.userId !== user.userId) return fail('Task not found.', 404);

  const now = new Date().toISOString();
  const action = body.action;

  if (action === 'ensure-prompt') {
    const id = body.id;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const options = Array.isArray(body.options) ? body.options : [];
    if (typeof id !== 'string' || !id || id.length > MAX_PROMPT_ID)
      return fail('Give the prompt a short id.', 400);
    if (!question || question.length > MAX_QUESTION)
      return fail('Ask the question in under 2,000 characters.', 400);
    if (
      options.length > MAX_OPTIONS ||
      options.some((o) => typeof o !== 'string' || !o.trim() || o.length > MAX_OPTION)
    )
      return fail('Keep to ten short options.', 400);
    const ensured = ensurePrompt(row.prompts, { id, question, options: options as string[] }, now);
    const audit = ensured.created ? [auditEntry('prompt_asked', user.userId, now, { id })] : [];
    continuity.save(conversationId, { prompts: ensured.prompts, outcome: row.outcome }, audit);
    return Response.json({ prompt: ensured.prompt, created: ensured.created }, { headers });
  }

  if (action === 'resolve-prompt') {
    const id = body.id;
    const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : '';
    if (typeof id !== 'string' || !id) return fail('Name the prompt to answer.', 400);
    if (!resolution || resolution.length > MAX_RESOLUTION)
      return fail('Answer in under 2,000 characters.', 400);
    const resolved = resolvePrompt(row.prompts, id, resolution, user.userId, now);
    if (!resolved.ok) return fail('That prompt is not waiting for an answer.', 404);
    const audit = resolved.alreadyResolved
      ? []
      : [auditEntry('prompt_resolved', user.userId, now, { id, resolution })];
    continuity.save(conversationId, { prompts: resolved.prompts, outcome: row.outcome }, audit);
    return Response.json({ prompt: resolved.prompt }, { headers });
  }

  if (action === 'record-outcome' || action === 'replace-outcome') {
    const input = body.outcome as { status?: unknown; summary?: unknown; runId?: unknown } | null;
    const status = input?.status;
    const summary = typeof input?.summary === 'string' ? input.summary.trim() : '';
    const runId = typeof input?.runId === 'string' ? input.runId : null;
    if (!isOutcomeStatus(status)) return fail('Say how the task ended.', 400);
    if (!summary || summary.length > MAX_SUMMARY)
      return fail('Summarise the outcome in under 4,000 characters.', 400);
    if (runId && runId.length > MAX_PROMPT_ID) return fail('That run id is too long.', 400);

    if (action === 'record-outcome') {
      let recorded: { outcome: TaskOutcome; audit: AuditEntry };
      try {
        recorded = recordOutcome(row.outcome, { status, summary, runId }, user.userId, now);
      } catch {
        // An outcome is already recorded: replacing it is a separate,
        // explicit action, never a second write.
        return fail('An outcome is already recorded. Replace it explicitly.', 409);
      }
      continuity.save(conversationId, { prompts: row.prompts, outcome: recorded.outcome }, [
        recorded.audit,
      ]);
      return Response.json({ outcome: recorded.outcome }, { headers });
    }

    // replace-outcome: the no-silent-replacement rule. Without the explicit
    // flag this is refused outright — a retry, a reload, or a background
    // transition must never overwrite what was recorded.
    if (body.explicit !== true)
      return fail('Replacing an outcome needs your explicit confirmation.', 400);
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_OPTION) : null;
    const replaced = replaceOutcome(
      row.outcome,
      { status, summary, runId },
      { actor: user.userId, explicit: true, reason: reason ?? undefined },
      now,
    );
    if (!replaced.ok) return fail(replaced.error, 400);
    continuity.save(conversationId, { prompts: row.prompts, outcome: replaced.outcome }, [
      replaced.audit,
    ]);
    return Response.json({ outcome: replaced.outcome }, { headers });
  }

  return fail('Unknown action.', 400);
}
