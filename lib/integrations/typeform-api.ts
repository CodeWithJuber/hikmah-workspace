import { publicOrigin } from '../server/origin.ts';
import { TypeformError, typeformPage } from './typeform-client.ts';
import type { TypeformService } from './typeform-service.ts';

const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body)
    throw new TypeformError('Expected a JSON request.');
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 12_000) throw new TypeformError('The integration request is too large.', 413);
      text += decoder.decode(next.value, { stream: true });
    }
    const parsed = JSON.parse(text + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch (error) {
    if (error instanceof TypeformError) throw error;
    throw new TypeformError('Expected a JSON request.');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function typeformRequest(
  request: Request,
  userId: string | undefined,
  service: TypeformService,
  resource: 'connection' | 'forms' | 'responses' = 'connection',
) {
  try {
    if (!userId) throw new TypeformError('Sign in to use Typeform.', 401);
    if (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method !== 'GET' && request.headers.get('origin') !== publicOrigin(request)))
      throw new TypeformError('Use Typeform from your signed-in workspace.', 403);
    const params = new URL(request.url).searchParams;
    let result: unknown;
    if (resource === 'forms' && request.method === 'GET')
      result = await service.forms(userId, typeformPage(params.get('page') ?? 1), request.signal);
    else if (resource === 'responses' && request.method === 'GET')
      result = await service.responses(userId, params.get('formId') ?? '', params.get('before') ?? undefined, request.signal);
    else if (resource !== 'connection') throw new TypeformError('Unsupported method.', 405);
    else {
      if (request.method === 'PUT') await service.save(userId, (await body(request)).token, request.signal);
      else if (request.method === 'DELETE') await service.disconnect(userId);
      else if (request.method === 'POST') {
        const input = await body(request);
        if (input.action === 'test') await service.test(userId, request.signal);
        else if (input.action === 'grant') await service.grant(userId, input.formId, input.email, request.signal);
        else if (input.action === 'revoke') service.revoke(userId, input.formId, input.userId);
        else throw new TypeformError('Choose a supported Typeform action.');
      } else if (request.method !== 'GET') throw new TypeformError('Unsupported method.', 405);
      result = await service.status(userId);
    }
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({
      error: error instanceof TypeformError ? error.message : 'Typeform is unavailable. Ask the owner to check its connection.',
    }, { status: error instanceof TypeformError ? error.status : 503, headers });
  }
}
