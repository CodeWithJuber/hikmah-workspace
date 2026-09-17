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
import { rememberTools, type MemoryToolContext } from './tools/memory.ts';
import {
  deepResearchTools,
  RESEARCH_PART_ID,
  type LaneUsage,
  type ResearchView,
} from './tools/deep-research.ts';
import type { Model } from '../engines/meaning-engine.ts';
import type { ResolvedGrants } from '../chat/approvals.ts';

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
  /** Writes a data part into the run's stream: the research progress card. */
  onData?: (chunk: { type: string; id: string; data: unknown }) => void;
  /** A research lane finished, and this is what it cost. */
  onLaneUsage?: (lane: string, usage: LaneUsage) => void;
  /**
   * Offer `deep_research` this turn. Off by default and switched on per turn
   * from the composer, because a fan-out of sub-agents is not a tool every
   * question should have within reach — on a free key it can be the day's
   * request allowance in one message.
   */
  deepResearch?: boolean;
  /**
   * Search the web this turn: the composer's Search switch. `search_web` and
   * `read_webpage` are offered whatever the conversation's switches say, and
   * the instructions tell the model to search before it answers — a person
   * who asked for the web should not get an answer from memory instead.
   */
  webSearch?: boolean;
  /**
   * What the owner has already said yes to: tools that run without asking,
   * here or anywhere, and commands granted by name. Read when the run is
   * driven, so a grant made on the card while the run was paused applies as
   * soon as it resumes. See lib/chat/approvals.ts.
   */
  approvals?: ResolvedGrants;
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
   * Enables `remember`: saving something the person just said, in their own
   * words, to their memory. Omitted when the run has no person behind it.
   */
  memory?: MemoryToolContext;
  /**
   * MCP tools for this run, already connected and gated.
   *
   * Connecting is the caller's job because it is async and has to happen once
   * per run, while this function is synchronous and may be called per step.
   */
  mcp?: Pick<McpRunTools, 'tools' | 'approval' | 'guidance'>;
  /**
   * Nobody is watching this run: a background task, or a research lane.
   *
   * It is built without `ask_user` and without every tool whose gate could
   * resolve to the owner's approval — the shell, SSH, and any server tool not
   * auto-approved. Such a run that paused on a card would pause forever, and
   * keep one of the owner's run slots while it did. Withheld rather than
   * auto-approved: an unattended run is not a reason to run a command nobody
   * agreed to.
   */
  unattended?: boolean;
  model?: LanguageModel;
};

/** The built-in tools a research lane may use: what reads, nothing that
 * writes to the workspace or reaches a machine. */
const LANE_TOOLS = new Set(['search_web', 'search_reference', 'read_webpage', 'research_quran']);
/** What the composer's Search switch asks for by name. */
const SEARCH_TOOLS = new Set(['search_web', 'read_webpage']);
const SEARCH_GUIDANCE =
  'For this message the person switched Search on. Search the web before answering, read the pages that matter, and say which pages the answer rests on. If the search finds nothing useful, say so rather than answering from memory as if it had.';

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
    ...(options.memory ? rememberTools(options.memory) : {}),
    // Last, so a built-in tool can never be shadowed by a server that named one
    // of its tools after it. The mcp__server__tool prefix makes a collision
    // unlikely, but "unlikely" is not the property worth relying on here.
    ...(options.mcp?.tools ?? {}),
  };
  const allowed = new Set(options.enabledTools ?? []);
  // What would stop on a person. Withheld entirely from an unattended run, so
  // the approval maps below have nothing to gate and the run cannot pause.
  const wouldWait = (name: string) =>
    name === 'ask_user' ||
    name === 'ssh_exec' ||
    name === 'bash' ||
    name === 'sandbox_run' ||
    (name.startsWith('mcp__') && options.mcp?.approval.get(name) !== 'auto');
  // What this message asked for by name, over the conversation's switches and
  // an agent's allowlist alike. Only the two search tools: the switch adds
  // them, it does not undo every other choice.
  const asked = options.webSearch ? SEARCH_TOOLS : new Set<string>();
  const tools = Object.fromEntries(
    Object.entries(all).filter(
      ([name]) =>
        (asked.has(name) ||
          (!disabled.has(name) &&
            (allowed.size === 0 || allowed.has(name) || name.startsWith('mcp__')))) &&
        !(options.unattended && wouldWait(name)),
    ),
  );
  // The fan-out, over the run's own model. Its lanes get the research tools
  // and the auto-approved server tools from the set above — never a tool that
  // would wait on a person, and never itself — so a lane is an unattended run
  // by construction, sharing the parent's connections rather than opening its
  // own.
  if (options.deepResearch && !disabled.has('deep_research')) {
    const model = options.model ?? createLanguageModel(options.provider);
    const laneTools = Object.fromEntries(
      Object.entries(tools).filter(
        ([name]) =>
          LANE_TOOLS.has(name) ||
          (name.startsWith('mcp__') && options.mcp?.approval.get(name) === 'auto'),
      ),
    );
    Object.assign(
      tools,
      deepResearchTools({
        model,
        tools: laneTools,
        instructions: options.instructions,
        signal: options.signal,
        freeOnly: options.provider.freeOnly === true,
        diagnosticSecrets: [options.provider.apiKey ?? ''],
        publish: (view: ResearchView) =>
          options.onData?.({ type: 'data-' + RESEARCH_PART_ID, id: RESEARCH_PART_ID, data: view }),
        onLaneUsage: options.onLaneUsage,
      }),
    );
  }
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
  const grants = options.approvals;
  const sshApproval =
    options.ssh && !disabled.has('ssh_exec')
      ? { ssh_exec: sshApprovalPolicy({ listHosts: options.ssh.listHosts, grants }) }
      : undefined;
  const mcpApproval = options.mcp?.approval.size
    ? mcpToolApproval(options.mcp.approval, grants)
    : undefined;
  // sandbox_run is never auto-approved by a rule: a program is not something
  // anyone can skim the way they can skim `ls -la`. Only the owner's own grant
  // from the card, for this conversation or always, lets it run unasked.
  const shellApproval = options.shell?.available
    ? {
        ...(disabled.has('bash') ? {} : { bash: shellApprovalPolicy(grants) }),
        ...(disabled.has('sandbox_run')
          ? {}
          : {
              sandbox_run: grants?.tools.has('sandbox_run')
                ? ('approved' as const)
                : ('user-approval' as const),
            }),
      }
    : undefined;

  // Asked for in words, not forced with `toolChoice`. A forced tool choice is
  // enforced by the SDK: a model that answers in prose anyway — most free
  // models do — fails the whole turn with "did not contain a call to the
  // required tool", measured in the browser. A person who switched Search on
  // wants the web, not an error card.
  const mustSearch = options.webSearch === true && 'search_web' in tools;
  return new ToolLoopAgent({
    model: options.model ?? createLanguageModel(options.provider),
    instructions: withServerGuidance(
      mustSearch ? options.instructions + '\n\n' + SEARCH_GUIDANCE : options.instructions,
      options.mcp?.guidance,
    ),
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
      ? {
          toolApproval: Object.fromEntries(
            // Only for tools actually offered: an unattended run withheld every
            // gated one above, and a policy for a tool that is not there is a
            // promise the run cannot keep.
            Object.entries({ ...mcpApproval, ...shellApproval, ...sshApproval }).filter(
              ([name]) => name in tools,
            ),
          ),
        }
      : {}),
  });
}
