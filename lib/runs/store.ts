/** The run store.
 *
 * Deliberately built on the raw node:sqlite handle rather than the D1-shaped
 * shim in server/storage.mjs. Two reasons, both load-bearing:
 *
 *  1. The shim's `run()` discards result rows, so `UPDATE ... RETURNING`, which
 *     is how a run is claimed atomically, cannot be used through it.
 *  2. The shim re-prepares a statement on every call. The worker appends one
 *     row per streamed chunk, so re-compiling per token would be the dominant
 *     cost of a run on a small box.
 *
 * This module imports nothing from Next, the kernel, or the browser modules, so
 * the worker can be tested without a server.
 */
import { createLearningStore } from '../learning/store.ts';
import { sealRunConfig } from '../../server/run-credentials.mjs';
import type { RunReasonCode, RunSegment } from './telemetry.ts';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  /** Stopped on a question only the owner can answer. */
  | 'waiting_client'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RunRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  status: RunStatus;
  step_count: number;
  error: string | null;
  /** The latest machine-readable outcome (completed, cancelled, timeout, …).
   * Stamped on every status transition; null for runs from before PR-07. */
  reason_code: string | null;
  config: string;
  /** Next unused chunk sequence. Claimed from the row rather than counted from
   * run_events, which is pruned at the end of every step. */
  event_seq: number;
  created_at: string;
  ended_at: string | null;
};

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  mode: string;
  model: string;
  active_run_id: string | null;
  created_at: string;
  updated_at: string;
};

/** A conversation as the list needs it: the row, plus what its run is doing,
 * plus — for a background task — how many suggestions it left to review. */
export type ConversationSummaryRow = ConversationRow & {
  run_status: RunStatus | null;
  to_review: number;
  /** The last message on the active path, for the list's preview line. */
  last_role: string | null;
  last_parts: unknown;
};

export type StoredMessage = {
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
};

/** The subset of node:sqlite's DatabaseSync this store needs. */
export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
};

const TERMINAL: RunStatus[] = ['done', 'failed', 'cancelled'];

