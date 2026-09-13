/** Assembles the agent for one run.
 *
 * Shared deliberately: the request-scoped chat route uses it now, and the
 * durable worker will use the same function later, so a run behaves identically
 * whether it is driven by an open tab or resumed by the server.
 */
import { ToolLoopAgent, isStepCount, type LanguageModel } from 'ai';
import { historyBudget, reduceMessages } from './context.ts';
import { DEFAULT_MAX_STEPS } from './chat-request.ts';
import { createLanguageModel, type ModelRequest } from './models.ts';
import { askTools } from './tools/ask.ts';
import { deterministicTools, type PlanStep } from './tools/deterministic.ts';
import { javascriptTools } from './tools/javascript.ts';
import { researchTools } from './tools/research.ts';
import { sshApprovalPolicy, sshTools, type SshToolContext } from './tools/ssh.ts';
import { mcpToolApproval, type McpRunTools } from '../mcp/run-context.ts';
import { withServerGuidance } from './server-guidance.ts';
import { shellApprovalPolicy, shellTools, type ShellToolContext } from './tools/shell.ts';
import { mediaTools, type MediaToolContext } from './tools/media.ts';
import { fileTools, type FileToolContext } from './tools/files.ts';
import type { Model } from '../engines/meaning-engine.ts';

export type RunAgentOptions = {
  provider: ModelRequest;
  instructions: string;
  maxSteps?: number;
  contextCharacters?: number;
  /** The model's window in tokens, when the provider publishes one. */
  contextWindow?: number;
  /** Local symbolic model backing interpret_meaning. */
  meaningModel: Model;
  savedSearchKey?: () => Promise<string>;
  onPlan?: (steps: PlanStep[]) => void;
  signal: AbortSignal;
  /** Tool names the owner has switched off for this run. */
  disabledTools?: readonly string[];
  /**
   * An agent's allowlist over the built-in tools. Empty or absent means every
   * tool this run would otherwise offer.
   *
   * MCP tools are never filtered by it: they are enabled per server by the
   * owner and gated per tool by the MCP policy, which is a separate decision
   * from which built-ins an agent uses. An agent narrowing the built-ins should
   * not also silently switch off a server the owner turned on.
   */
  enabledTools?: readonly string[];
  /**
   * Enables ssh_exec and list_ssh_hosts.
   *
   * Omitted, they are not offered at all. That is deliberate: a caller with no
   * way to pause and ask the owner would otherwise be choosing between offering
   * the tool with silent approval and not offering it, and the first is not a
   * choice worth making available.
   */
  ssh?: Omit<SshToolContext, 'signal'>;
  /**
   * Enables bash and sandbox_run in the workbench container.
   *
   * Like ssh, omitted means not offered: a deployment with no workbench should
   * not advertise a shell that fails on every call.
   */
  shell?: Omit<ShellToolContext, 'signal'>;
  /**
   * Enables generate_image and generate_speech.
   *
   * Omitted when the deployment has no media key: offering a tool that fails on
   * every call wastes a step and tells the person nothing they can act on.
   */
  media?: Omit<MediaToolContext, 'signal'>;
  /**
   * Enables list_file/read_file/write_file/delete_file over the owner's
   * workspace.
   *
   * Not gated behind approval: these write inside the owner's own workspace,
   * which nothing else reads and no program runs. bash and ssh_exec are gated
   * because they act on a machine.
   */
  files?: FileToolContext;
  /**
   * MCP tools for this run, already connected and gated.
   *
   * Connecting is the caller's job because it is async and has to happen once
   * per run, while this function is synchronous and may be called per step.
   */
  mcp?: Pick<McpRunTools, 'tools' | 'approval' | 'guidance'>;
  model?: LanguageModel;
};

export function buildRunAgent(options: RunAgentOptions) {
  const disabled = new Set(options.disabledTools ?? []);
  const all = {
    ...researchTools({ savedSearchKey: options.savedSearchKey, signal: options.signal }),
    ...deterministicTools({ model: options.meaningModel, onPlan: options.onPlan }),
    // Always offered: it needs nothing from the deployment. The container-backed
    // sandbox_run below is the one that comes and goes with the workbench.
    ...javascriptTools(),
    // Likewise, and for a stronger reason: a run with no way to ask does not
    // wait, it guesses.
    ...askTools(),
    ...(options.ssh ? sshTools({ ...options.ssh, signal: options.signal }) : {}),
    ...(options.shell?.available ? shellTools({ ...options.shell, signal: options.signal }) : {}),
    ...(options.media?.key ? mediaTools({ ...options.media, signal: options.signal }) : {}),
    ...(options.files ? fileTools(options.files) : {}),
    // Last, so a built-in tool can never be shadowed by a server that named one
    // of its tools after it. The mcp__server__tool prefix makes a collision
    // unlikely, but "unlikely" is not the property worth relying on here.
    ...(options.mcp?.tools ?? {}),
  };
  const allowed = new Set(options.enabledTools ?? []);
  const tools = Object.fromEntries(
    Object.entries(all).filter(
      ([name]) =>
        !disabled.has(name) &&
        (allowed.size === 0 || allowed.has(name) || name.startsWith('mcp__')),
    ),
  );
  // What actually fits, from this model's own window, minus the system prompt
  // and the tool schemas this run is about to send. Computed after `tools` so
  // the count is the real one — an owner with the Qur'an server enabled offers
  // fifteen more than one without it.
  const limit = historyBudget({
    contextWindow: options.contextWindow,
    instructions: options.instructions.length,
    tools: Object.keys(tools).length,
    ceiling: options.contextCharacters,
  });

  // Only tools that reach outside this process are gated. Everything else in the
  // set reads or computes; ssh_exec runs a command on a machine the owner cares
  // about, and an MCP tool belongs to a server that is not on our side.
  const sshApproval =
    options.ssh && !disabled.has('ssh_exec')
      ? { ssh_exec: sshApprovalPolicy({ listHosts: options.ssh.listHosts }) }
      : undefined;
  const mcpApproval = options.mcp?.approval.size
    ? mcpToolApproval(options.mcp.approval)
    : undefined;
  // sandbox_run is never auto-approved: a program is not something anyone can
  // skim the way they can skim `ls -la`.
  const shellApproval = options.shell?.available
    ? {
        ...(disabled.has('bash') ? {} : { bash: shellApprovalPolicy() }),
        ...(disabled.has('sandbox_run') ? {} : { sandbox_run: 'user-approval' as const }),
      }
    : undefined;

  return new ToolLoopAgent({
    model: options.model ?? createLanguageModel(options.provider),
    instructions: withServerGuidance(options.instructions, options.mcp?.guidance),
    tools,
    stopWhen: isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS),
    prepareStep: ({ messages }) => ({ messages: reduceMessages(messages, limit) }),
    // Everything that reaches a machine is gated: ssh_exec a remote one, bash
    // and sandbox_run the workbench, an MCP tool somebody else's server. The
    // rest of the set reads or computes.
    //
    // shellApproval was computed here and then left out of this spread, so
    // `bash` ran whatever it liked and `sandbox_run` — documented as always
    // asking — never asked. Nothing failed: the tools worked, they just worked
    // without the card.
    ...(sshApproval || mcpApproval || shellApproval
      ? { toolApproval: { ...mcpApproval, ...shellApproval, ...sshApproval } }
      : {}),
  });
}
