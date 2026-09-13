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
import { useCallback, useEffect, useRef, useState } from 'react';
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { FileUIPart, LanguageModelUsage } from 'ai';
import { Paperclip, X } from 'lucide-react';
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
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { LearnTaskDialog } from './learn-task';
import { VoiceInput } from './voice-controls';
import { ToolsMenu } from './tools-menu';
import { MessageParts, messageText } from './message-parts';
import type { WorkspaceFiles } from '@/lib/playground/session';

/** What the run recorded about itself when it finished. Written by the worker
 * onto the answer, so it survives a reload rather than living in this tab. */
type AnswerMetadata = { model?: string; usage?: LanguageModelUsage };

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
  /** The models the provider offers. Empty while the catalog is loading, or
   * when the provider does not publish one. */
  models?: { id: string; label: string }[];
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
  onModel,
  showActivity = true,
  onTools,
  onArtifact,
  banner,
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
  // The "learn this in the background" dialog. Opened from the `+` menu and
  // rendered outside it, because a menu unmounts its content when it closes.
  const [learning, setLearning] = useState(false);
  // The stored failure is shown until this conversation does something else.
  // Reset during render rather than in an effect, because an effect would show
  // the previous conversation's failure for one frame after switching.
  const [staleFor, setStaleFor] = useState(id);
  const [retried, setRetried] = useState(false);
  if (staleFor !== id) {
    setStaleFor(id);
    setRetried(false);
  }
  useEffect(() => {
    transport.setConfig({ ...run, compare: compare ? {} : undefined, deepResearch });
  }, [transport, run, compare, deepResearch]);

  // Remember, by hand: your own message is saved as your words; an answer is
  // filed as the model's inference and waits for review. The route names the
  // memory after this conversation and decides the status from the provenance,
  // so the button cannot claim more trust for a line than its origin earns.
  const remember = useCallback(
    async (message: UIMessage): Promise<'saved' | 'suggested' | null> => {
      const content = messageText(message);
      if (!content) return null;
      try {
        const response = await fetch('/api/memory', {
          method: 'POST',
          credentials: 'same-origin',
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

  return (
    <div className="chat-view">
      {banner}
      <Conversation>
        <ConversationContent>
          {messages.length === 0 && (
            <div className="chat-welcome">
              {empty}
              {!!starters?.length && (
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
          {messages.map((message, index) => (
            <MessageParts
              key={message.id}
              message={message}
              status={status}
              onApproval={addToolApprovalResponse}
              // The answer is written into the message as the tool's output,
              // which is what the run resumes from. The tool name has to match
              // the call: addToolOutput routes by it.
              onQuestion={({ toolCallId, answer }) =>
                addToolOutput({ tool: 'ask_user', toolCallId, output: answer })
              }
              showActivity={showActivity}
              onArtifact={onArtifact}
              onRemember={remember}
              // Offered on every settled answer, not just the last: the server
              // truncates from the message being replayed, so an earlier one
              // rewinds the conversation to that point rather than corrupting
              // it. The tooltip says so, because it is not reversible.
              onRegenerate={
                !busy && !editing && message.role === 'assistant'
                  ? () => void regenerate({ messageId: message.id })
                  : undefined
              }
              onEdit={
                !busy && !editing && message.role === 'user' ? () => beginEdit(message) : undefined
              }
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
          <button
            type="button"
            onClick={() => {
              setRetried(true);
              void regenerate();
            }}
          >
            Try again
          </button>
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
              <PromptInputActionMenuTrigger />
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
                  Also answer without tools
                </DropdownMenuCheckboxItem>
                {/* Sub-agents fanned out over the question, each reading its
                    own sources. A choice for a question, not a setting. */}
                <DropdownMenuCheckboxItem
                  checked={deepResearch}
                  onCheckedChange={setDeepResearch}
                  onSelect={(event) => event.preventDefault()}
                >
                  Research deeply
                </DropdownMenuCheckboxItem>
                {/* A task is handed off, not sent: it becomes its own
                    conversation and this one stays free to type in. */}
                <DropdownMenuItem onSelect={() => setLearning(true)}>
                  Learn this in the background…
                </DropdownMenuItem>
                {/* The model, on a phone.
                    At 360px the composer row has about 320px and the four
                    controls beside it take 166 — so a name like "Free Models
                    Router" had roughly 60px to render in, which is not a
                    choice between layouts but an impossibility. Here it has the
                    width to be read. The select below is the same choice for a
                    window with room for it; exactly one of the two is ever
                    displayed, which is why both exist. */}
                {!!models?.length && onModel && (
                  <div className="chat-model-menu">
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Model</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={run.model} onValueChange={onModel}>
                      {models.map((model) => (
                        <DropdownMenuRadioItem key={model.id} value={model.id}>
                          {model.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </div>
                )}
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <VoiceInput disabled={busy} onText={dictate} />
            {onTools && (
              <ToolsMenu disabled={run.disabledTools ?? []} onChange={onTools} busy={busy} />
            )}
            {!!models?.length && (
              <PromptInputSelect value={run.model} onValueChange={onModel}>
                <PromptInputSelectTrigger className="chat-model-select">
                  <PromptInputSelectValue placeholder={run.model} />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {models.map((model) => (
                    <PromptInputSelectItem key={model.id} value={model.id}>
                      {model.label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
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
  );
}
