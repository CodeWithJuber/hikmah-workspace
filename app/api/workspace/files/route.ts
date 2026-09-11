import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { FileError, createFileStore } from '@/lib/files/store';
import { getStorage } from '@/server/storage.mjs';

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
  if (!path)
    return Response.json(
      { ...files.usage(user.userId), files: files.list(user.userId) },
      { headers },
    );

  try {
    const file = files.read(user.userId, path);
    if (!file) return fail('There is no file with that name.', 404);
    return Response.json({ file }, { headers });
  } catch (error) {
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
    const file = store().write(user.userId, body.path as string, body.content);
    return Response.json({ file: { path: file.path, updated_at: file.updated_at } }, { headers });
  } catch (error) {
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
    return Response.json({ deleted: store().delete(user.userId, path) }, { headers });
  } catch (error) {
    if (error instanceof FileError) return fail(error.message, error.status);
    throw error;
  }
}
