import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { FileError, createFileStore } from '@/lib/files/store';
import { PREVIEW_TTL_MS, previewPath, signPreviewToken } from '@/lib/files/preview-link';
import { getStorage } from '@/server/storage.mjs';
import { teamStore } from '@/lib/team/server';
import { assertCanRead, assertCanWrite, ownerOf, TeamAccessDenied } from '@/lib/team/enforcement';
import { canRead } from '@/lib/team/ownership';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const store = () => createFileStore(getStorage().raw);

/**
 * List the workspace, or read one file with `?path=`.
 *
 * Cookie plus Sec-Fetch-Site rather than Origin, as on the other read paths: a
 * browser sends no Origin on a same-origin GET.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const files = store();
  const path = new URL(request.url).searchParams.get('path');
  const raw = getStorage().raw;
  const team = teamStore();
  if (!path) {
    // Optional ?owner=: list a teammate's workspace when the caller holds a
    // read grant on the owner's workspace; anything else is the same 404.
    const ownerParam = new URL(request.url).searchParams.get('owner');
    let listOwner = user.userId;
    if (ownerParam && ownerParam !== user.userId) {
      try {
        const role = team.teamRoleOnOwner(ownerParam, user.userId);
        if (!canRead(user.userId, ownerParam, role)) throw new TeamAccessDenied();
        listOwner = ownerParam;
      } catch (error) {
        if (error instanceof TeamAccessDenied) return fail('Not found.', 404);
        throw error;
      }
    }
    // Where this workspace's pages are served, for a week: the Files panel's
    // full-page preview and its private link. Minted per read, so the link is
    // never older than the listing it came with.
    const secret = process.env.BETTER_AUTH_SECRET ?? '';
    const preview = secret
      ? previewPath(
          signPreviewToken({ userId: user.userId, expiresAt: Date.now() + PREVIEW_TTL_MS }, secret),
        )
      : undefined;
    return Response.json(
      { ...files.usage(listOwner), files: files.list(listOwner), preview },
      { headers },
    );
  }

  try {
    // The team layer resolves the owner from the row: the caller, or a
    // teammate with a read grant. Anyone else gets 404.
    const ownerId = assertCanRead(raw, team, user.userId, 'file', path);
    const file = files.read(ownerId, path);
    if (!file) return fail('There is no file with that name.', 404);
    return Response.json({ file }, { headers });
  } catch (error) {
    if (error instanceof TeamAccessDenied) return fail('There is no file with that name.', 404);
    if (error instanceof FileError) return fail(error.message, error.status);
    throw error;
  }
}

/** Create or replace one file. */
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as {
    path?: unknown;
    content?: unknown;
  } | null;
  if (!body || typeof body.content !== 'string') return fail('Send a path and its content.', 400);

  try {
    // A write to an existing row needs a write grant on its owner; a new
    // path is the caller's own file, so it is always theirs to create.
    const raw = getStorage().raw;
    const team = teamStore();
    const existingOwner = ownerOf(raw, team, 'file', user.userId, body.path as string);
    const ownerId = existingOwner
      ? assertCanWrite(raw, team, user.userId, 'file', body.path as string)
      : user.userId;
    const file = store().write(ownerId, body.path as string, body.content);
    return Response.json({ file: { path: file.path, updated_at: file.updated_at } }, { headers });
  } catch (error) {
    if (error instanceof TeamAccessDenied) return fail('There is no file with that name.', 404);
    if (error instanceof FileError) return fail(error.message, error.status);
    throw error;
  }
}

/** Remove one file. Deleting something absent is not an error. */
export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const path = new URL(request.url).searchParams.get('path');
  if (!path) return fail('Name the file to delete.', 400);
  try {
    // Deleting a teammate's file needs a write grant; deleting something
    // absent stays a non-error, exactly as before.
    const raw = getStorage().raw;
    const team = teamStore();
    const existingOwner = ownerOf(raw, team, 'file', user.userId, path);
    if (existingOwner && existingOwner !== user.userId)
      assertCanWrite(raw, team, user.userId, 'file', path);
    return Response.json(
      { deleted: store().delete(existingOwner ?? user.userId, path) },
      { headers },
    );
  } catch (error) {
    if (error instanceof TeamAccessDenied) return fail('There is no file with that name.', 404);
    if (error instanceof FileError) return fail(error.message, error.status);
    throw error;
  }
}
