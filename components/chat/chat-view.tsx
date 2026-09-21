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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import type { FileUIPart, LanguageModelUsage } from 'ai';
import {
  ArrowUp,
  BookOpen,
  Check,
  Code2,
  Columns2,
  Download,
  Globe,
  LoaderCircle,
  Paperclip,
  Scale,
  Search,
  Square,
  Telescope,
  WifiOff,
  X,
} from 'lucide-react';
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
import { LearnTaskDialog } from './learn-task';
import { ModelPicker, type PickerModel } from './model-picker';
import { ConnectModelCard } from './connect-model';
import { allModelsFree } from '@/lib/ai/endpoint';
import { PricingContext } from './pricing-context';
import { VoiceInput } from './voice-controls';
import { ToolsMenu } from './tools-menu';
import { CoScientistDialog } from '@/components/research/co-scientist-dialog';
import type { PreparedResearchBrief } from '@/lib/client/research-brief';
import { MessageParts, messageText } from './message-parts';
import type { GrantHandler } from './approval-card';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { clientFetch } from '@/lib/client/request';
import {
  CHAT_STARTERS,
  currentRunActivity,
  failureAction,
  readConversationDraft,
  transcriptMarkdown,
  writeConversationDraft,
  type ChatStarter,
} from './chat-experience';

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

