import {publicOrigin} from './origin';

const headers = {'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff'};
export async function runtimeRelay(request: Request, owner: boolean) {
  const fail = (error: string, status: number) => Response.json({error}, {status, headers});
  if (!owner) return fail('Owner access is required for the configured server runtime.', 403);
  const origin = publicOrigin(request);
  if (request.method !== 'POST' || request.headers.get('origin') !== origin) return fail('Use the runtime from your signed-in workspace.', 403);
  const endpoint = process.env.HIKMAH_RUNTIME_URL, token = process.env.HIKMAH_RUNTIME_TOKEN;
  if (!endpoint || !token) return fail('Server runtime is not configured. JavaScript remains available; configure HIKMAH_RUNTIME_URL and HIKMAH_RUNTIME_TOKEN for Python, Node and owner-defined SSH actions.', 503);
  try {
    const target = new URL(endpoint);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.hash || target.search) return fail('Invalid runtime server configuration.', 503);
    if (!request.body) return fail('A runtime request is required.', 400);
    const reader = request.body.getReader(), decoder = new TextDecoder(); let raw = '', bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
      if (bytes > 60000) return fail('Runtime request is too large.', 413);
      raw += decoder.decode(part.value, {stream: true});
    }} finally { await reader.cancel().catch(() => {}); }
    const body = JSON.parse(raw + decoder.decode());
    if (body.jsonrpc !== '2.0' || !['initialize','notifications/initialized','tools/list','tools/call'].includes(body.method)) return fail('Unsupported runtime operation.', 400);
    // The bundled adapter only exposes isolated execution and fixed SSH aliases.
    if (body.method === 'tools/call' && !['run_code','ssh_action'].includes(body.params?.name)) return fail('Unsupported runtime tool.', 400);
    const response = await fetch(target, {method: 'POST', redirect: 'error', credentials: 'omit',
      headers: {'Content-Type': 'application/json', Accept: 'application/json', Origin: origin, Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-11-25'},
      body: raw, signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)])});
    if (!response.ok) { await response.body?.cancel(); return fail('Configured runtime returned HTTP ' + response.status + '.', 502); }
    if (response.status === 204 || response.status === 202) return new Response(null, {status: response.status, headers});
    if (!response.body) return fail('Runtime returned no result.', 502);
    const output = response.body.getReader(); let result = '', size = 0; const decode = new TextDecoder();
    try { while (true) { const part = await output.read(); if (part.done) break; size += part.value.length;
      if (size > 256000) return fail('Runtime result is too large.', 502);
      result += decode.decode(part.value, {stream: true});
    }} finally { await output.cancel().catch(() => {}); }
    result = (result + decode.decode()).replaceAll(token, '[credential redacted]');
    JSON.parse(result);
    return new Response(result, {headers: {...headers, 'Content-Type': 'application/json'}});
  } catch { return fail('The runtime could not complete the request. Check its connection and execution limits.', 502); }
}
