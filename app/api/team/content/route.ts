import { getStorage } from '@/server/storage.mjs';
import { requirePermission } from '@/lib/authz/server';
import { KernelHttpError } from '@/lib/kernel/server';
import { teamStore } from '@/lib/team/server';
import { ownerOf, type OwnableResource } from '@/lib/team/enforcement';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Consented content access for staff.
 *
 * Support staff see metadata by default (/api/team/support-view). Reading a
 * person's actual content needs an explicit, unexpired, unrevoked grant from
 * the workspace owner (team_content_consents) — and EVERY read here writes
 * one row to team_content_access_log, which the owner reviews at
 * /api/team/access-log. No grant → 404; the route never distinguishes "no
 * consent" from "no such resource".
 *
 * Covered types: file (body), memory (content), secret (the sealed
 * ciphertext — support cannot unseal it, but the access is still gated and
 * audited). Runs are deliberately EXCLUDED: a run's config can embed provider
 * keys, and telemetry plus metadata suffice for support work.
 */

type ContentResource = 'file' | 'memory' | 'secret';

const isContentResource = (value: unknown): value is ContentResource =>
  value === 'file' || value === 'memory' || value === 'secret';

function readContent(resource: ContentResource, ownerId: string, ref: string): unknown {
  const raw = getStorage().raw;
  if (resource === 'file') {
    const row = raw
      .prepare('SELECT path, body, updated_at FROM workspace_files WHERE user_id = ? AND path = ?')
      .get(ownerId, ref) as { path?: string; body?: string; updated_at?: string } | undefined;
    return row?.body !== undefined
      ? { path: row.path, body: row.body, updatedAt: row.updated_at }
      : null;
  }
  if (resource === 'memory') {
    const row = raw
      .prepare(
        'SELECT id, kind, title, content, updated_at FROM memories WHERE user_id = ? AND id = ?',
      )
      .get(ownerId, ref) as
      | { id?: string; kind?: string; title?: string; content?: string; updated_at?: string }
      | undefined;
    return row?.content !== undefined
      ? {
          id: row.id,
          kind: row.kind,
          title: row.title,
          content: row.content,
          updatedAt: row.updated_at,
        }
      : null;
  }
  const row = raw
    .prepare(
      'SELECT name, destination, sealed, updated_at FROM workspace_secrets WHERE user_id = ? AND name = ?',
    )
    .get(ownerId, ref) as
    { name?: string; destination?: string; sealed?: string; updated_at?: string } | undefined;
  return row?.sealed !== undefined
    ? {
        name: row.name,
        destination: row.destination,
        sealed: row.sealed,
        updatedAt: row.updated_at,
      }
    : null;
}

export async function GET(request: Request) {
  let staffId: string;
  try {
    staffId = (await requirePermission('users:read')).user.userId;
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
  const params = new URL(request.url).searchParams;
  const resource = params.get('resource');
  const ref = params.get('ref') ?? '';
  if (!isContentResource(resource) || !ref || ref.length > 512)
    return fail('resource (file, memory, secret) and ref are required.', 400);

  const store = teamStore();
  const raw = getStorage().raw;
  // Resolve the owner from the row itself, then find a live consent on any of
  // the owner's workspaces. Both steps fail closed to the same 404.
  const ownerId = ownerOf(raw, store, resource as OwnableResource, staffId, ref);
  let consent: { id: string } | null = null;
  if (ownerId && ownerId !== staffId) {
    for (const workspace of store.listWorkspaces(ownerId)) {
      if (workspace.ownerUserId !== ownerId) continue;
      const active = store.activeConsent(workspace.id, staffId);
      if (active) {
        consent = active;
        break;
      }
    }
  }
  if (!ownerId || !consent) return fail('Not found.', 404);

  const content = readContent(resource, ownerId, ref);
  if (content === null) return fail('Not found.', 404);

  // The audit row is the point of this route: a read whose audit could not be
  // written throws, so it never claims to be audited when it is not.
  store.logContentAccess(staffId, resource, ref, ownerId, consent.id);
  return Response.json({ content }, { headers });
}
