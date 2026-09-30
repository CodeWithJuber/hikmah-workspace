import { publicOrigin } from './origin.ts';
import { createSecretStore, SecretError } from '../../server/workspace-secrets.mjs';
import { getStorage } from '@/server/storage.mjs';
import { teamStore } from '@/lib/team/server';
import { assertCanRead, assertCanWrite, ownerOf, TeamAccessDenied } from '@/lib/team/enforcement';
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
export async function secretsRequest(
  request: Request,
  userId: string | undefined,
  store = createSecretStore(),
) {
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
  if (!userId) return fail('Sign in to manage your workspace secrets.', 401);
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request))
    return fail('Use your signed-in workspace to manage secrets.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return fail('Use your signed-in workspace.', 403);
  try {
    if (request.method === 'GET') {
      const name = new URL(request.url).searchParams.get('name');
      if (name) {
        // Single-secret read through the team layer: the caller's own, or a
        // teammate's with a read grant. Anything else is 404 — the value is
        // never the thing returned, only name/destination/updatedAt.
        try {
          const ownerId = assertCanRead(getStorage().raw, teamStore(), userId, 'secret', name);
          const found = (await store.list(ownerId)).find((s) => s.name === name);
          if (!found) return fail('No such secret.', 404);
          return Response.json({ secret: found }, { headers });
        } catch (error) {
          if (error instanceof TeamAccessDenied) return fail('No such secret.', 404);
          throw error;
        }
      }
      return Response.json({ secrets: await store.list(userId) }, { headers });
    }
    if (request.method === 'DELETE') {
      const name = new URL(request.url).searchParams.get('name');
      const raw = getStorage().raw;
      const team = teamStore();
      const existingOwner = name ? ownerOf(raw, team, 'secret', userId, name) : null;
      if (existingOwner && existingOwner !== userId) {
        try {
          assertCanWrite(raw, team, userId, 'secret', name as string);
        } catch (error) {
          if (error instanceof TeamAccessDenied) return fail('No such secret.', 404);
          throw error;
        }
      }
      await store.remove(existingOwner ?? userId, name);
    } else if (request.method === 'PUT') {
      if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body)
        return fail('Expected a secret variable.', 400);
      const reader = request.body.getReader();
      let size = 0,
        body = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 60000) return fail('Secret request is too large.', 413);
          body += decoder.decode(part.value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const input = JSON.parse(body + decoder.decode()) as { name?: unknown };
      const secretName = typeof input?.name === 'string' ? input.name : '';
      // Overwriting a teammate's secret needs a write grant; a new name is
      // always the caller's own to create.
      const raw = getStorage().raw;
      const team = teamStore();
      const existingOwner = secretName ? ownerOf(raw, team, 'secret', userId, secretName) : null;
      let saveOwner = userId;
      if (existingOwner && existingOwner !== userId) {
        try {
          saveOwner = assertCanWrite(raw, team, userId, 'secret', secretName);
        } catch (error) {
          if (error instanceof TeamAccessDenied) return fail('No such secret.', 404);
          throw error;
        }
      }
      await store.save(saveOwner, input);
    } else return fail('Unsupported method.', 405);
    return Response.json({ secrets: await store.list(userId) }, { headers });
  } catch (e) {
    return fail(
      e instanceof SecretError ? e.message : 'Could not update workspace secrets.',
      e instanceof SecretError ? e.status : 400,
    );
  }
}
