/** What support staff see by default: metadata, never content.
 *
 * The backlog acceptance is "support metadata by default". This module makes
 * that true BY CONSTRUCTION, not by convention: each projector builds a fresh
 * object containing only the declared metadata fields. There is no code path
 * here that copies a content column — `body`, `sealed`, `content`, `config`,
 * `error` and payloads are simply not named, so they cannot leak.
 *
 * Content needs an explicit consent grant (team_content_consents) and every
 * such read is written to team_content_access_log; that path lives in
 * lib/team/store.ts and the /api/team/content route, not here.
 */

export type MetadataResource = 'run' | 'file' | 'secret' | 'memory';

export type RunMetadata = {
  resource: 'run';
  id: string;
  status: string;
  stepCount: number;
  createdAt: string;
  endedAt: string | null;
};

export type FileMetadata = {
  resource: 'file';
  path: string;
  /** Characters, not content: a size the staff member can reason about. */
  sizeChars: number;
  updatedAt: string;
};

export type SecretMetadata = {
  resource: 'secret';
  name: string;
  destination: string;
  updatedAt: string;
};

export type MemoryMetadata = {
  resource: 'memory';
  id: string;
  kind: string;
  title: string;
  updatedAt: string;
};

export type ResourceMetadata = RunMetadata | FileMetadata | SecretMetadata | MemoryMetadata;

/** The content columns each projector MUST NOT touch. Named here so a review
 * can grep the negative: adding a column to this list without removing it
 * from a projector below is the bug this file exists to prevent. */
export const CONTENT_COLUMNS: Record<MetadataResource, readonly string[]> = {
  run: ['config', 'error'],
  file: ['body'],
  secret: ['sealed'],
  memory: ['content', 'content_key'],
};

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** One resource row (as the store returns it) to its metadata view. Unknown
 * resource types return null: fail closed rather than guessing a shape. */
export function projectMetadata(resource: MetadataResource, row: Row): ResourceMetadata | null {
  switch (resource) {
    case 'run':
      return {
        resource: 'run',
        id: text(row.id),
        status: text(row.status),
        stepCount: num(row.step_count),
        createdAt: text(row.created_at),
        endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
      };
    case 'file':
      // sizeChars prefers an explicit size column (a route can SELECT
      // LENGTH(body) and never load the content at all); the body fallback
      // exists for callers that already hold the row.
      return {
        resource: 'file',
        path: text(row.path),
        sizeChars:
          typeof row.sizeChars === 'number'
            ? row.sizeChars
            : typeof row.size_chars === 'number'
              ? row.size_chars
              : text(row.body).length,
        updatedAt: text(row.updated_at),
      };
    case 'secret':
      return {
        resource: 'secret',
        name: text(row.name),
        destination: text(row.destination),
        updatedAt: text(row.updated_at),
      };
    case 'memory':
      return {
        resource: 'memory',
        id: text(row.id),
        kind: text(row.kind),
        title: text(row.title),
        updatedAt: text(row.updated_at),
      };
    default:
      return null;
  }
}

/** Project a list; rows that do not project are dropped, not passed through. */
export function projectMetadataList(resource: MetadataResource, rows: Row[]): ResourceMetadata[] {
  const out: ResourceMetadata[] = [];
  for (const row of rows) {
    const projected = projectMetadata(resource, row);
    if (projected) out.push(projected);
  }
  return out;
}
