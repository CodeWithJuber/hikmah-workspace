import { getChatGPTUser } from '../../../chatgpt-auth';
import { teamStore } from '@/lib/team/server';
import { KernelHttpError } from '@/lib/kernel/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Team workspaces: named sharing scopes anchored at their owner.
 *
 * A person's own rows need no workspace row — their user_id is the owner of
 * record. A workspace exists when someone wants teammates to read (viewer) or
 * read and write (member) their resources.
 */

/** Workspaces the caller owns or is an active member of. */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  try {
    return Response.json({ workspaces: teamStore().listWorkspaces(user.userId) }, { headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}

/** Create a workspace owned by the caller. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail('Send a JSON body with a name.', 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) return fail('A workspace needs a name.', 400);
  try {
    const workspace = teamStore().createWorkspace(name, user.userId);
    return Response.json({ workspace }, { status: 201, headers });
  } catch (error) {
    if (error instanceof KernelHttpError) return fail(error.message, error.status);
    throw error;
  }
}
