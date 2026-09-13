export const validSecretName = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name);
export const parseSecretRef = (name: unknown) => (validSecretName(name) ? name : '');
export interface SecretMetadata {
  name: string;
  destination: string;
  updatedAt: string;
}
export type SecretResolver = (name: string, destination: string) => Promise<string>;
export const SECRET_SERVICES = [
  { value: 'provider:openrouter', label: 'OpenRouter · chat and media' },
  { value: 'provider:experiential', label: 'Experiential · chat' },
  { value: 'search:brave', label: 'Brave web search' },
  { value: 'runtime', label: 'Server runtime connection' },
  { value: 'runtime:env', label: 'Code runtime environment' },
  // What a server config's ${NAME} resolves to. Listed before the per-endpoint
  // form below because it is the one the current MCP screen asks for; the two
  // read alike and only one of them was ever offered here.
  { value: 'mcp-env', label: 'MCP server environment' },
  { value: 'mcp', label: 'MCP tool server · one endpoint' },
];
export function mcpSecretDestination(url: string) {
  try {
    return 'mcp:' + new URL(url).href;
  } catch {
    return '';
  }
}
