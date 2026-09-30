/** The request handler behind `/api/github`.
 *
 * The route file owns sign-in and the Origin check; this owns the request
 * against the store and the secret vault, so connect/disconnect behavior is
 * testable without the app's module aliases. The token is verified against
 * GitHub before anything is saved, and it is stored in the encrypted secret
 * store bound to the connection id — never in the database row.
 */
import { DatabaseSync } from 'node:sqlite';
import { createGitHubClient, type GitHubFetcher } from './client.ts';
import { parseDeclaredScopes } from './scopes.ts';
import { createGitHubStore, GitHubStoreError, type GitHubConnection } from './store.ts';

export type SecretPort = {
  save(userId: string, input: { name: string; value: string; destination: string }): Promise<void>;
  remove(userId: string, name: string): Promise<void>;
  resolve(userId: string, name: string, destination: string): Promise<string>;
};

export type GitHubApiContext = {
  db: DatabaseSync;
  userId: string | null;
  secrets: SecretPort;
  fetchImpl?: GitHubFetcher;
};

export const githubSecretName = (connectionId: string) =>
  `GITHUB_${connectionId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
export const githubSecretDestination = (connectionId: string) => `github:${connectionId}`;

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

const publicConnection = (connection: GitHubConnection) => ({
  id: connection.id,
  label: connection.label,
  scopes: connection.scopes,
  status: connection.status,
  lastError: connection.lastError,
  createdAt: connection.createdAt,
});

export async function githubRequest(
  request: Request,
  context: GitHubApiContext,
): Promise<Response> {
  if (!context.userId) return fail('Sign in to your private workspace.', 401);
  const store = createGitHubStore(context.db);
  const userId = context.userId;
  const listing = () =>
    Response.json(
      {
        connections: store.list(userId).map(publicConnection),
        liveWritesEnabled: process.env.GITHUB_LIVE_WRITES === '1',
      },
      { headers },
    );

  try {
    if (request.method === 'GET') return listing();

    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id') ?? '';
      if (!store.get(id, userId)) return fail('That connection is not saved here.', 404);
      // The token dies with the connection: a deleted row must not leave a
      // live credential in the vault.
      await context.secrets.remove(userId, githubSecretName(id)).catch(() => {});
      store.remove(id, userId);
      return listing();
    }

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail('Expected a JSON request body.', 400);
      const token = String(body.token ?? '');
      if (!token || token.length > 512)
        return fail('Paste the fine-grained token you created on GitHub.', 400);
      const scopes = parseDeclaredScopes(body.scopes);
      // Verify before saving: a token that does not work, or a connection
      // whose declared scopes the owner never granted, must fail here — not
      // mid-flow with a half-written receipt trail.
      const login = await createGitHubClient({ token, fetchImpl: context.fetchImpl }).verifyToken();
      const connection = store.add(userId, String(body.label ?? ''), scopes);
      await context.secrets.save(userId, {
        name: githubSecretName(connection.id),
        value: token,
        destination: githubSecretDestination(connection.id),
      });
      return Response.json(
        {
          connections: store.list(userId).map(publicConnection),
          login: login.login,
        },
        { headers },
      );
    }

    return fail('Method not allowed.', 405);
  } catch (error) {
    if (error instanceof GitHubStoreError) return fail(error.message, error.status);
    const { GitHubScopeError } = await import('./scopes.ts');
    if (error instanceof GitHubScopeError) return fail(error.message, 400);
    if (error instanceof Error && error.name === 'GitHubApiError') return fail(error.message, 502);
    throw error;
  }
}
