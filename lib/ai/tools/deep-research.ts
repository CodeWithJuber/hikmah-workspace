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
import { safeDiagnostic } from '../../runs/safe-error.ts';
import { evaluateEvidence } from '../../engines/agent-math.ts';

export type LaneStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** One page a lane read: the URL plus what the lane actually extracted from
 * it, so every source is inspectable — open the source, see what came out. */
export type SourceRecord = {
  url: string;
  /** Bounded head of the page text the lane actually saw. Absent when the
   * lane predates extraction records or the read returned no text. */
  excerpt?: string;
  /** When the page was read, from the read_webpage result. */
  retrievedAt?: string;
};

/** A discrete claim a lane declared about what it read, with its stance. */
export type LaneClaim = {
  text: string;
  stance: 'supports' | 'refutes';
};

export type ResearchLane = {
  question: string;
  status: LaneStatus;
  /** What the lane concluded, bounded. */
  summary?: string;
  /** The pages it actually read, with what it extracted from each. */
  sources: SourceRecord[];
  /** The lane's discrete claims, parsed off its SUPPORTS:/REFUTES: lines. */
  claims?: LaneClaim[];
  error?: string;
};

/** One side of a contradiction: the lanes on that side and what they read. */
export type ContradictionSide = {
  /** The sub-question the lane answered. */
  lane: string;
  /** The URLs that lane read for this claim. */
  sources: string[];
};

export type Contradiction = {
  /** The claim the sources disagree on, in the lane's own words. */
  claim: string;
  supporting: ContradictionSide[];
  refuting: ContradictionSide[];
};

/** Everything the card shows, published whole on every change. */
export type ResearchView = {
  status: 'planning' | 'running' | 'done' | 'failed' | 'interrupted';
  question: string;
  lanes: ResearchLane[];
  /** Sub-questions no lane answered. */
  gaps: string[];
  /** Why it stopped early, when it did. */
  note?: string;
  /** Claims both supported and refuted by different lanes. Disagreement
   * shown, never resolved — the evaluateEvidence contract. Present on the
   * final publish; empty means none was found, not that none exists. */
  contradictions?: Contradiction[];
};

export type LaneUsage = { inputTokens: number; outputTokens: number };

export type LaneResult = {
  summary: string;
  sources: SourceRecord[];
  claims?: LaneClaim[];
  usage?: LaneUsage;
};

