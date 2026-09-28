import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createProjectsStore } from '@/lib/chat/projects-store';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** The sidebar's own listing, with how many conversations each project holds. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    return fail('Use this from your signed-in workspace.', 403);

  const projects = createProjectsStore(getStorage().raw).listProjects(user.userId);
  return Response.json({ projects }, { headers });
}

/** Create a project. The name is user text on the way in, so it is bounded
 * before it reaches the row. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);

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

  const project = createProjectsStore(getStorage().raw).createProject(user.userId, name);
  return Response.json({ project }, { headers, status: 201 });
}
