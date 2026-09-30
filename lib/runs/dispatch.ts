/** The smart dispatcher: the run pipeline's missing brain.
 *
 * Until this module, every run sent everything — the 24 tool definitions
 * (~15k input tokens), all retrieval, the full prompt — and the model figured
 * out what the turn needed. Now the turn is classified FIRST, and the run is
 * built for the lane it actually takes:
 *
 * - `direct`: greeting/filler. No tools, no retrieval. Target < 2.5k input
 *   tokens. Reuses the deterministic greeting signal from the
 *   greeting-tokens-v2 ticket (isFillerQuery in lib/memory/recall.ts).
 * - `standard`: today's behavior — full tools + retrieval. The default when
 *   nothing specific matches.
 * - `research`: the turn wants the live web — the composer's Search switch,
 *   deep research, or detected research intent. Web tools only.
 * - `quran`: the turn is about the Quran. Quran tools only, with the owner's
 *   Quran lens as a lane constraint (lā taqfu / tabayyun / amāna): answers
 *   are grounded in tool output, never quoted from memory.
 *
 * Classification is deterministic rules first: fast, zero model cost, and a
 * pure function, so the whole matrix is unit-testable. Only an ambiguous turn
 * asks Jev (typed choice, 3s cap, fail-open to `standard`) — Jev proposes, it
 * never blocks the turn, the same contract lib/runs/jev-lane.ts keeps.
 *
 * Decision inputs, per the standing mandate: JEV judges the ambiguous calls,
 * the Quran lens constrains the quran lane, the wisdom playbook guides
 * (deterministic-first, fail-open, never invent).
 */
import { isFillerQuery } from '../memory/recall.ts';
import { systemOne } from '../integrations/jev-client.ts';
import { researchSlotNames } from '../research/tool-slot.ts';

/** The lanes a turn can take. */
export type DispatchLane = 'direct' | 'standard' | 'research' | 'quran';

export type DispatchFlags = {
  webSearch?: boolean;
  deepResearch?: boolean;
  /** Accepted for forward-compatibility; v1 does not route on it. Incognito
   * is a consent flag, honored downstream exactly as today. */
  incognito?: boolean;
};

/** What tool set the lane offers: none (toolFree), today's full set, or a
 * narrowed allowlist the route passes as enabledTools. */
export type LaneToolPlan = 'none' | 'full' | 'web' | 'quran';

export type DispatchDecision = {
  lane: DispatchLane;
  tools: LaneToolPlan;
  /** Whether the turn may retrieve saved knowledge and earlier conversations. */
  retrieval: boolean;
  /** The research lane wants web tools even without the composer's switch. */
  useWeb: boolean;
  /** Target input-token budget for the turn. Telemetry, not a hard cap: the
   * receipt shows it, the run never refuses over it. */
  promptBudget: number;
  /** True when Jev's advisory picked the lane (ambiguous turn). */
  jevAdvised: boolean;
  /** Extra instruction block for the lane, '' when none. */
  laneConstraint: string;
  /** Registered lib/research slot names for this lane (v1: none — the honest
   * stub; the first real slot lands with the Ruh inference work). */
  researchSlots: string[];
};