const STARTER_ICONS = { research: Search, build: Code2, compare: Scale, explain: BookOpen };
const onlineSnapshot = () => navigator.onLine;
const serverOnlineSnapshot = () => true;
function subscribeOnline(notify: () => void) {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

function SendControl({
  busy,
  stopping,
  blocked,
  draft,
  halt,
}: {
  busy: boolean;
  stopping: boolean;
  blocked: boolean;
  draft: string;
  halt: () => void;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      className="chat-send-control"
      status={busy ? 'streaming' : 'ready'}
      onStop={halt}
      disabled={stopping || (!busy && (blocked || (!draft.trim() && !attachments.files.length)))}
      aria-label={stopping ? 'Stopping response' : busy ? 'Stop response' : 'Send message'}
      title={busy ? 'Stop response' : 'Send message (Enter)'}
    >
      {stopping ? (
        <LoaderCircle size={20} className="spin" aria-hidden="true" />
      ) : busy ? (
        <Square size={16} aria-hidden="true" />
      ) : (
        <ArrowUp size={20} aria-hidden="true" />
      )}
    </PromptInputSubmit>
  );
}

/** The paperclip always opens the picker; tools live in their own named menu. */
function AttachControl({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      className="chat-attach-control"
      aria-label="Attach a file"
      title="Attach a file"
      disabled={disabled}
      onClick={attachments.openFileDialog}
    >
      <Paperclip size={20} aria-hidden="true" />
    </PromptInputButton>
  );
}

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
          <Paperclip size={12} aria-hidden="true" />
          <span>{file.filename || file.mediaType || 'Attachment'}</span>
          <button
            type="button"
            aria-label={`Remove ${file.filename || 'attachment'}`}
            onClick={() => attachments.remove(file.id)}
          >
            <X size={12} />
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
  /** Offered on an empty conversation. A starter fills a draft for review. */
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
  // configuration because it is a choice for this conversation, not a saved setting.
  const [compare, setCompare] = useState(false);
  // Optional help stays selected in this conversation until switched off.
  // Its chips remain visible so additional calls are never an invisible mode.
  const [deepResearch, setDeepResearch] = useState(false);
  // Explicit web search overrides the conversation's general tool switches.
  const [webSearch, setWebSearch] = useState(false);
  // A background research task is a separate conversation.
  const [learning, setLearning] = useState(false);
  const [researchDialog, setResearchDialog] = useState({
    open: false,
    capabilities: { webSearch: false, parallelResearch: false },
  });
  const [draft, setDraft] = useState(() => {
    try {
      return readConversationDraft(window.sessionStorage, id);
    } catch {
      return '';
    }
  });
  const [draftSaved, setDraftSaved] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [stopState, setStopState] = useState<'idle' | 'stopping' | 'stopped' | 'unconfirmed'>(
    'idle',
  );
  const [exported, setExported] = useState(false);
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, serverOnlineSnapshot);
  const updateDraft = useCallback(
    (value: string) => {
      setDraft(value);
      try {
        setDraftSaved(writeConversationDraft(window.sessionStorage, id, value));
      } catch {
        setDraftSaved(false);
      }
    },
    [id],
  );
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
  const activity = currentRunActivity(messages.at(-1));
  const failure = error?.message || (!retried ? initialError : '') || '';
  const recovery = failureAction(failure);

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
    setStopState('stopping');
    void (async () => {
      await stop();
      const confirmed = runId ? await cancelRun(runId) : false;
      setStopState(confirmed ? 'stopped' : 'unconfirmed');
      onSettled?.();
    })().catch(() => setStopState('unconfirmed'));
  }, [transport, stop, onSettled]);

  // Keep text controlled while retaining PromptInput's validated attachments.
  const composer = useRef<HTMLTextAreaElement>(null);

  // The question being rewritten, if any. Sending while this is set replaces
  // that message rather than adding one, and the server truncates the turns it
  // started — so the conversation reads as though it had been asked that way.
  const [editing, setEditing] = useState<string | null>(null);
  const draftBeforeEdit = useRef('');
  const dictate = useCallback(
    (text: string) => {
      const next = draft ? draft.trimEnd() + ' ' + text : text;
      if (editing) setDraft(next);
      else updateDraft(next);
      composer.current?.focus();
    },
    [draft, editing, updateDraft],
  );
  const beginEdit = useCallback(
    (message: UIMessage) => {
      draftBeforeEdit.current = draft;
      setDraft(messageText(message));
      composer.current?.focus();
      setEditing(message.id);
    },
    [draft],
  );
  const cancelEdit = useCallback(() => {
    setEditing(null);
    updateDraft(draftBeforeEdit.current);
  }, [updateDraft]);

  const chooseStarter = useCallback(
    (prompt: string) => {
      // Suggestions draft a request. Only the Tools menu changes execution.
      updateDraft(prompt);
      composer.current?.focus();
    },
    [updateDraft],
  );

  const prepareResearch = useCallback(
    (brief: PreparedResearchBrief) => {
      // Keep anything already written and all staged attachments. The prepared
      // question is still an editable draft, and only Send starts a model call.
      const next = draft.trim() ? `${draft.trimEnd()}\n\n${brief.prompt}` : brief.prompt;
      if (editing) setDraft(next);
      else updateDraft(next);
      setWebSearch(brief.webSearch);
      setDeepResearch(brief.deepResearch);
      setResearchDialog((current) => ({ ...current, open: false }));
      window.requestAnimationFrame(() => composer.current?.focus());
    },
    [draft, editing, updateDraft],
  );

  const exportTranscript = useCallback(() => {
    const url = URL.createObjectURL(
      new Blob([transcriptMarkdown(messages)], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `hikmah-conversation-${id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  }, [id, messages]);

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
      if ((!trimmed && !files?.length) || busy || stopState === 'stopping' || needsKey || !online)
        return;
      // Whatever failed before, this turn supersedes it.
      setRetried(true);
      setStopState('idle');
      setAttachmentError('');

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
        updateDraft(draftBeforeEdit.current);
        return;
      }

      void sendMessage({ text: trimmed, files });
      updateDraft('');
    },
    [
      busy,
      editing,
      messages,
      regenerate,
      sendMessage,
      setMessages,
      stopState,
      needsKey,
      online,
      updateDraft,
    ],
  );

  // What each model costs, for the receipt under every answer.
  const pricing = useMemo(
    () => new Map((models ?? []).map((model) => [model.id, model])),
    [models],
  );

  return (
    <PricingContext.Provider value={pricing}>
      <div className={'chat-view' + (messages.length === 0 ? ' is-empty' : '')}>
        {banner}
        {messages.length > 0 && (
          <div className="chat-transcript-toolbar">
            <span>
              {messages.filter((message) => message.role === 'user').length} prompts in this
              conversation
            </span>
            <button
              type="button"
              onClick={exportTranscript}
              title="Download the visible answers and sources as Markdown"
            >
              {exported ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Download size={16} aria-hidden="true" />
              )}
              Export chat
            </button>
          </div>
        )}
        <Conversation className="chat-transcript" aria-label="Conversation messages">
          <ConversationContent className="chat-transcript-content">
            {messages.length === 0 && <div className="chat-welcome">{empty}</div>}
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
            {busy && (
              <div className="chat-thinking chat-run-progress" role="status">
                <span className="chat-thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {!online
                    ? 'Connection lost — reconnect when you’re online'
                    : status === 'submitted'
                      ? 'Sending your request…'
                      : activity.label}
                </span>
                {activity.completed > 0 && <small>{activity.completed} tools completed</small>}
                {streamingText && <span className="sr-only">Response is streaming.</span>}
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

        <div className="chat-composer-area">
          {!online && (
            <div className="chat-connection-notice" role="status">
              <WifiOff size={16} aria-hidden="true" />
              <span>
                You’re offline. Your draft is still here. Reconnect to check the latest response.
              </span>
              <button type="button" onClick={() => window.location.reload()}>
                Reconnect
              </button>
            </div>
          )}
          {stopState !== 'idle' && !busy && (
            <div className="chat-connection-notice" role="status">
              <span>
                {stopState === 'stopping'
                  ? 'Stopping the run…'
                  : stopState === 'stopped'
                    ? 'Response stopped. You can continue from here.'
                    : 'The stream stopped, but the server has not confirmed cancellation.'}
              </span>
              {stopState === 'unconfirmed' && (
                <button type="button" onClick={() => window.location.reload()}>
                  Check status
                </button>
              )}
              {stopState === 'stopped' && (
                <button
                  type="button"
                  onClick={() => setStopState('idle')}
                  aria-label="Dismiss stopped notice"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {/* The live failure first; the stored one only while nothing has been
          sent since, so pressing Try again cannot leave the old reason sitting
          under the new answer. */}
          {!!failure && (
            <div className="chat-error" role="alert">
              <strong>
                {recovery === 'reconnect'
                  ? 'Connection interrupted'
                  : 'This request needs attention'}
              </strong>
              <p>{failure}</p>
              {/* A run paused on a card this tab has lost track of — answered
                once and refused, or answered from another tab — is put right by
                reloading, which shows the card again from the stored turn.
                Try again would re-send into the same refusal. */}
              {recovery === 'reload' || recovery === 'reconnect' ? (
                <button type="button" onClick={() => window.location.reload()}>
                  {recovery === 'reconnect' ? 'Reconnect to saved run' : 'Reload conversation'}
                </button>
              ) : recovery === 'configure' && onOpenSettings ? (
                // The fix is a key, not a retry: open where it goes.
                <button type="button" onClick={onOpenSettings}>
                  Add a key
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !online}
                  onClick={() => {
                    setRetried(true);
                    setStopState('idle');
                    void regenerate();
                  }}
                >
                  Try again
                </button>
              )}
            </div>
          )}

          <PromptInput
            className="chat-composer"
            onSubmit={submit}
            accept={ACCEPT}
            multiple
            globalDrop
            maxFiles={MAX_FILES}
            maxFileSize={MAX_FILE_BYTES}
            onError={(issue) => setAttachmentError(issue.message)}
            onSubmitCapture={(event) => {
              if (busy || needsKey || !online || stopState === 'stopping') {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
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
              {(webSearch || deepResearch || compare) && (
                <div className="chat-selected-modes" aria-label="Extra help for this conversation">
                  {webSearch && (
                    <button
                      type="button"
                      onClick={() => setWebSearch(false)}
                      aria-label="Turn off web search"
                    >
                      <Globe size={12} /> Search <X size={12} />
                    </button>
                  )}
                  {deepResearch && (
                    <button
                      type="button"
                      onClick={() => setDeepResearch(false)}
                      aria-label="Turn off deep research"
                    >
                      <Telescope size={12} /> Research <X size={12} />
                    </button>
                  )}
                  {compare && (
                    <button
                      type="button"
                      onClick={() => setCompare(false)}
                      aria-label="Turn off comparison"
                    >
                      <Columns2 size={12} /> Compare answers <X size={12} />
                    </button>
                  )}
                </div>
              )}
              <PromptInputTextarea
                ref={composer}
                value={draft}
                onChange={(event) => {
                  if (editing) setDraft(event.currentTarget.value);
                  else updateDraft(event.currentTarget.value);
                }}
                aria-label={editing ? 'Edit your message' : 'Message Hikmah'}
                aria-describedby="chat-composer-hint"
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    (busy || needsKey || !online || stopState === 'stopping')
                  )
                    event.preventDefault();
                }}
                // The transcript sets dir="auto" on every rendered message and the
                // composer never did, so typing Urdu or Arabic stayed left-aligned
                // with the caret and the punctuation on the wrong side — the one
                // place in the app where the owner writes rather than reads.
                dir="auto"
                placeholder={
                  editing
                    ? 'Rewrite your question…'
                    : 'Ask a question, attach a file, or describe a task…'
                }
              />
            </PromptInputBody>
            <PromptInputFooter className="chat-composer-row chat-composer-simple-row">
              <PromptInputTools className="chat-composer-tools">
                <AttachControl disabled={!!editing} />
                <ToolsMenu
                  disabled={run.disabledTools ?? []}
                  onChange={onTools}
                  busy={busy}
                  webSearch={webSearch}
                  onWebSearch={setWebSearch}
                  deepResearch={deepResearch}
                  onDeepResearch={setDeepResearch}
                  compare={compare}
                  onCompare={setCompare}
                  onBackgroundTask={needsKey ? undefined : () => setLearning(true)}
                  onCoScientist={(capabilities) => setResearchDialog({ open: true, capabilities })}
                />
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
              <VoiceInput disabled={busy || !!editing} onText={dictate} />
              <SendControl
                busy={busy}
                stopping={stopState === 'stopping'}
                blocked={needsKey || !online}
                draft={draft}
                halt={halt}
              />
            </PromptInputFooter>
          </PromptInput>
          {attachmentError && (
            <p className="chat-attachment-error" role="alert">
              {attachmentError}{' '}
              <button
                type="button"
                onClick={() => setAttachmentError('')}
                aria-label="Dismiss attachment error"
              >
                <X size={12} />
              </button>
            </p>
          )}
          {messages.length === 0 &&
            !needsKey &&
            !draft.trim() &&
            !editing &&
            (starters?.length ? (
              <div
                className="chat-starters chat-agent-starters"
                role="group"
                aria-label="Try asking this agent"
              >
                {starters.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => chooseStarter(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            ) : (
              <div
                className="chat-intent-shortcuts chat-outcome-starters"
                role="group"
                aria-label="Ideas to get started"
              >
                {(Object.keys(CHAT_STARTERS) as ChatStarter[]).map((choice) => {
                  const Icon = STARTER_ICONS[choice];
                  return (
                    <button
                      type="button"
                      key={choice}
                      onClick={() => chooseStarter(CHAT_STARTERS[choice].prompt)}
                      title={CHAT_STARTERS[choice].detail}
                    >
                      <Icon size={20} aria-hidden="true" />
                      {CHAT_STARTERS[choice].label}
                    </button>
                  );
                })}
              </div>
            ))}
          {needsKey && onOpenSettings && <ConnectModelCard onOpenSettings={onOpenSettings} />}
          <div className="chat-composer-hint" id="chat-composer-hint">
            <span>Enter to send · Shift + Enter for a new line</span>
            {draftSaved && draft && !editing && (
              <span className="chat-draft-saved">
                <Check size={12} aria-hidden="true" /> Draft saved in this tab
              </span>
            )}
          </div>
        </div>
        <LearnTaskDialog
          open={learning}
          onOpenChange={setLearning}
          run={run as unknown as Record<string, unknown>}
          onStarted={onSettled}
        />
        <CoScientistDialog
          open={researchDialog.open}
          onOpenChange={(open) => setResearchDialog((current) => ({ ...current, open }))}
          capabilities={researchDialog.capabilities}
          onPrepare={prepareResearch}
        />
      </div>
    </PricingContext.Provider>
  );
}
