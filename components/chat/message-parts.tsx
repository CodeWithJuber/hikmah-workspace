'use client';
/** Renders one assistant or user message as its ordered parts.
 *
 * AI SDK 7 models a message as a list of typed parts rather than a string, so
 * tool calls, reasoning and sources interleave with the text in the order they
 * actually happened. The switch below is deliberately exhaustive and ends in a
 * `default` branch: the SDK adds part types between minor versions, and an
 * unhandled one must degrade to something visible rather than vanish.
 */
import { isToolUIPart, type UIMessage } from 'ai';
import { memo, useMemo, useState } from 'react';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { ApprovalCard, type GrantHandler } from './approval-card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  AlertCircle,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  GitFork,
  LoaderCircle,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageToolbar,
} from '@/components/ai-elements/message';
import { describeWorking, groupParts, toolLabel } from '@/lib/chat/working';
import { dedupeSources, sourceAnchorId, type CitedSource } from '@/lib/chat/citations';
import { CitedText } from './citation-pills';
import { AnswerPyramid } from './answer-pyramid';
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { ReadAloud } from './voice-controls';
import { ChatReceipt } from './chat-receipt';
import { MemoryAnnotations, type MemoryForAha } from './memory-annotations';
import { FollowUpChips } from './follow-up-chips';
import { usePricing } from './pricing-context';
import { estimatedCost } from '@/lib/playground/model-catalog';
import { InlineArtifact } from '@/components/kernel/artifact';
import { ClarificationCard } from '@/components/kernel/question';
import { messageArtifact } from '@/lib/chat/artifact';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { SiblingSwitcher } from './branch-ui';
import { FeedbackButtons } from './message-feedback';
import type { FeedbackValue } from '@/lib/chat/feedback-store';
import { GeneratedImage } from './generated-image';

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/** Curated follow-ups after an answer. Plain and useful; the chips component
 * takes any source, so an LLM-generated set can replace this later. */
const FOLLOW_UP_SUGGESTIONS = [
  'Explain this more simply',
  'Give me an example',
  'What should I do next?',
  'Make it shorter',
];

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** The source strip for research answers: a horizontal scroll of source cards
 * instead of the Sources collapsible. Each card keeps the anchor id the
 * citation pills link to, so tapping a [n] pill in the answer still lands on
 * its card. */
export function ResearchSourceStrip({
  messageId,
  sources,
}: {
  messageId: string;
  sources: CitedSource[];
}) {
  return (
    <div className="chat-source-strip" role="group" aria-label={`${sources.length} sources`}>
      {sources.map((source, index) => {
        const id = sourceAnchorId(messageId, index);
        const title = source.title ?? source.url ?? 'Source';
        const host = source.type === 'source-url' && source.url ? hostOf(source.url) : undefined;
        const card = (
          <>
            <span className="chat-source-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="chat-source-card-text">
              <span className="chat-source-title">{title}</span>
              {host && <span className="chat-source-host">{host}</span>}
            </span>
          </>
        );
        // A source-document has no URL, and an <a> without href is not a
        // link: the keyboard cannot reach it while it still looks like every
        // other citation. Render those as plain cards, same as the list did.
        return source.type === 'source-url' && source.url ? (
          <a
            key={id}
            id={id}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="chat-source-card"
          >
            {card}
          </a>
        ) : (
          // A source-document has no URL: a plain card, not a link to nowhere.
          // The id is still the fragment target the citation pills jump to.
          <span key={id} id={id} className="chat-source-card">
            {card}
          </span>
        );
      })}
    </div>
  );
}

/** A one-line follow-up box under a research answer. Sending fills the main
 * composer as an editable draft — it never sends directly, same as the chips. */
export function MiniFollowUpComposer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="chat-mini-followup"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text) return;
        onSubmit(text);
        setValue('');
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask a follow-up…"
        aria-label="Ask a follow-up"
        maxLength={2000}
      />
      <button type="submit" disabled={!value.trim()} aria-label="Put follow-up in the composer">
        <ArrowUp size={16} aria-hidden="true" />
      </button>
    </form>
  );
}

/** Answers one paused tool call. Resolved by the chat view, which owns useChat. */
export type RespondToApproval = (response: { id: string; approved: boolean }) => void;

/** Answers one ask_user call. Same owner, same reason: only useChat can write a
 * tool output back into the message. */
export type RespondToQuestion = (response: { toolCallId: string; answer: string }) => void;

/** Saves a message to memory. Returns how it was filed, or null on failure. */
export type RememberMessage = (message: UIMessage) => Promise<'saved' | 'suggested' | null>;

