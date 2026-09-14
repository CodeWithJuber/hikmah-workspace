'use client';
/** The chat surface, driven by a run that belongs to the server.
 *
 * The browser owns neither the agent loop nor the run: it posts a message and
 * tails a replayable log. useChat owns the optimistic insert, the streaming
 * reassembly, the status machine and abort, all of which this app previously
 * hand-rolled; the durable transport owns queueing, resuming and cancelling.
 *
 * What that buys, and what the old surface could not do: close the tab
 * mid-answer, come back, and the answer is still being written.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { hasAnsweredQuestion } from '@/lib/runs/resume';
import { useChat } from '@ai-sdk/react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { FileUIPart, LanguageModelUsage } from 'ai';
import { Columns2, Globe, GraduationCap, Paperclip, Telescope, X } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from '@/components/ai-elements/context';
import { cancelRun, createDurableChatTransport } from '@/lib/chat/durable-transport';
// One number for the meter and the run budget; see lib/ai/context.ts.
import { ASSUMED_CONTEXT_TOKENS } from '@/lib/ai/context';
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { LearnTaskDialog } from './learn-task';
import { ModelPicker, type PickerModel } from './model-picker';
import { ConnectModelCard } from './connect-model';
import { allModelsFree } from '@/lib/ai/endpoint';
import { PricingContext } from './pricing-context';
import { VoiceInput } from './voice-controls';
import { ToolsMenu } from './tools-menu';
import { MessageParts, messageText } from './message-parts';
import type { GrantHandler } from './approval-card';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { clientFetch } from '@/lib/client/request';

/** What the run recorded about itself when it finished. Written by the worker
 * onto the answer, so it survives a reload rather than living in this tab. */
type AnswerMetadata = { model?: string; usage?: LanguageModelUsage };

/** How many turns are rendered at once.
 *
 * Every message on screen costs its own markdown render, and a code block in
 * one costs a Shiki tokenisation. Measured over a 30-turn transcript on a
 * 4x-throttled phone, the turns *above the fold* were 7.8s of the 14s a single
 * answer spent blocking the main thread — work done for text nobody was
 * looking at. Forty is comfortably more than fits on any screen, so the window
 * is invisible until a conversation is genuinely long, and the rest is one
 * button away.
 *
 * A plain slice rather than virtualisation: `use-stick-to-bottom` anchors the
 * scroll by measuring the content, and a windowing library that swaps rows
 * under it fights that. A slice does not. */
const WINDOW = 40;

/** What an attachment may be, and how much of it. The composer inlines a file
 * as a data URL rather than uploading it, so these caps are what keeps a
 * message row — and the prompt built from it — a sensible size. */
const ACCEPT = 'image/*,text/*,.md,.markdown,.json,.csv,.pdf';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** The files staged for the next message. Rendered here because the library
 * offers the state and the picker but no list, and a file you cannot see or
 * remove is worse than no attachments at all. */
