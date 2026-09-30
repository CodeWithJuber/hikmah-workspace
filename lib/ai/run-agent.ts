/** Assembles the agent for one run.
 *
 * Shared deliberately: the request-scoped chat route uses it now, and the
 * durable worker will use the same function later, so a run behaves identically
 * whether it is driven by an open tab or resumed by the server.
 */
import {
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ToolSet,
  type TypedToolCall,
} from 'ai';
import { historyBudget, reduceMessages } from './context.ts';
import { DEFAULT_MAX_STEPS } from './chat-request.ts';
import { createLanguageModel, type ModelRequest } from './models.ts';
import { askTools } from './tools/ask.ts';
import { deterministicTools, type PlanStep } from './tools/deterministic.ts';
import { DISAGREEMENT_PART_ID, DISAGREEMENT_PART_TYPE } from '../chat/verifiability.ts';
import { javascriptTools } from './tools/javascript.ts';
import { researchTools } from './tools/research.ts';
import { sshApprovalPolicy, sshTools, type SshToolContext } from './tools/ssh.ts';
import { type McpRunTools } from '../mcp/run-context.ts';
import { withServerGuidance } from './server-guidance.ts';
import { createToolPolicy, type PolicyFn, type ToolDecider } from './tool-policy.ts';
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
   * A resume snapshot for this turn's research: the interrupted card's last
   * published view, handed through the chat request by the UI's Resume. It is
   * validated inside the tool and used only when its question matches the
   * question the model actually asks — a stale snapshot cannot hijack a new
   * question, and a malformed one is ignored.
   */
  researchResume?: unknown;
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
  mcp?: Pick<McpRunTools, 'tools' | 'approval' | 'guidance' | 'callGate'>;
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
  /**
   * Offer no tools at all: a greeting/filler turn. The 24 tool definitions
   * cost ~15k input tokens on every run, even a "direct" 0-call greeting —
   * more than the rest of the prompt combined. A greeting can never benefit
   * from a tool, so the definitions are withheld rather than sent and
   * ignored. Decided per turn by the caller (the runs route, from the same
   * signal that skips retrieval); an explicit Search/deep-research request
   * keeps its tools.
   */
  toolFree?: boolean;
  model?: LanguageModel;
};

/** The built-in tools a research lane may use: what reads, nothing that
 * writes to the workspace or reaches a machine. */
const LANE_TOOLS = new Set(['search_web', 'search_reference', 'read_webpage', 'research_quran']);
/** What the composer's Search switch asks for by name. */
const SEARCH_TOOLS = new Set(['search_web', 'read_webpage']);
const SEARCH_GUIDANCE =
  'For this message the person switched Search on. Search the web before answering, read the pages that matter, and say which pages the answer rests on. If the search finds nothing useful, say so rather than answering from memory as if it had.';

/** Why the explicitly safe tools need no approval: they read or compute inside
 * this process. None reaches a machine or an outside server. */
const SAFE_TOOL_REASON =
  'Reads or computes inside this process: reaches no machine and no outside server.';

/**
 * The permission decider for one run, built alongside its tool set.
 *
 * Deny by default: every tool the run offers gets an explicit decision — a
 * per-tool gate for the ones that reach a machine or a server, an explicit
 * safe-set membership for the ones that do not — and anything the decider was
 * not built with is denied. This replaces the record-form `toolApproval`,
 * where a tool with no entry fell back to the SDK's `not-applicable` and ran
 * with no policy decision at all.
 *
 * Server (MCP) tools re-check their gate at call time through
 * `McpRunTools.callGate`: a consent revoked after assembly, or one whose
 * expiry passed mid-run, stops authorizing here rather than at the next run.
 */