function CopyAction({ message }: { message: UIMessage }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const label =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? 'Copy failed — select the text to copy'
        : message.role === 'user'
          ? 'Copy message'
          : 'Copy answer';
  return (
    <MessageAction
      tooltip={label}
      aria-label={label}
      disabled={!messageText(message)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(messageText(message));
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
    >
      {state === 'copied' ? (
        <Check size={16} />
      ) : state === 'failed' ? (
        <AlertCircle size={16} />
      ) : (
        <Copy size={16} />
      )}
    </MessageAction>
  );
}

/** The Remember control on a message.
 *
 * The control `components/playground/knowledge.tsx` has promised — "choose
 * Remember on a message" — since before the chat surface existed. Your own
 * message is saved as your words; an answer is filed as the model's
 * inference and waits for your review, and the label says which happened.
 */
function RememberAction({
  message,
  onRemember,
}: {
  message: UIMessage;
  onRemember: RememberMessage;
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'suggested' | 'failed'>('idle');
  const own = message.role === 'user';
  const label =
    state === 'saved'
      ? 'Saved to memory'
      : state === 'suggested'
        ? 'Suggested — review it in Memory'
        : state === 'failed'
          ? 'Could not save'
          : own
            ? 'Remember this, in your words'
            : 'Suggest this answer as a memory';
  return (
    <MessageAction
      tooltip={label}
      aria-label={label}
      disabled={state === 'saving' || !messageText(message)}
      onClick={() => {
        setState('saving');
        void onRemember(message).then((result) => setState(result ?? 'failed'));
      }}
    >
      {state === 'saved' || state === 'suggested' ? (
        <BookmarkCheck size={16} />
      ) : (
        <Bookmark size={16} />
      )}
    </MessageAction>
  );
}

/** What ask_user is asking, defensively read: it arrives as tool input, which is
 * model output, so neither field is guaranteed to be the shape the schema asked
 * for. A card with no question is worse than no card, so an unreadable one falls
 * back to the generic tool row. */
function questionFrom(input: unknown): { question: string; options: string[] } | null {
  const value = (input ?? {}) as { question?: unknown; options?: unknown };
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question) return null;
  const options = Array.isArray(value.options)
    ? value.options.filter(
        (option): option is string => typeof option === 'string' && !!option.trim(),
      )
    : [];
  return { question, options };
}

/** One generated asset, as the media tools describe it in their output. */
type GeneratedMedia = {
  kind?: string;
  url?: string;
  mediaType?: string;
  prompt?: string;
};

const isMedia = (value: unknown): value is GeneratedMedia =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as GeneratedMedia).url === 'string' &&
  // Only paths this app serves. A url from anywhere else is not something to
  // load into the page on a tool's say-so.
  (value as GeneratedMedia).url!.startsWith('/api/media/assets/');

/**
 * The images and audio in a media tool's output, if it produced any.
 *
 * Read structurally rather than by tool name so a failed call — which returns
 * an error instead — falls through to the ordinary output card and says what
 * went wrong, rather than rendering as a broken picture.
 */
function generatedMedia(output: unknown): GeneratedMedia[] {
  if (!output || typeof output !== 'object') return [];
  const value = output as { images?: unknown; audio?: unknown };
  const found = [...(Array.isArray(value.images) ? value.images : []), value.audio];
  return found.filter(isMedia);
}

