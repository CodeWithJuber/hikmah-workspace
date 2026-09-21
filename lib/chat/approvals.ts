/** Approvals that are remembered.
 *
 * Every `bash`, `sandbox_run` and `ssh_exec` call asked again, and the card
 * offered only Allow and Don't allow, so a person starting the same preview
 * server for the tenth time approved it for the tenth time. A grant now has a
 * scope, in the order a careful person would widen it:
 *
 * - **this command** — the exact command, and the same command with more
 *   arguments after it; never one with a separator in it;
 * - **this tool in this conversation** — the gate stays elsewhere;
 * - **this tool, always** — the tool runs without asking anywhere.
 *
 * Grants live in the chat settings and are read when a run is *driven*, not
 * when it is created, so a grant made while a run is paused on the card
 * applies the moment that run resumes. Pure: shared by the card, the settings
 * screen and the policies.
 */

export type ApprovalSettings = {
  /** Tools that run without asking anywhere: bash, sandbox_run, ssh_exec, or
   * an MCP tool's full id. */
  auto: string[];
  /** Commands the shell may run without asking, matched as the whole command
   * or as a prefix at a word boundary. */
  commands: string[];
  /** Tools that run without asking in one conversation, by its id. */
  conversations: Record<string, string[]>;
};

export const DEFAULT_APPROVALS: ApprovalSettings = { auto: [], commands: [], conversations: {} };

/** Bounds, so a settings row cannot grow without limit from a card. */
const MAX_AUTO_TOOLS = 100;
const MAX_GRANTED_COMMANDS = 100;
const MAX_GRANT_CONVERSATIONS = 50;
const MAX_COMMAND_LENGTH = 300;
const MAX_TOOL_NAME = 100;

/** Characters that turn one command into several, or redirect its output.
 * The same set the shell tool refuses to auto-approve. */
const SEPARATORS = /[;&|`$><\n\r\\]/;

const cleanCommand = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const command = raw.trim().replace(/\s+/g, ' ');
  if (!command || command.length > MAX_COMMAND_LENGTH || SEPARATORS.test(command)) return null;
  return command;
};

const cleanTool = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_TOOL_NAME ? raw : null;

const unique = <T>(values: (T | null)[]): T[] => [
  ...new Set(values.filter((value): value is T => value !== null)),
];

/** Whatever was stored, as grants a policy can read. */
export function parseApprovals(raw: unknown): ApprovalSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const auto = Array.isArray(value.auto)
    ? unique(value.auto.map(cleanTool)).slice(0, MAX_AUTO_TOOLS)
    : [];
  const commands = Array.isArray(value.commands)
    ? unique(value.commands.map(cleanCommand)).slice(0, MAX_GRANTED_COMMANDS)
    : [];
  const conversations: Record<string, string[]> = {};
  if (value.conversations && typeof value.conversations === 'object') {
    for (const [id, tools] of Object.entries(value.conversations as Record<string, unknown>)) {
      if (Object.keys(conversations).length >= MAX_GRANT_CONVERSATIONS) break;
      if (!id || id.length > 200 || !Array.isArray(tools)) continue;
      const kept = unique(tools.map(cleanTool));
      if (kept.length) conversations[id] = kept;
    }
  }
  return { auto, commands, conversations };
}

export type Grant =
  | { scope: 'command'; tool: 'bash'; command: string }
  | { scope: 'conversation'; tool: string; conversationId: string }
  | { scope: 'always'; tool: string };

/** The settings with one more grant in it. A command that cannot be granted
 * (a separator, too long) leaves the settings as they were. */
export function withGrant(current: ApprovalSettings, grant: Grant): ApprovalSettings {
  if (grant.scope === 'command') {
    const command = cleanCommand(grant.command);
    if (!command) return current;
    return {
      ...current,
      commands: unique([...current.commands, command]).slice(-MAX_GRANTED_COMMANDS),
    };
  }
  const tool = cleanTool(grant.tool);
  if (!tool) return current;
  if (grant.scope === 'always')
    return { ...current, auto: unique([...current.auto, tool]).slice(-MAX_AUTO_TOOLS) };
  const existing = current.conversations[grant.conversationId] ?? [];
  const conversations = {
    ...current.conversations,
    [grant.conversationId]: unique([...existing, tool]),
  };
  // The oldest conversations' grants go first when there are too many: a
  // grant is about work in progress, and fifty conversations ago is not.
  const keys = Object.keys(conversations);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_GRANT_CONVERSATIONS)))
    delete conversations[key];
  return { ...current, conversations };
}

export type Revocation =
  | { kind: 'auto'; value: string }
  | { kind: 'command'; value: string }
  | { kind: 'conversation'; conversationId: string };

/** The settings with one grant taken back. */
export function withoutGrant(current: ApprovalSettings, revoke: Revocation): ApprovalSettings {
  if (revoke.kind === 'auto')
    return { ...current, auto: current.auto.filter((tool) => tool !== revoke.value) };
  if (revoke.kind === 'command')
    return { ...current, commands: current.commands.filter((c) => c !== revoke.value) };
  const conversations = { ...current.conversations };
  delete conversations[revoke.conversationId];
  return { ...current, conversations };
}

/** What one run may do without asking: the tools granted everywhere and in
 * its conversation, and the commands granted by name. */
export type ResolvedGrants = { tools: Set<string>; commands: string[] };

export function grantsFor(settings: ApprovalSettings, conversationId: string): ResolvedGrants {
  return {
    tools: new Set([...settings.auto, ...(settings.conversations[conversationId] ?? [])]),
    commands: settings.commands,
  };
}

/** Is this command one of the granted ones? The whole command, or a granted
 * prefix followed by a space and more arguments; a separator anywhere means no,
 * because `python3 -m http.server; rm -rf /` starts with a granted command. */
export function commandGranted(command: string, prefixes: readonly string[]): boolean {
  const clean = cleanCommand(command);
  if (!clean) return false;
  return prefixes.some((prefix) => clean === prefix || clean.startsWith(prefix + ' '));
}

/** The tools whose calls the run can pause on, for the settings screen. */
export const GATED_TOOLS = ['bash', 'sandbox_run', 'ssh_exec', 'typeform_read_responses'] as const;
