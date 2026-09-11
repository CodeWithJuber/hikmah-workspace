/** The .mcp.json server-entry shape.
 *
 * Every host has converged on this: Claude Code, Claude Desktop, Cursor and
 * VS Code all read `{"mcpServers": {name: {...}}}`. Adopting it verbatim means a
 * user can paste the snippet from any server's README and have it work, and can
 * take their configuration elsewhere.
 */

export type McpTransport = 'http' | 'sse' | 'stdio';

export type McpServerConfig =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

/** `${NAME}` and `${NAME:-default}`, resolved from the encrypted secret store
 * at connect time so a token is never stored in the server row itself. */
const VARIABLE = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g;

export function expandVariables(
  value: string,
  lookup: (name: string) => string | undefined,
): string {
  return value.replace(VARIABLE, (_match, name: string, fallback?: string) => {
    const resolved = lookup(name);
    if (resolved !== undefined && resolved !== '') return resolved;
    if (fallback !== undefined) return fallback;
    throw new McpConfigError(`This server needs the secret ${name}. Save it in Settings first.`);
  });
}

/** Every variable a config references, so the UI can ask for them up front
 * rather than failing at connect time. */
export function referencedVariables(config: McpServerConfig): string[] {
  const found = new Set<string>();
  const scan = (value: string) => {
    for (const match of value.matchAll(VARIABLE)) found.add(match[1]);
  };
  if (config.type === 'stdio') {
    scan(config.command);
    for (const arg of config.args ?? []) scan(arg);
    for (const value of Object.values(config.env ?? {})) scan(value);
  } else {
    scan(config.url);
    for (const value of Object.values(config.headers ?? {})) scan(value);
  }
  return [...found];
}

function assertRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new McpConfigError(`${field} must be an object of string values.`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new McpConfigError(`${field}.${key} must be a string.`);
    out[key] = item;
  }
  return out;
}

/** Validate one server entry. */
export function parseServerConfig(raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== 'object') throw new McpConfigError('Expected a server object.');
  const value = raw as Record<string, unknown>;
  // `type` is optional in the wild: a `url` means remote, a `command` means stdio.
  const type = (value.type as string) ?? (value.command ? 'stdio' : 'http');

  if (type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim())
      throw new McpConfigError('A stdio server needs a command.');
    const args = value.args === undefined ? [] : value.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))
      throw new McpConfigError('args must be a list of strings.');
    return {
      type: 'stdio',
      command: value.command.trim(),
      args: args as string[],
      env: assertRecord(value.env, 'env'),
    };
  }

  if (type !== 'http' && type !== 'sse')
    throw new McpConfigError(`Unsupported transport "${type}". Use http, sse or stdio.`);
  if (typeof value.url !== 'string') throw new McpConfigError('A remote server needs a url.');

  let url: URL;
  try {
    url = new URL(expandVariables(value.url, () => 'placeholder'));
  } catch {
    throw new McpConfigError('Enter a valid server URL, including https://.');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  // The server calls this URL, so plain HTTP off-box would expose the token in
  // transit and the request would carry the container's network position.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new McpConfigError('Use an HTTPS server URL. A local server may use HTTP.');
  if (url.username || url.password)
    throw new McpConfigError('Put credentials in headers, not in the URL.');

  return { type, url: value.url, headers: assertRecord(value.headers, 'headers') };
}

/** Parse a pasted `{"mcpServers": {...}}` document. */
export function parseMcpJson(raw: unknown): { name: string; config: McpServerConfig }[] {
  if (!raw || typeof raw !== 'object') throw new McpConfigError('Expected a JSON object.');
  const servers = (raw as Record<string, unknown>).mcpServers ?? raw;
  if (!servers || typeof servers !== 'object')
    throw new McpConfigError('Expected an "mcpServers" object.');
  return Object.entries(servers as Record<string, unknown>).map(([name, config]) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name))
      throw new McpConfigError(`"${name}" is not a usable server name.`);
    return { name, config: parseServerConfig(config) };
  });
}
