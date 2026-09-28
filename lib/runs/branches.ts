/** Message branching: a tree over messages with the active path materialized.
 *
 * The messages table is a tree through `parent_id`; `on_active_path` marks
 * the single root-to-leaf path that the worker and the transcript read (see
 * drizzle/0023_message_branches.sql). This module owns the tree operations:
 * editing a user message into a sibling branch, switching which branch is
 * active, and forking a conversation from a message. The linear pipeline —
 * listMessages, truncateFrom, the worker's prompt builder — keeps working
 * unchanged once it filters on `on_active_path = 1`.
 *
 * Like lib/runs/store.ts this module imports nothing from Next, the kernel,
 * or the browser modules, and uses only erasable TypeScript (no enums, no
 * parameter properties) so it survives node --test type-stripping.
 */
import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './store.ts';

type BranchRow = {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  parts: string;
  metadata: string | null;
  parent_id: string | null;
  on_active_path: number;
  created_at: string;
};

type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  mode: string;
  model: string;
};

export type Siblings = {
  siblings: { id: string }[];
  index: number;
};

export type EditOutcome =
  | { newId: string }
  /** The message does not exist, or belongs to someone else's conversation. */
  | { forbidden: true }
  /** Only user messages can be edited into a branch. */
  | { notUserMessage: true };

function get<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

