/** The owner's workspace files.
 *
 * Built on the raw node:sqlite handle for the same reason the run store is: the
 * D1-shaped shim discards result rows, so `RETURNING` is unavailable through it.
 *
 * The limits below are far larger than the ones these files had inside the
 * workspace blob — twelve files of eighty thousand characters. That cap was
 * never about what a workspace should hold; it was about what could be rewritten
 * as one JSON document on every save. Rows are written one at a time, so the
 * limits can be what a working project actually needs.
 */

/** Per-owner ceilings. Generous, but bounded: this is one person's workspace on
 * a small box, not a hosting service. */
export const MAX_FILES = 200;
export const MAX_FILE_CHARACTERS = 256_000;
export const MAX_TOTAL_CHARACTERS = 8_000_000;

/** A path segment: ordinary filename characters, and nothing that would climb
 * out of the workspace or collide with an object prototype. */
const SEGMENT = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79}$/;
const RESERVED = ['constructor', 'prototype', '__proto__'];
/** Deep enough for a real project, shallow enough to stay readable in a list. */
const MAX_DEPTH = 8;

export type WorkspaceFile = {
  path: string;
  body: string;
  updated_at: string;
};

export class FileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FileError';
    this.status = status;
  }
}

/**
 * A path this workspace will store, or a refusal saying why.
 *
 * Directories are allowed — a real project has them, and a row store has no
 * reason to forbid them — but every segment is checked, so `..`, an absolute
 * path and a prototype key are each rejected rather than normalised into
 * something that happens to work.
 */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new FileError('Give the file a name.');
  const path = raw.trim().replace(/^\.\//, '');
  if (path.startsWith('/'))
    throw new FileError('Use a path inside the workspace, not an absolute one.');
  const segments = path.split('/');
  if (segments.length > MAX_DEPTH) throw new FileError('That path is nested too deeply.');
  for (const segment of segments)
    if (!SEGMENT.test(segment) || RESERVED.includes(segment))
      throw new FileError(`"${segment}" is not a usable file or folder name.`);
  return segments.join('/');
}

export type SqliteHandle = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

export function createFileStore(
  db: SqliteHandle,
  now: () => string = () => new Date().toISOString(),
) {
  const statements = {
    list: db.prepare(
      `SELECT path, updated_at, LENGTH(body) AS size
       FROM workspace_files WHERE user_id = ? ORDER BY path`,
    ),
    read: db.prepare(
      'SELECT path, body, updated_at FROM workspace_files WHERE user_id = ? AND path = ?',
    ),
    write: db.prepare(
      `INSERT INTO workspace_files (user_id, path, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, path)
       DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ),
    remove: db.prepare('DELETE FROM workspace_files WHERE user_id = ? AND path = ? RETURNING path'),
    total: db.prepare(
      `SELECT COALESCE(SUM(LENGTH(body)), 0) AS n, COUNT(*) AS files
       FROM workspace_files WHERE user_id = ?`,
    ),
    existing: db.prepare(
      'SELECT LENGTH(body) AS size FROM workspace_files WHERE user_id = ? AND path = ?',
    ),
  };

  return {
    /** Names and sizes, not bodies: a listing is for choosing, not reading. */
    list(userId: string): { path: string; updated_at: string; size: number }[] {
      return statements.list.all(userId) as { path: string; updated_at: string; size: number }[];
    },

    read(userId: string, path: string): WorkspaceFile | null {
      return (statements.read.get(userId, normalizePath(path)) ?? null) as WorkspaceFile | null;
    },

    /**
     * Write a file, replacing it if it is already there.
     *
     * The ceilings are checked against what the workspace would hold *after*
     * this write, with the replaced file's own size discounted — otherwise
     * editing a large file would be refused for the space it already occupies.
     */
    write(userId: string, rawPath: string, body: string): WorkspaceFile {
      const path = normalizePath(rawPath);
      if (typeof body !== 'string') throw new FileError('A file is text.');
      if (body.length > MAX_FILE_CHARACTERS)
        throw new FileError(
          `A file is limited to ${MAX_FILE_CHARACTERS.toLocaleString()} characters.`,
        );

      const previous = (statements.existing.get(userId, path) ?? null) as { size: number } | null;
      const { n: total, files } = statements.total.get(userId) as { n: number; files: number };
      if (!previous && files >= MAX_FILES)
        throw new FileError(`This workspace holds up to ${MAX_FILES} files.`);
      if (total - (previous?.size ?? 0) + body.length > MAX_TOTAL_CHARACTERS)
        throw new FileError('This workspace is full. Delete something before writing more.');

      const stamp = now();
      statements.write.run(userId, path, body, stamp, stamp);
      return { path, body, updated_at: stamp };
    },

    /** Returns false when there was nothing there, which is not an error. */
    delete(userId: string, path: string): boolean {
      return (statements.remove.get(userId, normalizePath(path)) ?? null) !== null;
    },

    usage(userId: string): { files: number; characters: number } {
      const row = statements.total.get(userId) as { n: number; files: number };
      return { files: row.files, characters: row.n };
    },
  };
}

export type FileStore = ReturnType<typeof createFileStore>;
