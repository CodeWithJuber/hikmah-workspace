/** The remembered tools behind one MCP server: what the owner said yes to.
 *
 * The route file owns sign-in and the Origin check; this owns the request
 * against the store, so the list/revoke behavior is testable without the
 * app's module aliases.
 *
 * Handle one request against the saved consents.
 *
 * The caller checks Origin on writes: a same-origin browser GET carries no
 * Origin header, so requiring one here would break the list.
 */
import { DatabaseSync } from 'node:sqlite';
import { McpStoreError, createMcpStore, type McpConsent } from './store.ts';

export type ConsentsApiContext = {
  db: DatabaseSync;
  userId: string | null;
};

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** What the settings screen shows for one remembered tool: no fingerprint, no
 * connector internals — just what the owner said yes to and when it lapses. */
const publicConsent = (consent: McpConsent) => ({
  toolName: consent.toolName,
  scope: consent.scope,
  conversationId: consent.scope === 'conversation' ? consent.conversationId : undefined,
  grantedAt: consent.grantedAt,
  expiresAt: consent.expiresAt,
});

export async function consentsRequest(
  request: Request,
  context: ConsentsApiContext,
): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const store = createMcpStore(context.db);
  const userId = context.userId;
  const params = new URL(request.url).searchParams;
  const serverId = params.get('serverId') ?? '';
  const row = serverId ? store.get(serverId, userId) : null;
  if (!row) return fail('That server is not saved here.', 404);
  const listing = () =>
    Response.json({ consents: store.consents(serverId).map(publicConsent) }, { headers });

  try {
    if (request.method === 'GET') return listing();

    if (request.method === 'DELETE') {
      const toolName = params.get('toolName') ?? '';
      const scope = params.get('scope') ?? '';
      const conversationId = params.get('conversationId') ?? '';
      if (!toolName || (scope !== 'always' && scope !== 'conversation'))
        return fail('Name the remembered tool to revoke.', 400);
      store.revokeConsent(serverId, toolName, scope, conversationId);
      return listing();
    }

    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof McpStoreError) return fail(error.message, 400);
    throw error;
  }
}