function StagedAttachments() {
  const attachments = usePromptInputAttachments();
  if (!attachments.files.length) return null;
  return (
    <ul className="chat-attachments">
      {attachments.files.map((file) => (
        <li key={file.id}>
          <Paperclip size={13} aria-hidden="true" />
          <span>{file.filename || file.mediaType || 'Attachment'}</span>
          <button
            type="button"
            aria-label={`Remove ${file.filename || 'attachment'}`}
            onClick={() => attachments.remove(file.id)}
          >
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A context window to measure against when the catalogue does not name one.
 * Deliberately modest: over-stating it would make a full conversation look
 * roomy right up to the point the provider rejects it. */
/**
 * Should the turn be sent back on its own, because the owner has finished
 * answering whatever the run stopped on?
 *
 * The question half is `hasAnsweredQuestion` — the same function the route uses
 * to decide whether to resume, deliberately rather than a second copy of the
 * rule: if the two ever disagreed, this would send a turn the server then
 * refused, and the run would sit paused with the owner's answer already given.
 *
 * The SDK's `lastAssistantMessageIsCompleteWithToolCalls` is not used here. It
 * fires whenever the last step ends in a completed tool call, which an ordinary
 * server-side tool does all the time, and would re-send turns the server had
 * already finished.
 */
function pausedTurnIsAnswered({ messages }: { messages: UIMessage[] }): boolean {
  if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages })) return true;
  const last = messages.at(-1);
  return last?.role === 'assistant' && hasAnsweredQuestion(last);
}

export type ChatViewProps = {
  /** Stable id so a reload re-attaches to the same conversation. */
  id: string;
  /** Everything the server needs to pick a model; the key never comes from here. */
  run: {
    baseUrl: string;
    model: string;
    freeOnly: boolean;
    apiKeySecret?: string;
    instructions: string;
    maxSteps?: number;
    /** How much earlier conversation travels with each turn. */
    contextCharacters?: number;
    /** The chosen model's window in tokens, when the provider publishes one.
     *
     * Part of the run rather than a prop of its own: the server budgets history
     * against it, and the meter below reads the same value, so the figure shown
     * and the figure enforced are one number. */
    contextWindow?: number;
    disabledTools?: string[];
    /** An agent's allowlist over the built-in tools. */
    enabledTools?: string[];
  };
  /** The stored transcript, loaded before this mounts. useChat captures it when
   * the conversation is created, so it cannot be supplied later. */
  initialMessages?: UIMessage[];
  /** Why the last run for this conversation failed, from the stored row.
   *
   * A live failure arrives through useChat; this is the one that already
   * happened, which useChat cannot know about because it only tails a run it
   * considers active. Cleared as soon as anything is sent, so a retry does not
   * argue with its own result. */
  initialError?: string;
  /** Called when a run settles, so a conversation list can catch up. */
  onSettled?: () => void;
  /** Shown when the conversation is empty. */
  empty?: React.ReactNode;
  /** Offered on an empty conversation. Sent as written rather than dropped in
   * the composer: a starter is a question someone already decided to ask. */
  starters?: string[];
  /** The models the provider offers, with what the catalogue says about each.
   * Empty while it loads, or when the provider publishes none. */
  models?: PickerModel[];
  /** The catalogue is still being fetched. */
  modelsLoading?: boolean;
  /** Why the catalogue could not be fetched, in words, or ''. */
  modelsError?: string;
  /** Applies from the next turn, which is why it is not part of `run`: an
   * answer already written was written by the model that wrote it. */
  onModel?: (model: string) => void;
  /** Whether the transcript shows the run's own working. */
  showActivity?: boolean;
  /** Changing which tools the run may use. Absent leaves the menu out. */
  onTools?: (disabledTools: string[]) => Promise<void> | void;
  /** Opens a page an answer produced, in the side panel. */
  onArtifact?: (files: WorkspaceFiles) => void;
  /** Shown above the transcript: a background task says what it is. */
  banner?: React.ReactNode;
  /** Nothing would pay for a message: the empty state asks for a key instead
   * of offering starters that would fail. */
  needsKey?: boolean;
  /** Opens the Settings tab. */
  onOpenSettings?: () => void;
  /** Remembers a yes from the approval card, with its scope. */
  onGrant?: GrantHandler;
};

export function ChatView({
  id,
  run,
  initialMessages,
  initialError,
  onSettled,
  empty,
  starters,
  models,
  modelsLoading = false,
  modelsError = '',
  onModel,
  showActivity = true,
  onTools,
  onArtifact,
  banner,
  needsKey = false,
  onGrant,
  onOpenSettings,
}: ChatViewProps) {
  // A lazy initial state rather than useMemo: this must be created exactly
  // once, and useMemo is a cache React is free to discard, not a guarantee.
  //
  // The transport holds the live configuration and the run in flight, rather
  // than this component holding them: useChat captures the transport into its
  // Chat instance on first render and only replaces it when the conversation id
  // changes, so anything the view kept would never reach the instance actually
  // sending the requests.
  const [transport] = useState(() => createDurableChatTransport({ config: run }));
  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({
    id,
    transport,
    messages: initialMessages,
    // One commit per frame rather than one per chunk.
    //
    // Unthrottled, every `UIMessageChunk` produced a new messages array and a
    // full React commit — measured at 28,000 DOM mutations and 49s of blocking
    // time for a single answer on a 4x-throttled phone. A provider streaming at
    // 100 chunks/s cannot be rendered 100 times a second on a phone, and a
    // reader cannot see it either. 50ms is under the ~16ms-per-frame budget's
    // notice and divides the commits by roughly the chunk rate.
    throttle: 50,
    // Rejoin an answer that was still being written when this tab last left.
    resume: true,
    // A tool that needs the owner's say-so pauses the run mid-step. Once every
    // pending request on the last message has an answer, the turn is sent back
    // automatically; without this the owner would answer the card and then
    // have to nudge the conversation by hand for anything to happen.
    sendAutomaticallyWhen: pausedTurnIsAnswered,
  });

  // Compare answers the same question a second time with no tools, to show what
  // the agent's machinery is actually buying. Held here rather than in the run
  // configuration because it is a per-turn choice, not a setting.
  const [compare, setCompare] = useState(false);
  // Deep research, per turn for the same reason — and because on a free key a
  // fan-out of lanes can be most of the day's request allowance in one go.
  const [deepResearch, setDeepResearch] = useState(false);
  // Search the web for this message, whatever the conversation's tool switches
  // say. Per turn: a person asks for a search about one question, not about
  // every question after it.
  const [webSearch, setWebSearch] = useState(false);
  // The "learn this in the background" dialog. Opened from the `+` menu and
  // rendered outside it, because a menu unmounts its content when it closes.
  const [learning, setLearning] = useState(false);
  // The stored failure is shown until this conversation does something else.
  // Reset during render rather than in an effect, because an effect would show
  // the previous conversation's failure for one frame after switching.
  const [staleFor, setStaleFor] = useState(id);
  const [retried, setRetried] = useState(false);
  // Earlier turns, once asked for. Reset with the conversation: opening a
  // different chat should start at its end, not wherever the last one was
  // expanded to.
  const [showEarlier, setShowEarlier] = useState(false);
  if (staleFor !== id) {
    setStaleFor(id);
    setRetried(false);
    setShowEarlier(false);
  }
  useEffect(() => {
    transport.setConfig({ ...run, compare: compare ? {} : undefined, deepResearch, webSearch });
  }, [transport, run, compare, deepResearch, webSearch]);

  // Remember, by hand: your own message is saved as your words; an answer is
  // filed as the model's inference and waits for review. The route names the
  // memory after this conversation and decides the status from the provenance,
  // so the button cannot claim more trust for a line than its origin earns.
  const remember = useCallback(
    async (message: UIMessage): Promise<'saved' | 'suggested' | null> => {
      const content = messageText(message);
      if (!content) return null;
      try {
        const response = await clientFetch('/api/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            kind: 'reference',
            provenance: message.role === 'user' ? 'quote' : 'inference',
            sourceConversationId: id,
          }),
        });
        if (!response.ok) return null;
        const payload = (await response.json().catch(() => ({}))) as {
          memory?: { status?: string };
        };
        return payload.memory?.status === 'saved'
          ? 'saved'
          : payload.memory?.status === 'suggested'
            ? 'suggested'
            : null;
      } catch {
        return null;
      }
    },
    [id],
  );

  // What is actually rendered. The newest turns always are; the rest are behind
  // one button. `hidden` is how many that button is offering.
  const hidden = showEarlier ? 0 : Math.max(0, messages.length - WINDOW);
  const visible = hidden ? messages.slice(hidden) : messages;

  const busy = status === 'submitted' || status === 'streaming';
  // Whether any of the answer has actually arrived. Once it has, the words are
  // the progress indicator and a label beside them is noise.
  const streamingText =
    messages.at(-1)?.role === 'assistant' &&
    (messages.at(-1)?.parts ?? []).some(
      (part) => part.type === 'text' && !!(part as { text?: string }).text?.trim(),
    );

  // The most recent answer's own figures. Earlier turns each carry their own,
  // but the composer is about the next message, so the latest is the one that
  // says how much room is left.
  const latest = messages.findLast((message) => message.role === 'assistant');
  const spent = (latest?.metadata as AnswerMetadata | undefined) ?? undefined;
  // Three fifths of the window is where trimming the oldest turns starts to be
  // a real possibility rather than a theoretical one, so it is where the figure
  // starts being information rather than decoration.
  const crowded =
    (spent?.usage?.totalTokens ?? 0) > (run.contextWindow || ASSUMED_CONTEXT_TOKENS) * 0.6;

  // Report the edge, not the state: firing on every render while idle would
  // refetch the conversation list forever.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) onSettled?.();
    wasBusy.current = busy;
  }, [busy, onSettled]);

  // Two halves, and both are needed: stop() ends this tab's stream, and the
  // cancel aborts the provider call the worker is still driving. Without the
  // second, the run would finish into the log with nobody watching.
  const halt = useCallback(() => {
    const runId = transport.activeRun();
    void stop();
    if (runId) void cancelRun(runId);
  }, [transport, stop]);

  // Dictation writes straight into the textarea rather than through
  // PromptInputProvider. The provider would lift the attachment state out of
  // PromptInput too, and its own `add` applies none of the accept, count or
  // size limits the local one does — so wrapping for the sake of the text would
  // quietly drop the caps on the files. The textarea is uncontrolled and its
  // value is read from the form on submit, so writing to it is enough.
  const composer = useRef<HTMLTextAreaElement>(null);
  const dictate = useCallback((text: string) => {
    const field = composer.current;
    if (!field) return;
    field.value = field.value ? field.value.trimEnd() + ' ' + text : text;
    field.focus();
  }, []);

  // The question being rewritten, if any. Sending while this is set replaces
  // that message rather than adding one, and the server truncates the turns it
  // started — so the conversation reads as though it had been asked that way.
  const [editing, setEditing] = useState<string | null>(null);
  const beginEdit = useCallback((message: UIMessage) => {
    const field = composer.current;
    if (!field) return;
    field.value = messageText(message);
    field.focus();
    // The caret goes to the end, because the common edit is adding to a
    // question rather than replacing it.
    field.setSelectionRange(field.value.length, field.value.length);
    setEditing(message.id);
  }, []);
  const cancelEdit = useCallback(() => {
    setEditing(null);
    if (composer.current) composer.current.value = '';
  }, []);

  // The three handlers the transcript needs, each created once.
  //
  // They used to be arrows built inside `messages.map`, so every message got a
  // new function on every render and `React.memo` on MessageParts could never
  // hit. Taking the message as an argument is what makes them stable.
  const answerQuestion = useCallback(
    ({ toolCallId, answer }: { toolCallId: string; answer: string }) =>
      // The answer is written into the message as the tool's output, which is
      // what the run resumes from. The tool name has to match the call:
      // addToolOutput routes by it.
      addToolOutput({ tool: 'ask_user', toolCallId, output: answer }),
    [addToolOutput],
  );
  const regenerateMessage = useCallback(
    (messageId: string) => void regenerate({ messageId }),
    [regenerate],
  );

  const submit = useCallback(
    ({ text, files }: { text?: string; files?: FileUIPart[] }) => {
      const trimmed = (text ?? '').trim();
      // A file on its own is a message: "look at this" is a complete request.
      if ((!trimmed && !files?.length) || busy) return;
      // Whatever failed before, this turn supersedes it.
      setRetried(true);

      if (editing) {
        setEditing(null);
        // Rewrite the stored message, then replay it. setMessages assigns
        // straight onto the chat instance that regenerate reads, so the edit is
        // in place by the time the request is built — no waiting for a render.
        //
        // Only the text is replaced. Attachments on the original are file parts
        // carrying data URLs, and re-staging them into the composer would mean
        // rebuilding files nobody re-picked; leaving them attached is what the
        // owner meant by editing the words.
        setMessages(
          messages.map((message) =>
            message.id === editing
              ? {
                  ...message,
                  parts: [
                    { type: 'text' as const, text: trimmed },
                    ...message.parts.filter((part) => part.type !== 'text'),
                  ],
                }
              : message,
          ),
        );
        void regenerate({ messageId: editing });
        if (composer.current) composer.current.value = '';
        return;
      }

      void sendMessage({ text: trimmed, files });
    },
    [busy, editing, messages, regenerate, sendMessage, setMessages],
  );

  // What each model costs, for the receipt under every answer.
  const pricing = useMemo(
    () => new Map((models ?? []).map((model) => [model.id, model])),
    [models],
  );

  return (
    <PricingContext.Provider value={pricing}>
      <div className="chat-view">
        {banner}
        <Conversation>
          <ConversationContent>
            {messages.length === 0 && (
              <div className="chat-welcome">
                {empty}
                {needsKey && onOpenSettings ? (
                  <ConnectModelCard onOpenSettings={onOpenSettings} />
                ) : null}
                {!needsKey && !!starters?.length && (
                  <div className="chat-starters">
                    {starters.map((prompt) => (
                      <button key={prompt} type="button" onClick={() => submit({ text: prompt })}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {hidden > 0 && (
              <button type="button" className="chat-earlier" onClick={() => setShowEarlier(true)}>
                Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
              </button>
            )}
            {visible.map((message, index) => (
              <MessageParts
                key={message.id}
                message={message}
                status={status}
                // Only the newest message can be the one being written. The
                // slice keeps the end of the conversation, so its last entry is
                // the transcript's last entry either way.
                isLast={index === visible.length - 1}
                onApproval={addToolApprovalResponse}
                conversationId={id}
                onGrant={onGrant}
                // Every handler below is stable across renders, and that is the
                // point: MessageParts is memoised, and a fresh arrow per message
                // per render would defeat it entirely — which is what the three
                // inline closures here used to do. They take the message (or its
                // id) instead of closing over it.
                onAnswer={answerQuestion}
                showActivity={showActivity}
                onArtifact={onArtifact}
                onRemember={remember}
                // Offered on every settled answer, not just the last: the server
                // truncates from the message being replayed, so an earlier one
                // rewinds the conversation to that point rather than corrupting
                // it. The tooltip says so, because it is not reversible.
                //
                // A boolean rather than an absent handler: `undefined` when busy
                // was a prop that changed identity on every status change, and a
                // memoised child needs a value it can compare.
                actionsReady={!busy && !editing}
                onRegenerateMessage={regenerateMessage}
                onEditMessage={beginEdit}
              />
            ))}
            {/* Something on the screen while the work happens.
              A screen reader was told by the live region below, and a sighted
              person was told by a spinner inside the send button and nothing
              else — so a turn that took a while, or a tool that took a while
              before writing a word, looked like nothing had happened. It
              disappears the moment real text arrives, because the answer is a
              better indicator than any label. */}
            {busy && !streamingText && (
              <div className="chat-thinking" role="status">
                <span className="chat-thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{status === 'submitted' ? 'Sending…' : 'Working on it…'}</span>
              </div>
            )}
            {/* The answer region is announced while a run is in progress, so a
              screen reader learns that work is happening and when it lands. */}
            <div aria-live="polite" className="sr-only">
              {busy ? 'Working on your request.' : ''}
            </div>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {/* The live failure first; the stored one only while nothing has been
          sent since, so pressing Try again cannot leave the old reason sitting
          under the new answer. */}
        {(error || (initialError && !retried)) && (
          <div className="chat-error" role="alert">
            <p>{error ? error.message : initialError}</p>
            {/* A run paused on a card this tab has lost track of — answered
                once and refused, or answered from another tab — is put right by
                reloading, which shows the card again from the stored turn.
                Try again would re-send into the same refusal. */}
            {/waiting for you|Reload the conversation/.test(
              error ? error.message : (initialError ?? ''),
            ) ? (
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            ) : /No API key/.test(error ? error.message : (initialError ?? '')) &&
              onOpenSettings ? (
              // The fix is a key, not a retry: open where it goes.
              <button type="button" onClick={onOpenSettings}>
                Add a key
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRetried(true);
                  void regenerate();
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}

        <PromptInput
          onSubmit={submit}
          accept={ACCEPT}
          multiple
          globalDrop
          maxFiles={MAX_FILES}
          maxFileSize={MAX_FILE_BYTES}
        >
          <PromptInputBody>
            {editing && (
              <p className="chat-editing" role="status">
                Editing an earlier question. Sending replaces it, and every reply after it.
                <button type="button" onClick={cancelEdit}>
                  Cancel
                </button>
              </p>
            )}
            <StagedAttachments />
            <PromptInputTextarea
              ref={composer}
              // The transcript sets dir="auto" on every rendered message and the
              // composer never did, so typing Urdu or Arabic stayed left-aligned
              // with the caret and the punctuation on the wrong side — the one
              // place in the app where the owner writes rather than reads.
              dir="auto"
              placeholder={
                editing ? 'Rewrite your question…' : 'Ask anything, or describe what to build.'
              }
            />
          </PromptInputBody>
          <PromptInputFooter className="chat-composer-row">
            <PromptInputTools className="chat-composer-tools">
              <PromptInputActionMenu>
                {/* An icon-only trigger with no name at all: a screen reader
                    announced "button" and nothing else, and there was no
                    tooltip on a pointer either. */}
                <PromptInputActionMenuTrigger
                  aria-label="Attach a file, and more for this message"
                  title="Attach a file, and more"
                />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                  {/* Comparing two answers is an expert's question about the
                    product, asked once and then rarely. It was a labelled
                    checkbox on the main row, permanently occupying width that
                    the model name needed, in front of everyone who only wanted
                    to type a message. */}
                  <DropdownMenuCheckboxItem
                    checked={compare}
                    onCheckedChange={setCompare}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <Columns2 className="mr-2 size-4" aria-hidden="true" />
                    Also answer without tools
                  </DropdownMenuCheckboxItem>
                  {/* A task is handed off, not sent: it becomes its own
                    conversation and this one stays free to type in. */}
                  <DropdownMenuItem onSelect={() => setLearning(true)}>
                    <GraduationCap className="mr-2 size-4" aria-hidden="true" />
                    Learn this in the background…
                  </DropdownMenuItem>
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <VoiceInput disabled={busy} onText={dictate} />
              {/* The two ways a question changes shape, on the row where it is
                typed. "Research deeply" was a checkbox inside the `+` menu,
                which is where nobody looking for "search the web" looks, and
                there was no plain search switch at all: the model searched when
                it felt like it. Both are per turn and show their state here. */}
              <Toggle
                pressed={webSearch}
                onPressedChange={setWebSearch}
                className="chat-turn-toggle"
                aria-label="Search the web for this message"
                title="Search the web for this message"
              >
                <Globe size={16} aria-hidden="true" />
                <span className="chat-turn-label">Search</span>
              </Toggle>
              {/* Sub-agents fanned out over the question, each reading its own
                sources. A choice for a question, not a setting. */}
              <Toggle
                pressed={deepResearch}
                onPressedChange={setDeepResearch}
                className="chat-turn-toggle"
                aria-label="Research deeply: sub-agents read sources in parallel"
                title="Research deeply: sub-agents read sources in parallel"
              >
                <Telescope size={16} aria-hidden="true" />
                <span className="chat-turn-label">Research</span>
              </Toggle>
              {/* The model before the tools: on a phone the row wraps after
                Research, and the second line then reads model first, which is
                the thing people change; the tool count is the detail. */}
              {onModel && (
                <ModelPicker
                  models={models ?? []}
                  value={run.model}
                  onSelect={onModel}
                  loading={modelsLoading}
                  error={modelsError}
                  className="chat-model-select"
                  local={allModelsFree(run.baseUrl)}
                />
              )}
              {onTools && (
                <ToolsMenu disabled={run.disabledTools ?? []} onChange={onTools} busy={busy} />
              )}
            </PromptInputTools>
            {/* The meter is a diagnostic, and it was on screen permanently: a bare
              percentage beside a spinner, meaning nothing to most people, taking
              room on the row the send button needed. Every answer already
              carries its own token count in its receipt, so this is only worth
              showing once the window is actually filling up and the next message
              is at risk of losing the beginning of the conversation. */}
            {spent?.usage && crowded && (
              <Context
                maxTokens={run.contextWindow || ASSUMED_CONTEXT_TOKENS}
                modelId={spent.model ?? run.model}
                usage={spent.usage}
                usedTokens={spent.usage.totalTokens ?? 0}
              >
                <ContextTrigger />
                <ContextContent>
                  <ContextContentHeader />
                  <ContextContentBody>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                  <ContextContentFooter />
                </ContextContent>
              </Context>
            )}
            {/* Doubles as Stop while a run is in flight.
              After a failure the button is passed 'ready', not 'error': the
              component renders an ✕ for an errored chat, and on a phone that
              read as "stop" or "blocked" on a button that in fact sends —
              reported as "beech me stuck". The card above already says what
              went wrong; a button you can press should look like one. */}
            <PromptInputSubmit
              status={status === 'error' ? 'ready' : status}
              onClick={busy ? halt : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
        <LearnTaskDialog
          open={learning}
          onOpenChange={setLearning}
          run={run as unknown as Record<string, unknown>}
          onStarted={onSettled}
        />
      </div>
    </PricingContext.Provider>
  );
}
