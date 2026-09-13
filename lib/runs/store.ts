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
      `INSERT INTO messages (id, conversation_id, seq, role, parts, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getConversation: db.prepare('SELECT id, user_id, mode FROM conversations WHERE id = ?'),
    messageSeq: db.prepare('SELECT seq FROM messages WHERE conversation_id = ? AND id = ?'),
    // Across every conversation, because the primary key is: an id already
    // taken by another thread cannot be inserted here, however free it looks
    // from inside this one.
    messageById: db.prepare('SELECT id FROM messages WHERE id = ?'),
    countMessages: db.prepare('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?'),
    deleteFromSeq: db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?'),
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
                WHERE m.source_conversation_id = c.id AND m.status = 'suggested') AS to_review
       FROM conversations c
       LEFT JOIN runs r ON r.id = c.active_run_id
       WHERE c.user_id = ?
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
       WHERE user_id = ? AND mode <> 'task'
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT 1`,
    ),
    // Only when it is still unset: the title is written from the opening
    // message, and a later message must not rename a conversation the owner has
    // been finding by that name.
    setTitle: db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = ''"),
    deleteConversation: db.prepare(
      'DELETE FROM conversations WHERE id = ? AND user_id = ? RETURNING id',
    ),
    nextSeq: db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?',
    ),
    listMessages: db.prepare(
      'SELECT id, role, parts, metadata FROM messages WHERE conversation_id = ? ORDER BY seq',
    ),
    insertRun: db.prepare(
      `INSERT INTO runs (id, conversation_id, user_id, status, config, created_at, priority)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
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
    finish: db.prepare('UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?'),
    bumpSteps: db.prepare('UPDATE runs SET step_count = step_count + 1 WHERE id = ?'),
    // A process that dies mid-run leaves rows marked running with nobody
    // driving them. Requeue on boot and on shutdown so the work resumes instead
    // of being stranded.
    requeueRunning: db.prepare("UPDATE runs SET status = 'queued' WHERE status = 'running'"),
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
    // Claimed from the run rather than counted from run_events: that table is
    // pruned at the end of every step, and deriving the number from it made a
    // resumed run restart at 0 and its output vanish behind a stale cursor.
    nextEventSeq: db.prepare(
      'UPDATE runs SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq - 1 AS next',
    ),
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
    pruneEvents: db.prepare('DELETE FROM run_events WHERE run_id = ?'),
  };

  const one = <T>(value: unknown): T | null => (value ?? null) as T | null;

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

    appendMessage(conversationId: string, message: StoredMessage) {
      const seq = (statements.nextSeq.get(conversationId) as { next: number }).next;
      statements.insertMessage.run(
        message.id,
        conversationId,
        seq,
        message.role,
        JSON.stringify(message.parts ?? []),
        message.metadata === undefined ? null : JSON.stringify(message.metadata),
        now(),
      );
      return seq;
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
        JSON.stringify(input.config),
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

    getRun(id: string): RunRow | null {
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

    bumpSteps(id: string) {
      statements.bumpSteps.run(id);
    },

    finish(
      id: string,
      status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
      error?: string,
    ) {
      statements.finish.run(status, error ?? null, now(), id);
      const run = one<RunRow>(statements.getRun.get(id));
      if (run) statements.setActiveRun.run(null, now(), run.conversation_id);
    },

    /** Reclaim runs stranded by a crash or a restart. Returns nothing useful; it
     * is called for effect on boot and on SIGTERM. */
    requeueRunning() {
      statements.requeueRunning.run();
    },

    appendEvent(runId: string, payload: unknown): number {
      const claimed = statements.nextEventSeq.get(runId) as { next: number } | undefined;
      if (!claimed) throw new Error('No such run: ' + runId);
      const seq = claimed.next;
      statements.appendEvent.run(runId, seq, JSON.stringify(payload), now());
      return seq;
    },

    /** Replay buffer for a reconnecting client, from the last seq it saw. */
    eventsAfter(runId: string, after: number): { seq: number; payload: unknown }[] {
      return (
        statements.eventsAfter.all(runId, after) as Array<{ seq: number; payload: string }>
      ).map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) }));
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
    saveAssistantMessage(conversationId: string, message: StoredMessage): void {
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
      statements.insertMessage.run(id, conversationId, seq, message.role, parts, metadata, now());
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
      statements.pruneEvents.run(runId);
    },

    isTerminal(status: RunStatus) {
      return TERMINAL.includes(status);
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
