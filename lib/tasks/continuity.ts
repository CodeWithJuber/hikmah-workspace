/** Task continuity (PR-16b): what a background learning task keeps across a reload.
 *
 * A task is a server-side run nobody is watching, so a reload must never
 * disturb it. Three rules, each a pure function here so it can be tested
 * without a worker, a database or a session (the same split as
 * lib/runs/resume.ts):
 *
 * 1. Continue, never duplicate. `continueTask` maps a task's run state onto
 *    one decision: a pending run re-binds (`rebind` — the client re-tails its
 *    stream), a finished run reads its report (`settled`), and nothing on
 *    record is `none`. There is deliberately no "start a new run" outcome:
 *    while a run is pending, dispatching another is the bug.
 * 2. Ask once. `ensurePrompt` registers a disambiguation prompt idempotently:
 *    the same prompt id returns the same prompt, and a resolved prompt is
 *    never asked again. A reload re-renders the pending prompt; it does not
 *    create a second one. `resolvePrompt` applies an answer idempotently, so
 *    a double-submitted answer cannot double-apply.
 * 3. No silent replacement. `recordOutcome` writes the first outcome;
 *    `replaceOutcome` replaces it only on an explicit user action
 *    (`explicit: true`) and appends an audit entry saying what changed, who
 *    did it, and why. Anything else is refused.
 */

/** The run states in which a task still has a run to re-bind to.
 * Module-private: the rule is asserted through isPendingRunStatus, not the list. */
const PENDING_RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'waiting_client'] as const;

/** Run states in which a task still has a run to re-bind to. */
export function isPendingRunStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && (PENDING_RUN_STATUSES as readonly string[]).includes(status);
}

export type ContinueDecision =
  /** A run is still in flight: re-bind to it and tail its stream. Never
   * dispatch a new run while one is pending — that is the duplicate the
   * rule exists to prevent. */
  | { action: 'rebind'; runId: string; status: string }
  /** The run finished: read the report it left. No new work to dispatch. */
  | { action: 'settled'; runId: string; status: string }
  /** No run on record for this task. */
  | { action: 'none' };

export function continueTask(input: {
  /** The run `activeForConversation` reports, if any. */
  activeRunId: string | null;
  activeStatus?: string | null;
  /** The newest run for the conversation, whatever became of it. */
  lastRunId: string | null;
  lastStatus?: string | null;
}): ContinueDecision {
  // Pending wins over everything: a reload re-binds to the run in flight.
  if (input.activeRunId && isPendingRunStatus(input.activeStatus)) {
    return { action: 'rebind', runId: input.activeRunId, status: input.activeStatus as string };
  }
  // An active id whose status is not pending is a corrupt read (the lookup
  // only returns pending runs); fall through to the newest run rather than
  // trusting it.
  if (input.lastRunId) {
    return { action: 'settled', runId: input.lastRunId, status: input.lastStatus ?? 'unknown' };
  }
  return { action: 'none' };
}

// ---------------------------------------------------------------------------
// Disambiguation prompts: ask once.
// ---------------------------------------------------------------------------

/** One question the task layer put to the person, awaiting disambiguation. */
export interface TaskPrompt {
  /** Stable identity: the same id asked twice is the same prompt, not two. */
  id: string;
  question: string;
  options: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
}

export function ensurePrompt(
  prompts: TaskPrompt[],
  spec: { id: string; question: string; options?: string[] },
  now: string,
): { prompts: TaskPrompt[]; prompt: TaskPrompt | null; created: boolean } {
  const existing = prompts.find((p) => p.id === spec.id);
  if (existing) {
    // Ask once: a reload gets the same pending prompt back, and a resolved
    // prompt is never re-asked — null means "nothing to ask".
    return { prompts, prompt: existing.resolvedAt ? null : existing, created: false };
  }
  const prompt: TaskPrompt = {
    id: spec.id,
    question: spec.question,
    options: [...(spec.options ?? [])],
    createdAt: now,
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
  };
  return { prompts: [...prompts, prompt], prompt, created: true };
}

