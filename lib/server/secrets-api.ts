import {publicOrigin} from './origin.ts';
import {createSecretStore, SecretError} from '../../server/workspace-secrets.mjs';
const headers = {'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff'};
export async function secretsRequest(request: Request, userId: string | undefined, store = createSecretStore()) {
  const fail = (error: string, status: number) => Response.json({error}, {status, headers});
  if (!userId) return fail('Sign in to manage your workspace secrets.', 401);
  if (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request)) return fail('Use your signed-in workspace to manage secrets.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') return fail('Use your signed-in workspace.', 403);
  try {
    if (request.method === 'GET') return Response.json({secrets: await store.list(userId)}, {headers});
    if (request.method === 'DELETE') {
      await store.remove(userId, new URL(request.url).searchParams.get('name'));
    } else if (request.method === 'PUT') {
      if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) return fail('Expected a secret variable.', 400);
      const reader = request.body.getReader(); let size = 0, body = ''; const decoder = new TextDecoder();
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 60000) return fail('Secret request is too large.', 413); body += decoder.decode(part.value, {stream: true}); } }
      finally { await reader.cancel().catch(() => {}); }
      await store.save(userId, JSON.parse(body + decoder.decode()));
    } else return fail('Unsupported method.', 405);
    return Response.json({secrets: await store.list(userId)}, {headers});
  } catch (e) { return fail(e instanceof SecretError ? e.message : 'Could not update workspace secrets.', e instanceof SecretError ? e.status : 400); }
}
