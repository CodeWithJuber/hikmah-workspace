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
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Copy, Pencil, RefreshCw } from 'lucide-react';
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { ReadAloud } from './voice-controls';

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/** Answers one paused tool call. Resolved by the chat view, which owns useChat. */
export type RespondToApproval = (response: { id: string; approved: boolean }) => void;

/** What the owner is being asked to allow, in their words rather than JSON.
 *
 * Tools that ask for approval carry a `description` written for a person; it is
 * the whole point of that field. Falling back to the raw input keeps the card
 * honest when a tool does not supply one — an empty card would be a prompt to
 * approve something unstated. */
function approvalSummary(part: { input?: unknown }): string {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const described = typeof input.description === 'string' ? input.description.trim() : '';
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (described && command) return `${described}\n\n${command}`;
  if (described) return described;
  if (command) return command;
  return JSON.stringify(part.input ?? {}, null, 2);
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
            caption this needs. preload="none" so a transcript with several of
            these does not fetch them all on open. */}
        <audio controls src={media.url} preload="none" />
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
        <strong>Without tools</strong>
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
      {running && <p className="chat-compare-note">Answering…</p>}
      {view.status === 'failed' && (
        <p className="chat-compare-note" role="alert">
          {view.error ?? 'The comparison did not finish.'}
        </p>
      )}
      {view.status === 'cancelled' && <p className="chat-compare-note">Stopped.</p>}
    </section>
  );
}

/** Sources are collected across the message so citations render as one list. */
function sourceParts(message: UIMessage) {
  return message.parts.filter(
    (part) => part.type === 'source-url' || part.type === 'source-document',
  );
}

export function MessageParts({
  message,
  status,
  onApproval,
  onRegenerate,
  onEdit,
}: {
  message: UIMessage;
  status: ChatStatus;
  onApproval?: RespondToApproval;
  /** Offered on the answer it would replace. Absent while a run is in flight. */
  onRegenerate?: () => void;
  /** Offered on a question worth asking differently. Absent while a run is in
   * flight, for the same reason regenerate is: both rewrite the transcript. */
  onEdit?: () => void;
}) {
  const streaming = status === 'streaming';
  const sources = sourceParts(message);
  const settled = status !== 'streaming' && status !== 'submitted';
  const answered = message.role === 'assistant' && settled;
  const asked = message.role === 'user' && settled;

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => {
          const key = message.id + '-' + index;

          if (part.type === 'text')
            return (
              <MessageResponse key={key} isAnimating={streaming} dir="auto">
                {part.text}
              </MessageResponse>
            );

          if (part.type === 'reasoning')
            return (
              <Reasoning key={key} isStreaming={part.state === 'streaming'}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );

          // isToolUIPart covers both declared tools and dynamic ones, so the
          // two share a branch; only the header needs to distinguish them.
          if (isToolUIPart(part)) {
            const media = generatedMedia(part.output);
            return (
              <Tool key={key}>
                {part.type === 'dynamic-tool' ? (
                  <ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} />
                ) : (
                  <ToolHeader type={part.type} state={part.state} />
                )}
                <ToolContent>
                  <ToolInput input={part.input} />
                  {/* The run is paused here waiting for an answer. Without this
                      card the tool sits on "Awaiting Approval" forever, because
                      nothing else can send the response. */}
                  <Confirmation approval={part.approval} state={part.state}>
                    <ConfirmationRequest>
                      <ConfirmationTitle>{approvalSummary(part)}</ConfirmationTitle>
                    </ConfirmationRequest>
                    <ConfirmationAccepted>
                      <ConfirmationTitle>You allowed this.</ConfirmationTitle>
                    </ConfirmationAccepted>
                    <ConfirmationRejected>
                      <ConfirmationTitle>You declined this.</ConfirmationTitle>
                    </ConfirmationRejected>
                    <ConfirmationActions>
                      <ConfirmationAction
                        variant="outline"
                        onClick={() =>
                          part.approval && onApproval?.({ id: part.approval.id, approved: false })
                        }
                      >
                        Don&rsquo;t allow
                      </ConfirmationAction>
                      <ConfirmationAction
                        onClick={() =>
                          part.approval && onApproval?.({ id: part.approval.id, approved: true })
                        }
                      >
                        Allow
                      </ConfirmationAction>
                    </ConfirmationActions>
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

          if (part.type === 'file')
            return (
              <p key={key} className="chat-attachment-note">
                Attached: {part.filename ?? part.mediaType}
              </p>
            );

          if (part.type === 'data-compare')
            return <ComparisonLane key={key} view={(part.data ?? {}) as CompareView} />;

          // A step boundary in a multi-step run. It carries no content of its
          // own; the tool cards around it already show what happened.
          if (part.type === 'step-start') return null;

          return (
            <details key={key} className="chat-unknown-part">
              <summary>Unrecognised content ({part.type})</summary>
              <pre>{JSON.stringify(part, null, 2)}</pre>
            </details>
          );
        })}

        {sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((part, index) => (
                <a
                  key={message.id + '-source-' + index}
                  href={part.type === 'source-url' ? part.url : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {part.title ?? (part.type === 'source-url' ? part.url : 'Source')}
                </a>
              ))}
            </SourcesContent>
          </Sources>
        )}

        {answered && (
          <MessageToolbar>
            <MessageActions>
              <MessageAction
                tooltip="Copy answer"
                onClick={() => void copyMessage(message)}
                disabled={!messageText(message)}
              >
                <Copy size={15} />
              </MessageAction>
              {/* Reads the text parts only, so the tool receipts and reasoning
                  between them are not spoken. Silent about code, which the
                  component replaces with a spoken note rather than reciting. */}
              <ReadAloud text={messageText(message)} />
              {onRegenerate && (
                <MessageAction
                  tooltip="Answer again, replacing everything after this"
                  onClick={onRegenerate}
                >
                  <RefreshCw size={15} />
                </MessageAction>
              )}
            </MessageActions>
          </MessageToolbar>
        )}

        {asked && onEdit && (
          <MessageToolbar>
            <MessageActions>
              <MessageAction
                tooltip="Edit and ask again, replacing everything after this"
                onClick={onEdit}
              >
                <Pencil size={15} />
              </MessageAction>
            </MessageActions>
          </MessageToolbar>
        )}
      </MessageContent>
    </Message>
  );
}

/** The answer as text, which is what someone copying it wants — not the tool
 * receipts and reasoning that sit between the text parts. */
export function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n\n')
    .trim();
}

async function copyMessage(message: UIMessage): Promise<void> {
  const text = messageText(message);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Denied clipboard permission is the owner's decision, not an error to
    // interrupt them with.
  }
}
