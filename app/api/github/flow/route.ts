/** The exemplar step endpoint.
 *
 * POST /api/github/flow
 *   { connectionId, action, params, approvedParamsHash?, checksOverride? }
 *
 * Runs one exemplar action through `runExemplarAction` and turns an
 * `ExemplarFailure` into a 422 carrying the recovery guidance and the
 * preserved draft, so the client can show "here is what to do, and nothing
 * was lost" instead of a bare error.
 */
import { getChatGPTUser } from '../../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { createSecretStore } from '@/server/workspace-secrets.mjs';
import { runExemplarAction, ExemplarFailure } from '@/lib/github/flow';
import { githubSecretName, githubSecretDestination } from '@/lib/github/connections-api';
import { EXEMPLAR_ACTIONS, type ExemplarAction } from '@/lib/github/scopes';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  if (request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail('Expected a JSON request body.', 400);
  const action = body.action as ExemplarAction;
  if (!EXEMPLAR_ACTIONS.includes(action)) return fail('Pick one of the exemplar steps.', 400);
  const connectionId = String(body.connectionId ?? '');
  if (!connectionId) return fail('Name the GitHub connection.', 400);
  const params =
    body.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>) : {};

  const secrets = createSecretStore();
  try {
    const result = await runExemplarAction({
      db: getStorage().raw,
      userId: user.userId,
      connectionId,
      action,
      params,
      getToken: async (id) =>
        secrets
          .resolve(user.userId, githubSecretName(id), githubSecretDestination(id), true)
          .then((value) => value || null)
          .catch(() => null),
      approvedParamsHash:
        typeof body.approvedParamsHash === 'string' ? body.approvedParamsHash : undefined,
      checksOverride: body.checksOverride === true,
      liveWritesEnabled: process.env.GITHUB_LIVE_WRITES === '1',
    });
    return Response.json(
      {
        action: result.action,
        dryRun: result.dryRun,
        receiptId: result.receiptId,
        data: result.data,
        blocked: result.blocked ?? null,
        liveWritesEnabled: process.env.GITHUB_LIVE_WRITES === '1',
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof ExemplarFailure)
      return Response.json(
        {
          error: error.message,
          code: error.code,
          recovery: error.recovery,
          retryable: error.retryable,
          preserved: error.preserved ?? null,
        },
        { status: 422, headers },
      );
    throw error;
  }
}