export function resolvePrompt(
  prompts: TaskPrompt[],
  promptId: string,
  resolution: string,
  actor: string,
  now: string,
):
  | { ok: true; prompts: TaskPrompt[]; prompt: TaskPrompt; alreadyResolved: boolean }
  | { ok: false; error: 'unknown-prompt' } {
  const index = prompts.findIndex((p) => p.id === promptId);
  if (index === -1) return { ok: false, error: 'unknown-prompt' };
  const current = prompts[index] as TaskPrompt;
  // Idempotent: an answer submitted twice (retry after a lost response)
  // resolves once; the second submit is absorbed, not double-applied.
  if (current.resolvedAt) {
    return { ok: true, prompts, prompt: current, alreadyResolved: true };
  }
  const resolved: TaskPrompt = {
    ...current,
    resolvedAt: now,
    resolution,
    resolvedBy: actor,
  };
  const next = [...prompts];
  next[index] = resolved;
  return { ok: true, prompts: next, prompt: resolved, alreadyResolved: false };
}

// ---------------------------------------------------------------------------
// Outcomes: never silently replaced.
// ---------------------------------------------------------------------------

/** What the task concluded, as recorded — not as predicted. */
export interface TaskOutcome {
  status: 'done' | 'failed' | 'cancelled' | 'stopped';
  summary: string;
  runId: string | null;
  recordedAt: string;
  recordedBy: string;
}

/** Append-only: entries are added, never rewritten. */
export interface AuditEntry {
  at: string;
  actor: string;
  action: 'outcome_recorded' | 'outcome_replaced' | 'prompt_asked' | 'prompt_resolved';
  detail: Record<string, unknown>;
}

export function auditEntry(
  action: AuditEntry['action'],
  actor: string,
  now: string,
  detail: Record<string, unknown> = {},
): AuditEntry {
  return { at: now, actor, action, detail };
}

function toOutcome(
  input: { status: TaskOutcome['status']; summary: string; runId?: string | null },
  actor: string,
  now: string,
): TaskOutcome {
  return {
    status: input.status,
    summary: input.summary,
    runId: input.runId ?? null,
    recordedAt: now,
    recordedBy: actor,
  };
}

/**
 * Record the task's first outcome. Throws when one is already recorded:
 * replacing an outcome goes through `replaceOutcome`, which demands the
 * explicit user action — a second `recordOutcome` call is exactly the silent
 * replacement the rule forbids.
 */
export function recordOutcome(
  current: TaskOutcome | null,
  input: { status: TaskOutcome['status']; summary: string; runId?: string | null },
  actor: string,
  now: string,
): { outcome: TaskOutcome; audit: AuditEntry } {
  if (current) {
    throw new Error(
      'recordOutcome: an outcome is already recorded — replacing it requires replaceOutcome with explicit user action',
    );
  }
  const outcome = toOutcome(input, actor, now);
  return { outcome, audit: auditEntry('outcome_recorded', actor, now, { outcome }) };
}

/**
 * Replace a recorded outcome. Refused unless the caller passes
 * `explicit: true` — the user's own action, not a retry, a reload, or a
 * background transition. Every replacement appends an audit entry naming
 * what it was, what it became, who did it, and why.
 */
export function replaceOutcome(
  current: TaskOutcome | null,
  input: { status: TaskOutcome['status']; summary: string; runId?: string | null },
  opts: { actor: string; explicit?: boolean; reason?: string },
  now: string,
): { ok: true; outcome: TaskOutcome; audit: AuditEntry } | { ok: false; error: string } {
  if (opts.explicit !== true) {
    return {
      ok: false,
      error: 'replacing a recorded outcome requires explicit user action (explicit: true)',
    };
  }
  const outcome = toOutcome(input, opts.actor, now);
  const audit = auditEntry('outcome_replaced', opts.actor, now, {
    from: current,
    to: outcome,
    reason: opts.reason ?? null,
  });
  return { ok: true, outcome, audit };
}
