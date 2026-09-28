import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createProjectsStore } from '@/lib/chat/projects-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Rename a project.
 *
 * Same answer whether the project is missing or belongs to someone else, so
 * the reply cannot be used to enumerate another owner's projects.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const name =
    typeof body === 'object' && body !== null
      ? String((body as { name?: unknown }).name ?? '')
      : '';
  if (!name.trim()) return fail('Give the project a name.', 400);
  if (name.trim().length > 120) return fail('Keep the project name under 120 characters.', 400);

  const ok = createProjectsStore(getStorage().raw).renameProject(user.userId, id, name);
  if (!ok) return fail('Project not found.', 404);
  return Response.json({ renamed: true }, { headers });
}

/**
 * Delete a project. The conversations stay: the foreign key is
 * ON DELETE SET NULL, so they return to the unfiled list rather than being
 * deleted with the project.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const { id } = await context.params;
  const ok = createProjectsStore(getStorage().raw).deleteProject(user.userId, id);
  if (!ok) return fail('Project not found.', 404);
  return Response.json({ deleted: true }, { headers });
}
