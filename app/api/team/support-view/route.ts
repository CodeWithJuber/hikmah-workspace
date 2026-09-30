import { getStorage } from '@/server/storage.mjs';
import { requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';
import { projectMetadataList, type MetadataResource } from '@/lib/team/support-view';
import { createTeamCache } from '@/lib/team/cache';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Support metadata by default.
 *
 * Staff (support or owner — the `users:read` permission) may list a person's
 * resource METADATA: names, counts, timestamps. Content columns are never
 * selected here — the file query takes LENGTH(body), never body — and the
 * projector in lib/team/support-view.ts builds the response from a
 * whitelist, so content cannot leak by construction.
 *
 * Results are cached per user (lib/team/cache.ts): the cache is namespaced by
 * the resource owner's id, so one person's metadata can never be served for
 * another's key.
 */

const RESOURCES: Record<MetadataResource, { sql: string; limit: number }> = {
  run: {
    sql: 'SELECT id, status, step_count, created_at, ended_at FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    limit: 100,
  },
  file: {
    // LENGTH(body): the size without the content.
    sql: 'SELECT path, LENGTH(body) AS size_chars, updated_at FROM workspace_files WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    limit: 200,
  },
  secret: {
    sql: 'SELECT name, destination, updated_at FROM workspace_secrets WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    limit: 200,
  },
  memory: {
    sql: 'SELECT id, kind, title, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    limit: 200,
  },
};

const cache = createTeamCache();

const isResource = (value: unknown): value is MetadataResource =>
  typeof value === 'string' && value in RESOURCES;

export async function GET(request: Request) {
  let staff: { userId: string };
  try {
    staff = (await requirePermission('users:read')).user;
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
  const params = new URL(request.url).searchParams;
  const targetId = params.get('user_id') ?? '';
  const resource = params.get('resource');
  if (!targetId || targetId.length > 128) return fail('user_id is required.', 400);
  if (!isResource(resource)) return fail('resource must be run, file, secret or memory.', 400);

  const scope = cache.scope(`support:${staff.userId}:target:${targetId}`);
  const cacheKey = `metadata:${resource}`;
  const cachedView = scope.get<unknown[]>(cacheKey);
  if (cachedView) return Response.json({ metadata: cachedView, cached: true }, { headers });

  const raw = getStorage().raw;
  const { sql, limit } = RESOURCES[resource];
  const rows = raw.prepare(sql).all(targetId, limit) as Array<Record<string, unknown>>;
  const metadata = projectMetadataList(resource, rows);
  scope.set(cacheKey, metadata, 30_000);
  return Response.json({ metadata, cached: false }, { headers });
}
