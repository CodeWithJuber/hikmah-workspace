/** `deep_research`: one question, several sub-agents, one honest answer.
 *
 * The AI SDK's own guidance for multi-agent work is a sub-agent as a tool: the
 * parent calls it, the tool runs its own `ToolLoopAgent` and returns what it
 * found. This is that, fanned out — a planning step breaks the question into
 * sub-questions, one lane per sub-question runs in parallel with the research
 * tools, and the findings come back with the URLs each lane actually read.
 *
 * Three things decided the shape, and none of them is taste:
 *
 * - **A lane is unattended.** It is built from the run's already-filtered tool
 *   set — no `ask_user`, no tool gated on the person's approval — so it cannot
 *   pause on a card nobody is watching. The caller passes that set in; this
 *   module never widens it.
 * - **Free keys are rate-limited hard.** OpenRouter's published free limits
 *   are 20 requests a minute and 50 a day. Five lanes of eight steps plus the
 *   planner is most of a day in one message. Under `freeOnly` the lanes run
 *   one at a time, at most two of them, and the first 429 stops the rest from
 *   launching. The numbers are set by that limit, not by preference.
 * - **A source is a page a lane read**, never a search snippet. Search results
 *   are leads; `read_webpage` calls are the record. A finding's sources are the
 *   URLs that lane fetched, so "cited" means "opened".
 *
 * Progress is published as one `data-research` part whose later chunks replace
 * earlier ones (the `data-compare` pattern), on lane state changes only —
 * every publish is a row in the durable log.
 */
import {
  generateText,
  isStepCount,
  ToolLoopAgent,
  tool,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import { z } from 'zod';

export type LaneStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export type ResearchLane = {
  question: string;
  status: LaneStatus;
  /** What the lane concluded, bounded. */
  summary?: string;
  /** The URLs it actually read. */
  sources: string[];
  error?: string;
};

/** Everything the card shows, published whole on every change. */
export type ResearchView = {
  status: 'planning' | 'running' | 'done' | 'failed';
  question: string;
  lanes: ResearchLane[];
  /** Sub-questions no lane answered. */
  gaps: string[];
  /** Why it stopped early, when it did. */
  note?: string;
};

export type LaneUsage = { inputTokens: number; outputTokens: number };

export type LaneResult = {
  summary: string;
  sources: string[];
  usage?: LaneUsage;
};

export type DeepResearchContext = {
  /** The run's own model, shared by the planner and every lane. */
  model: LanguageModel;
  /** The tools a lane may use. Already filtered for an unattended run. */
  tools: ToolSet;
  /** The run's instructions, so a lane answers in the same voice and language. */
  instructions?: string;
  signal: AbortSignal;
  /** Whether the run is on a free key: lanes run sequentially and fewer. */
  freeOnly: boolean;
  /** Writes the progress card into the run's stream. */
  publish?: (view: ResearchView) => void;
  /** One call per finished lane, so each lane's tokens become a usage row. */
  onLaneUsage?: (lane: string, usage: LaneUsage) => void;
  /** Injected by the tests; the defaults talk to the model. */
  plan?: (question: string, breadth: number, signal: AbortSignal) => Promise<string[]>;
  runLane?: (question: string, signal: AbortSignal) => Promise<LaneResult>;
  /** Wall-clock bound on the whole call. */
  timeoutMs?: number;
  /** Tool-calling rounds a lane gets. */
  laneSteps?: number;
};

/** The one part id the tool writes to. */
export const RESEARCH_PART_ID = 'research';

/** Lanes at most, attended and free. */
const MAX_BREADTH = 5;
const FREE_BREADTH = 2;
/** The whole call, planner and lanes. Long enough for a lane to read three
 * pages at the 45 s source timeout; short enough that a stuck lane cannot hold
 * the run for the worker's whole life. */
const RESEARCH_TIMEOUT_MS = 240_000;
/** Rounds per lane: search, read, read, write. */
const LANE_STEPS = 8;
/** A finding is a paragraph the parent can quote, not a page. */
const MAX_SUMMARY = 2_000;
/** Tokens across all lanes before no further lane is launched. A budget on the
 * call, not a cap on a lane already running. */
const RESEARCH_TOKEN_BUDGET = 120_000;

const LANE_BRIEF = `You are one research lane of a larger investigation, working unattended. Answer the sub-question below and nothing else. Search, then read the pages that matter — a search snippet is a lead, not a source — and write a finding of at most two paragraphs. Every claim must come from a page you actually read in this lane; name the exact URL beside it. Say plainly what you could not find or verify. Do not ask questions; nobody will answer.`;

/** Break a question into sub-questions, one per numbered line.
 *
 * A numbered list rather than JSON output: most free models do not support a
 * response schema, and a list is what they write well. The parse is tolerant
 * of bullets, numbers and stray blank lines, and a plan that yields nothing
 * becomes one lane on the question itself. */
export function parseSubQuestions(text: string, breadth: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|\(\d+\))\s*/, '').trim())
    .filter(
      (line) => line.length > 3 && !/^(sub-?questions?|here|questions?)\b[:：]?$/i.test(line),
    );
  const unique = [...new Set(lines)];
  return unique.slice(0, Math.max(1, breadth));
}