export type DeepResearchContext = {
  /** The run's own model, shared by the planner and every lane. */
  model: LanguageModel;
  /** A prior published view the server attached to this turn (the UI's
   * Resume hands the interrupted card's view through the chat request).
   * Validated inside; used only when its question matches this call's. */
  resumeFrom?: unknown;
  /** The tools a lane may use. Already filtered for an unattended run. */
  tools: ToolSet;
  /** The run's instructions, so a lane answers in the same voice and language. */
  instructions?: string;
  signal: AbortSignal;
  /** Whether the run is on a free key: lanes run sequentially and fewer. */
  freeOnly: boolean;
  /** In-memory credentials to remove from provider diagnostics before publish. */
  diagnosticSecrets?: readonly string[];
  /** Writes the progress card into the run's stream. */
  publish?: (view: ResearchView) => void;
  /** Writes a validated disagreement record into the run's stream, so the
   *  answer's verifiability check can surface it instead of the final answer
   *  silently cherry-picking one side. */
  publishDisagreement?: (data: {
    disagreements: { claim: string; parties: { url: string; says: string }[] }[];
  }) => void;
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
/** Discrete claims a lane may declare, each bounded like the finding. */
const MAX_CLAIMS = 20;
const MAX_CLAIM = 300;
/** What the card shows of a page the lane read: the head of the text it saw. */
const MAX_EXCERPT = 400;
/** Contradictions shown on the final card; more than this is noise. */
const MAX_CONTRADICTIONS = 10;
/** Tokens across all lanes before no further lane is launched. A budget on the
 * call, not a cap on a lane already running. */
const RESEARCH_TOKEN_BUDGET = 120_000;

const LANE_BRIEF = `You are one research lane of a larger investigation, working unattended. Answer the sub-question below and nothing else. Search, then read the pages that matter — a search snippet is a lead, not a source — and write a finding of at most two paragraphs. Every claim must come from a page you actually read in this lane; name the exact URL beside it. Say plainly what you could not find or verify. If two pages you read disagree on a fact — or a page contradicts the question's premise — report it on its own line, exactly: DISAGREEMENT | <the disputed fact> | <page URL> :: <what it says> | <page URL> :: <what it says>. Do not ask questions; nobody will answer.\n\nEnd with your key claims as a list, one per line: \"SUPPORTS: <claim>\" for what the pages you read support, \"REFUTES: <claim>\" for what they contradict. Each claim must come from a page you read in this lane; skip the list when you have no discrete claims.`;

/** A disagreement a lane reported: what is disputed, and what each page says. */
export type LaneDisagreement = {
  claim: string;
  parties: { url: string; says: string }[];
};

const MAX_DISAGREEMENT_PARTIES = 4;
const MAX_DISAGREEMENT_FIELD = 500;

/**
 * Parse the `DISAGREEMENT | <fact> | <url> :: <says> | <url> :: <says>` lines a
 * lane was briefed to write. Strict on shape, tolerant on surrounding prose: a
 * malformed line is dropped, never half-parsed into a disagreement that was
 * not reported. Same contract as parseSubQuestions — a marker line, not JSON,
 * because that is what unattended models write reliably.
 */
export function parseLaneDisagreements(summary: string): LaneDisagreement[] {
  const disagreements: LaneDisagreement[] = [];
  for (const rawLine of String(summary ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^disagreement\s*\|/i.test(line)) continue;
    const segments = line
      .split('|')
      .map((segment) => segment.trim())
      .filter(Boolean);
    // Marker + disputed fact + at least two "url :: says" parties.
    if (segments.length < 4) continue;
    const claim = segments[1].slice(0, MAX_DISAGREEMENT_FIELD);
    if (!claim) continue;
    const parties: { url: string; says: string }[] = [];
    for (const segment of segments.slice(2, 2 + MAX_DISAGREEMENT_PARTIES)) {
      const at = segment.indexOf('::');
      if (at < 0) continue;
      const url = segment.slice(0, at).trim();
      const says = segment
        .slice(at + 2)
        .trim()
        .slice(0, MAX_DISAGREEMENT_FIELD);
      if (!isHttpUrl(url) || !says) continue;
      parties.push({ url, says });
    }
    if (parties.length >= 2) disagreements.push({ claim, parties });
  }
  return disagreements;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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

/** A lane's discrete claims, read off its SUPPORTS:/REFUTES: lines.
 *
 * A tolerant line parse in the parseSubQuestions tradition: most free models
 * do not do schemas, and a list is what they write well. Lines that do not
 * match are ignored, not errors — a lane with no parseable claims simply
 * contributes no assertions. */
export function parseClaims(text: string): LaneClaim[] {
  const claims: LaneClaim[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]\s*)?(supports?|refutes?)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const stance = /^sup/i.test(match[1]) ? 'supports' : 'refutes';
    const claim = match[2].replace(/\s+/g, ' ').trim();
    if (claim.length < 4 || claim.length > MAX_CLAIM) continue;
    if (claims.some((existing) => existing.text.toLowerCase() === claim.toLowerCase())) continue;
    if (claims.length >= MAX_CLAIMS) break;
    claims.push({ text: claim, stance });
  }
  return claims;
}

/** The URLs a lane opened, from its own steps: read_webpage calls that came
 * back without an error field. Each record keeps what the lane extracted —
 * the bounded head of the page text it actually saw — so the source is
 * inspectable later, not just a link. */
function readSources(
  steps: readonly { toolCalls?: readonly unknown[]; toolResults?: readonly unknown[] }[],
): SourceRecord[] {
  const outputs = new Map<string, unknown>();
  const records = new Map<string, SourceRecord>();
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const callId = (result as { toolCallId?: unknown }).toolCallId;
      if (typeof callId === 'string' && !outputs.has(callId))
        outputs.set(callId, (result as { output?: unknown }).output);
    }
    for (const call of step.toolCalls ?? []) {
      const { toolName, toolCallId, input } = call as {
        toolName?: string;
        toolCallId?: string;
        input?: { url?: unknown };
      };
      if (toolName !== 'read_webpage' || typeof toolCallId !== 'string') continue;
      const output = outputs.get(toolCallId);
      if (output && typeof output === 'object' && 'error' in (output as object)) continue;
      const url = input?.url;
      if (typeof url !== 'string' || !url || records.has(url)) continue;
      const record: SourceRecord = { url };
      const content = (output as { content?: unknown } | null)?.content;
      if (typeof content === 'string' && content.trim())
        record.excerpt = content.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT);
      const retrievedAt = (output as { retrievedAt?: unknown } | null)?.retrievedAt;
      if (typeof retrievedAt === 'string' && retrievedAt)
        record.retrievedAt = retrievedAt.slice(0, 64);
      records.set(url, record);
    }
  }
  return [...records.values()];
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
  const text = result.text.trim();
  return {
    summary: text.slice(0, MAX_SUMMARY),
    sources: readSources(result.steps as never),
    claims: parseClaims(text),
    usage: {
      inputTokens: Number(usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(usage?.outputTokens ?? 0) || 0,
    },
  };
}