export function createToolDecider(options: RunAgentOptions): {
  decide: ToolDecider;
  tools: ToolSet;
  /** Tools the policy explicitly allows without a gate. The SDK mapping below
   * keeps their old status (`not-applicable`): approval never applied to
   * them, so emitting approval bookkeeping would tell the closing step — and
   * the activity log — that every turn stopped on a person. */
  safeTools: Set<string>;
} {
  // A greeting/filler turn: no definitions reach the provider at all, and
  // the decider denies by default anyway, so nothing can run. Early, before
  // any tool module is assembled.
  if (options.toolFree === true) {
    return {
      decide: async () => ({
        gate: 'denied',
        reason: 'This turn offers no tools.',
      }),
      tools: {},
      safeTools: new Set<string>(),
    };
  }
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
  // the gates below have nothing to decide and the run cannot pause.
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

  const grants = options.approvals;
  // The fan-out, over the run's own model. Its lanes get the research tools
  // and the auto-approved server tools from the set above — never a tool that
  // would wait on a person, and never itself — so a lane is an unattended run
  // by construction, sharing the parent's connections rather than opening its
  // own. Built before the gates so the decider covers it explicitly.
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
        resumeFrom: options.researchResume,
        publish: (view: ResearchView) =>
          options.onData?.({ type: 'data-' + RESEARCH_PART_ID, id: RESEARCH_PART_ID, data: view }),
        publishDisagreement: (data) =>
          options.onData?.({ type: DISAGREEMENT_PART_TYPE, id: DISAGREEMENT_PART_ID, data }),
        onLaneUsage: options.onLaneUsage,
      }),
    );
  }

  const gates: Record<string, PolicyFn> = {};
  // One server tool's gate, decided at call time, not from the assembly
  // snapshot. Mirrors `mcpToolApproval`'s grant override: what the owner said
  // yes to on the card runs, whatever the policy said at assembly.
  const mcpGate =
    (toolId: string): PolicyFn =>
    () => {
      const decided = options.mcp?.callGate(toolId) ?? 'deny';
      if (decided === 'deny')
        return { gate: 'denied', reason: `The ${toolId} tool is denied by policy.` };
      if (grants?.tools.has(toolId)) return { gate: 'approved' };
      if (decided === 'auto') return { gate: 'approved' };
      return {
        gate: 'user-approval',
        reason: `The ${toolId} tool needs the owner's approval.`,
      };
    };
  for (const name of Object.keys(tools)) {
    if (name === 'ssh_exec' && options.ssh && !disabled.has('ssh_exec'))
      gates[name] = sshApprovalPolicy({ listHosts: options.ssh.listHosts, grants });
    else if (name.startsWith('mcp__') && options.mcp) gates[name] = mcpGate(name);
    else if (name === 'bash' && options.shell?.available && !disabled.has('bash'))
      gates[name] = shellApprovalPolicy(grants);
    else if (name === 'sandbox_run' && options.shell?.available && !disabled.has('sandbox_run'))
      // Never auto-approved by a rule: a program is not something anyone can
      // skim the way they can skim `ls -la`. Only the owner's own grant from
      // the card, for this conversation or always, lets it run unasked.
      gates[name] = () =>
        grants?.tools.has('sandbox_run')
          ? { gate: 'approved' }
          : {
              gate: 'user-approval',
              reason: 'sandbox_run runs a program in the workbench; it always asks first.',
            };
  }
  const safeTools = new Set(Object.keys(tools).filter((name) => !(name in gates)));
  const decide = createToolPolicy({ gates, safeTools, safeReason: SAFE_TOOL_REASON });
  return { decide, tools, safeTools };
}

export function buildRunAgent(options: RunAgentOptions) {
  const { decide, tools, safeTools } = createToolDecider(options);
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
    // The single dispatch for every tool call this run makes. The SDK's
    // function form is invoked for *every* tool call — unlike the record
    // form it replaces, which silently ran any tool with no entry — and the
    // decider denies by default: only an explicit gate or an explicit
    // safe-set membership lets a call through. Denials reach the model as an
    // execution-denied tool result, carrying the policy's reason.
    //
    // The safe set keeps its old SDK status (`not-applicable`): approval
    // never applied to these tools, and emitting approval bookkeeping for
    // them would tell the closing step that every turn stopped on a person.
    toolApproval: async ({ toolCall }: { toolCall: TypedToolCall<ToolSet> }) => {
      const decision = await decide(toolCall.toolName, toolCall.input);
      if (decision.gate === 'approved' && safeTools.has(toolCall.toolName))
        return 'not-applicable' as const;
      return decision.gate;
    },
  });
}