async function defaultPlan(
  context: DeepResearchContext,
  question: string,
  breadth: number,
  signal: AbortSignal,
): Promise<string[]> {
  const { text } = await generateText({
    model: context.model,
    system:
      'You plan research. Break the question into the smallest set of distinct sub-questions that, answered from public sources, would answer it. Reply with a numbered list only, one sub-question per line, no preamble.',
    prompt: `Question: ${question}\n\nAt most ${breadth} sub-questions.`,
    abortSignal: signal,
  });
  return parseSubQuestions(text, breadth);
}

/** The URLs a lane opened, from its own steps: read_webpage calls that came
 * back without an error field. */
function readUrls(
  steps: readonly { toolCalls?: readonly unknown[]; toolResults?: readonly unknown[] }[],
): string[] {
  const urls = new Set<string>();
  for (const step of steps) {
    const failed = new Set(
      (step.toolResults ?? [])
        .filter((result) => {
          const output = (result as { output?: unknown }).output;
          return output && typeof output === 'object' && 'error' in (output as object);
        })
        .map((result) => (result as { toolCallId?: string }).toolCallId),
    );
    for (const call of step.toolCalls ?? []) {
      const { toolName, toolCallId, input } = call as {
        toolName?: string;
        toolCallId?: string;
        input?: { url?: unknown };
      };
      if (toolName !== 'read_webpage' || failed.has(toolCallId)) continue;
      if (typeof input?.url === 'string' && input.url) urls.add(input.url);
    }
  }
  return [...urls];
}

async function defaultLane(
  context: DeepResearchContext,
  question: string,
  signal: AbortSignal,
): Promise<LaneResult> {
  const agent = new ToolLoopAgent({
    model: context.model,
    instructions: [context.instructions, LANE_BRIEF].filter(Boolean).join('\n\n'),
    tools: context.tools,
    stopWhen: isStepCount(context.laneSteps ?? LANE_STEPS),
  });
  const result = await agent.generate({ prompt: question, abortSignal: signal });
  const usage = result.totalUsage;
  return {
    summary: result.text.trim().slice(0, MAX_SUMMARY),
    sources: readUrls(result.steps as never),
    usage: {
      inputTokens: Number(usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(usage?.outputTokens ?? 0) || 0,
    },
  };
}

/** Whether a failure is the provider refusing on rate. The message is all a
 * lane has; both the status code and the word are looked for. */
export function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  return status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
}

/**
 * Plan, fan out, gather. Never throws for a lane's sake: a lane that fails is
 * a gap in the findings, and the parent is told so. Throws only when the
 * whole call is aborted, which is the run being cancelled.
 */