/** Exact claim identity: only the same claim in the same scope can
 * contradict. Near-misses never match — the evaluateEvidence contract. */
function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!,;:]+$/, '');
}

/** Where lane claims disagree, show it — using the disagreement contract,
 * not rebuilding it. Claims are grouped by exact normalized claim; a group
 * both supported and refuted becomes one contradiction, evaluated through
 * evaluateEvidence so the 'both' state is computed, not asserted. A lane
 * with no parseable claims contributes nothing: no claims, no
 * contradictions, never an invented one. */
export function detectContradictions(
  lanes: readonly ResearchLane[],
  question: string,
): Contradiction[] {
  const scope = {
    tenant: 'research',
    project: question.trim().slice(0, 120) || 'research',
    context: 'deep-research',
  };
  const groups = new Map<
    string,
    { display: string; supporting: ContradictionSide[]; refuting: ContradictionSide[] }
  >();
  lanes.forEach((lane) => {
    for (const claim of lane.claims ?? []) {
      const key = normalizeClaim(claim.text);
      if (!key) continue;
      let group = groups.get(key);
      if (!group) {
        group = { display: claim.text, supporting: [], refuting: [] };
        groups.set(key, group);
      }
      const side: ContradictionSide = {
        lane: lane.question,
        sources: lane.sources.map((source) => source.url).slice(0, 10),
      };
      (claim.stance === 'supports' ? group.supporting : group.refuting).push(side);
    }
  });
  const contradictions: Contradiction[] = [];
  for (const group of groups.values()) {
    if (!group.supporting.length || !group.refuting.length) continue;
    if (contradictions.length >= MAX_CONTRADICTIONS) break;
    // The contract call: assertions both ways on one proposition must come
    // back 'both'. If it ever does not, the group is not shown — a
    // contradiction the evidence state cannot see is not one to display.
    try {
      const assertions = [
        ...group.supporting.map((side, index) => ({
          id: `support-${index}`,
          proposition: { id: normalizeClaim(group.display), scope },
          polarity: 'positive' as const,
          sourceRef: side.sources[0] ?? `lane:${side.lane}`,
        })),
        ...group.refuting.map((side, index) => ({
          id: `refute-${index}`,
          proposition: { id: normalizeClaim(group.display), scope },
          polarity: 'negative' as const,
          sourceRef: side.sources[0] ?? `lane:${side.lane}`,
        })),
      ];
      const verdict = evaluateEvidence({ id: normalizeClaim(group.display), scope }, assertions);
      if (verdict.state !== 'both') continue;
    } catch {
      continue;
    }
    contradictions.push({
      claim: group.display,
      supporting: group.supporting,
      refuting: group.refuting,
    });
  }
  return contradictions;
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

/** The published view, as a Zod schema: the trust boundary for a resume
 * snapshot arriving from the client or the model. Malformed snapshots are
 * ignored — a resume that cannot be validated becomes a fresh run. */
const sourceRecordSchema = z.object({
  url: z.string().min(1).max(2000),
  excerpt: z.string().max(2000).optional(),
  retrievedAt: z.string().max(64).optional(),
});
/** Views published before extraction records existed carry bare URL strings;
 * accept both shapes at the boundary and normalize after validation. */
const sourceSchema = z.union([z.string().min(1).max(2000), sourceRecordSchema]);
const laneClaimSchema = z.object({
  text: z.string().min(1).max(MAX_CLAIM),
  stance: z.enum(['supports', 'refutes']),
});
const researchLaneSchema = z.object({
  question: z.string().min(1).max(2000),
  status: z.enum(['queued', 'running', 'done', 'failed', 'skipped']),
  summary: z.string().max(4000).optional(),
  sources: z.array(sourceSchema).max(50).default([]),
  claims: z.array(laneClaimSchema).max(MAX_CLAIMS).optional(),
  error: z.string().max(2000).optional(),
});
const contradictionSideSchema = z.object({
  lane: z.string().max(2000),
  sources: z.array(z.string().max(2000)).max(50).default([]),
});
const contradictionSchema = z.object({
  claim: z.string().min(1).max(MAX_CLAIM),
  supporting: z.array(contradictionSideSchema).max(25).default([]),
  refuting: z.array(contradictionSideSchema).max(25).default([]),
});
const researchViewSchema = z.object({
  status: z.enum(['planning', 'running', 'done', 'failed', 'interrupted']),
  question: z.string().min(1).max(2000),
  lanes: z.array(researchLaneSchema).max(25),
  gaps: z.array(z.string().max(2000)).max(25).default([]),
  note: z.string().max(2000).optional(),
  contradictions: z.array(contradictionSchema).max(MAX_CONTRADICTIONS).optional(),
});

const normalizeQuestion = (question: string): string =>
  question.trim().toLowerCase().replace(/\s+/g, ' ');

/** A resume snapshot survives only validation: anything malformed is not a
 * snapshot, and the run starts fresh rather than failing on it. Old string
 * sources are normalized to records here. */
function validSnapshot(value: unknown): ResearchView | undefined {
  const parsed = researchViewSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const view = parsed.data as ResearchView & { lanes: { sources: (string | SourceRecord)[] }[] };
  for (const lane of view.lanes)
    lane.sources = lane.sources.map((source) =>
      typeof source === 'string' ? { url: source } : source,
    );
  return view;
}

/** Lane results cross an injected seam in the tests; normalize a bare URL
 * string into a record so both shapes land as SourceRecord[]. */
function toSourceRecord(source: string | SourceRecord): SourceRecord {
  if (typeof source === 'string') return { url: source };
  const record: SourceRecord = { url: String(source.url ?? '') };
  if (typeof source.excerpt === 'string' && source.excerpt) record.excerpt = source.excerpt;
  if (typeof source.retrievedAt === 'string' && source.retrievedAt)
    record.retrievedAt = source.retrievedAt;
  return record;
}

/**
 * Plan, fan out, gather. Never throws for a lane's sake: a lane that fails is
 * a gap in the findings, and the parent is told so. Throws only when the
 * whole call is aborted, which is the run being cancelled — and even then it
 * publishes an `interrupted` view first, so the card shows a resumable state
 * instead of a stuck spinner.
 *
 * Resume: pass the last published view as `resumeFrom` (or attach it to the
 * context, where it is used only when its question matches this call's).
 * Lanes already done are kept and never re-run; the rest continue from
 * where the interruption stopped them. A resume is a new call with its own
 * token budget — the budget guards one call, and the snapshot is not
 * trusted for accounting.
 */
export async function deepResearch(
  context: DeepResearchContext,
  input: { question: string; breadth?: number; resumeFrom?: unknown },
): Promise<{
  findings: { question: string; summary: string; sources: SourceRecord[] }[];
  gaps: string[];
  contradictions: Contradiction[];
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

  // The explicit input wins; either snapshot applies only to the question it
  // was published for, so a stale or mismatched snapshot is ignored and the
  // run starts fresh rather than hijacking lanes from another question.
  const explicit = validSnapshot(input.resumeFrom);
  const attached = validSnapshot(context.resumeFrom);
  const snapshot = explicit ?? attached;
  const resumedLanes =
    snapshot &&
    normalizeQuestion(snapshot.question) === normalizeQuestion(input.question) &&
    snapshot.lanes.length
      ? snapshot.lanes
      : undefined;

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
  if (resumedLanes) {
    // No re-plan: the snapshot already holds the sub-questions. Lanes done
    // in the interrupted run keep their findings; the rest re-run.
    questions = resumedLanes.map((lane) => lane.question).slice(0, breadth);
    publish({
      status: 'running',
      lanes: resumedLanes
        .slice(0, breadth)
        .map((lane) =>
          lane.status === 'done' && lane.summary
            ? { ...lane, status: 'done' as const }
            : { question: lane.question, status: 'queued' as const, sources: [] },
        ),
    });
  } else {
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
  }

  let spent = 0;
  let stop: string | undefined;
  const runOne = async (index: number) => {
    if (view.lanes[index]?.status === 'done') return;
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
      setLane(index, {
        status: 'done',
        summary: result.summary,
        sources: result.sources.map(toSourceRecord),
        ...(result.claims ? { claims: result.claims } : {}),
      });
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
            : safeDiagnostic(error, context.diagnosticSecrets, 'The lane failed.'),
      });
    }
  };

  // In parallel — that is the point — except on a free key, where the rate
  // limit makes one lane at a time the only shape that finishes at all.
  try {
    if (context.freeOnly)
      for (let index = 0; index < questions.length; index += 1) await runOne(index);
    else await Promise.all(questions.map((_, index) => runOne(index)));
  } catch (error) {
    if (context.signal.aborted) {
      // The run was cancelled or the client went away: publish the resumable
      // state before the throw, so the card is honest about where it stands.
      const lanes = view.lanes.map((lane) =>
        lane.status === 'done'
          ? lane
          : { ...lane, error: lane.error ?? 'Interrupted before it finished.' },
      );
      publish({
        status: 'interrupted',
        lanes,
        gaps: lanes.filter((lane) => lane.status !== 'done').map((lane) => lane.question),
        note: 'Interrupted — resume continues from the lanes already finished.',
      });
    }
    throw error;
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
  const contradictions = detectContradictions(view.lanes, input.question);
  publish({
    status: findings.length ? 'done' : 'failed',
    gaps,
    contradictions,
    note: stop ?? (clock.signal.aborted ? 'Stopped at the time limit.' : undefined),
  });
  // A disagreement is only admitted when every party is a page the lane
  // actually read — a lane must not manufacture a dispute from a snippet it
  // never opened, and the read list is the record of what it opened.
  if (context.publishDisagreement) {
    const read = new Set<string>();
    for (const lane of view.lanes)
      for (const source of lane.sources) read.add(normLaneUrl(toSourceRecord(source).url));
    const disagreements: { claim: string; parties: { url: string; says: string }[] }[] = [];
    for (const lane of view.lanes) {
      if (lane.status !== 'done' || !lane.summary) continue;
      for (const reported of parseLaneDisagreements(lane.summary)) {
        const parties = reported.parties.filter((party) => read.has(normLaneUrl(party.url)));
        if (parties.length >= 2) disagreements.push({ claim: reported.claim, parties });
      }
    }
    if (disagreements.length > 0) context.publishDisagreement({ disagreements });
  }
  return { findings, gaps, contradictions, ...(view.note ? { note: view.note } : {}) };
}