export function createBranchStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    getConversation: db.prepare(
      'SELECT id, user_id, title, mode, model FROM conversations WHERE id = ?',
    ),
    getMessage: db.prepare(
      'SELECT id, conversation_id, seq, role, parts, metadata, parent_id, on_active_path, created_at FROM messages WHERE conversation_id = ? AND id = ?',
    ),
    childrenOf: db.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND parent_id = ?
       ORDER BY created_at, id`,
    ),
    rootChildren: db.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND parent_id IS NULL
       ORDER BY created_at, id`,
    ),
    activePathIds: db.prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND on_active_path = 1
       ORDER BY seq`,
    ),
    onPathChild: db.prepare(
      `SELECT id, parent_id, on_active_path, created_at FROM messages
       WHERE conversation_id = ? AND parent_id = ? AND on_active_path = 1
       ORDER BY created_at, id
       LIMIT 1`,
    ),
    latestChild: db.prepare(
      `SELECT id, parent_id, on_active_path, created_at FROM messages
       WHERE conversation_id = ? AND parent_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ),
    maxSeq: db.prepare(
      'SELECT COALESCE(MAX(seq), -1) AS top FROM messages WHERE conversation_id = ?',
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, parts, metadata, parent_id, on_active_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setOnPath: db.prepare('UPDATE messages SET on_active_path = ? WHERE id = ?'),
    insertConversation: db.prepare(
      `INSERT INTO conversations (id, user_id, title, mode, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    conversationMessages: db.prepare(
      `SELECT id, conversation_id, seq, role, parts, metadata, parent_id, on_active_path, created_at FROM messages
       WHERE conversation_id = ?
       ORDER BY seq`,
    ),
  };

  function ownedConversation(conversationId: string, userId: string): ConversationRow | null {
    const row = get<ConversationRow>(statements.getConversation.get(conversationId));
    return row && row.user_id === userId ? row : null;
  }

  function messageIn(conversationId: string, messageId: string): BranchRow | null {
    return get<BranchRow>(statements.getMessage.get(conversationId, messageId));
  }

  /** The chain of ancestors from the root down to the message itself. */
  function ancestorChain(conversationId: string, messageId: string): string[] | null {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = messageId;
    while (current) {
      if (seen.has(current)) return null; // a cycle is corruption, not a path
      seen.add(current);
      const row = messageIn(conversationId, current);
      if (!row) return null;
      chain.unshift(row.id);
      current = row.parent_id;
    }
    return chain;
  }

  /** Active-path descendants of a message, following the on-path child and
   * falling back to the latest child where the path has gone cold (which is
   * exactly what switching to an edited-away branch does). */
  function descendantChain(conversationId: string, messageId: string): string[] {
    const chain: string[] = [];
    let current = messageId;
    const seen = new Set<string>([current]);
    for (;;) {
      const onPath = get<{ id: string }>(statements.onPathChild.get(conversationId, current));
      const next =
        onPath ?? get<{ id: string }>(statements.latestChild.get(conversationId, current));
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next.id);
      current = next.id;
    }
    return chain;
  }

  function flip(oldIds: string[], newIds: string[]): void {
    const deactivate = new Set(oldIds);
    const activate = new Set(newIds);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of deactivate) if (!activate.has(id)) statements.setOnPath.run(0, id);
      for (const id of activate) if (!deactivate.has(id)) statements.setOnPath.run(1, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Direct children of a message, oldest first. Passing null lists the
   * conversation's roots (parent_id IS NULL). */
  function listChildren(conversationId: string, messageId: string | null): { id: string }[] {
    const rows =
      messageId === null
        ? statements.rootChildren.all(conversationId)
        : statements.childrenOf.all(conversationId, messageId);
    return (rows as { id: string }[]).map((row) => ({ id: row.id }));
  }

  /** The ids on the active path, root to leaf. This is what the transcript
   * and the worker's prompt builder read. */
  function getActivePath(conversationId: string): string[] {
    return (statements.activePathIds.all(conversationId) as { id: string }[]).map((row) => row.id);
  }

  /** The message's sibling group — itself included — and its index in it.
   * Null when the message does not exist in this conversation. */
  function getSiblings(conversationId: string, messageId: string): Siblings | null {
    const row = messageIn(conversationId, messageId);
    if (!row) return null;
    const siblings = listChildren(conversationId, row.parent_id);
    const index = siblings.findIndex((sibling) => sibling.id === messageId);
    return { siblings, index };
  }

  /** Make the branch containing `messageId` the active one, flipping
   * on_active_path in a single transaction. Null when the conversation is
   * not this owner's, or the message is not in it. */
  function activateBranch(
    conversationId: string,
    userId: string,
    messageId: string,
  ): { path: string[] } | null {
    if (!ownedConversation(conversationId, userId)) return null;
    const ancestors = ancestorChain(conversationId, messageId);
    if (!ancestors) return null;
    const path = ancestors.concat(descendantChain(conversationId, messageId));
    flip(getActivePath(conversationId), path);
    return { path };
  }

  /** Edit a user message into a new sibling branch: the new message goes on
   * the active path, and the old message plus its active-path subtree goes
   * off it. The client then regenerates from the new message through the
   * normal runs flow. */
  function editIntoBranch(
    conversationId: string,
    userId: string,
    messageId: string,
    newParts: unknown,
  ): EditOutcome {
    if (!ownedConversation(conversationId, userId)) return { forbidden: true };
    const row = messageIn(conversationId, messageId);
    if (!row) return { forbidden: true };
    if (row.role !== 'user') return { notUserMessage: true };

    const newId = 'msg_' + randomUUID();
    const top = (statements.maxSeq.get(conversationId) as { top: number }).top;
    const deactivate = [row.id].concat(descendantChain(conversationId, row.id));

    db.exec('BEGIN IMMEDIATE');
    try {
      statements.insertMessage.run(
        newId,
        conversationId,
        top + 1,
        'user',
        JSON.stringify(newParts ?? []),
        row.metadata,
        row.parent_id,
        1,
        now(),
      );
      for (const id of deactivate) statements.setOnPath.run(0, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { newId };
  }

  /** Fork the conversation at a message: a new conversation owned by the
   * same user, holding a copy of the active path up to and including the
   * message — new ids, the parent chain preserved relatively, seq 0..n. */
  function forkAt(
    conversationId: string,
    userId: string,
    messageId: string,
    newId: string,
  ): { id: string } | null {
    const conversation = ownedConversation(conversationId, userId);
    if (!conversation) return null;
    const prefix = ancestorChain(conversationId, messageId);
    if (!prefix) return null;

    const stamp = now();
    const rows = (statements.conversationMessages.all(conversationId) as BranchRow[]).filter(
      (row) => prefix.includes(row.id),
    );
    const remap = new Map<string, string>();
    for (const row of rows) remap.set(row.id, 'msg_' + randomUUID());

    db.exec('BEGIN IMMEDIATE');
    try {
      statements.insertConversation.run(
        newId,
        userId,
        conversation.title + ' (fork)',
        conversation.mode,
        conversation.model,
        stamp,
        stamp,
      );
      rows.forEach((row, index) => {
        statements.insertMessage.run(
          remap.get(row.id) as string,
          newId,
          index,
          row.role,
          row.parts,
          row.metadata,
          row.parent_id ? (remap.get(row.parent_id) as string) : null,
          1,
          stamp,
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { id: newId };
  }

  /** Take an assistant message (and whatever is visibly below it) off the
   * active path, preserving it as a sibling of the answer that replaces it.
   * This is what "regenerate" means now: the old answer is not deleted, it
   * becomes branch 1 of 2. Returns the parent id the new answer should be
   * written under, so the client can regenerate from the right message. */
  function detachSubtree(
    conversationId: string,
    userId: string,
    messageId: string,
  ): { parentId: string | null } | { forbidden: true } | { notAssistant: true } {
    if (!ownedConversation(conversationId, userId)) return { forbidden: true };
    const row = messageIn(conversationId, messageId);
    if (!row) return { forbidden: true };
    if (row.role !== 'assistant') return { notAssistant: true };

    // Strictly the visible subtree: the on-path child chain below this
    // message. A later sibling the person switched away from is already off
    // the path and stays exactly where it is.
    const offPath: string[] = [row.id];
    let current = row.id;
    for (;;) {
      const child = get<{ id: string }>(statements.onPathChild.get(conversationId, current));
      if (!child || offPath.includes(child.id)) break;
      offPath.push(child.id);
      current = child.id;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of offPath) statements.setOnPath.run(0, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { parentId: row.parent_id };
  }

  return {
    children: listChildren,
    siblingsOf: getSiblings,
    activePath: getActivePath,
    setActiveBranch: activateBranch,
    editMessage: editIntoBranch,
    forkConversation: forkAt,
    detachSubtree,
  };
}

export type BranchStore = ReturnType<typeof createBranchStore>;
