import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { AgentError, createAgentStore } from '@/lib/agents/store';
import { BUILT_IN_TOOLS } from '@/lib/agents/templates';
import { getStorage } from '@/server/storage.mjs';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const store = () => createAgentStore(getStorage().raw);

/** The owner's agents, seeded with the built-in templates on first read. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  // The tool names travel with the list so an editor can offer exactly what an
  // agent may name, rather than keeping its own copy that drifts.
  return Response.json({ agents: store().list(user.userId), tools: BUILT_IN_TOOLS }, { headers });
}

/** Create an agent, or replace one by id. */
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail('Send the agent as JSON.', 400);
  try {
    return Response.json({ agent: store().save(user.userId, body as never) }, { headers });
  } catch (error) {
    if (error instanceof AgentError) return fail(error.message, error.status);
    throw error;
  }
}

/** Remove one. Deleting a built-in is allowed and sticks: the templates are
 * seeded only into a workspace that has no agents at all, so nothing resurrects
 * what the owner threw away. */
export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return fail('Name the agent to delete.', 400);
  return Response.json({ deleted: store().delete(id, user.userId) }, { headers });
}