/** Lane read-URLs and reported URLs compared on the same footing. */
function normLaneUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    return (
      url.hostname.toLowerCase().replace(/^www\./, '') +
      url.pathname.replace(/\/+$/, '') +
      url.search
    );
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function deepResearchTools(context: DeepResearchContext) {
  return {
    deep_research: tool({
      description:
        'Investigate a question thoroughly: it is broken into sub-questions, each researched in parallel by its own agent that searches and reads real pages, and the findings come back with the exact URLs each one read plus what it extracted from each. Use for questions that need several sources compared, not for a fact one search would settle. Report the findings with their sources, and name the gaps it reports as unanswered rather than filling them from memory. When the lanes report that sources disagree, surface the disagreement explicitly \u2014 never cherry-pick one side silently. When it returns contradictions, report them as disagreements between sources — shown, never resolved into a single claim. If a previous research run was interrupted, pass its last published research view as resumeFrom: lanes already finished are kept and never re-run, and the rest continue from where they stopped.',
      inputSchema: z.object({
        question: z.string().min(1).max(2000).describe('The question to investigate, in full.'),
        breadth: z
          .number()
          .int()
          .min(1)
          .max(MAX_BREADTH)
          .optional()
          .describe('How many sub-questions to pursue at most. Fewer is faster.'),
        resumeFrom: researchViewSchema
          .optional()
          .describe(
            'The last published research view of an interrupted run. Lanes already done are kept; the rest re-run.',
          ),
      }),
      execute: async (input) => deepResearch(context, input),
    }),
  };
}
