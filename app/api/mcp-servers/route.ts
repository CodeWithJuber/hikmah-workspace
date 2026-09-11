import { getChatGPTUser } from '../../chatgpt-auth';
import { publicOrigin } from '@/lib/server/origin';
import { getStorage } from '@/server/storage.mjs';
import { McpStoreError, createMcpStore, publicServer } from '@/lib/mcp/store';
import { DEFAULT_SERVERS } from '@/lib/mcp/defaults';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

/** The catalogue entry behind a seeded row, for the description and the notice. */
const catalogue = (name: string) => DEFAULT_SERVERS.find((server) => server.name === name);

async function handle(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return fail('Sign in to your private workspace.', 401);
  // Writes must carry our own Origin. A GET does not: browsers omit it on
  // same-origin GETs, so requiring it would break the list for everyone.
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace.', 403);

  const store = createMcpStore(getStorage().raw);
  const userId = user.userId;
  const listing = () =>
    Response.json(
      {
        servers: store.list(userId).map((row) => {
          const entry = catalogue(row.name);
          return {
            ...publicServer(row),
            label: entry?.label ?? row.name,
            description: entry?.description,
            notice: entry?.notice,
            requires: entry?.requires ?? [],
          };
        }),
      },
      { headers },
    );

  try {
    if (request.method === 'GET') return listing();

    if (request.method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id') ?? '';
      if (!store.get(id, userId)) return fail('That server is not saved here.', 404);
      store.remove(id, userId);
      return listing();
    }

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail('Expected a JSON request body.', 400);
      store.add(userId, String(body.name ?? ''), body.config);
      return listing();
    }

    if (request.method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail('Expected a JSON request body.', 400);
      store.update(String(body.id ?? ''), userId, {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        trusted: typeof body.trusted === 'boolean' ? body.trusted : undefined,
        approval: body.approval as 'auto' | 'ask' | 'deny' | undefined,
        allowTools: Array.isArray(body.allowTools) ? (body.allowTools as string[]) : undefined,
        denyTools: Array.isArray(body.denyTools) ? (body.denyTools as string[]) : undefined,
      });
      return listing();
    }

    return fail('Unsupported method.', 405);
  } catch (error) {
    if (error instanceof McpStoreError) return fail(error.message, error.status);
    return fail(error instanceof Error ? error.message : 'Could not update MCP servers.', 400);
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
