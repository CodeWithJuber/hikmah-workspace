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

const ASSUMED_CONTEXT = 32_000;

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
  /** The chosen model's context window, when the provider publishes one. */
  contextWindow?: number;
  /** Whether the transcript shows the run's own working. */
  showActivity?: boolean;
  /** Changing which tools the run may use. Absent leaves the menu out. */
  onTools?: (disabledTools: string[]) => Promise<void> | void;
  /** Opens a page an answer produced, in the side panel. */
  onArtifact?: (files: WorkspaceFiles) => void;
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
  contextWindow,
  showActivity = true,
  onTools,
  onArtifact,
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
    transport.setConfig({ ...run, compare: compare ? {} : undefined });
  }, [transport, run, compare]);

  const busy = status === 'submitted' || status === 'streaming';

  // The most recent answer's own figures. Earlier turns each carry their own,
  // but the composer is about the next message, so the latest is the one that
  // says how much room is left.
  const latest = messages.findLast((message) => message.role === 'assistant');
  const spent = (latest?.metadata as AnswerMetadata | undefined) ?? undefined;

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
            placeholder={
              editing ? 'Rewrite your question…' : 'Ask anything, or describe what to build.'
            }
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
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
            {/* "Compare without tools" wrapped onto three lines on a phone and
                crowded the send button off the row. The full meaning is in the
                tooltip, which costs no width. */}
            <label
              className="chat-compare-toggle"
              title="Answer a second time with no tools, to show what the tools are buying"
            >
              <input
                type="checkbox"
                checked={compare}
                onChange={(event) => setCompare(event.target.checked)}
              />
              Compare
            </label>
          </PromptInputTools>
          {spent?.usage && (
            <Context
              maxTokens={contextWindow || ASSUMED_CONTEXT}
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
          {/* Doubles as Stop while a run is in flight. */}
          <PromptInputSubmit status={status} onClick={busy ? halt : undefined} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