export function createRunStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  // Prepared once. The append path runs per streamed chunk.
  const statements = {
    insertConversation: db.prepare(
      `INSERT INTO conversations (id, user_id, title, mode, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, parts, metadata, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // The tree link for message branching (Chat v2): the message this one
    // answers, or null for the root of a thread. New rows default to the
    // active path; the branch store flips paths when siblings are switched.
    messageParent: db.prepare(
      'SELECT parent_id FROM messages WHERE conversation_id = ? AND id = ?',
    ),
    lastActiveMessage: db.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND on_active_path = 1
       ORDER BY seq DESC
       LIMIT 1`,
    ),
    getConversation: db.prepare('SELECT id, user_id, mode FROM conversations WHERE id = ?'),
    messageSeq: db.prepare('SELECT seq FROM messages WHERE conversation_id = ? AND id = ?'),
    // Across every conversation, because the primary key is: an id already
    // taken by another thread cannot be inserted here, however free it looks
    // from inside this one.
    messageById: db.prepare('SELECT id FROM messages WHERE id = ?'),
    countMessages: db.prepare('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?'),
    // Branched messages live off the active path: truncating for a new turn
    // only removes what the person is actually reading, never a sibling they
    // switched away from. (Chat v2 message branching.)
    deleteFromSeq: db.prepare(
      'DELETE FROM messages WHERE conversation_id = ? AND seq >= ? AND on_active_path = 1',
    ),
    // Joined to the active run because "in flight" and "stopped to ask you
    // something" look identical from the conversation row alone, and a run
    // paused on an approval nobody can see is a conversation that never
    // finishes.
    listConversations: db.prepare(
      `SELECT c.id, c.user_id, c.title, c.mode, c.model, c.active_run_id,
              c.created_at, c.updated_at, r.status AS run_status,
              -- What a task filed and nobody has looked at yet. Counted here,
              -- not by the list, so "2 to review" costs no second request.
              (SELECT COUNT(*) FROM memories m
                WHERE m.source_conversation_id = c.id AND m.status = 'suggested') AS to_review,
              -- The row's preview line: the last message on the active path,
              -- so the list reads like a chat app instead of a file browser.
              -- Two cheap correlated lookups on an indexed column; the list is
              -- capped at 200 rows.
              (SELECT m2.role FROM messages m2
                WHERE m2.conversation_id = c.id AND m2.on_active_path = 1
                ORDER BY m2.seq DESC LIMIT 1) AS last_role,
              (SELECT m2.parts FROM messages m2
                WHERE m2.conversation_id = c.id AND m2.on_active_path = 1
                ORDER BY m2.seq DESC LIMIT 1) AS last_parts
       FROM conversations c
       LEFT JOIN runs r ON r.id = c.active_run_id
       WHERE c.user_id = ?
       -- Temp chats (Chat v2) are ephemeral: they exist so the send flow has
       -- a conversation id, but they must never surface in the list.
       AND c.id NOT LIKE 'temp-%'
       -- updated_at is a millisecond timestamp, so two conversations touched in
       -- the same millisecond tie. Ordering on it alone leaves SQLite free to
       -- return them either way round, and the sidebar would reshuffle between
       -- refreshes for no reason the owner can see. The id breaks the tie
       -- arbitrarily but consistently, which is the property that matters.
       ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
       LIMIT ?`,
    ),
    // Where /chat lands: the last conversation the owner was actually in. A
    // background task is not that, however recently it finished.
    latestChat: db.prepare(
      `SELECT id FROM conversations
       WHERE user_id = ? AND mode <> 'task' AND id NOT LIKE 'temp-%'
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 1`,
    ),
    // Only when it is still unset: the title is written from the opening
    // message, and a later message must not rename a conversation the owner has
    // been finding by that name.
    setTitle: db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = ''"),
    // A sibling's title, for the dedupe below. The conversation being named is
    // excluded: naming it what it is already called is not a collision.
    titleTaken: db.prepare(
      'SELECT 1 AS taken FROM conversations WHERE user_id = ? AND title = ? AND id != ? LIMIT 1',
    ),
    deleteConversation: db.prepare(
      'DELETE FROM conversations WHERE id = ? AND user_id = ? RETURNING id',
    ),
    nextSeq: db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?',
    ),
    listMessages: db.prepare(
      // The active path only: branched-away siblings are read through the
      // branch store, never the transcript. (Chat v2 message branching.)
      `SELECT id, role, parts, metadata FROM messages
       WHERE conversation_id = ? AND on_active_path = 1
       ORDER BY seq`,
    ),
    insertRun: db.prepare(
      `INSERT INTO runs (id, conversation_id, user_id, status, config, created_at, priority)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    ),
    // Idempotency keys for enqueueRun: the same key always resolves to the
    // same run id, so a retried request never starts a second run. Claimed
    // with INSERT OR IGNORE so two racing enqueues cannot both win.
    idempotencyHit: db.prepare('SELECT run_id FROM run_idempotency WHERE key = ?'),
    claimIdempotency: db.prepare(
      'INSERT OR IGNORE INTO run_idempotency (key, run_id, created_at) VALUES (?, ?, ?)',
    ),
    // Claim the next queued run and mark it running in one statement, so two
    // workers (or a worker racing its own restart) cannot take the same run.
    //
    // Priority first, then age. The Pro plan has been claiming "priority on the
    // run queue" against a strict FIFO with no such column; this is the
    // ordering that makes the sentence true. Age still breaks every tie, so
    // within a tier the queue is exactly as fair as it was.
    claim: db.prepare(
      `UPDATE runs SET status = 'running'
       WHERE id = (
         SELECT id FROM runs WHERE status = 'queued'
          ORDER BY priority DESC, created_at, id LIMIT 1
       )
       RETURNING *`,
    ),
    // The same claim, passing over background tasks. The worker uses it while
    // a task is already running, so the last free slot always goes to a chat:
    // a task is unattended and long, and two of them would otherwise fill the
    // worker and queue every live conversation behind them.
    claimChat: db.prepare(
      `UPDATE runs SET status = 'running'
       WHERE id = (
         SELECT id FROM runs
          WHERE status = 'queued' AND json_extract(config, '$.task') IS NULL
          ORDER BY priority DESC, created_at, id LIMIT 1
       )
       RETURNING *`,
    ),
    getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    setStatus: db.prepare('UPDATE runs SET status = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE runs SET status = ?, error = ?, ended_at = ?, reason_code = ?,
      config = CASE WHEN json_valid(config) THEN json_remove(config, '$.apiKey', '$.providerCredential') ELSE '{}' END
      -- Terminal is terminal: a drive that settles late (after a forced
      -- cancel, after a resume) must not overwrite the outcome already
      -- recorded, or a cancelled run comes back as done and the badge with it.
      WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')`),
    /** The machine-readable reason for a non-terminal transition: paused on
     * an approval, paused on a question, or resumed after a denied approval.
     * Separate from finish because these transitions do not end the run. */
    setReasonCode: db.prepare('UPDATE runs SET reason_code = ? WHERE id = ?'),
    /** One timed segment of a run's life (PR-07 telemetry). Names and
     * durations only — never prompt text, tool arguments or keys. */
    insertSegment: db.prepare(
      'INSERT INTO run_telemetry (run_id, segment, duration_ms, reason_code, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    timeline: db.prepare(
      `SELECT run_id, segment, duration_ms, reason_code, created_at
       FROM run_telemetry WHERE run_id = ? ORDER BY created_at, rowid`,
    ),
    bumpSteps: db.prepare('UPDATE runs SET step_count = step_count + 1 WHERE id = ?'),
    // A process that dies mid-run leaves rows marked running with nobody
    // driving them. Requeue on boot and on shutdown so the work resumes instead
    // of being stranded.
    requeueRunning: db.prepare("UPDATE runs SET status = 'queued' WHERE status = 'running'"),
    // The interrupted attempts, for reconciliation in requeueRunning below:
    // only a run that was mid-drive can hold events from an attempt that will
    // never finish.
    interruptedRuns: db.prepare("SELECT id FROM runs WHERE status = 'running'"),
    // Only from waiting_approval: a run that is already queued or running must
    // not be restarted underneath the worker driving it.
    requeueApproved: db.prepare(
      "UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'waiting_approval'",
    ),
    // The same guard for a question. Kept as its own statement rather than
    // widening the one above: an approval arriving for a run that is waiting on
    // an answer, or the reverse, is a client that has lost track of the run, and
    // it should release nothing.
    requeueAnswered: db.prepare(
      "UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'waiting_client'",
    ),
    replaceMessage: db.prepare(
      'UPDATE messages SET parts = ?, metadata = ? WHERE id = ? AND conversation_id = ?',
    ),
    setActiveRun: db.prepare(
      'UPDATE conversations SET active_run_id = ?, updated_at = ? WHERE id = ?',
    ),
    appendEvent: db.prepare(
      'INSERT INTO run_events (run_id, seq, payload, created_at) VALUES (?, ?, ?, ?)',
    ),
    // Read from the run rather than counted from run_events: that table is
    // pruned at the end of every step, and deriving the number from it made a
    // resumed run restart at 0 and its output vanish behind a stale cursor.
    //
    // A SELECT and an UPDATE rather than one UPDATE ... RETURNING, because the
    // cursor is now claimed in memory for a whole batch and written back once
    // per flush. See `appendEvent`.
    eventSeq: db.prepare('SELECT event_seq AS next FROM runs WHERE id = ?'),
    setEventSeq: db.prepare('UPDATE runs SET event_seq = ? WHERE id = ?'),
    countQueued: db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'"),
    countActive: db.prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE user_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'waiting_client')`,
    ),
    activeForConversation: db.prepare(
      `SELECT id FROM runs
       WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'waiting_client')
       LIMIT 1`,
    ),
    // The newest run for a conversation, whatever became of it. Ordered the
    // same way claim() orders the queue, so "newest" means the same thing in
    // both places.
    lastRun: db.prepare(
      `SELECT status, error FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ),
    eventsAfter: db.prepare(
      'SELECT seq, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq',
    ),
    countEventsAfter: db.prepare(
      'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND seq > ?',
    ),
    pruneEvents: db.prepare('DELETE FROM run_events WHERE run_id = ?'),
  };

  const one = <T>(value: unknown): T | null => (value ?? null) as T | null;

  /* Streamed chunks, written in batches rather than one at a time.
   *
   * `emit` in lib/runs/worker.ts ran two statements per chunk on the single Node
   * thread that also answers every panel's fetch: an UPDATE ... RETURNING to
   * claim a sequence number, and an INSERT. Measured on a WAL database with
   * node:sqlite's defaults, 2,000 chunks cost 623 ms — 312 us each, so a
   * 3,000-chunk answer spent roughly a second of the event loop writing, and
   * every fetch issued during it waited. In transactions of 50 the same 2,000
   * chunks cost 18 ms: 34x.
   *
   * What that trades is durability inside the flush window. It is bounded on
   * purpose:
   *
   *  - Connected clients never read this table. They are served from the bus, in
   *    memory, with the sequence number this function hands out — so batching is
   *    invisible to a stream that stays up.
   *  - Every reader of run_events or of `runs.event_seq` flushes first, so a
   *    RECONNECTING client cannot be handed a gap. That is `getRun`,
   *    `eventsAfter`, `countEventsAfter`, `finish` and `pruneEvents`; none of
   *    them is called per chunk.
   *  - A crash inside the window loses at most 25 ms of chunks — and loses the
   *    sequence numbers with them, because the cursor is written in the same
   *    transaction. `requeueRunning` puts the run back on boot and it replays
   *    from a consistent point rather than from a cursor pointing past rows that
   *    were never written.
   */
  const FLUSH_MS = 25;
  const FLUSH_ROWS = 50;
  let buffered: { runId: string; seq: number; payload: string; at: string }[] = [];
  /** The next sequence number for a run with chunks in flight. Seeded from the
   * row once per flush window, not read per chunk. */
  const claimed = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushEvents(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buffered.length) return;
    const cursors = [...claimed];
    claimed.clear();
    /* A run can be deleted while its answer is still streaming — someone
     * deletes the conversation from the list, and ON DELETE CASCADE takes the
     * run and its events with it. Unbatched, the row was already written and
     * went with the cascade. Buffered, it arrives afterwards and fails the
     * foreign key, which would take down the whole transaction and with it the
     * chunks of every OTHER run in the same flush.
     *
     * So a vanished run's chunks are dropped here rather than written. One
     * existence check per run per flush window, not per chunk. Found by
     * tests/runs-store.test.mjs, which has asserted since it was written that
     * deleting a conversation takes its events with it. */
    const alive = new Set();
    for (const runId of new Set(buffered.map((row) => row.runId)))
      if (statements.getRun.get(runId)) alive.add(runId);
    const rows = buffered.filter((row) => alive.has(row.runId));
    buffered = [];
    if (!rows.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) statements.appendEvent.run(row.runId, row.seq, row.payload, row.at);
      // In the same transaction as the rows it counts. A cursor that outran its
      // rows would make a resumed run skip the chunks in between.
      for (const [runId, next] of cursors)
        if (alive.has(runId)) statements.setEventSeq.run(next, runId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // Put them back so the next flush retries rather than dropping an answer
      // on a transient busy timeout.
      buffered = rows.concat(buffered);
      for (const [runId, next] of cursors)
        if (alive.has(runId) && !claimed.has(runId)) claimed.set(runId, next);
      throw error;
    }
  }

  return {
    createConversation(input: {
      id: string;
      userId: string;
      title?: string;
      mode?: string;
      model?: string;
    }) {
      const stamp = now();
      statements.insertConversation.run(
        input.id,
        input.userId,
        input.title ?? '',
        input.mode ?? 'chat',
        input.model ?? '',
        stamp,
        stamp,
      );
      return input.id;
    },

    /** The owner's conversations, most recently active first. */
    listConversations(userId: string, limit = 100): ConversationSummaryRow[] {
      return statements.listConversations.all(userId, limit) as ConversationSummaryRow[];
    },

    /** The conversation /chat opens on: the most recently active one that is
     * not a background task, or null for an owner with none. */
    latestChat(userId: string): { id: string } | null {
      return one<{ id: string }>(statements.latestChat.get(userId));
    },

    /** Name a conversation, if it does not have one yet. */
    setTitle(conversationId: string, title: string) {
      statements.setTitle.run(title, conversationId);
    },

    /** A title no other conversation of this owner's already carries.
     *
     * Auto-titles come from the opening message, so two conversations that
     * start the same way used to share one identical sidebar row. The first
     * keeps the bare title; later ones get " (2)", " (3)", … — the file
     * manager's convention, and readable in a narrow sidebar. */
    uniqueTitle(userId: string, base: string, excludeId = ''): string {
      const taken = (title: string) =>
        statements.titleTaken.get(userId, title, excludeId) !== undefined;
      if (!taken(base)) return base;
      for (let n = 2; ; n += 1) {
        const candidate = `${base} (${n})`;
        if (!taken(candidate)) return candidate;
      }
    },

    /**
     * Remove a conversation and everything under it.
     *
     * Messages, runs and their events go with it through ON DELETE CASCADE, so
     * this cannot leave a run queued against a conversation that is gone.
     * Returns false when the conversation is not this owner's, which is the
     * same answer as it not existing.
     */
    deleteConversation(id: string, userId: string): boolean {
      return (statements.deleteConversation.get(id, userId) ?? null) !== null;
    },

    /** Who owns this conversation, or null when there is no such row. */
    getConversation(id: string): { id: string; user_id: string; mode: string } | null {
      return one<{ id: string; user_id: string; mode: string }>(statements.getConversation.get(id));
    },

    appendMessage(conversationId: string, message: StoredMessage, parentId?: string | null) {
      const seq = (statements.nextSeq.get(conversationId) as { next: number }).next;
      statements.insertMessage.run(
        message.id,
        conversationId,
        seq,
        message.role,
        JSON.stringify(message.parts ?? []),
        message.metadata === undefined ? null : JSON.stringify(message.metadata),
        parentId ?? null,
        now(),
      );
      return seq;
    },

    /** The tree parent of a message, or null for a root. Used when a turn is
     * re-appended after truncation (regenerate / edit-into-branch) so the new
     * row keeps the old row's place in the tree. */
    getMessageParent(conversationId: string, messageId: string): string | null {
      const row = statements.messageParent.get(conversationId, messageId) as
        { parent_id: string | null } | undefined;
      return row?.parent_id ?? null;
    },

    /** The last message on the active path: the parent a fresh turn answers. */
    lastActiveMessageId(conversationId: string): string | null {
      const row = statements.lastActiveMessage.get(conversationId) as { id: string } | undefined;
      return row?.id ?? null;
    },

    /**
     * Drop this message and everything after it, and say how many went.
     *
     * Answering again re-sends the user message that is already a row, so the
     * turn has to be removed before it can be written a second time. Scoped to
     * one conversation and returning the count, because the failure mode of
     * getting this wrong is deleting somebody's transcript: an unknown id, or
     * one belonging to another conversation, removes nothing.
     *
     * Reusing the freed seq numbers is safe — appendMessage derives the next
     * one from MAX(seq), so the sequence simply resumes where the truncation
     * left it.
     */
    truncateFrom(conversationId: string, messageId: string): number {
      const found = statements.messageSeq.get(conversationId, messageId) as
        { seq: number } | undefined;
      if (!found) return 0;
      const before = statements.countMessages.get(conversationId) as { total: number };
      statements.deleteFromSeq.run(conversationId, found.seq);
      const after = statements.countMessages.get(conversationId) as { total: number };
      return before.total - after.total;
    },

    listMessages(conversationId: string): StoredMessage[] {
      return (
        statements.listMessages.all(conversationId) as Array<{
          id: string;
          role: string;
          parts: string;
          metadata: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        role: row.role,
        parts: JSON.parse(row.parts),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }));
    },

    createRun(input: {
      id: string;
      conversationId: string;
      userId: string;
      config: unknown;
      /** Higher is claimed first. Written here from the caller's tier rather
       * than read from their subscription at claim time, so a plan that changes
       * while a run waits cannot reorder work already queued under the old one.
       * Absent means 0, which is how every run behaved before this existed. */
      priority?: number;
    }) {
      statements.insertRun.run(
        input.id,
        input.conversationId,
        input.userId,
        JSON.stringify({
          ...sealRunConfig(input.config, { id: input.id, user_id: input.userId }),
          // Server-owned consent snapshot. Never trust a caller-supplied one,
          // and never apply a later opt-in to an already queued conversation.
          // The one narrowing a caller may make is an explicit disable —
          // an incognito run opts out of learning capture — because a disable
          // can only ever take less than the consent allows, never more.
          learning:
            (input.config as { learning?: { enabled?: boolean } } | null)?.learning?.enabled ===
            false
              ? { enabled: false, revision: -1 }
              : createLearningStore(db, now).consent(input.userId),
        }),
        now(),
        Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
      );
      statements.setActiveRun.run(input.id, now(), input.conversationId);
      return input.id;
    },

    /** Take the highest-priority, then oldest, queued run — or null when the
     * queue is empty. With `chatOnly`, a queued background task is left where
     * it is. */
    claimNext(options: { chatOnly?: boolean } = {}): RunRow | null {
      return one<RunRow>((options.chatOnly ? statements.claimChat : statements.claim).get());
    },

    /** The run id already filed under this idempotency key, or null when the
     * key is new. Used by enqueueRun before any selection work, so a retry
     * returns the original run without re-running the policy. */
    idempotencyHit(key: string): string | null {
      const row = one<{ run_id: string }>(statements.idempotencyHit.get(key));
      return row?.run_id ?? null;
    },

    /** Claim an idempotency key for a run id. False when another run claimed
     * it first — the caller must then re-read the hit rather than create a
     * second run. */
    claimIdempotency(key: string, runId: string): boolean {
      const result = statements.claimIdempotency.run(key, runId, now()) as {
        changes?: number;
      };
      return Number(result?.changes ?? 0) > 0;
    },

    getRun(id: string): RunRow | null {
      // `event_seq` on this row is what lib/runs/sse.ts numbers a failure
      // notice with, and what lib/runs/resume.ts compares a client's cursor
      // against. Both would be wrong by however many chunks are still buffered.
      flushEvents();
      return one<RunRow>(statements.getRun.get(id));
    },

    /**
     * Put a paused run back in the queue.
     *
     * Returns false when the run was not waiting, which is how a duplicate
     * answer to the same approval is absorbed rather than starting a second run.
     */
    requeueAnswered(id: string): boolean {
      const result = statements.requeueAnswered.run(id) as { changes?: number };
      return (result.changes ?? 0) > 0;
    },

    requeueApproved(id: string): boolean {
      const result = statements.requeueApproved.run(id) as { changes?: number };
      return Number(result?.changes ?? 0) > 0;
    },

    /** Overwrite a stored message in place, keeping its position in the thread.
     *
     * An approval answers a message that is already a row; appending the
     * answered copy would leave the conversation holding both. */
    replaceMessage(
      conversationId: string,
      message: { id: string; parts: unknown; metadata?: unknown },
    ): boolean {
      const result = statements.replaceMessage.run(
        JSON.stringify(message.parts ?? []),
        message.metadata === undefined ? null : JSON.stringify(message.metadata),
        message.id,
        conversationId,
      ) as { changes?: number };
      return Number(result?.changes ?? 0) > 0;
    },

    setStatus(id: string, status: RunStatus) {
      statements.setStatus.run(status, id);
    },

    /**
     * Stamp the machine-readable reason for the run's latest outcome or
     * transition (PR-07). Terminal outcomes go through `finish`; this covers
     * the transitions that keep the run alive — waiting_approval,
     * waiting_client, and a denied approval on resume.
     */
    setReasonCode(id: string, reasonCode: RunReasonCode) {
      statements.setReasonCode.run(reasonCode, id);
    },

    /**
     * Record one timed segment of a run (PR-07 telemetry).
     *
     * Best effort on purpose, like the usage rows: observability must never
     * break the run it is observing. A missing row undercounts one segment;
     * a thrown error would lose the answer. Names and durations only — the
     * signature takes no payload, so prompt text, tool arguments and keys
     * cannot enter this table by construction.
     */
    recordSegment(
      runId: string,
      segment: RunSegment,
      durationMs: number,
      reasonCode?: RunReasonCode,
    ) {
      try {
        statements.insertSegment.run(
          runId,
          segment,
          Math.max(0, Math.trunc(durationMs)),
          reasonCode ?? null,
          now(),
        );
      } catch (error) {
        console.error(
          '[hikmah] telemetry segment not recorded:',
          error instanceof Error ? error.message : error,
        );
      }
    },

    /**
     * The run's ordered segment sequence: submit → accepted result, each leg
     * timed. Given a run id, this reconstructs the whole run.
     */
    runTimeline(runId: string): Array<{
      runId: string;
      segment: RunSegment;
      durationMs: number;
      reasonCode: RunReasonCode | null;
      createdAt: string;
    }> {
      return (
        statements.timeline.all(runId) as Array<{
          run_id: string;
          segment: RunSegment;
          duration_ms: number;
          reason_code: RunReasonCode | null;
          created_at: string;
        }>
      ).map((row) => ({
        runId: row.run_id,
        segment: row.segment,
        durationMs: row.duration_ms,
        reasonCode: row.reason_code,
        createdAt: row.created_at,
      }));
    },

    bumpSteps(id: string) {
      statements.bumpSteps.run(id);
    },

    finish(
      id: string,
      status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
      error?: string,
      reasonCode?: RunReasonCode,
    ) {
      // The last chunks of the answer go in before the run is marked ended, or
      // a client reconnecting on the end notice replays a transcript missing its
      // final tokens.
      flushEvents();
      statements.finish.run(status, error ?? null, now(), reasonCode ?? null, id);
      // Always: a terminal run must never keep a conversation marked as
      // answering, even if this call lost the race to finish it first. The
      // sidebar badge reads active_run_id, so this is what clears it.
      const run = one<RunRow>(statements.getRun.get(id));
      if (run) statements.setActiveRun.run(null, now(), run.conversation_id);
    },

    /** Reclaim runs stranded by a crash or a restart. Returns nothing useful; it
     * is called for effect on boot and on SIGTERM.
     *
     * Reconciliation (PR-09): a requeued run is driven again from scratch, so
     * the interrupted attempt's events are stale — replaying them ahead of the
     * new attempt's chunks would show a reconnecting client phantom output
     * from an answer that will never be finished. They are pruned here, at the
     * recovery point. The row's event_seq is deliberately left to keep
     * climbing: a client holding a cursor from before the interruption then
     * replays exactly the new attempt's events — no gap from a reset cursor,
     * no repeat of the old ones. */
    requeueRunning() {
      flushEvents();
      const interrupted = (statements.interruptedRuns.all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      // After the flush above, nothing is still buffered for these runs, so
      // the delete cannot be resurrected by a later write of the same rows.
      for (const id of interrupted) statements.pruneEvents.run(id);
      statements.requeueRunning.run();
    },

    /** Buffer a streamed chunk and return the sequence number it will carry.
     *
     * Returns synchronously and immediately, because the caller hands the same
     * number straight to the bus — a connected client sees the chunk before it
     * is on disk, and that is the point. See the comment above `flushEvents`
     * for what that trades and what bounds it. */
    appendEvent(runId: string, payload: unknown): number {
      let seq = claimed.get(runId);
      if (seq === undefined) {
        const row = statements.eventSeq.get(runId) as { next: number } | undefined;
        if (!row) throw new Error('No such run: ' + runId);
        seq = row.next;
      }
      claimed.set(runId, seq + 1);
      buffered.push({ runId, seq, payload: JSON.stringify(payload), at: now() });
      if (buffered.length >= FLUSH_ROWS) flushEvents();
      else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          // Swallowed here and nowhere else. A throw inside a timer is an
          // uncaught exception with no caller to answer to, and the catch in
          // `flushEvents` has already put the rows back — so the next chunk
          // re-arms this, and a reader-path flush (which has a caller) is
          // where a real write failure surfaces. Found by a test whose
          // database closed with a flush still pending.
          try {
            flushEvents();
          } catch {
            /* retried on the next chunk, or by the next reader */
          }
        }, FLUSH_MS);
        // A pending flush must not hold the process open at shutdown; the
        // paths that matter flush explicitly.
        (flushTimer as unknown as { unref?: () => void }).unref?.();
      }
      return seq;
    },

    /** Write anything buffered, now.
     *
     * Public so the worker can flush on SIGTERM, when 25 ms is longer than the
     * process has left. */
    flushEvents,

    /** Replay buffer for a reconnecting client, from the last seq it saw. */
    eventsAfter(runId: string, after: number): { seq: number; payload: unknown }[] {
      // Before the read, or a reconnecting client is handed a gap where the
      // buffered chunks should be.
      flushEvents();
      return (
        statements.eventsAfter.all(runId, after) as Array<{ seq: number; payload: string }>
      ).map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) }));
    },

    /** How many events a reconnecting client has missed.
     *
     * The stream route only needs to know whether there are any, to decide
     * between a 204 and holding a connection open. It used to ask `eventsAfter`
     * and take `.length`, which reads every payload off disk and JSON.parses
     * it — a whole answer's worth — and then `runEventStream` immediately did
     * the same read again. One pass per connect instead of two, and this one
     * touches no payloads at all. */
    countEventsAfter(runId: string, after: number): number {
      flushEvents();
      return (statements.countEventsAfter.get(runId, after) as { n: number }).n;
    },

    /** Runs waiting for the worker, across all owners. Reported by /api/health
     * so a stalled loop is visible before anyone notices a hung answer. */
    countQueued(): number {
      return (statements.countQueued.get() as { n: number }).n;
    },

    /** Runs not yet finished for this owner, used to bound queue growth. */
    countActive(userId: string): number {
      return (statements.countActive.get(userId) as { n: number }).n;
    },

    /** The unfinished run for a conversation, if any. */
    activeForConversation(conversationId: string): string | null {
      const row = statements.activeForConversation.get(conversationId) as
        { id: string } | undefined;
      return row?.id ?? null;
    },

    /** Store the answer a run produced, whether or not it has been stored before.
     *
     * A resumed run gets its message back from the SDK carrying the id of the
     * paused turn it is continuing — `createAgentUIStream` defaults
     * `originalMessages` to the transcript it was given, and reuses the last
     * assistant message's id. Appending that a second time hit the primary key,
     * which failed the run and threw away the answer it had just produced. It is
     * the same turn, so it is an update.
     *
     * Scoped to the conversation on purpose: an id that belongs to a different
     * thread is not this turn, and adopting it would move someone else's
     * message rather than record this one.
     *
     * And an answer is never lost to its id. When the id is taken by another
     * conversation the message is still written here, under one derived from
     * it: a primary key is a bookkeeping detail, and the answer the person
     * waited for is not. Losing one to a collision is exactly how
     * `UNIQUE constraint failed: messages.id` reached the transcript.
     */
    saveAssistantMessage(
      conversationId: string,
      message: StoredMessage,
      parentId?: string | null,
    ): void {
      const parts = JSON.stringify(message.parts ?? []);
      const metadata = message.metadata === undefined ? null : JSON.stringify(message.metadata);
      const changed = statements.replaceMessage.run(
        parts,
        metadata,
        message.id,
        conversationId,
      ) as { changes?: number };
      // The UPDATE is scoped to the conversation, so nothing changed means this
      // id is not a turn in this thread — either it is new, or it is taken.
      if (Number(changed?.changes ?? 0) > 0) return;
      const seq = (statements.nextSeq.get(conversationId) as { next: number }).next;
      const taken = statements.messageById.get(message.id) as { id: string } | undefined;
      const id = taken ? message.id + '-' + conversationId + '-' + seq : message.id;
      statements.insertMessage.run(
        id,
        conversationId,
        seq,
        message.role,
        parts,
        metadata,
        parentId ?? null,
        now(),
      );
    },

    /** Why the last run for this conversation failed, or null.
     *
     * A failure is recorded on the run row and, until this existed, read by
     * nothing: the browser only tails a run it thinks is active, and a failed
     * one is not, so reopening a conversation that had failed showed the
     * question, no answer, and no explanation.
     *
     * Only the newest run counts. A retry that succeeded must clear the old
     * reason, or the reload after a successful retry reads as another failure.
     */
    lastFailure(conversationId: string): string | null {
      const row = statements.lastRun.get(conversationId) as
        { status: RunStatus; error: string | null } | undefined;
      if (row?.status !== 'failed') return null;
      // Cancelling is something the person did on purpose, and is filtered out
      // by the status check above rather than by inspecting the reason.
      return row.error || 'The run failed.';
    },

    pruneEvents(runId: string) {
      // Before the delete, not after: a buffered chunk written afterwards would
      // resurrect the step this is clearing.
      flushEvents();
      statements.pruneEvents.run(runId);
    },

    isTerminal(status: RunStatus) {
      return TERMINAL.includes(status);
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