/** Generated media, played or shown rather than printed as JSON. */
function MediaAttachment({ media }: { media: GeneratedMedia }) {
  if (media.kind === 'audio')
    return (
      <figure className="chat-media">
        {/* The figcaption below carries the text that was spoken, which is the
            caption this needs — a <track> would be the same words in a second
            format, and there is no timing to put in one: the clip is generated
            from that prompt, not transcribed from speech. preload="none" so a
            transcript with several of these does not fetch them all on open. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          controls
          aria-label={media.prompt ?? 'Generated audio'}
          src={media.url}
          preload="none"
        />
        {media.prompt && <figcaption dir="auto">{media.prompt}</figcaption>}
      </figure>
    );
  return (
    <figure className="chat-media">
      {/* Not next/image: these are generated at run time behind an
          owner-scoped route, so there is nothing for the optimiser to
          pre-process and a loader would only add a hop. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={media.url} alt={media.prompt ?? 'Generated image'} loading="lazy" />
      {media.prompt && <figcaption dir="auto">{media.prompt}</figcaption>}
    </figure>
  );
}

/** A step of the plan the run published through update_plan. */
type PlanStep = { step: string; status: 'pending' | 'in_progress' | 'completed' };

/** What the run said it was going to do, and how far along it is.
 *
 * Rendered as a checklist rather than the tool's JSON result, which is what it
 * looked like before: the plan is for the reader, which is the whole reason the
 * tool exists. */
function TaskPlan({ steps }: { steps: PlanStep[] }) {
  if (!steps.length) return null;
  return (
    <section className="chat-plan" aria-label="Task plan">
      <h3>Plan</h3>
      <ol>
        {steps.map((entry, index) => (
          <li key={index} className={'chat-plan-' + entry.status}>
            {entry.status === 'completed' ? (
              <Check size={16} aria-hidden="true" />
            ) : entry.status === 'in_progress' ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <span className="chat-plan-number">{index + 1}</span>
            )}
            <span>{entry.step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The comparison lane's state, as the run writes it. */
type CompareView = {
  status?: string;
  model?: string;
  text?: string;
  latencyMs?: number;
  firstTextMs?: number;
  error?: string;
};

/** The same question answered without the agent's tools, beside the answer that
 * used them. Rendered as its own block rather than inline, because the whole
 * point of the mode is reading the two next to each other. */
function ComparisonLane({ view }: { view: CompareView }) {
  const running = view.status === 'running';
  return (
    <section className="chat-compare" aria-label="Comparison: the same question without tools">
      <header>
        {/* "Without tools" alone read as a category nobody had asked for. It is
            a control: the same question, answered with the tools taken away, so
            the two answers side by side show what the tools were worth. */}
        <strong>Same question, no tools</strong>
        <span className="chat-compare-model">{view.model}</span>
        {/* Time to the first token is the number a person actually feels; the
            total is what the workflows cost. Both, once they exist. */}
        {view.firstTextMs !== undefined && (
          <span className="chat-compare-timing">
            {Math.round(view.firstTextMs)} ms to first word
            {view.latencyMs !== undefined && ` · ${Math.round(view.latencyMs)} ms total`}
          </span>
        )}
      </header>
      {/* Shown whatever the status: a stopped or failed comparison has usually
          written something, and hiding a partial answer is the defect this
          surface was rebuilt to fix. */}
      {view.text && <div dir="auto">{view.text}</div>}
      {running ? (
        <p className="chat-compare-note">Answering…</p>
      ) : (
        view.status === 'done' && (
          <p className="chat-compare-note">
            The answer above used the tools; this one had none, so the difference between them is
            what they added.
          </p>
        )
      )}
      {view.status === 'failed' && (
        <p className="chat-compare-note" role="alert">
          {view.error ?? 'The comparison did not finish.'}
        </p>
      )}
      {view.status === 'cancelled' && <p className="chat-compare-note">Stopped.</p>}
    </section>
  );
}

/** The research fan-out's state, as the tool publishes it. */
type ResearchView = {
  status?: string;
  question?: string;
  lanes?: {
    question: string;
    status: string;
    summary?: string;
    sources?: string[];
    error?: string;
  }[];
  gaps?: string[];
  note?: string;
};

const LANE_WORDS: Record<string, string> = {
  queued: 'Waiting',
  running: 'Reading…',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** One row per lane, so the reader can watch the fan-out arrive and, when it
 * is done, open each finding with the pages it actually read. Closed rows on
 * a phone, like the working: the answer below is what they came for. */
function ResearchCard({ view }: { view: ResearchView }) {
  const lanes = view.lanes ?? [];
  const done = lanes.filter((lane) => lane.status === 'done').length;
  const running = view.status === 'planning' || view.status === 'running';
  return (
    <section className="chat-research" aria-label="Deep research">
      <header>
        <strong>
          {view.status === 'planning'
            ? 'Planning the research…'
            : `Deep research · ${lanes.length === 1 ? '1 lane' : `${lanes.length} lanes`}`}
        </strong>
        {lanes.length > 0 && (
          <span className="chat-research-count">
            {running ? `${done} of ${lanes.length} done` : `${done} of ${lanes.length} answered`}
          </span>
        )}
      </header>
      {lanes.length > 0 && (
        <ol>
          {lanes.map((lane, index) => (
            <li key={index} className={'chat-research-' + lane.status}>
              {lane.status === 'running' ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : lane.status === 'done' ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <span className="chat-plan-number">{index + 1}</span>
              )}
              {lane.status === 'done' && lane.summary ? (
                // <details>, not the ui/collapsible: the finding and its source
                // links are the payload of this card, and a closed Radix
                // Collapsible does not render its content into the DOM at all
                // (no find-in-page, nothing without JS, and the receipt test
                // cannot see it). The chat.css rules target details too.
                <details className="chat-research-lane">
                  <summary className="chat-research-lane-trigger">
                    <span dir="auto">{lane.question}</span>
                    <span className="chat-research-state">
                      {lane.sources?.length
                        ? `${lane.sources.length} ${lane.sources.length === 1 ? 'page' : 'pages'} read`
                        : 'no page read'}
                    </span>
                  </summary>
                  <p dir="auto">{lane.summary}</p>
                  {!!lane.sources?.length && (
                    <ul className="chat-research-sources">
                      {lane.sources.map((url) => (
                        <li key={url}>
                          <a href={url} target="_blank" rel="noreferrer noopener">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              ) : (
                <span className="chat-research-row">
                  <span dir="auto">{lane.question}</span>
                  <span className="chat-research-state">
                    {lane.error ?? LANE_WORDS[lane.status] ?? lane.status}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {view.note && <p className="chat-research-note">{view.note}</p>}
      {!running && !!view.gaps?.length && (
        <p className="chat-research-note">
          Not answered:{' '}
          {view.gaps.length === 1 ? '1 sub-question' : `${view.gaps.length} sub-questions`}. The
          answer says so rather than filling them in.
        </p>
      )}
    </section>
  );
}

/** Sources are collected across the message so citations render as one list. */
function sourceParts(message: UIMessage) {
  return message.parts.filter(
    (part) => part.type === 'source-url' || part.type === 'source-document',
  );
}

type WorkflowPlanData = {
  arm: string;
  budget: { maxCalls: number; maxTokens: number; maxCost: number; deadlineMs: number };
  selection:
    | { scores: Record<string, number>; propensity: number; featureVersion: number }
    | { overridden: true };
  terminalState?: string;
};

type AnswerUsage = {
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

const fmtCount = (value: number) => new Intl.NumberFormat('en-US').format(Math.round(value));
const fmtCost = (value: number) => '$' + (value < 0.01 ? value.toFixed(4) : value.toFixed(3));

/** One budget leg as a meter: used versus cap, from observed spend only. */
function BudgetMeter({
  label,
  used,
  cap,
  text,
}: {
  label: string;
  used: number;
  cap: number;
  text: string;
}) {
  const ratio = cap > 0 ? used / cap : used > 0 ? 1 : 0;
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const hit = ratio >= 1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ width: 44, flex: 'none', fontSize: 12, opacity: 0.65 }}>{label}</span>
      <div
        role="img"
        aria-label={`${label}: ${text}`}
        style={{
          flex: '1 1 auto',
          height: 6,
          borderRadius: 3,
          background: 'color-mix(in srgb, currentColor 16%, transparent)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: hit ? 'var(--error-text)' : 'currentColor',
            opacity: hit ? 0.9 : 0.55,
          }}
        />
      </div>
      <span
        style={{
          flex: 'none',
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          opacity: hit ? 1 : 0.75,
          fontWeight: hit ? 600 : 400,
        }}
      >
        {text}
      </span>
    </div>
  );
}

/** The v5 workflow plan, streamed as a `data-workflow` part when the run
 * starts (see lib/runs/service.ts). A closed-by-default inspector: the answer
 * below is what the reader came for, but which arm the policy chose, why, and
 * what budget it may spend is one tap away.
 *
 * Honesty contract, kept in the copy: scores are the policy's judgment, never
 * P(correct); a terminal state is named as a limit, not a success; spend is
 * counted from this message's own parts and metadata, never predicted.
 */
function WorkflowPlanCard({
  plan,
  callsUsed,
  meta,
}: {
  plan: WorkflowPlanData;
  callsUsed: number;
  meta: AnswerUsage;
}) {
  const pricing = usePricing();
  const inputTokens = Number(meta.usage?.inputTokens ?? 0);
  const outputTokens = Number(meta.usage?.outputTokens ?? 0);
  const tokensUsed = Number(meta.usage?.totalTokens ?? inputTokens + outputTokens);
  const cost = estimatedCost(
    meta.model ? pricing.get(meta.model) : undefined,
    inputTokens,
    outputTokens,
  );
  const sel = plan.selection;
  const overridden = typeof sel === 'object' && sel !== null && 'overridden' in sel;
  const scores = !overridden
    ? Object.entries((sel as { scores: Record<string, number> }).scores ?? {})
        .filter(([, s]) => typeof s === 'number' && Number.isFinite(s))
        .sort((a, b) => b[1] - a[1])
    : [];
  const top = scores.slice(0, 2);
  const topMax = Math.max(0, ...top.map(([, s]) => Math.abs(s)), 0.0001);
  const { maxCalls, maxTokens, maxCost } = plan.budget;
  const terminal = typeof plan.terminalState === 'string' ? plan.terminalState : undefined;

  return (
    <Collapsible
      style={{
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        borderRadius: 'var(--radius-element)',
        padding: '6px 10px',
        marginBottom: 8,
        fontSize: 13,
      }}
    >
      <CollapsibleTrigger
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Run plan · {plan.arm}</span>
        {terminal ? (
          <span style={{ color: 'var(--error-text)', fontWeight: 600, whiteSpace: 'nowrap' }}>
            ended: {terminal.replace(/_/g, ' ')}
          </span>
        ) : (
          <span style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>
            {callsUsed}/{maxCalls} calls
          </span>
        )}
        <span style={{ marginLeft: 'auto', opacity: 0.45, flex: 'none' }}>▾</span>
      </CollapsibleTrigger>
      <CollapsibleContent style={{ paddingTop: 8 }}>
        {terminal && (
          <p style={{ margin: '0 0 8px', color: 'var(--error-text)', fontWeight: 600 }}>
            The run reached its limit ({terminal.replace(/_/g, ' ')}). A limit is not a success —
            the answer above is whatever was finished before it.
          </p>
        )}
        {overridden ? (
          <p style={{ margin: '0 0 8px', opacity: 0.75 }}>
            Arm chosen explicitly — the policy did not choose this run&apos;s arm.
          </p>
        ) : (
          <div style={{ marginBottom: 8 }}>
            <p style={{ margin: '0 0 4px', opacity: 0.65, fontSize: 12 }}>
              Why {plan.arm} — policy v{(sel as { featureVersion: number }).featureVersion ?? '?'} ·
              selection chance{' '}
              {typeof (sel as { propensity: number }).propensity === 'number'
                ? (sel as { propensity: number }).propensity.toFixed(2)
                : '—'}
            </p>
            {top.map(([arm, score]) => (
              <div
                key={arm}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 2,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    width: 120,
                    flex: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    fontWeight: arm === plan.arm ? 600 : 400,
                  }}
                >
                  {arm}
                </span>
                <div
                  style={{
                    flex: '1 1 auto',
                    height: 5,
                    borderRadius: 3,
                    background: 'color-mix(in srgb, currentColor 14%, transparent)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${(Math.abs(score) / topMax) * 100}%`,
                      height: '100%',
                      borderRadius: 3,
                      background: 'currentColor',
                      opacity: arm === plan.arm ? 0.8 : 0.35,
                    }}
                  />
                </div>
                <span
                  style={{
                    flex: 'none',
                    fontSize: 12,
                    fontVariantNumeric: 'tabular-nums',
                    opacity: 0.75,
                  }}
                >
                  {score.toFixed(3)}
                </span>
              </div>
            ))}
            <p style={{ margin: '4px 0 0', opacity: 0.6, fontSize: 12 }}>
              The policy&apos;s judgment about how to work — not the probability the answer is
              right.
            </p>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <BudgetMeter
            label="calls"
            used={callsUsed}
            cap={maxCalls}
            text={`${callsUsed}/${maxCalls}`}
          />
          <BudgetMeter
            label="tokens"
            used={tokensUsed}
            cap={maxTokens}
            text={`${fmtCount(tokensUsed)}/${fmtCount(maxTokens)}`}
          />
          {cost !== undefined && (
            <BudgetMeter
              label="cost"
              used={cost}
              cap={maxCost}
              text={`${fmtCost(cost)}/$${maxCost}`}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Sibling info for the "‹ 1/3 ›" switcher (Chat v2 message branching), from
 * the messages route. Absent (or total < 2) means no switcher. */
export type BranchInfo = {
  /** Zero-based index of this message among its siblings. */
  index: number;
  /** Number of siblings sharing this message's parent. */
  total: number;
  /** Sibling message ids in order, for prev/next switching. */
  siblings: string[];
};

function MessagePartsInner({
  message,
  status,
  conversationId,
  onApproval,
  onGrant,
  onAnswer,
  actionsReady = true,
  onRegenerateMessage,
  onEditMessage,
  onArtifact,
  onRemember,
  showActivity = true,
  isLast = false,
  branch,
  onSwitchBranch,
  onForkMessage,
  feedback,
  onRate,
  memoryById,
  onJumpToMemory,
  onFollowUpSelect,
  queryText,
}: {
  message: UIMessage;
  status: ChatStatus;
  /** For an approval remembered for this conversation only. */
  conversationId?: string;
  onApproval?: RespondToApproval;
  /** Remembers a yes with a scope; see the approval card. */
  onGrant?: GrantHandler;
  onAnswer?: RespondToQuestion;
  /** Whether the run's own working is shown. Off hides the tool cards and the
   * reasoning; it never hides a tool waiting on the owner, because a question
   * nobody can see is a run that never finishes. */
  showActivity?: boolean;
  /** Whether the transcript may be rewritten right now. False while a run is
   * in flight or another message is being edited — both of the actions below
   * rewrite history, and neither is safe mid-run.
   *
   * A boolean rather than an absent handler, because this component is
   * memoised and a value it can compare is worth more than a prop that is
   * sometimes a function and sometimes `undefined`. */
  actionsReady?: boolean;
  /** Answer again, replacing this message and everything after it. Takes the
   * id rather than closing over it, so one function serves every message. */
  onRegenerateMessage?: (messageId: string) => void;
  /** Ask this question differently. Takes the message, for the same reason. */
  onEditMessage?: (message: UIMessage) => void;
  /** Opens a produced page in the side panel. */
  onArtifact?: (files: WorkspaceFiles) => void;
  /** Saves this message to memory. */
  onRemember?: RememberMessage;
  /** The newest message in the transcript — the only one a run can be writing
   * into. Everything above it is finished, whatever the run is doing. */
  isLast?: boolean;
  /** Sibling info for the branch switcher; see BranchInfo above. A scalar
   * object the parent replaces (never mutates), so the memo still holds. */
  branch?: BranchInfo;
  /** Switch to a sibling branch. Takes ids, so one function serves every
   * message — the same stability rule as onRegenerateMessage. */
  onSwitchBranch?: (messageId: string, siblingId: string) => void;
  /** Fork the conversation into a new one from this message. */
  onForkMessage?: (messageId: string) => void;
  /** This owner's thumbs rating for the message, if any. */
  feedback?: FeedbackValue | null;
  /** Rate the message; the parent PUTs it and updates `feedback`. */
  onRate?: (messageId: string, value: FeedbackValue | null) => void;
  /** The person's memory rows, for the inline "used your memory"
   * annotations. Absent is fine — memories simply get the quiet line. */
  memoryById?: Map<string, MemoryForAha>;
  /** One-click jump to a memory row (opens the Memory panel). */
  onJumpToMemory?: (memoryId: string) => void;
  /** A follow-up chip fills the composer as an editable draft. */
  onFollowUpSelect?: (suggestion: string) => void;
  /** The question this answer answers (the nearest preceding user message's
   * text). Research answers restate it as a heading, so the reader sees what
   * was asked without scrolling up. */
  queryText?: string;
}) {
  // Only the message actually being written is animating.
  //
  // This was `status === 'streaming'`, which is a property of the *run*, not of
  // a message — so starting an answer flipped `isAnimating` from false to true
  // on all thirty settled turns at once, and finishing it flipped them back.
  // MessageResponse memoises on `children` and `isAnimating` together, so each
  // flip re-rendered every Streamdown in the transcript and re-ran Shiki over
  // every code block in it. Profiled on a 4x-throttled phone: the TextMate
  // regex engine was 61% of all CPU during one answer.
  const streaming = status === 'streaming' && isLast;
  const settled = !isLast || (status !== 'streaming' && status !== 'submitted');
  // Repeated citations of the same source collapse to one list entry, in
  // first-mention order — the pills and the count below both read from this.
  const sources = useMemo(() => dedupeSources(sourceParts(message)), [message]);
  const answered = message.role === 'assistant' && settled;
  /** A research answer: settled, with sources to show. It reads like a brief
   * — the question restated, the sources as cards, the cited answer — rather
   * than a chat bubble with a sources drawer bolted on. */
  const research = answered && sources.length > 0;
  // Copy, read aloud and answer again all act on the text of an answer. A turn
  // that stopped to ask permission has no text yet, so the row was three
  // controls that would each do nothing, under a card asking a question — and a
  // band of empty space where an answer was expected.
  const hasText = message.parts.some(
    (part) => part.type === 'text' && !!(part as { text?: string }).text?.trim(),
  );
  const asked = message.role === 'user';
  // Both rewrite the transcript from this message on, so both are offered only
  // when nothing else is in flight. Derived here rather than passed in, so the
  // parent hands down one stable function instead of one closure per message.
  const canRegenerate = actionsReady && !!onRegenerateMessage && message.role === 'assistant';
  const canEdit = actionsReady && !!onEditMessage && message.role === 'user';
  // Forking is offered on any settled message: it copies the active path up
  // to and including this message into a new conversation.
  const canFork = actionsReady && !!onForkMessage;
  // The "‹ 1/3 ›" switcher, only when this message actually has siblings and
  // the transcript is settled enough to rewrite.
  const showSwitcher = !!branch && branch.total > 1 && !!onSwitchBranch && actionsReady;
  const switchToSibling = (direction: -1 | 1) => {
    if (!branch || !onSwitchBranch) return;
    const target = branch.siblings[branch.index + direction];
    if (target) onSwitchBranch(message.id, target);
  };
  // Only once the answer has settled: a page assembled from a half-written file
  // would render as a broken preview and then change under the reader.
  //
  // Memoised because it is the most expensive thing on this path: it runs a
  // regex with a lazy `[\s\S]*?` against an anchored terminator over the whole
  // message, which backtracks hard when a fence is unclosed or the language is
  // one it does not match.
  const artifact = useMemo(() => (answered ? messageArtifact(message) : null), [answered, message]);
  /** The artifact's caption: the agent's own first sentence about what it
   * built. The card header already says what kind of thing it is; this says
   * what it does, in the agent's words. */
  const artifactCaption = useMemo(() => {
    if (!artifact) return undefined;
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text?: unknown }).text)
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return undefined;
    const match = text.match(/^.*?[.!?](\s|$)/);
    const first = (match ? match[0] : text).trim();
    return first.length > 140 ? first.slice(0, 140).trimEnd() + '…' : first;
  }, [message, artifact]);
  const hasPlan = message.parts.some((part) => part.type === 'data-plan');

  // Sorted before it is rendered, so the answer, the working and anything
  // still asking the reader are three things instead of one interleaved
  // column. See lib/chat/working.ts for why.
  //
  // All three derive from `message.parts` alone, so they are computed once per
  // message rather than once per render — which, during a stream, is once per
  // commit for every message on screen.
  const { working, summary, rest } = useMemo(() => {
    const groups = groupParts(message.parts);
    // A Set, not `!working.includes(part)`: that was O(parts²) by identity, and
    // a long agent turn carries 30-80 parts.
    const inWorking = new Set(groups.working);
    const completed = groups.working.filter(
      (part) => 'state' in part && part.state === 'output-available',
    );
    const failed = groups.working.filter(
      (part) =>
        'state' in part && (part.state === 'output-error' || part.state === 'output-denied'),
    ).length;
    return {
      working: groups.working,
      summary:
        (describeWorking(completed) || 'Run activity') +
        (failed ? ` · ${failed} failed or declined` : ''),
      // Original order for everything that is not the working: a plan card
      // belongs where the model put it, before the answer it introduces.
      rest: message.parts.filter((part) => !inWorking.has(part)),
    };
  }, [message.parts]);
  const renderPart = (part: (typeof message.parts)[number], index: number) => {
    const key = message.id + '-' + index;

    if (part.type === 'text') {
      // Long settled assistant answers fold behind a disclosure; everything
      // else renders whole.
      if (message.role === 'assistant' && settled)
        return (
          <AnswerPyramid key={key} messageId={message.id} text={part.text} sources={sources} />
        );
      return (
        <CitedText
          key={key}
          messageId={message.id}
          text={part.text}
          sources={sources}
          streaming={streaming}
          settled={false}
        />
      );
    }

    if (part.type === 'reasoning' && !showActivity) return null;

    if (part.type === 'reasoning')
      return (
        <p className="chat-provider-activity" key={key}>
          {part.state === 'streaming'
            ? 'The model is processing the request.'
            : 'The provider reported a completed reasoning step.'}
        </p>
      );

    // isToolUIPart covers both declared tools and dynamic ones, so the
    // two share a branch; only the header needs to distinguish them.
    if (isToolUIPart(part)) {
      // A question is not a tool call the reader needs to audit, it is the
      // run talking to them. Rendered as itself rather than as a row in
      // the activity list, and shown whatever the activity setting says:
      // hiding it would leave the run waiting for an answer to a question
      // nobody could see.
      if (part.type === 'tool-ask_user') {
        const asked = questionFrom(part.input);
        if (asked && part.state === 'input-available')
          return (
            <ClarificationCard
              key={key}
              value={{
                ...asked,
                resolve: (answer) => onAnswer?.({ toolCallId: part.toolCallId, answer }),
              }}
            />
          );
        if (asked && part.state === 'output-available')
          return (
            <p className="chat-answered-question" key={key}>
              <span>{asked.question}</span>
              <strong>{String(part.output ?? '')}</strong>
            </p>
          );
        // Anything else — an unreadable question, a denied or errored call
        // — falls through to the generic row, which says what happened.
      }
      const media = generatedMedia(part.output);
      // Generated pictures and audio are the answer, not the working, so
      // they stay visible however the setting is set. A tool waiting on
      // the owner stays too: hiding the question would strand the run.
      const waiting = part.state === 'approval-requested';
      if (!showActivity && !media.length && !waiting) return null;
      // The run is paused here waiting for an answer, and the answer is the
      // only thing that can move it. Its own block in the transcript — never a
      // Collapsible. The card lived inside the tool's disclosure, opened with
      // `defaultOpen` when the part was waiting; that is read once at mount,
      // and on a live stream the part mounts *before* the approval is asked
      // for, so the card stayed closed and Allow was behind a tap nobody knew
      // to make. See components/chat/approval-card.tsx.
      if (waiting)
        return (
          <ApprovalCard
            key={key}
            part={part}
            conversationId={conversationId}
            onApproval={onApproval}
            onGrant={onGrant}
          />
        );
      // The plan is rendered as its own card from the data part, so the
      // tool's own row would be the same information twice.
      if (part.type === 'tool-update_plan' && hasPlan) return null;
      return (
        <Tool key={key}>
          {part.type === 'dynamic-tool' ? (
            <ToolHeader
              type="dynamic-tool"
              state={part.state}
              toolName={part.toolName}
              title={toolLabel(part)}
            />
          ) : (
            <ToolHeader type={part.type} state={part.state} title={toolLabel(part)} />
          )}
          <ToolContent>
            <ToolInput input={part.input} />
            {/* What was decided, once it has been: the card above handled the
                asking, this is the record of the answer. */}
            <Confirmation approval={part.approval} state={part.state}>
              <ConfirmationAccepted>
                <ConfirmationTitle>You allowed this.</ConfirmationTitle>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <ConfirmationTitle>You declined this.</ConfirmationTitle>
              </ConfirmationRejected>
            </Confirmation>
            {/* A generated picture is the answer, not a description of
                      one, so it is shown rather than printed as the JSON
                      reference the model received. A call that failed produced
                      no media and falls through to the card below, which says
                      what went wrong. */}
            {media.length > 0 ? (
              media.map((entry, position) => (
                <MediaAttachment key={key + '-media-' + position} media={entry} />
              ))
            ) : (
              /* errorText and output are mutually exclusive; the component
                       shows whichever is present, so a failed tool stays visible
                       in the transcript rather than silently missing. */
              <ToolOutput output={part.output} errorText={part.errorText} />
            )}
          </ToolContent>
        </Tool>
      );
    }

    // Rendered once, after the parts loop, so repeated citations of the
    // same source do not each open their own list.
    if (part.type === 'source-url' || part.type === 'source-document') return null;

    // A generated image is the answer, not an attachment note: rendered as
    // the picture itself, with the generation prompt as alt text. (Chat v2
    // /image command — the part carries an /api/media/assets/... URL, and
    // the message metadata carries the prompt and model.)
    if (part.type === 'file') {
      const filePart = part as { mediaType?: string; url?: string };
      if (typeof filePart.mediaType === 'string' && filePart.mediaType.startsWith('image/'))
        return (
          <GeneratedImage
            key={key}
            url={filePart.url ?? ''}
            alt={(message.metadata as { prompt?: string } | undefined)?.prompt}
            model={(message.metadata as { model?: string } | undefined)?.model}
          />
        );
      return (
        <p key={key} className="chat-attachment-note">
          Attached: {part.filename ?? part.mediaType}
        </p>
      );
    }

    if (part.type === 'data-plan') {
      if (!showActivity) return null;
      const steps = (part.data as { steps?: PlanStep[] } | undefined)?.steps ?? [];
      return <TaskPlan key={key} steps={steps} />;
    }

    if (part.type === 'data-compare')
      return <ComparisonLane key={key} view={(part.data ?? {}) as CompareView} />;

    if (part.type === 'data-research')
      return <ResearchCard key={key} view={(part.data ?? {}) as ResearchView} />;

    // Which saved memories the prompt carried. The receipt below the answer
    // reads it; here it would be a line above the answer saying the same.
    if (part.type === 'data-memories') return null;

    // The v5 workflow plan for this run. Rendered as its own inspector card,
    // closed by default: the answer below is what the reader came for. Spend
    // is counted from this message's own parts and metadata — observed, never
    // predicted. Hidden with the rest of the run's activity.
    if (part.type === 'data-workflow') {
      if (!showActivity) return null;
      const plan = (part as { data?: unknown }).data as WorkflowPlanData | undefined;
      const budget = plan?.budget;
      if (!plan || typeof plan.arm !== 'string' || !budget || typeof budget.maxCalls !== 'number')
        return null;
      return (
        <WorkflowPlanCard
          key={key}
          plan={plan}
          callsUsed={message.parts.filter(isToolUIPart).length}
          meta={(message.metadata as AnswerUsage | undefined) ?? {}}
        />
      );
    }

    // A step boundary in a multi-step run. It carries no content of its
    // own; the tool cards around it already show what happened.
    if (part.type === 'step-start') return null;

    return (
      <Collapsible key={key} className="chat-unknown-part">
        <CollapsibleTrigger className="chat-unknown-part-trigger">
          Unrecognised content ({part.type})
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre>{JSON.stringify(part, null, 2)}</pre>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  // A turn that renders to literally nothing.
  //
  // A model can end a turn having only thought — reasoning parts and no text —
  // and reasoning is filed under the working, which is hidden entirely when the
  // owner has activity switched off. The result was a blank space where an
  // answer belongs: no words, no card, nothing to press, reported as "thinking
  // is in a loop, no response". The run records the reason now and streams it,
  // but the transcript still has to account for the turn rather than leave a
  // hole where it was.
  const blank =
    message.role === 'assistant' &&
    settled &&
    !hasText &&
    // Receipts and step boundaries cannot substitute for an actual answer.
    rest.every((part) =>
      [
        'data-memories',
        'step-start',
        'data-plan',
        'data-research',
        'source-url',
        'source-document',
      ].includes(part.type),
    ) &&
    !working.some((part) => isToolUIPart(part) && generatedMedia(part.output).length > 0);

  return (
    <Message from={message.role} className="chat-message">
      <MessageContent>
        {/* A research answer reads like a brief: the question restated up top,
          so the reader sees what was asked without scrolling up. */}
        {research && queryText && <h2 className="chat-research-query">{queryText}</h2>}
        {blank && (
          <p className="chat-blank-turn">
            {working.length
              ? 'The model stopped without writing an answer.'
              : 'This turn produced nothing.'}{' '}
            Answer again, or choose a different model.
            {canRegenerate && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-1"
                onClick={() => onRegenerateMessage?.(message.id)}
              >
                Answer again
              </Button>
            )}
          </p>
        )}
        {/* Research answers get the source strip before the answer instead of
          the collapsible after it: the cards are the first thing a reader
          scans. Everything else keeps the Sources drawer. */}
        {research && <ResearchSourceStrip messageId={message.id} sources={sources} />}
        {showActivity && working.length > 0 && (
          /* The working, as one thing rather than scattered through the
             answer. The header names which sources answered and how many
             steps it took — the question a reader is actually asking when
             they cannot tell where the MCP call happened. Closed by
             default: the answer is what they came for. */
          <Collapsible className="chat-working">
            <CollapsibleTrigger className="chat-working-trigger">
              {summary || 'How this was worked out'}
            </CollapsibleTrigger>
            <CollapsibleContent className="chat-working-body">
              {working.map(renderPart)}
            </CollapsibleContent>
          </Collapsible>
        )}
        {rest.map(renderPart)}

        {!research && sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((part, index) =>
                /* A source-document has no URL, and an <a> without href is not a
                   link: it takes no focus and the keyboard cannot reach it, while
                   still looking like every other citation. Render the ones that
                   can be followed as links and the rest as plain text. Each
                   entry carries the anchor id the inline pill links to. */
                part.type === 'source-url' ? (
                  <a
                    key={message.id + '-source-' + index}
                    id={sourceAnchorId(message.id, index)}
                    href={part.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {part.title ?? part.url}
                  </a>
                ) : (
                  <span
                    key={message.id + '-source-' + index}
                    id={sourceAnchorId(message.id, index)}
                  >
                    {part.title ?? 'Source'}
                  </span>
                ),
              )}
            </SourcesContent>
          </Sources>
        )}

        {artifact && onArtifact && (
          <InlineArtifact files={artifact} caption={artifactCaption} onOpen={onArtifact} />
        )}

        {answered && showActivity && <ChatReceipt message={message} />}

        {/* Inline proof the person's memory worked — under the answer that
          used it. A used memory taught recently earns the aha moment. */}
        {answered && (
          <MemoryAnnotations message={message} memoryById={memoryById} onJump={onJumpToMemory} />
        )}

        {/* Follow-ups that keep the conversation alive, on the newest settled
          answer only. A chip fills the composer as an editable draft — it
          never sends. The set is curated for now; the component takes any
          source, so an LLM-generated set can replace it later. */}
        {answered && isLast && onFollowUpSelect && (
          <FollowUpChips suggestions={FOLLOW_UP_SUGGESTIONS} onSelect={onFollowUpSelect} />
        )}

        {/* A research answer ends with its own one-line follow-up box: typing
          here fills the main composer as an editable draft, same as the chips
          — it never sends directly. */}
        {research && isLast && onFollowUpSelect && (
          <MiniFollowUpComposer onSubmit={onFollowUpSelect} />
        )}

        {answered && hasText && (
          <MessageToolbar>
            <MessageActions>
              <CopyAction message={message} />
              {/* Reads the text parts only, so the tool receipts and reasoning
                  between them are not spoken. Silent about code, which the
                  component replaces with a spoken note rather than reciting. */}
              <ReadAloud text={messageText(message)} />
              {onRemember && <RememberAction message={message} onRemember={onRemember} />}
              {canRegenerate && (
                <MessageAction
                  tooltip="Answer again — this answer is kept as a branch"
                  onClick={() => onRegenerateMessage?.(message.id)}
                >
                  <RefreshCw size={16} />
                </MessageAction>
              )}
              {canFork && (
                <MessageAction
                  tooltip="Fork the conversation from here into a new chat"
                  onClick={() => onForkMessage?.(message.id)}
                >
                  <GitFork size={16} />
                </MessageAction>
              )}
              {onRate && (
                <FeedbackButtons
                  messageId={message.id}
                  value={feedback ?? null}
                  onRate={(value) => onRate(message.id, value)}
                />
              )}
            </MessageActions>
            {showSwitcher && branch && (
              <SiblingSwitcher
                index={branch.index}
                total={branch.total}
                onPrev={() => switchToSibling(-1)}
                onNext={() => switchToSibling(1)}
              />
            )}
          </MessageToolbar>
        )}
      </MessageContent>
      {/* Beside the question, not inside it. As a toolbar within MessageContent
          this added a fourth line to a bubble whose content was one word, so a
          conversation of short questions was mostly empty box. It sits under
          the bubble now, out of the way until wanted: revealed on hover with a
          pointer, always there on a touch screen, where there is no hover to
          reveal it with. */}
      {asked && (hasText || canEdit || onRemember) && (
        <div className="chat-ask-actions">
          {hasText && <CopyAction message={message} />}
          {onRemember && <RememberAction message={message} onRemember={onRemember} />}
          {canEdit && (
            <MessageAction
              tooltip="Edit and ask again — this question is kept as a branch"
              onClick={() => onEditMessage?.(message)}
            >
              <Pencil size={16} />
            </MessageAction>
          )}
          {canFork && (
            <MessageAction
              tooltip="Fork the conversation from here into a new chat"
              onClick={() => onForkMessage?.(message.id)}
            >
              <GitFork size={16} />
            </MessageAction>
          )}
          {showSwitcher && branch && (
            <SiblingSwitcher
              index={branch.index}
              total={branch.total}
              onPrev={() => switchToSibling(-1)}
              onNext={() => switchToSibling(1)}
            />
          )}
        </div>
      )}
    </Message>
  );
}

/**
 * One message, rendered once per change rather than once per streamed chunk.
 *
 * Without this, every chunk of an answer re-rendered every message in the
 * transcript: 30 settled turns, each re-grouping its parts, re-scanning itself
 * for an artifact and re-highlighting its code, a hundred times a second.
 * Measured on a 4x-throttled phone before this landed: one answer cost 49
 * seconds of blocking time, the worst single task 33 seconds.
 *
 * The comparison is deliberately shallow. Every prop above is either a scalar
 * or a function the parent creates once — which is why `onRegenerateMessage`
 * and `onEditMessage` take the message instead of closing over it, and why
 * `actionsReady` is a boolean rather than a handler that is sometimes absent.
 * A settled message's `parts` array keeps its identity across a stream, so a
 * settled message re-renders only when it actually changes.
 */
export const MessageParts = memo(MessagePartsInner);

/** The answer as text, which is what someone copying it wants — not the tool
 * receipts and reasoning that sit between the text parts. */
export function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n\n')
    .trim();
}
