import { redactRpc } from './redact-secrets.ts';
import { publicOrigin } from './origin.ts';
import { publicHttpsRequest } from './public-https.ts';
import { type SecretResolver, mcpSecretDestination } from '../playground/secret-reference.ts';
const privateHeaders = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
};
export async function relayMcpRequest(
  request: Request,
  authenticated: boolean,
  resolveSecret: SecretResolver,
  send = publicHttpsRequest,
) {
  const fail = (error: string, status = 400) =>
    Response.json({ error }, { status, headers: privateHeaders });
  if (!authenticated) return fail('Sign in to use saved connector credentials.', 401);
  if (request.method !== 'POST' || request.headers.get('origin') !== publicOrigin(request))
    return fail('Use this connector from your signed-in workspace.', 403);
  try {
    const endpoint = request.headers.get('X-Hikmah-Mcp-Url') ?? '';
    const destination = mcpSecretDestination(endpoint);
    if (!destination) return fail('Invalid connector endpoint.');
    const key = await resolveSecret(request.headers.get('X-Hikmah-Secret-Ref') ?? '', destination);
    const protocol = request.headers.get('MCP-Protocol-Version');
    if (!['2025-11-25', '2026-07-28'].includes(protocol ?? ''))
      return fail('Unsupported MCP revision.');
    if (!request.body) return fail('Expected a connector request.');
    const reader = request.body.getReader(),
      decoder = new TextDecoder();
    let body = '',
      size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1_000_000) return fail('Connector request is too large.', 413);
        body += decoder.decode(part.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    body += decoder.decode();
    const rpc = JSON.parse(body);
    if (
      rpc.jsonrpc !== '2.0' ||
      !['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(rpc.method)
    )
      return fail('Unsupported MCP operation.');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + key,
      Origin: publicOrigin(request),
      'MCP-Protocol-Version': protocol!,
    };
    for (const [name, value] of request.headers)
      if (
        ['mcp-session-id', 'mcp-method', 'mcp-name'].includes(name) ||
        /^mcp-param-[a-z0-9_-]+$/.test(name)
      ) {
        if (value.length > 2048 || /[^\x20-\x7e]/.test(value)) return fail('Invalid MCP header.');
        headers[name] = value;
      }
    const result = await send(
      new URL(endpoint),
      headers,
      body,
      AbortSignal.any([request.signal, AbortSignal.timeout(120000)]),
    );
    if (!result.ok) {
      await result.body?.cancel();
      return fail(
        'Connector returned HTTP ' + result.status + '. Check its saved credential and endpoint.',
        502,
      );
    }
    const raw = await result.text();
    const output = raw
      ? redactRpc(raw, [key], !!result.headers.get('content-type')?.includes('text/event-stream'))
      : '';
    const responseHeaders: Record<string, string> = {
      ...privateHeaders,
      'Content-Type': result.headers.get('content-type') ?? 'application/json',
    };
    const session = result.headers.get('mcp-session-id');
    if (session && session.length <= 256 && !/[^\x21-\x7e]/.test(session) && !session.includes(key))
      responseHeaders['Mcp-Session-Id'] = session;
    return new Response(result.status === 204 ? null : output, {
      status: result.status,
      headers: responseHeaders,
    });
  } catch {
    return fail(
      'Could not use the saved connector credential. Check its service, endpoint, and server availability in Settings → Secrets.',
      502,
    );
  }
}
