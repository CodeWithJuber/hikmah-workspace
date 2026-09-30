/** Persistence for task continuity (PR-16b): one row per task conversation.
 *
 * Thin wrapper over the raw SQLite handle, following the run store's shape:
 * prepared statements, an injectable clock, JSON columns parsed with
 * validation (corrupt state throws rather than being guessed at). The audit
 * column is append-only — entries are added, never rewritten.
 */
import type { SqliteHandle } from '../runs/store.ts';
import type { AuditEntry, TaskOutcome, TaskPrompt } from './continuity.ts';

export interface TaskContinuityRow {
  conversationId: string;
  userId: string;
  idempotencyKey: string | null;
  runId: string | null;
  prompts: TaskPrompt[];
  outcome: TaskOutcome | null;
  audit: AuditEntry[];
  createdAt: string;
  updatedAt: string;
}

type RawRow = {
  conversation_id: string;
  user_id: string;
  idempotency_key: string | null;
  run_id: string | null;
  prompts: string;
  outcome: string | null;
  audit: string;
  created_at: string;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePrompts(raw: string): TaskPrompt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('task_continuity: prompts column is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('task_continuity: prompts column is not an array');
  for (const p of parsed) {
    if (
      !isRecord(p) ||
      typeof p.id !== 'string' ||
      typeof p.question !== 'string' ||
      !Array.isArray(p.options)
    ) {
      throw new Error('task_continuity: prompts column holds a malformed prompt');
    }
  }
  return parsed as TaskPrompt[];
}

const OUTCOME_STATUSES = ['done', 'failed', 'cancelled', 'stopped'] as const;

function parseOutcome(raw: string | null): TaskOutcome | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('task_continuity: outcome column is not valid JSON');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.status !== 'string' ||
    !(OUTCOME_STATUSES as readonly string[]).includes(parsed.status) ||
    typeof parsed.summary !== 'string'
  ) {
    throw new Error('task_continuity: outcome column holds a malformed outcome');
  }
  return {
    status: parsed.status as TaskOutcome['status'],
    summary: parsed.summary,
    runId: typeof parsed.runId === 'string' ? parsed.runId : null,
    recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
    recordedBy: typeof parsed.recordedBy === 'string' ? parsed.recordedBy : '',
  };
}

function parseAudit(raw: string): AuditEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('task_continuity: audit column is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('task_continuity: audit column is not an array');
  return parsed as AuditEntry[];
}

function toRow(raw: RawRow): TaskContinuityRow {
  return {
    conversationId: raw.conversation_id,
    userId: raw.user_id,
    idempotencyKey: raw.idempotency_key,
    runId: raw.run_id,
    prompts: parsePrompts(raw.prompts),
    outcome: parseOutcome(raw.outcome),
    audit: parseAudit(raw.audit),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function createTaskContinuityStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO task_continuity
         (conversation_id, user_id, idempotency_key, run_id, prompts, outcome, audit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    remove: db.prepare('DELETE FROM task_continuity WHERE conversation_id = ?'),
    get: db.prepare('SELECT * FROM task_continuity WHERE conversation_id = ?'),
    byKey: db.prepare(
      `SELECT * FROM task_continuity
       WHERE user_id = ? AND idempotency_key = ?
       ORDER BY created_at DESC, conversation_id DESC
       LIMIT 1`,
    ),
    updateState: db.prepare(
      `UPDATE task_continuity
       SET prompts = ?, outcome = ?, audit = ?, updated_at = ?
       WHERE conversation_id = ?`,
    ),
    // The run store is the source of truth for run status; the continuity
    // row only names the task's run. Read live so the continue decision is
    // never made on a stale copy.
    newestRun: db.prepare(
      `SELECT id, status FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ),
  };

  return {
    /** Insert the row for a newly created task. A duplicate (user, key)
     * throws the unique-index violation — the caller replays the winner. */
    create(input: {
      conversationId: string;
      userId: string;
      idempotencyKey: string | null;
      runId: string | null;
    }): void {
      const stamp = now();
      statements.insert.run(
        input.conversationId,
        input.userId,
        input.idempotencyKey,
        input.runId,
        '[]',
        null,
        '[]',
        stamp,
        stamp,
      );
    },

    /** Remove a row this request just created (e.g. the enqueue failed and
     * the task never started). Cleanup of our own write, not user data. */
    remove(conversationId: string): void {
      statements.remove.run(conversationId);
    },

    get(conversationId: string): TaskContinuityRow | null {
      const raw = statements.get.get(conversationId) as RawRow | undefined;
      return raw ? toRow(raw) : null;
    },

    /** The task this idempotency key already started, if any — the replay
     * target that makes a retried POST return the same task instead of
     * dispatching a duplicate. Exact key match only: a fresh key always
     * starts a fresh task. */
    findByKey(userId: string, idempotencyKey: string): TaskContinuityRow | null {
      const raw = statements.byKey.get(userId, idempotencyKey) as RawRow | undefined;
      return raw ? toRow(raw) : null;
    },

    /** Persist prompt/outcome changes and append audit entries. The audit
     * entries are appended to what is stored — never rewritten. */
    save(
      conversationId: string,
      state: { prompts: TaskPrompt[]; outcome: TaskOutcome | null },
      appendAudit: AuditEntry[],
    ): void {
      const current = statements.get.get(conversationId) as RawRow | undefined;
      if (!current) throw new Error('task_continuity: no row for this conversation');
      const audit = [...parseAudit(current.audit), ...appendAudit];
      statements.updateState.run(
        JSON.stringify(state.prompts),
        state.outcome ? JSON.stringify(state.outcome) : null,
        JSON.stringify(audit),
        now(),
        conversationId,
      );
    },

    /** The task's newest run, whatever became of it — for the continue decision. */
    newestRun(conversationId: string): { id: string; status: string } | null {
      const row = statements.newestRun.get(conversationId) as
        { id: string; status: string } | undefined;
      return row ?? null;
    },
  };
}

export type TaskContinuityStore = ReturnType<typeof createTaskContinuityStore>;
