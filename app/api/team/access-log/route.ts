import { getChatGPTUser } from '../../../chatgpt-auth';
import { teamStore } from '@/lib/team/server';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Who read my content, and when.
 *
 * Every consented content read writes one row to team_content_access_log
 * (see /api/team/content); this route lets the resource owner review theirs.
 * Staff with the audit permission see the same shape through the admin
 * console, not here — this is the owner's own receipt.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('offset') ?? 0);
  const { entries, total } = teamStore().listAccessByOwner(user.userId, limit, offset);
  return Response.json({ entries, total }, { headers });
}
