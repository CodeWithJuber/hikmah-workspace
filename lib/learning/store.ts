import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from '../runs/store.ts';
import {
  DEFAULT_LEARNING_POLICY,
  MAX_LEARNING_EXAMPLES,
  MAX_PROMPT_CHARACTERS,
  MAX_RESPONSE_CHARACTERS,
  type ExampleStatus,
  type LearningConsent,
  type LearningExample,
  type LearningPolicy,
  type LearningSnapshot,
} from './types.ts';
import { redactLearningText } from './privacy.ts';

export class LearningError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Row = {
  id: string;
  user_id: string;
  run_id: string;
  conversation_id: string;
  model: string;
  provider: string;
  status: ExampleStatus;
  prompt: string;
  response: string;
  correction: string | null;
  redactions: string;
  created_at: string;
  reviewed_at: string | null;
  revision: number;
};

export type CapturedExchange = {
  model: string;
  provider: string;
  prompt: string;
  response: string;
  redactions: string[];
};

const example = (row: Row): LearningExample => ({
  id: row.id,
  runId: row.run_id,
  conversationId: row.conversation_id,
  model: row.model,
  provider: row.provider,
  status: row.status,
  prompt: row.prompt,
  response: row.response,
  correction: row.correction,
  effectiveResponse: row.correction ?? row.response,
  redactions: JSON.parse(row.redactions),
  createdAt: row.created_at,
  reviewedAt: row.reviewed_at,
  revision: row.revision,
});

