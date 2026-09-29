import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { retryDeferredMemories } from '@/lib/memory/triage-retry';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/**
 * Re-run due deferred memory-triage items for the signed-in user.
 *
 * A deferred item is one triage could not decide because Jev was unreachable;
 * the retry gives it a second look, and surfaces it rather than deferring a
 * second time. Safe to call after any turn — with nothing due it only reads.
 */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this from your signed-in workspace.', 403);
  const result = await retryDeferredMemories({ userId: user.userId });
  return Response.json(result, { headers });
}
