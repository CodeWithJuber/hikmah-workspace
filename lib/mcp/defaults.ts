/** The default server catalogue.
 *
 * A fresh install previously had no MCP servers at all, so the model had no
 * grounded source for anything. These are seeded as rows the owner can enable;
 * only the Qur'an server is on by default, because it is the one that changes
 * what the model is allowed to assert rather than merely adding a capability.
 */
import type { McpServerConfig } from './config.ts';

export type DefaultServer = {
  name: string;
  label: string;
  description: string;
  config: McpServerConfig;
  /** Seeded enabled. Reserved for read-only servers that need no credential. */
  enabled: boolean;
  /** Trusted servers may auto-approve their read-only tools. */
  trusted: boolean;
  /** Secret names the owner must save before this server can connect. */
  requires?: string[];
  /** Shown before enabling, so the owner sees what will run or be contacted. */
  notice?: string;
};

export const DEFAULT_SERVERS: DefaultServer[] = [
  {
    name: 'quran',
    label: 'Quran.com',
    description:
      "The Quran Foundation's own MCP server: Arabic text, 50+ translations, 15+ tafsirs, morphology and search, with grounding rules that require citing the edition rather than answering from memory.",
    // The endpoint is the root URL. Both /mcp and /sse return 404 on this
    // server, which is worth stating because every other server in this list
    // uses a path.
    config: { type: 'http', url: 'https://mcp.quran.ai' },
    enabled: true,
    trusted: true,
    notice:
      'Queries are sent to mcp.quran.ai. The server is licensed QFGPL-1.0, which is non-commercial and network-copyleft: this app only calls the hosted endpoint and never vendors or self-hosts its code. The local research_quran ledger remains available as a fallback.',
  },
  {
    name: 'context7',
    label: 'Context7',
    description:
      'Up-to-date documentation for libraries and frameworks, so coding answers match the version you actually have rather than the model’s training data.',
    config: {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY:-}' },
    },
    enabled: false,
    trusted: true,
    notice: 'Works without a key at a lower rate limit. Save CONTEXT7_API_KEY to raise it.',
  },
  {
    name: 'github',
    label: 'GitHub',
    description:
      'Repositories, issues and pull requests through GitHub’s official server. Start with a read-only token and a narrow toolset.',
    config: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
    },
    enabled: false,
    trusted: false,
    requires: ['GITHUB_TOKEN'],
    notice:
      'Needs a personal access token. This server exposes dozens of tools, several of which write; keep approval on.',
  },
  {
    name: 'hadith',
    label: 'Hadith (self-hosted)',
    description:
      'A hadith server you run yourself. There is no official sunnah.com MCP server, and the community options are small single-maintainer projects, so this is deliberately left for you to point at something you trust.',
    config: { type: 'http', url: '${HIKMAH_HADITH_MCP_URL}' },
    enabled: false,
    trusted: false,
    requires: ['HIKMAH_HADITH_MCP_URL'],
    notice:
      'Disabled until you supply an endpoint. Hadith answers should depend only on a source you have chosen deliberately.',
  },
  {
    name: 'filesystem',
    label: 'Workspace files',
    description:
      'Read and write files under /workspace, the same volume the terminal and the assistant’s shell commands use. Reference implementation, run as a command in the workbench.',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    },
    enabled: false,
    trusted: false,
    notice:
      'Runs as a command in the workbench container, which downloads it on first use. Scoped to /workspace: it cannot read the app’s database or your saved secrets. It can write, so keep approval on.',
  },
  {
    name: 'search',
    label: 'Web search (SearXNG)',
    description:
      'Searches through the SearXNG service this deployment already runs, so queries do not leave the box for a third-party search API.',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-searxng'],
      env: { SEARXNG_URL: '${HIKMAH_SEARCH_ORIGIN:-http://search:8080}' },
    },
    enabled: false,
    trusted: true,
    notice:
      'Runs as a command in the workbench container. Read-only, and it queries the search service on the private network rather than the public internet directly.',
  },
];

export function defaultServer(name: string): DefaultServer | undefined {
  return DEFAULT_SERVERS.find((server) => server.name === name);
}