export function createLearningStore(db: SqliteHandle, now = () => new Date().toISOString()) {
  const policy = (userId: string): LearningPolicy => {
    const row = db.prepare('SELECT * FROM learning_policies WHERE user_id = ?').get(userId) as
      | {
          enabled: number;
          use_approved: number;
          collect_syntax: number;
          retention_days: 7 | 30 | 90;
          revision: number;
        }
      | undefined;
    return row
      ? {
          enabled: row.enabled === 1,
          useApproved: row.use_approved === 1,
          collectSyntax: row.collect_syntax === 1,
          retentionDays: row.retention_days,
          revision: row.revision,
        }
      : { ...DEFAULT_LEARNING_POLICY };
  };
  const purge = (userId: string) => {
    const cutoff = new Date(
      Date.parse(now()) - policy(userId).retentionDays * 86_400_000,
    ).toISOString();
    db.prepare('DELETE FROM learning_examples WHERE user_id = ? AND created_at < ?').run(
      userId,
      cutoff,
    );
    db.prepare('DELETE FROM context_candidates WHERE user_id = ? AND created_at < ?').run(
      userId,
      cutoff,
    );
  };
  const counts = (userId: string) => {
    const rows = db
      .prepare(
        'SELECT status, COUNT(*) AS n FROM learning_examples WHERE user_id = ? GROUP BY status',
      )
      .all(userId) as { status: ExampleStatus; n: number }[];
    const result = { pending: 0, approved: 0, rejected: 0, total: 0 };
    for (const row of rows) {
      result[row.status] = Number(row.n);
      result.total += Number(row.n);
    }
    return result;
  };
  const get = (userId: string, id: string) => {
    const row = db
      .prepare('SELECT * FROM learning_examples WHERE user_id = ? AND id = ?')
      .get(userId, id) as Row | undefined;
    return row ? example(row) : null;
  };

  return {
    policy,
    consent(userId: string): LearningConsent {
      const current = policy(userId);
      return { enabled: current.enabled, revision: current.revision };
    },
    configure(userId: string, patch: Partial<Omit<LearningPolicy, 'revision'>>) {
      for (const key of ['enabled', 'useApproved', 'collectSyntax'] as const)
        if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
          throw new LearningError('Learning switches must be true or false.');
      if (patch.retentionDays !== undefined && ![7, 30, 90].includes(patch.retentionDays))
        throw new LearningError('Choose 7, 30 or 90 days of retention.');
      const current = policy(userId),
        next = { ...current, ...patch };
      // Every change revokes old run snapshots, including an off/on cycle.
      db.prepare(
        `INSERT INTO learning_policies (user_id,enabled,use_approved,collect_syntax,retention_days,revision,updated_at)
        VALUES (?,?,?,?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET
        enabled=excluded.enabled,use_approved=excluded.use_approved,collect_syntax=excluded.collect_syntax,
        retention_days=excluded.retention_days,revision=learning_policies.revision+1,updated_at=excluded.updated_at`,
      ).run(
        userId,
        Number(next.enabled),
        Number(next.useApproved),
        Number(next.collectSyntax),
        next.retentionDays,
        now(),
      );
      purge(userId);
      return policy(userId);
    },
    /** Called by the server completion hook, never accepted as a public API body.
     * The durable run supplies identity and consent; an arbitrary client cannot
     * invent a successful provider exchange. */
    capture(userId: string, runId: string, captured: CapturedExchange): boolean {
      const current = policy(userId);
      if (!current.enabled) return false;
      const run = db
        .prepare('SELECT config,conversation_id,status FROM runs WHERE id = ? AND user_id = ?')
        .get(runId, userId) as
        { config: string; conversation_id: string; status: string } | undefined;
      if (!run || run.status !== 'done') return false;
      let consent: LearningConsent | undefined;
      try {
        consent = JSON.parse(run.config).learning;
      } catch {
        return false;
      }
      if (consent?.enabled !== true || consent.revision !== current.revision) return false;
      if (
        !captured.prompt.trim() ||
        !captured.response.trim() ||
        captured.prompt.length > MAX_PROMPT_CHARACTERS ||
        captured.response.length > MAX_RESPONSE_CHARACTERS
      )
        return false;
      purge(userId);
      if (counts(userId).total >= MAX_LEARNING_EXAMPLES) return false;
      const result = db
        .prepare(
          `INSERT INTO learning_examples
        (id,user_id,run_id,conversation_id,model,provider,prompt,response,redactions,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM runs r JOIN learning_policies p ON p.user_id = r.user_id
          WHERE r.id = ? AND r.user_id = ? AND r.status = 'done' AND p.enabled = 1
            AND p.revision = ? AND json_extract(r.config,'$.learning.enabled') = 1
            AND json_extract(r.config,'$.learning.revision') = p.revision
        ) AND (SELECT COUNT(*) FROM learning_examples WHERE user_id = ?) < ?
        ON CONFLICT(user_id,run_id) DO NOTHING`,
        )
        .run(
          'learn_' + randomUUID(),
          userId,
          runId,
          run.conversation_id,
          captured.model,
          captured.provider,
          captured.prompt,
          captured.response,
          JSON.stringify(captured.redactions),
          now(),
          runId,
          userId,
          current.revision,
          userId,
          MAX_LEARNING_EXAMPLES,
        ) as { changes: number };
      return Number(result.changes) === 1;
    },
    snapshot(
      userId: string,
      options: { status?: ExampleStatus; offset?: number; limit?: number } = {},
    ): LearningSnapshot {
      purge(userId);
      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
      const rows = options.status
        ? db
            .prepare(
              'SELECT * FROM learning_examples WHERE user_id = ? AND status = ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
            )
            .all(userId, options.status, limit, offset)
        : db
            .prepare(
              'SELECT * FROM learning_examples WHERE user_id = ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
            )
            .all(userId, limit, offset);
      const totals = counts(userId);
      return {
        policy: policy(userId),
        counts: totals,
        examples: (rows as Row[]).map(example),
        hasMore: offset + rows.length < (options.status ? totals[options.status] : totals.total),
        capability: { mode: 'reviewed-examples', providerWeightsChanged: false },
      };
    },
    get,
    review(
      userId: string,
      input: { id: string; revision: number; status: ExampleStatus; correction?: string | null },
      secrets: readonly string[] = [],
    ) {
      purge(userId);
      const previous = get(userId, input.id);
      if (!previous) throw new LearningError('That learning example was not found.', 404);
      if (!Number.isInteger(input.revision) || previous.revision !== input.revision)
        throw new LearningError(
          'This example changed in another tab. Refresh before reviewing.',
          409,
        );
      if (!['pending', 'approved', 'rejected'].includes(input.status))
        throw new LearningError('Choose a valid review status.');
      let correction = previous.correction;
      let redactions = previous.redactions;
      if (input.correction !== undefined) {
        if (input.correction === null) correction = null;
        else {
          if (
            typeof input.correction !== 'string' ||
            !input.correction.trim() ||
            input.correction.length > MAX_RESPONSE_CHARACTERS
          )
            throw new LearningError('Write a correction up to 24,000 characters.');
          const clean = redactLearningText(input.correction.trim(), secrets);
          correction = clean.text;
          redactions = [...new Set([...redactions, ...clean.redactions])];
        }
      }
      const result = db
        .prepare(
          `UPDATE learning_examples SET status=?,correction=?,redactions=?,reviewed_at=?,revision=revision+1
        WHERE user_id=? AND id=? AND revision=?`,
        )
        .run(
          input.status,
          correction,
          JSON.stringify(redactions),
          input.status === 'pending' ? null : now(),
          userId,
          input.id,
          input.revision,
        ) as { changes: number };
      if (Number(result.changes) !== 1)
        throw new LearningError('This example changed. Refresh before reviewing.', 409);
      return get(userId, input.id)!;
    },
    remove(userId: string, id: string) {
      const result = db
        .prepare('DELETE FROM learning_examples WHERE user_id = ? AND id = ?')
        .run(userId, id) as { changes: number };
      return Number(result.changes) === 1;
    },
    clear(userId: string) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM learning_examples WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM context_candidates WHERE user_id = ?').run(userId);
        // A run already in flight cannot immediately repopulate the queue.
        this.configure(userId, {});
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    approved(userId: string): LearningExample[] {
      purge(userId);
      if (!policy(userId).useApproved) return [];
      return (
        db
          .prepare(
            "SELECT * FROM learning_examples WHERE user_id = ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT ?",
          )
          .all(userId, MAX_LEARNING_EXAMPLES) as Row[]
      ).map(example);
    },
    export(userId: string, status: 'approved' | 'all') {
      purge(userId);
      const rows =
        status === 'approved'
          ? db
              .prepare(
                "SELECT * FROM learning_examples WHERE user_id = ? AND status = 'approved' ORDER BY created_at,id",
              )
              .all(userId)
          : db
              .prepare('SELECT * FROM learning_examples WHERE user_id = ? ORDER BY created_at,id')
              .all(userId);
      return (
        (rows as Row[])
          .map((row) =>
            JSON.stringify({
              format: 'hikmah.reviewed-exchange.v1',
              ...example(row),
              provenance: 'server-completed-model-exchange',
              providerWeightsChanged: false,
            }),
          )
          .join('\n') + (rows.length ? '\n' : '')
      );
    },
  };
}

export type LearningStore = ReturnType<typeof createLearningStore>;