/** Words that ask for the live web rather than stored knowledge. */
const RESEARCH_INTENT =
  /\b(search|google|look\s?up|latest|newest|recent|news|current|research|find\sout|what('?s|\sis)\shappening)\b/i;
/** Words that demand freshness: they beat a quran signal into the research lane. */
const WEB_FRESHNESS = /\b(latest|newest|recent|news|today|this\sweek|currently|current)\b/i;
/** Quran signals: names, verse references (2:255), surah/ayah + number, and
 * Arabic script. In this product a bare "2:255" is read as surah:ayah — the
 * quran server is connected, and the lens requires grounding either way. */
const QURAN_SIGNAL =
  /(\b(qur'?anic?|koran|mushaf|ayah|ayat|surah|sura|tafsir|hadith)\b|\b(surah|ayah)\s+\d+|\b\d{1,3}:\d{1,3}\b|[\u0600-\u06FF])/i;

export type Classification = { kind: 'lane'; lane: DispatchLane } | { kind: 'ambiguous' };

/**
 * Classify a turn deterministically. Pure: no I/O, no model, no clock — the
 * whole matrix is unit-testable. Order matters and is stated here:
 *
 * 1. An explicit tool request wins over every signal (the composer's Search
 *    switch, deep research) — the same rule isToolFreeTurn() carries.
 * 2. Greeting/filler: the deterministic signal from the greeting-tokens-v2
 *    ticket. An empty turn cannot benefit from tools or retrieval either.
 * 3. Quran signal without freshness words: the quran lane, grounded and
 *    lens-constrained.
 * 4. Research intent or freshness words: the research lane.
 * 5. A quran signal with neither of the above (e.g. a bare verse ref after
 *    the freshness check): still the quran lane.
 * 6. Anything else is ambiguous — Jev judges, with a deterministic fallback.
 */
export function classifyDispatch(query: string, flags: DispatchFlags = {}): Classification {
  const text = query.trim();
  if (flags.webSearch || flags.deepResearch) return { kind: 'lane', lane: 'research' };
  if (!text) return { kind: 'lane', lane: 'direct' };
  if (isFillerQuery(text)) return { kind: 'lane', lane: 'direct' };
  const quran = QURAN_SIGNAL.test(text);
  const fresh = WEB_FRESHNESS.test(text);
  if (quran && !fresh) return { kind: 'lane', lane: 'quran' };
  if (fresh || RESEARCH_INTENT.test(text)) return { kind: 'lane', lane: 'research' };
  if (quran) return { kind: 'lane', lane: 'quran' };
  return { kind: 'ambiguous' };
}

const LANE_QUESTION = {
  id: 'dispatch-lane',
  type: 'choice' as const,
  prompt: 'Which lane should this chat turn take?',
  options: ['direct', 'standard', 'research', 'quran'],
};

export type JevAdvisoryOptions = {
  /** Injected by tests; production uses the global fetch. */
  fetcher?: typeof fetch;
  /** Injected by tests; production uses the client's 3s default. */
  timeoutMs?: number;
};

const isLane = (value: unknown): value is DispatchLane =>
  value === 'direct' || value === 'standard' || value === 'research' || value === 'quran';

/**
 * Ask Jev which lane an ambiguous turn should take. Null when Jev cannot
 * answer — unreachable, slow, keyless, or a nonsense reply — and the caller
 * falls back to `standard`. Never throws and never blocks past its timeout:
 * the advisory is a proposal, never a verdict.
 */
export async function adviseLane(
  query: string,
  flags: DispatchFlags,
  options: JevAdvisoryOptions = {},
): Promise<DispatchLane | null> {
  const trimmed = query.trim().slice(0, 2000);
  if (!trimmed) return null;
  try {
    const decision = await systemOne(
      {
        query: trimmed,
        webSearch: flags.webSearch === true,
        deepResearch: flags.deepResearch === true,
        lanes: {
          direct: 'greeting or filler; no tools, no retrieval',
          standard: 'ordinary task or question; full tools and memory',
          research: 'needs the live web; web search tools',
          quran: 'about the Quran; quran tools with verification discipline',
        },
      },
      [LANE_QUESTION],
      { fetcher: options.fetcher, timeoutMs: options.timeoutMs },
    );
    const lane = decision?.answers.find((answer) => answer.id === 'dispatch-lane')?.value;
    return isLane(lane) ? lane : null;
  } catch {
    return null;
  }
}

/** Target input-token budgets per lane. The direct target is the
 * greeting-tokens-v2 contract: a "Hi" under 2.5k. Telemetry, not a cap. */
const PROMPT_BUDGETS: Record<DispatchLane, number> = {
  direct: 2_500,
  standard: 32_000,
  research: 48_000,
  quran: 32_000,
};

const TOOL_PLANS: Record<DispatchLane, LaneToolPlan> = {
  direct: 'none',
  standard: 'full',
  research: 'web',
  quran: 'quran',
};

/** The Quran lens as a lane constraint, from the owner's quran_lens.md
 * (forgekit/research/cognitive-substrate/quranic-lens): lā taqfu (17:36) —
 * no assertion without knowledge; tabayyun (49:6) — verify before acting;
 * amāna (33:72) — stewardship of the trust. This restates for the turn what
 * the core prompt already requires: scripture from the canonical tools,
 * never from memory — and research_quran's own honesty note (AI-authored
 * index, not scripture, not verified tafsir). */
const QURAN_LANE_CONSTRAINT = `Quran-lane discipline: answer only from what the quran tools return — never quote a verse, translation, or tafsir from memory (lā taqfu: do not assert what you have no knowledge of, 17:36). Verify every verse reference with the tools before answering (tabayyun: verify before acting, 49:6). Treat this content as a trust (amāna, 33:72): preserve each source's stated verification status, and say plainly when something is AI-authored research notes rather than scripture or verified tafsir.`;

/** The full decision for a lane. Pure. */
export function toDecision(
  lane: DispatchLane,
  options: { jevAdvised?: boolean } = {},
): DispatchDecision {
  return {
    lane,
    tools: TOOL_PLANS[lane],
    retrieval: lane !== 'direct',
    useWeb: lane === 'research',
    promptBudget: PROMPT_BUDGETS[lane],
    jevAdvised: options.jevAdvised === true,
    laneConstraint: lane === 'quran' ? QURAN_LANE_CONSTRAINT : '',
    researchSlots: researchSlotNames(lane),
  };
}

/**
 * Classify a turn and resolve its lane. Deterministic rules first (zero model
 * cost); only an ambiguous turn pays for a Jev advisory, and a Jev that
 * cannot answer falls back to `standard` — the turn is never blocked on Jev.
 */
export async function dispatchTurn(
  query: string,
  flags: DispatchFlags = {},
  options: JevAdvisoryOptions = {},
): Promise<DispatchDecision> {
  const classification = classifyDispatch(query, flags);
  if (classification.kind === 'lane') return toDecision(classification.lane);
  const advised = await adviseLane(query, flags, options);
  return toDecision(advised ?? 'standard', { jevAdvised: advised !== null });
}

/** Built-in tools each narrowed lane may offer. MCP (mcp__*) tools always
 * pass the allowlist inside run-agent.ts, so the quran lane keeps the quran
 * server's canonical tools with no extra work. */
const LANE_ALLOWLISTS: Record<Extract<LaneToolPlan, 'web' | 'quran'>, string[]> = {
  web: ['search_web', 'search_reference', 'read_webpage'],
  quran: ['research_quran', 'search_reference'],
};

/**
 * The enabledTools allowlist for a narrowed lane, or undefined to leave the
 * run's tool set exactly as the caller set it. An explicit allowlist on the
 * run wins over the lane: the lane narrows, it never widens past what was
 * asked for, and it never silently empties the set (zero tools is the direct
 * lane's job, via toolFree).
 */
export function laneToolAllowlist(
  decision: Pick<DispatchDecision, 'tools' | 'researchSlots'>,
  userAllowlist?: string[],
): string[] | undefined {
  if (decision.tools !== 'web' && decision.tools !== 'quran') return undefined;
  if (userAllowlist && userAllowlist.length > 0) return userAllowlist;
  return [...LANE_ALLOWLISTS[decision.tools], ...decision.researchSlots];
}