export async function deepResearch(
  context: DeepResearchContext,
  input: { question: string; breadth?: number },
): Promise<{
  findings: { question: string; summary: string; sources: string[] }[];
  gaps: string[];
  note?: string;
}> {
  const cap = context.freeOnly ? FREE_BREADTH : MAX_BREADTH;
  const breadth = Math.max(1, Math.min(cap, Math.trunc(input.breadth ?? cap)));
  // A referenced timer rather than AbortSignal.timeout, whose timer is unref'd
  // and so cannot by itself keep the process alive to fire: a lane waiting on
  // nothing but that timer would never be told the time was up.
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), context.timeoutMs ?? RESEARCH_TIMEOUT_MS);
  const signal = AbortSignal.any([context.signal, clock.signal]);

  let view: ResearchView = { status: 'planning', question: input.question, lanes: [], gaps: [] };
  const publish = (next: Partial<ResearchView>) => {
    view = { ...view, ...next };
    context.publish?.(view);
  };
  const setLane = (index: number, patch: Partial<ResearchLane>) => {
    const lanes = view.lanes.map((lane, at) => (at === index ? { ...lane, ...patch } : lane));
    publish({ lanes });
  };
  publish({});

  let questions: string[];
  try {
    questions = await (context.plan ?? ((q, b, s) => defaultPlan(context, q, b, s)))(
      input.question,
      breadth,
      signal,
    );
  } catch (error) {
    if (context.signal.aborted) throw error;
    // No plan is not no research: the question itself is one lane.
    questions = [];
  }
  // Bounded here, not only asked for: a planner that lists more than it was
  // asked has still only earned `breadth` lanes.
  questions = questions.slice(0, breadth);
  if (!questions.length) questions = [input.question];

  publish({
    status: 'running',
    lanes: questions.map((question) => ({ question, status: 'queued', sources: [] })),
  });

  let spent = 0;
  let stop: string | undefined;
  const runOne = async (index: number) => {
    if (stop || signal.aborted || spent >= RESEARCH_TOKEN_BUDGET) {
      setLane(index, {
        status: 'skipped',
        error: stop ?? (clock.signal.aborted ? 'Out of time.' : 'Out of budget.'),
      });
      return;
    }
    setLane(index, { status: 'running' });
    try {
      const result = await (context.runLane ?? ((q, s) => defaultLane(context, q, s)))(
        questions[index],
        signal,
      );
      if (result.usage) {
        spent += result.usage.inputTokens + result.usage.outputTokens;
        context.onLaneUsage?.(questions[index], result.usage);
      }
      setLane(index, { status: 'done', summary: result.summary, sources: result.sources });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const rate = isRateLimit(error);
      if (rate && !stop) stop = 'The provider refused on rate; no further lanes were started.';
      setLane(index, {
        status: 'failed',
        error: clock.signal.aborted
          ? 'Out of time.'
          : rate
            ? 'Rate-limited by the provider.'
            : error instanceof Error && error.message
              ? error.message
              : 'The lane failed.',
      });
    }
  };

  // In parallel — that is the point — except on a free key, where the rate
  // limit makes one lane at a time the only shape that finishes at all.
  try {
    if (context.freeOnly)
      for (let index = 0; index < questions.length; index += 1) await runOne(index);
    else await Promise.all(questions.map((_, index) => runOne(index)));
  } finally {
    clearTimeout(timer);
  }

  const gaps = view.lanes.filter((lane) => lane.status !== 'done').map((lane) => lane.question);
  const findings = view.lanes
    .filter((lane) => lane.status === 'done')
    .map((lane) => ({
      question: lane.question,
      summary: lane.summary ?? '',
      sources: lane.sources,
    }));
  publish({
    status: findings.length ? 'done' : 'failed',
    gaps,
    note: stop ?? (clock.signal.aborted ? 'Stopped at the time limit.' : undefined),
  });
  return { findings, gaps, ...(view.note ? { note: view.note } : {}) };
}

export function deepResearchTools(context: DeepResearchContext) {
  return {
    deep_research: tool({
      description:
        'Investigate a question thoroughly: it is broken into sub-questions, each researched in parallel by its own agent that searches and reads real pages, and the findings come back with the exact URLs each one read. Use for questions that need several sources compared, not for a fact one search would settle. Report the findings with their sources, and name the gaps it reports as unanswered rather than filling them from memory.',
      inputSchema: z.object({
        question: z.string().min(1).max(2000).describe('The question to investigate, in full.'),
        breadth: z
          .number()
          .int()
          .min(1)
          .max(MAX_BREADTH)
          .optional()
          .describe('How many sub-questions to pursue at most. Fewer is faster.'),
      }),
      execute: async (input) => deepResearch(context, input),
    }),
  };
}
