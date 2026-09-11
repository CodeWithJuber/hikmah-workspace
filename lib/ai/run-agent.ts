/** Assembles the agent for one run.
 *
 * Shared deliberately: the request-scoped chat route uses it now, and the
 * durable worker will use the same function later, so a run behaves identically
 * whether it is driven by an open tab or resumed by the server.
 */
import { ToolLoopAgent, isStepCount, type LanguageModel } from 'ai';
import { DEFAULT_CONTEXT_CHARACTERS, reduceMessages } from './context.ts';
import { createLanguageModel, type ModelRequest } from './models.ts';
import { deterministicTools, type PlanStep } from './tools/deterministic.ts';
import { researchTools } from './tools/research.ts';
import { sshApprovalPolicy, sshTools, type SshToolContext } from './tools/ssh.ts';
import { mcpToolApproval, type McpRunTools } from '../mcp/run-context.ts';
import { shellApprovalPolicy, shellTools, type ShellToolContext } from './tools/shell.ts';
import { mediaTools, type MediaToolContext } from './tools/media.ts';
import { fileTools, type FileToolContext } from './tools/files.ts';
import type { Model } from '../engines/meaning-engine.ts';

/** Ceiling on tool-calling rounds, so a loop cannot run forever unattended. */
export const DEFAULT_MAX_STEPS = 12;

export type RunAgentOptions = {
  provider: ModelRequest;
  instructions: string;
  maxSteps?: number;
  contextCharacters?: number;
  /** Local symbolic model backing interpret_meaning. */
  meaningModel: Model;
  savedSearchKey?: () => Promise<string>;
  onPlan?: (steps: PlanStep[]) => void;
  signal: AbortSignal;
  /** Tool names the owner has switched off for this run. */
  disabledTools?: readonly string[];
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
  mcp?: Pick<McpRunTools, 'tools' | 'approval'>;
  model?: LanguageModel;
};

export function buildRunAgent(options: RunAgentOptions) {
  const disabled = new Set(options.disabledTools ?? []);
  const all = {
    ...researchTools({ savedSearchKey: options.savedSearchKey, signal: options.signal }),
    ...deterministicTools({ model: options.meaningModel, onPlan: options.onPlan }),
    ...(options.ssh ? sshTools({ ...options.ssh, signal: options.signal }) : {}),
    ...(options.shell?.available ? shellTools({ ...options.shell, signal: options.signal }) : {}),
    ...(options.media?.key ? mediaTools({ ...options.media, signal: options.signal }) : {}),
    ...(options.files ? fileTools(options.files) : {}),
    // Last, so a built-in tool can never be shadowed by a server that named one
    // of its tools after it. The mcp__server__tool prefix makes a collision
    // unlikely, but "unlikely" is not the property worth relying on here.
    ...(options.mcp?.tools ?? {}),
  };
  const tools = Object.fromEntries(Object.entries(all).filter(([name]) => !disabled.has(name)));
  const limit = options.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS;

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
    instructions: options.instructions,
    tools,
    stopWhen: isStepCount(options.maxSteps ?? DEFAULT_MAX_STEPS),
    prepareStep: ({ messages }) => ({ messages: reduceMessages(messages, limit) }),
    // Only ssh_exec is gated. Every other tool here reads or computes; this one
    // runs a command on a machine the owner cares about.
    ...(sshApproval || mcpApproval ? { toolApproval: { ...mcpApproval, ...sshApproval } } : {}),
  });
}
