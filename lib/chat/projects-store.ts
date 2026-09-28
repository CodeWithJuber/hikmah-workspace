/** Chat v2 conversation management: projects, pinning, rename, move.
 *
 * Raw node:sqlite for the same reason `lib/runs/store.ts` uses it: this module
 * imports nothing from Next, so it can be exercised against a real database
 * without a server. Everything is scoped by user_id; a method that touches a
 * row belonging to someone else returns false/null rather than throwing, so a
 * 404 and "not yours" are the same answer by construction.
 */

import { randomUUID } from 'node:crypto';

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: unknown };
  };
  exec(sql: string): void;
};

export type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type ProjectWithCount = ProjectRow & {
  conversationCount: number;
};

/** Project ids share the repo's id shape: a short prefix, then a UUID. */
export const newProjectId = () => 'proj_' + randomUUID();

export function createProjectsStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    insertProject: db.prepare(
      'INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?'),
    listProjects: db.prepare(
      `SELECT p.id, p.user_id, p.name, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM conversations c
               WHERE c.project_id = p.id AND c.user_id = p.user_id) AS conversation_count
       FROM projects p
       WHERE p.user_id = ?
       ORDER BY p.updated_at DESC, p.id`,
    ),
    renameProject: db.prepare(
      'UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?'),
    // Renaming never touches the title-only-if-empty guard the runs store's
    // setTitle keeps: an owner may rename a conversation that already has a
    // title, including one a run generated.
    renameConversation: db.prepare(
      'UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?',
    ),
    setPinned: db.prepare('UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?'),
    moveConversation: db.prepare(
      'UPDATE conversations SET project_id = ? WHERE id = ? AND user_id = ?',
    ),
  };

  return {
    /** Create a project for the owner. A blank name is the caller's problem to
     * prevent; the store trims so "  " cannot become a nameless row. */
    createProject(userId: string, name: string): ProjectRow {
      const at = now();
      const row: ProjectRow = {
        id: newProjectId(),
        user_id: userId,
        name: name.trim(),
        created_at: at,
        updated_at: at,
      };
      statements.insertProject.run(row.id, row.user_id, row.name, row.created_at, row.updated_at);
      return row;
    },

    getProject(userId: string, projectId: string): ProjectRow | null {
      return (statements.getProject.get(projectId, userId) as ProjectRow | undefined) ?? null;
    },

    /** The owner's projects, most recently touched first, with how many of
     * their conversations each one currently holds. */
    listProjects(userId: string): ProjectWithCount[] {
      return (
        statements.listProjects.all(userId) as Array<ProjectRow & { conversation_count: number }>
      ).map((row) => ({
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        created_at: row.created_at,
        updated_at: row.updated_at,
        conversationCount: row.conversation_count,
      }));
    },

    /** False when the project is not this owner's (or not there at all). */
    renameProject(userId: string, projectId: string, name: string): boolean {
      const trimmed = name.trim();
      if (!trimmed) return false;
      const result = statements.renameProject.run(trimmed, now(), projectId, userId);
      return Number(result.changes) > 0;
    },

    /** False when the project is not this owner's. The conversations stay:
     * the foreign key is ON DELETE SET NULL, so they land back in the
     * unfiled list rather than following the project into the bin. */
    deleteProject(userId: string, projectId: string): boolean {
      const result = statements.deleteProject.run(projectId, userId);
      return Number(result.changes) > 0;
    },

    /** Rename a conversation even when it already has a title. False when it
     * is not this owner's. */
    renameConversation(id: string, userId: string, title: string): boolean {
      const result = statements.renameConversation.run(title.trim(), id, userId);
      return Number(result.changes) > 0;
    },

    /** Pin (1) or unpin (0). False when the conversation is not this owner's. */
    setPinned(id: string, userId: string, pinned: boolean): boolean {
      const result = statements.setPinned.run(pinned ? 1 : 0, id, userId);
      return Number(result.changes) > 0;
    },

    /** File a conversation into a project, or null to take it back out.
     * Moving into a project that is not this owner's is refused; the
     * conversations endpoint already verified the conversation itself. */
    moveConversation(id: string, userId: string, projectId: string | null): boolean {
      if (projectId !== null && !this.getProject(userId, projectId)) return false;
      const result = statements.moveConversation.run(projectId, id, userId);
      return Number(result.changes) > 0;
    },
  };
}
