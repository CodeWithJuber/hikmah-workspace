import type { McpConnection } from './workspace-config.ts';
import type { JsonSchema } from './transport.ts';
export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}
export interface McpSession {
  sessionId?: string;
  protocol: string;
}
const sessions = new Map<string, McpSession>();
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function validateMcpUrl(raw: string): string {
  if (raw === '/api/runtime') return raw;
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search)
    throw Error('Use a server URL without credentials, query parameters or fragments.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw Error('Use an HTTPS MCP URL. A local server may use HTTP.');
  return url.href;
}
async function readRpc(response: Response, id: number): Promise<unknown> {
  if (!response.ok)
    throw Error(
      response.status === 401 || response.status === 403
        ? 'The connector requires its own valid credential or OAuth setup.'
        : 'The connector returned HTTP ' + response.status + '.',
    );
  if (response.status === 202 || !response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2_000_000) throw Error('The connector response is too large.');
      text += decoder.decode(part.value, { stream: true });
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const events = text.split(/\r?\n\r?\n/);
        text = events.pop() ?? '';
        for (const event of events) {
          const lines = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!lines) continue;
          const data = JSON.parse(lines);
          if (data.id === id) return data;
        }
      }
    }
    text += decoder.decode();
    if (text.trim()) {
      const data = JSON.parse(text);
      if (data.id === id) return data;
    }
    throw Error('The connector did not return a completed JSON-RPC response.');
  } finally {
    void reader.cancel().catch(() => {});
  }
}
async function rpc(
  connection: McpConnection,
  key: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  notify = false,
  tool?: McpTool,
): Promise<unknown> {
  const endpoint = validateMcpUrl(connection.url);
  const saved = !!connection.secretRef && endpoint !== '/api/runtime';
  const target = saved ? '/api/mcp' : endpoint;
  const internal = target === '/api/runtime' || saved;
  const state = sessions.get(connection.id);
  const id = Math.floor(Math.random() * 1_000_000_000);
  const protocol = state?.protocol ?? connection.protocol;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocol,
  };
  if (saved) {
    headers['X-Hikmah-Secret-Ref'] = connection.secretRef!;
    headers['X-Hikmah-Mcp-Url'] = endpoint;
  } else if (key && !internal) {
    if (key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key))
      throw Error('Invalid connector credential.');
    headers.Authorization = 'Bearer ' + key;
  }
  if (state?.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
  const next = { ...params };
  if (protocol === '2026-07-28') {
    headers['Mcp-Method'] = method;
    if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
    next._meta = {
      'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientInfo': { name: 'Hikmah', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    if (tool && record(tool.inputSchema.properties) && record(params.arguments))
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        if (record(schema) && schema['x-mcp-header'] === true) {
          const value = params.arguments[name];
          if (
            typeof value !== 'string' ||
            /[^\x20-\x7e]/.test(value) ||
            !/^[a-zA-Z0-9_-]+$/.test(name)
          )
            throw Error('This tool requires an unsupported MCP header parameter.');
          headers['Mcp-Param-' + name] = value;
        }
      }
  }
  const timeout = AbortSignal.timeout(120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id }), method, params: next }),
      signal: combined,
      mode: internal ? 'same-origin' : 'cors',
      credentials: internal ? 'same-origin' : 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    if (combined.aborted)
      throw new DOMException('Connector request stopped or timed out', 'AbortError');
    throw Error(
      saved
        ? 'Could not reach the saved connector. Check Settings → Secrets and its endpoint.'
        : 'Could not reach this MCP server. It must allow this app’s origin and protocol headers through CORS.',
    );
  }
  const sessionId = response.headers.get('Mcp-Session-Id');
  if (sessionId) {
    if (sessionId.length > 256 || /[^\x21-\x7e]/.test(sessionId))
      throw Error('Invalid connector session.');
    sessions.set(connection.id, { protocol, sessionId });
  }
  if (notify) {
    if (!response.ok) throw Error('The connector rejected initialization.');
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const data = await readRpc(response, id);
  if (!record(data)) throw Error('Invalid MCP response.');
  if (data.error)
    throw Error(
      'The MCP server rejected ' + method + '. Check its protocol version and tool parameters.',
    );
  if (!record(data.result)) throw Error('The connector did not return a supported result.');
  if (method === 'initialize') {
    const result = data.result;
    if (
      typeof result.protocolVersion !== 'string' ||
      !['2025-11-25', '2026-07-28'].includes(result.protocolVersion)
    )
      throw Error('This server negotiated an unsupported MCP revision.');
    sessions.set(connection.id, {
      protocol: result.protocolVersion,
      sessionId: sessions.get(connection.id)?.sessionId,
    });
  }
  return data.result;
}
export async function connectMcp(
  connection: McpConnection,
  key: string,
  signal?: AbortSignal,
): Promise<McpTool[]> {
  sessions.delete(connection.id);
  if (connection.protocol === '2025-11-25') {
    await rpc(
      connection,
      key,
      'initialize',
      {
        protocolVersion: connection.protocol,
        capabilities: {},
        clientInfo: { name: 'Hikmah', version: '1.0.0' },
      },
      signal,
    );
    await rpc(connection, key, 'notifications/initialized', {}, signal, true);
  }
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const result = await rpc(connection, key, 'tools/list', cursor ? { cursor } : {}, signal);
    if (!record(result) || !Array.isArray(result.tools))
      throw Error('This server did not expose a tool catalog.');
    for (const raw of result.tools) {
      if (
        !record(raw) ||
        typeof raw.name !== 'string' ||
        raw.name.length > 128 ||
        !record(raw.inputSchema)
      )
        continue;
      tools.push({
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
        inputSchema: raw.inputSchema as JsonSchema,
        readOnly: record(raw.annotations) && raw.annotations.readOnlyHint === true,
      });
    }
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (cursor) {
      if (cursors.has(cursor)) throw Error('The connector repeated a pagination cursor.');
      cursors.add(cursor);
    }
    if (tools.length > 2000)
      throw Error('This connector catalog is too large. Select a narrower server scope.');
  } while (cursor);
  return tools;
}
export async function callMcp(
  connection: McpConnection,
  key: string,
  tool: McpTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await rpc(
    connection,
    key,
    'tools/call',
    { name: tool.name, arguments: args },
    signal,
    false,
    tool,
  );
  if (record(result) && result.resultType && result.resultType !== 'complete')
    throw Error(
      'This tool needs interactive MCP capabilities that this workspace has not enabled.',
    );
  return result;
}
