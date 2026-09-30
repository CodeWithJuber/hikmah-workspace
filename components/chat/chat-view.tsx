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
  AlertTriangle,
  ArrowUp,
  Check,
  Columns2,
  Download,
  Ghost,
  Globe,
  Keyboard,
  LoaderCircle,
  Paperclip,
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
import { streamingJustSettled, type SettledOutcome } from '@/lib/chat/announce';
import { AttachmentErrorAlert, RunStatusLiveRegion, type AttachmentIssue } from './composer-status';
// One number for the meter and the run budget; see lib/ai/context.ts.
import { ASSUMED_CONTEXT_TOKENS } from '@/lib/ai/context';
import { LearnTaskDialog } from './learn-task';
import { ModelPicker, type PickerModel } from './model-picker';
import { EmptyStateOnboarding } from './empty-state-onboarding';
import { StagedLoading } from './staged-loading';
import { pipelineStageIndex } from '@/lib/chat/pipeline-stage';
import { phaseFromParts } from '@/lib/runs/telemetry';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConnectModelCard } from './connect-model';
import { allModelsFree } from '@/lib/ai/endpoint';
import { PricingContext } from './pricing-context';
import { VoiceInput } from './voice-controls';
import { ToolsMenu } from './tools-menu';
import { ResearchBriefDialog } from '@/components/research/research-brief-dialog';
import type { PreparedResearchBrief } from '@/lib/client/research-brief';
import { MessageParts, messageText, type BranchInfo, type ResearchView } from './message-parts';
import type { GrantHandler } from './approval-card';
import type { WorkspaceFiles } from '@/lib/playground/session';
import type { FeedbackValue } from '@/lib/chat/feedback-store';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentPicker } from './agent-picker';
import type { Agent } from './agents-panel';
import { AhaMoment } from './aha-moment';
import { ShortcutsDialog } from './shortcuts-dialog';
import { useKeyboardShortcuts } from '@/lib/chat/shortcuts';
import { chatModeFor } from '@/lib/chat/mode';
import { useMemory } from '@/hooks/use-memory';
import { getIncognito, useIncognito } from '@/lib/memory/incognito';
import { useVisualViewport } from '@/hooks/use-visual-viewport';
import type { MemoryForAha } from './memory-annotations';
import { ConversationSearch } from './conversation-search';
import { useTempChat } from './temp-chat';
import { ContextEstimate } from './context-estimate';
import { ImageCommandButton, ImageCommandHint, IMAGE_COMMANDS } from './image-command';
import { ImageGeneratingState } from './generated-image';
import { parseImageCommand } from '@/lib/chat/image-gen';
import { clientFetch } from '@/lib/client/request';
import {
  currentRunActivity,
  failureAction,
  readConversationDraft,
  transcriptMarkdown,
  writeConversationDraft,
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

/** The scripted first message the empty state's "Show me" button sends: a
 * real turn that returns a real answer with a live artifact, not a draft. */
const DEMO_TURN = 'Build a clean calculator with HTML, CSS and JavaScript.';

/** Written by the learning lab on a successful teach; the next chat visit
 * surfaces one AhaMoment line from it, then it is done. */
const LAST_TEACH_KEY = 'hikmah:ui:last-teach';

/** What an attachment may be, and how much of it. The composer inlines a file
 * as a data URL rather than uploading it, so these caps are what keeps a
 * message row — and the prompt built from it — a sensible size. */
const ACCEPT = 'image/*,text/*,.md,.markdown,.json,.csv,.pdf';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

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
      className="chat-send-control n-press"
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
      className="chat-attach-control n-press"
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
        <li key={file.id} className="flex items-center gap-2">
          <Paperclip size={12} aria-hidden="true" />
          <span className="text-sm">{file.filename || file.mediaType || 'Attachment'}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={`Remove ${file.filename || 'attachment'}`}
            onClick={() => attachments.remove(file.id)}
          >
            <X size={12} />
          </Button>
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
  /** This owner's thumbs ratings, loaded with the transcript. The messages
   * route returns them as a map alongside the messages. */
  initialFeedback?: Record<string, FeedbackValue>;
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
  /** The paid model is configured with no key to pay for it: the card offers
   * the free tier or the settings, and the send stays blocked for paid runs.
   * Free-only mode never sets this — the first message always goes through. */
  needsKey?: boolean;
  /** Opens the Settings tab. */
  onOpenSettings?: () => void;
  /** Switches the saved connection to the free-only config — no key needed. */
  onUseFree?: () => void;
  /** The agent driving the next turn, if any. The composer's agent picker
   * toggles it; picking on an empty conversation surfaces its starters. */
  activeAgentId?: string | null;
  /** Apply an agent to the next turn (or null to switch off). */
  onAgent?: (agent: Agent | null) => void;
  /** Open the agents panel (manage-only surface). */
  onOpenAgents?: () => void;
  /** Remembers a yes from the approval card, with its scope. */
  onGrant?: GrantHandler;
};

export function ChatView({
  id,
  run,
  initialMessages,
  initialFeedback,
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
  onUseFree,
  activeAgentId = null,
  onAgent,
  onOpenAgents,
}: ChatViewProps) {
  // A lazy initial state rather than useMemo: this must be created exactly
  // once, and useMemo is a cache React is free to discard, not a guarantee.
  //
  // The transport holds the live configuration and the run in flight, rather
  // than this component holding them: useChat captures the transport into its
  // Chat instance on first render and only replaces it when the conversation id
  // changes, so anything the view kept would never reach the instance actually
  // sending the requests.
  const [transport] = useState(() =>
    createDurableChatTransport({ config: { ...run, incognito: getIncognito() } }),
  );
  // iOS keyboard lift: the keyboard shrinks the *visual* viewport only, so
  // when it reads smaller than the layout viewport the keyboard is up — pad
  // the composer by the occluded height so it stays above it. A snap (no
  // transition, and none on .chat-composer-area either), which is also what
  // prefers-reduced-motion requires: no animated lift. Desktop / SSR: the
  // hook returns null and this is a no-op.
  const visualViewport = useVisualViewport();
  const keyboardLift =
    visualViewport?.keyboardOpen && typeof window !== 'undefined'
      ? Math.max(0, window.innerHeight - visualViewport.height)
      : 0;
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
  /**
   * The interrupted card's last published view, stashed by its Resume button.
   * It rides the next turn's request body as `researchResume`; the tool
   * validates it and only resumes the matching question. One-shot: cleared
   * when the turn is sent, so a later turn cannot silently re-attach it.
   */
  const [researchResume, setResearchResume] = useState<ResearchView | null>(null);
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
  const [attachmentError, setAttachmentError] = useState<AttachmentIssue | null>(null);
  const [stopState, setStopState] = useState<'idle' | 'stopping' | 'stopped' | 'unconfirmed'>(
    'idle',
  );
  const [exported, setExported] = useState(false);
  const router = useRouter();
  // This owner's thumbs ratings for the transcript, seeded from the messages
  // route and refreshed with the transcript whenever a run settles.
  const [feedback, setFeedback] = useState<Record<string, FeedbackValue>>(
    () => initialFeedback ?? {},
  );
  // Chat v2: keyboard shortcuts dialog, in-conversation search, temp chat.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { temp, exitTemp, adoptTemp } = useTempChat();
  const isTempRoute = id.startsWith('temp-');
  // A temp conversation is recognised by its route: adopting the id tells the
  // hook which conversation to delete when this is left. (enterTemp is not
  // used here because this view remounts on navigation — the instance that
  // called enterTemp unmounts, and its cleanup would delete the id it issued.)
  useEffect(() => {
    if (isTempRoute) adoptTemp(id);
  }, [isTempRoute, id, adoptTemp]);
  // An /image turn in flight: the prompt being generated, shown as a
  // placeholder row until the finished message replaces it.
  const [generatingImage, setGeneratingImage] = useState<string | null>(null);
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
  // The sr-only polite region announces the run edge: "Working on your
  // request." while busy, then exactly one "Response ready." when streaming
  // settles, cleared after a second so it doesn't linger for assistive tech.
  // Per-chunk updates would break VoiceOver, so only the transition is
  // announced — never the answer text itself.
  // The first-run demo turn earned its celebration: one line, once ever, in
  // the aha-moment grammar. Marked in the settle effect, not on click, so it
  // only appears when the demo actually finished. localStorage is the source
  // of truth (a state mirror would go stale across the effect's closure);
  // private mode just means it shows this visit only.
  const DEMO_CELEBRATED_KEY = 'hikmah:ui:demo-celebrated';
  const demoTurnRef = useRef(false);
  const [showDemoCelebration, setShowDemoCelebration] = useState(false);
  const [justFinished, setJustFinished] = useState<false | SettledOutcome>(false);
  const statusRef = useRef(status);
  useEffect(() => {
    const prev = statusRef.current;
    statusRef.current = status;
    // A stop can land while the turn is still queueing (submitted): the run
    // never streamed, so the edge above stays quiet — but the owner still
    // needs to hear that the stop took.
    const stoppedWhileQueueing =
      stopState !== 'idle' && prev === 'submitted' && (status === 'ready' || status === 'error');
    if (!streamingJustSettled(prev, status) && !stoppedWhileQueueing) return;
    // A settle that follows a stop is announced as stopped, never as ready —
    // the run did not produce a response. A failure is announced as failed:
    // the failure card is visual-only otherwise.
    setJustFinished(stopState !== 'idle' ? 'stopped' : status === 'error' ? 'error' : 'ready');
    if (demoTurnRef.current) {
      demoTurnRef.current = false;
      let celebrated = false;
      try {
        celebrated = window.localStorage.getItem(DEMO_CELEBRATED_KEY) === '1';
        if (!celebrated) window.localStorage.setItem(DEMO_CELEBRATED_KEY, '1');
      } catch {
        // Private mode: the line shows this visit only.
      }
      if (!celebrated) setShowDemoCelebration(true);
    }
    const timer = window.setTimeout(() => setJustFinished(false), 1000);
    return () => window.clearTimeout(timer);
  }, [status, stopState]);
  if (staleFor !== id) {
    setStaleFor(id);
    setRetried(false);
    setShowEarlier(false);
    setJustFinished(false);
  }
  // Session incognito is read live rather than stored in the run prop: it is a
  // choice made for a question (like Search), not a setting that follows
  // every one, and re-running setConfig when it flips keeps the transport's
  // queued request honest.
  const incognito = useIncognito();
  useEffect(() => {
    transport.setConfig({
      ...run,
      compare: compare ? {} : undefined,
      deepResearch,
      // A resume snapshot stashed by the card's Resume button: the next turn
      // carries it, the run's tool validates it, then it is cleared.
      researchResume: researchResume ?? undefined,
      webSearch,
      incognito,
    });
  }, [transport, run, compare, deepResearch, researchResume, webSearch, incognito]);

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
  // The question each answer answers: the nearest preceding user message's
  // text. Research answers restate it as a heading, so the reader sees what
  // was asked without scrolling up. A Map, not a parallel array: the render
  // below maps over `visible`, and the lookup is by id.
  const queryByMessageId = useMemo(() => {
    const map = new Map<string, string>();
    let lastUserText: string | undefined;
    for (const message of visible) {
      if (message.role === 'user') {
        const text = messageText(message).trim();
        if (text) lastUserText = text;
      } else if (message.role === 'assistant' && lastUserText) {
        map.set(message.id, lastUserText);
      }
    }
    return map;
  }, [visible]);

  const busy = status === 'submitted' || status === 'streaming';
  // Free tier, no key: the run goes to free models. The pill says so, and
  // where the fast models are — one tap to /pricing, never a gate.
  // chatModeFor is the single definition of the mode (lib/chat/mode.ts):
  // a local/all-free server with freeOnly on reads as plan, not free.
  // How long the current run has been going, for the staged loader's long-run
  // copy ("Still working — some answers take a moment." at 20s). The start
  // lives in a ref and the tick writes the state, so the effect body itself
  // never calls setState (react-hooks/set-state-in-effect is an error here).
  const runStartedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!busy) {
      runStartedAtRef.current = null;
      return;
    }
    if (runStartedAtRef.current === null) runStartedAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      const started = runStartedAtRef.current;
      setElapsedSeconds(started === null ? 0 : Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const freeMode = chatModeFor(run) === 'free' && !run.apiKeySecret;
  // The learning lab's applause: after a successful teach there, the next
  // chat visit surfaces one AhaMoment line naming what changed — then it is
  // done. Read lazily so a repeat visit never flashes it on first paint (and
  // SSR, which has no localStorage, paints the undisclosed state).
  const [lastTeach, setLastTeach] = useState<{ learned: number; broken: number } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(LAST_TEACH_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: string; learned?: number; broken?: number };
      // Older than a week is just plumbing, not an aha.
      if (!parsed.at || Date.now() - new Date(parsed.at).getTime() > 7 * 24 * 3600 * 1000)
        return null;
      return {
        learned: Number(parsed.learned ?? 0),
        broken: Number(parsed.broken ?? 0),
      };
    } catch {
      return null;
    }
  });
  const dismissTeach = () => {
    try {
      window.localStorage.removeItem(LAST_TEACH_KEY);
    } catch {
      // Private mode: the moment just hides for this visit.
    }
    setLastTeach(null);
  };
  // A new run supersedes the finished announcement: the polite region belongs
  // to the current run, so a stale "Response ready." must not survive into it.
  // Render-time reset, the same pattern as the stale-conversation reset above.
  if (busy && justFinished) setJustFinished(false);
  // A new run also supersedes a previous stop notice: the alert belongs to
  // the run that was stopped, not the one now working. Kept out of the
  // 'stopping' window so halt's own async can still land its confirmation.
  if (busy && stopState !== 'idle' && stopState !== 'stopping') setStopState('idle');
  // Whether any of the answer has actually arrived. Once it has, the words are
  // the progress indicator and a label beside them is noise.
  const streamingText =
    messages.at(-1)?.role === 'assistant' &&
    (messages.at(-1)?.parts ?? []).some(
      (part) => part.type === 'text' && !!(part as { text?: string }).text?.trim(),
    );
  const activity = currentRunActivity(messages.at(-1));
  // The run's real phase, from the latest `data-run-phase` part it emitted
  // (PR-07): when present it drives the narrated stage directly, instead of
  // the activity-label heuristic. Null for older runs and non-streamed
  // clients, where the heuristic still applies.
  const runPhase = phaseFromParts(messages.at(-1)?.parts ?? []);
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
  // Re-read the transcript from the server. Branch switches, edits and
  // regenerations rewrite which messages sit on the active path, and the
  // local list only learns the authoritative shape this way; the feedback
  // map comes along too. Runs when a run settles and after branch
  // operations. A failed refresh keeps the local transcript rather than
  // blanking the chat.
  const refreshTranscript = useCallback(async () => {
    try {
      const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}/messages`);
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        messages?: UIMessage[];
        feedback?: Record<string, FeedbackValue>;
      } | null;
      if (payload && Array.isArray(payload.messages)) setMessages(payload.messages);
      if (payload && payload.feedback && typeof payload.feedback === 'object')
        setFeedback(payload.feedback);
    } catch {
      // Keep the local transcript.
    }
  }, [id, setMessages]);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      onSettled?.();
      // The run may have written a new branch (regenerate/edit), so the
      // local list re-reads the authoritative active path: sibling counts,
      // switcher positions and feedback all come from the server.
      void refreshTranscript();
    }
    wasBusy.current = busy;
  }, [busy, onSettled, refreshTranscript]);

  // Two halves, and both are needed: stop() ends this tab's stream, and the
  // cancel aborts the provider call the worker is still driving. Without the
  // second, the run would finish into the log with nobody watching.
  const halt = useCallback(() => {
    const runId = transport.activeRun();
    setStopState('stopping');
    stop();
    if (!runId) {
      // The turn's POST never produced a run id (still queueing, or the abort
      // landed first): there is no server run that could keep going, so the
      // abort is the whole stop — no 'unconfirmed' limbo for nothing.
      setStopState('stopped');
      onSettled?.();
      return;
    }
    void (async () => {
      const confirmed = await cancelRun(runId);
      // A newer run may have started while the cancel was in flight (the
      // composer re-enables as soon as the abort lands). Its stop notice
      // belongs to it — a stale confirmation must not overwrite it.
      if (transport.activeRun() !== runId) return;
      setStopState(confirmed ? 'stopped' : 'unconfirmed');
      onSettled?.();
    })().catch(() => {
      if (transport.activeRun() === runId) setStopState('unconfirmed');
    });
  }, [transport, stop, onSettled]);

  // Keep text controlled while retaining PromptInput's validated attachments.
  const composer = useRef<HTMLTextAreaElement>(null);

  // The question being rewritten, if any. Sending while this is set creates
  // a sibling question (the old one is kept as a branch) rather than adding
  // a new turn — see submitEdit below for the full flow.
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

  /** The person's memory rows, keyed for the inline "used your memory"
   * annotations. Memoised so the memoised MessageParts keeps its memo. */
  const { memories } = useMemory();
  const memoryById = useMemo<Map<string, MemoryForAha>>(
    () =>
      new Map(
        (memories ?? []).map((memory) => [
          memory.id,
          { title: memory.title, createdAt: memory.createdAt, updatedAt: memory.updatedAt },
        ]),
      ),
    [memories],
  );
  /** Opens the Memory panel and jumps to the row. A DOM event, not a prop:
   * the panel lives in ChatShell, three levels up, and the event keeps this
   * wiring additive. */
  const jumpToMemory = useCallback((memoryId: string) => {
    window.dispatchEvent(new CustomEvent('hikmah:open-memory', { detail: { memoryId } }));
  }, []);
  /** A follow-up chip fills an editable draft — it never sends. */
  const pickFollowUp = useCallback(
    (suggestion: string) => {
      chooseStarter(suggestion);
    },
    [chooseStarter],
  );

  /**
   * The interrupted research card's Resume button. The question becomes an
   * editable draft (never sent on its own), the research switch turns on so
   * the turn fans out again, and the card's last published view is stashed
   * for the request body — finished lanes are kept, the rest re-run.
   */
  const resumeResearch = useCallback(
    (view: ResearchView) => {
      if (view.question) chooseStarter(view.question);
      setDeepResearch(true);
      setResearchResume(view);
      composer.current?.focus();
    },
    [chooseStarter],
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

  // In-conversation search: the row ids are the anchors.
  const searchableMessages = useMemo(
    () => messages.map((message) => ({ id: message.id, text: messageText(message) })),
    [messages],
  );
  const jumpToMessage = useCallback((messageId: string) => {
    const row = document.getElementById(`message-${messageId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // So keyboard users land where the scroll went.
    (row as HTMLElement).focus({ preventScroll: true });
  }, []);

  // Switch the visible branch to a sibling message. The server flips the
  // active path in one transaction; the refresh then shows the sibling's
  // whole subtree.
  const switchBranch = useCallback(
    async (messageId: string, siblingId: string) => {
      if (messageId === siblingId) return;
      try {
        const response = await clientFetch(
          `/api/conversations/${encodeURIComponent(id)}/branches`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId: siblingId }),
          },
        );
        if (!response.ok) return;
        await refreshTranscript();
      } catch {
        // The transcript is unchanged; the switcher stays where it was.
      }
    },
    [id, refreshTranscript],
  );

  // Fork the conversation from any message into a new one, and open it.
  const forkMessage = useCallback(
    async (messageId: string) => {
      try {
        const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId }),
        });
        const payload = (await response.json().catch(() => null)) as {
          id?: string;
        } | null;
        if (!response.ok || !payload?.id) return;
        router.push(`/chat/${encodeURIComponent(payload.id)}`);
      } catch {
        // Stay where the conversation is; nothing was changed.
      }
    },
    [id, router],
  );

  // Thumbs up/down on an answer. Optimistic: the thumb flips at once, the
  // PUT follows, and a failure re-syncs from the server.
  const rateMessage = useCallback(
    async (messageId: string, value: FeedbackValue | null) => {
      setFeedback((previous) => {
        const next = { ...previous };
        if (value === null) delete next[messageId];
        else next[messageId] = value;
        return next;
      });
      try {
        const response = await clientFetch(
          `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/feedback`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
          },
        );
        if (!response.ok) await refreshTranscript();
      } catch {
        await refreshTranscript();
      }
    },
    [id, refreshTranscript],
  );

  // Inserts "/image " at the composer caret for the ImageCommandButton.
  const insertImageCommand = useCallback(
    (prefix: string) => {
      const field = composer.current;
      if (!field) {
        updateDraft(prefix + draft);
        return;
      }
      const start = field.selectionStart ?? draft.length;
      const end = field.selectionEnd ?? start;
      updateDraft(draft.slice(0, start) + prefix + draft.slice(end));
      window.requestAnimationFrame(() => {
        field.focus();
        const caret = start + prefix.length;
        field.setSelectionRange(caret, caret);
      });
    },
    [draft, updateDraft],
  );

  // Temporary chat: on means navigating to a temp- id (the route, not the
  // hook, issues it — see the adoptTemp note above); off means deleting the
  // temp conversation and going back to the landing.
  const tempActive = temp || isTempRoute;
  const toggleTemp = useCallback(async () => {
    if (tempActive) {
      await exitTemp();
      router.push('/chat');
    } else {
      router.push(`/chat/temp-${crypto.randomUUID()}`);
    }
  }, [tempActive, exitTemp, router]);

  // ⌘⇧O: a genuinely new conversation, the same call the sidebar's New chat
  // button makes — not the landing, which would reopen the latest chat.
  const startNewChat = useCallback(async () => {
    try {
      const response = await clientFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = (await response.json().catch(() => null)) as {
        id?: string;
      } | null;
      if (!response.ok || !payload?.id) return;
      router.push(`/chat/${encodeURIComponent(payload.id)}`);
    } catch {
      // Stay where the conversation is.
    }
  }, [router]);

  // Chat v2 keyboard shortcuts. The kill-switch (`enabled`) lives in chat
  // settings once that ships; the hook defaults it on. toggle-sidebar is
  // owned by the shell, which wires its own instance of this hook.
  useKeyboardShortcuts({
    'new-chat': () => void startNewChat(),
    'focus-composer': () => composer.current?.focus(),
    'open-shortcuts-dialog': () => setShortcutsOpen(true),
    'stop-generation': () => {
      if (busy) halt();
    },
    'scroll-bottom': () => {
      const transcript = document.querySelector('.chat-transcript');
      transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
    },
  });

  // Whether the /image hint shows under the composer.
  const imageHintVisible = IMAGE_COMMANDS.some((command) =>
    draft.toLowerCase().startsWith(command),
  );

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
  // Regenerating now branches: the old answer is preserved as a sibling
  // first (POST preserve takes it off the active path), then the normal
  // regenerate replays the parent question. useChat drops the preserved
  // answer from its own list and re-sends the question; the server
  // truncates only the active path — the preserved sibling survives — and
  // the worker writes the new answer under the same parent, so it lands as
  // a sibling. The settle refresh brings back the "‹ 1/2 ›" switcher.
  const regenerateMessage = useCallback(
    async (messageId: string) => {
      try {
        const response = await clientFetch(
          `/api/conversations/${encodeURIComponent(id)}/branches/preserve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId }),
          },
        );
        if (!response.ok) return;
      } catch {
        return;
      }
      try {
        await regenerate({ messageId });
      } catch {
        // The answer was preserved but the replay never started: re-sync so
        // the transcript shows the preserved branch rather than a stale row.
        await refreshTranscript();
      }
    },
    [id, regenerate, refreshTranscript],
  );

  // Editing a question now branches it: the PATCH creates a sibling question
  // and takes the old one (plus its answers) off the active path. The new
  // question is spliced into the local list in the old one's place, then
  // replayed through the normal regenerate flow — the server truncates and
  // re-appends it under its old parent, and the worker's answer lands as
  // its child. The settle refresh brings back authoritative sibling counts.
  const submitEdit = useCallback(
    async (editingId: string, newText: string) => {
      const original = messages.find((message) => message.id === editingId) as
        (UIMessage & { branch?: BranchInfo }) | undefined;
      setEditing(null);
      try {
        const response = await clientFetch(
          `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(editingId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parts: [
                { type: 'text', text: newText },
                ...(original?.parts.filter((part) => part.type !== 'text') ?? []),
              ],
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          newId?: string;
        } | null;
        if (!response.ok || !payload?.newId) throw new Error('The edit was not saved.');
        const newId = payload.newId;
        const sibling = original?.branch;
        setMessages(
          messages.map((message) =>
            message.id === editingId
              ? {
                  ...message,
                  id: newId,
                  parts: [
                    { type: 'text' as const, text: newText },
                    ...message.parts.filter((part) => part.type !== 'text'),
                  ],
                  branch: sibling
                    ? {
                        index: sibling.total,
                        total: sibling.total + 1,
                        siblings: [...sibling.siblings, newId],
                      }
                    : undefined,
                }
              : message,
          ),
        );
        updateDraft(draftBeforeEdit.current);
        try {
          await regenerate({ messageId: newId });
        } catch {
          await refreshTranscript();
        }
      } catch {
        // The edit did not land: back into editing so the words are not
        // lost, and re-sync the transcript.
        setEditing(editingId);
        await refreshTranscript();
      }
    },
    [id, messages, regenerate, refreshTranscript, setMessages, updateDraft],
  );

  // An /image turn: no agent run, just the picture. The route stores both
  // the command text (as the user turn) and the generated image (as the
  // answer), so the transcript reads like any other exchange.
  const generateImage = useCallback(
    async (rawText: string, prompt: string) => {
      setGeneratingImage(prompt);
      updateDraft('');
      try {
        const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, userText: rawText }),
        });
        const payload = (await response.json().catch(() => null)) as {
          message?: UIMessage;
          userMessage?: UIMessage | null;
          error?: string;
        } | null;
        const finished = payload?.message;
        if (!response.ok || !finished)
          throw new Error(payload?.error || 'The image could not be generated.');
        const userTurn = payload?.userMessage;
        setMessages((previous) => [...previous, ...(userTurn ? [userTurn] : []), finished]);
        // A first /image turn created this conversation; the list catches up.
        onSettled?.();
      } catch (error) {
        setAttachmentError({
          code: 'image',
          message: error instanceof Error ? error.message : 'The image could not be generated.',
        });
      } finally {
        setGeneratingImage(null);
      }
    },
    [id, setMessages, updateDraft, onSettled],
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
      setAttachmentError(null);
      // A resume snapshot is one-shot: this turn carries it, then it is gone.
      setResearchResume(null);

      // /image and /imagine never reach the agent: they are a media turn,
      // not a chat turn. Not while editing — there the text is the question.
      const imagePrompt = !editing && !files?.length ? parseImageCommand(trimmed) : null;
      if (imagePrompt !== null) {
        void generateImage(trimmed, imagePrompt);
        return;
      }

      if (editing) {
        void submitEdit(editing, trimmed);
        return;
      }

      void sendMessage({ text: trimmed, files });
      updateDraft('');
    },
    [
      busy,
      editing,
      generateImage,
      submitEdit,
      sendMessage,
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
        {/* The learning lab's applause, once: what the owner's teaching
          changed. Dismissing clears it everywhere; a week-old teach is not an
          aha, so the state never shows it. */}
        {lastTeach && (
          <div className="chat-teach-moment">
            <AhaMoment
              sourceLabel="What you taught me in the learning lab"
              detail={`${lastTeach.learned} new ${
                lastTeach.learned === 1 ? 'thing' : 'things'
              } learned`}
            />
            <button
              type="button"
              aria-label="Dismiss teaching moment"
              onClick={dismissTeach}
              className="chat-teach-dismiss n-press"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {/* The first-run demo turn's applause, once ever: the demo built a
          working app, and the line points at the transcript below. Dismissing
          hides it; localStorage keeps it gone. */}
        {showDemoCelebration && (
          <div className="chat-teach-moment">
            <AhaMoment
              sourceLabel="That was a live app"
              detail="Tap it — everything here works like this"
            />
            <button
              type="button"
              aria-label="Dismiss demo celebration"
              onClick={() => setShowDemoCelebration(false)}
              className="chat-teach-dismiss"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {messages.length > 0 && (
          <div className="chat-transcript-head flex items-center justify-between gap-2 px-1 py-2">
            <span className="text-sm text-muted-foreground">
              {messages.filter((message) => message.role === 'user').length}{' '}
              {messages.filter((message) => message.role === 'user').length === 1
                ? 'message'
                : 'messages'}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSearchOpen((open) => !open)}
                title="Search in this conversation"
                aria-expanded={searchOpen}
                className="n-press"
              >
                <Search size={16} aria-hidden="true" />
                Search
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setShortcutsOpen(true)}
                    aria-label="Keyboard shortcuts"
                    className="n-press"
                  >
                    <Keyboard size={16} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Keyboard shortcuts</TooltipContent>
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={exportTranscript}
                // The export is the whole conversation — both sides' turns,
                // attachments and sources — not just the visible answers.
                title="Download the full conversation as Markdown"
                className="n-press"
              >
                {exported ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Download size={16} aria-hidden="true" />
                )}
                Export chat
              </Button>
            </div>
          </div>
        )}
        {searchOpen && messages.length > 0 && (
          <ConversationSearch
            messages={searchableMessages}
            onJump={jumpToMessage}
            className="chat-transcript-search"
          />
        )}
        <Conversation className="chat-transcript" aria-label="Conversation messages">
          <ConversationContent className="chat-transcript-content">
            {messages.length === 0 && (
              <div className="chat-welcome">
                {empty ?? (
                  /* Always first-run: a new conversation remounts this view
                   * (key={conversationId}), so an empty transcript is a fresh
                   * start. The 'cleared' variant stays available for a future
                   * clear-thread feature. */
                  <EmptyStateOnboarding
                    variant="first-run"
                    onPick={chooseStarter}
                    onDemo={() => {
                      demoTurnRef.current = true;
                      submit({ text: DEMO_TURN });
                    }}
                    title={starters?.length ? 'Ask this agent' : undefined}
                    chips={
                      starters?.length
                        ? starters.map((prompt) => ({ label: prompt, prompt }))
                        : undefined
                    }
                  />
                )}
              </div>
            )}
            {hidden > 0 && (
              <div className="flex justify-center py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowEarlier(true)}
                  className="n-press"
                >
                  Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
                </Button>
              </div>
            )}
            {visible.map((message, index) => (
              <div
                key={message.id}
                id={`message-${message.id}`}
                className="chat-message-row"
                data-message-id={message.id}
                // A jump target for in-conversation search: focusable so
                // keyboard users land where the scroll went.
                tabIndex={-1}
              >
                <MessageParts
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
                  // Offered on every settled answer. Regenerating branches now:
                  // the old answer is kept as a sibling ("‹ 1/2 ›") rather than
                  // replaced, and editing a question branches it the same way.
                  // Forking copies the active path up to the message into a new
                  // conversation.
                  //
                  // A boolean rather than an absent handler: `undefined` when busy
                  // was a prop that changed identity on every status change, and a
                  // memoised child needs a value it can compare.
                  actionsReady={!busy && !editing}
                  onRegenerateMessage={regenerateMessage}
                  onEditMessage={beginEdit}
                  branch={(message as UIMessage & { branch?: BranchInfo }).branch}
                  onSwitchBranch={switchBranch}
                  onForkMessage={forkMessage}
                  feedback={feedback[message.id] ?? null}
                  onRate={rateMessage}
                  memoryById={memoryById}
                  onJumpToMemory={jumpToMemory}
                  onFollowUpSelect={failure ? undefined : pickFollowUp}
                  // An interrupted card's Resume button: stashes its last
                  // published view and drafts the question again.
                  onResumeResearch={failure ? undefined : resumeResearch}
                  // The question this answer answers, for the research
                  // heading. Undefined for the first turn and for anything
                  // without a preceding user message.
                  queryText={queryByMessageId.get(message.id)}
                />
              </div>
            ))}
            {/* An /image turn in flight: the finished GeneratedImage replaces
              this row when the POST returns, so the thread never shows a gap. */}
            {generatingImage && (
              <div className="chat-message-row">
                <ImageGeneratingState prompt={generatingImage} />
              </div>
            )}
            {/* Something on the screen while the work happens.
              The pipeline is narrated stage by stage ("Consulting your memory"
              → "Checking tools" → …) instead of a dead spinner — the richer
              pipeline is the differentiation, so it gets named. */}
            {busy && (
              <div className="chat-thinking chat-run-progress" role="status">
                {!online ? (
                  <span>Connection lost — reconnect when you’re online</span>
                ) : (
                  <StagedLoading
                    currentIndex={pipelineStageIndex({
                      online,
                      status,
                      activityLabel: activity.label,
                      activityCompleted: activity.completed,
                      streamingText,
                      phase: runPhase,
                    })}
                    elapsedSeconds={elapsedSeconds}
                  />
                )}
                {activity.completed > 0 && <small>{activity.completed} tools completed</small>}
                {streamingText && <span className="sr-only">Response is streaming.</span>}
              </div>
            )}
            {/* The answer region is announced while a run is in progress, so a
              screen reader learns that work is happening and when it lands.
              Only the transition is announced — never the streamed answer
              text (per-chunk live updates break VoiceOver). */}
            <RunStatusLiveRegion busy={busy} outcome={justFinished} />
            {/* End-of-transcript clearance: a real element's height, so the
              last turn always scrolls fully above the floating composer.
              (Bottom padding alone did not hold on phones — the
              stick-to-bottom scroller nests inside the transcript box.)
              Only with messages: the empty state's welcome stays centered. */}
            {messages.length > 0 && (
              <div aria-hidden="true" className="chat-transcript-end-spacer" />
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div
          className="chat-composer-area"
          style={
            keyboardLift > 0
              ? {
                  // Keeps the resting geometry (14px / safe-area) and adds the
                  // occluded height on top of it.
                  paddingBottom: `calc(max(14px, env(safe-area-inset-bottom, 0px)) + ${Math.round(keyboardLift)}px)`,
                }
              : undefined
          }
        >
          {!online && (
            <Alert className="mb-3">
              <WifiOff className="size-4" aria-hidden="true" />
              <AlertTitle>You’re offline</AlertTitle>
              <AlertDescription>
                <p>Your draft is still here. Reconnect to check the latest response.</p>
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                    Reconnect
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {stopState !== 'idle' && !busy && (
            <Alert className="mb-3">
              <Square className="size-4" aria-hidden="true" />
              <AlertDescription className="col-start-2">
                <div className="flex items-center justify-between gap-2">
                  <p>
                    {stopState === 'stopping'
                      ? 'Stopping the run…'
                      : stopState === 'stopped'
                        ? 'Response stopped. You can continue from here.'
                        : 'The stream stopped, but the server has not confirmed cancellation.'}
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    {stopState === 'unconfirmed' && (
                      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                        Check status
                      </Button>
                    )}
                    {stopState === 'stopped' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setStopState('idle')}
                        aria-label="Dismiss stopped notice"
                      >
                        Dismiss
                      </Button>
                    )}
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {/* The live failure first; the stored one only while nothing has been
          sent since, so pressing Try again cannot leave the old reason sitting
          under the new answer. */}
          {!!failure && (
            <Alert variant="destructive" className="mb-3">
              <AlertTriangle className="size-4" aria-hidden="true" />
              <AlertTitle>
                {recovery === 'reconnect'
                  ? 'Connection interrupted'
                  : /Free models only/i.test(failure ?? '')
                    ? 'Model not allowed'
                    : recovery === 'configure'
                      ? 'API key needed'
                      : 'This request needs attention'}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {recovery === 'configure' && !/Free models only/i.test(failure ?? '')
                    ? 'Your chat is not connected yet. Add your API key in Settings to start chatting.'
                    : failure}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {/* The two plan refusals (allowance used up, or no key while a
                  plan would include models) are answered by the pricing page —
                  the same destination the in-chat quota banner points at. */}
                  {/used this month’s included tokens|upgrade to a plan that includes models/i.test(
                    failure ?? '',
                  ) && (
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/pricing">See plans</Link>
                    </Button>
                  )}
                  {/* A run paused on a card this tab has lost track of — answered
                once and refused, or answered from another tab — is put right by
                reloading, which shows the card again from the stored turn.
                Try again would re-send into the same refusal. */}
                  {recovery === 'reload' || recovery === 'reconnect' ? (
                    <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                      {recovery === 'reconnect' ? 'Reconnect to saved run' : 'Reload conversation'}
                    </Button>
                  ) : recovery === 'configure' && onOpenSettings ? (
                    // The fix is in settings, not a retry: open where it goes.
                    // For a missing key it's "Add a key"; for the free-only block
                    // it's "Open settings" (turn it off or pick a free model).
                    <Button size="sm" variant="outline" onClick={onOpenSettings}>
                      {/Free models only/i.test(failure ?? '') ? 'Open settings' : 'Add a key'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !online}
                      onClick={() => {
                        setRetried(true);
                        setStopState('idle');
                        void regenerate();
                      }}
                    >
                      Try again
                    </Button>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Temporary chat: nothing typed here is kept. The notice sits
            above the composer rather than in it, so the input row keeps its
            shape and the state is visible before anything is typed. */}
          {tempActive && (
            <Alert className="mb-3">
              <Ghost className="size-4" aria-hidden="true" />
              <AlertTitle>Temporary chat</AlertTitle>
              <AlertDescription>
                <p>Nothing here is saved to your history.</p>
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={() => void toggleTemp()}>
                    Turn off
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <PromptInput
            className={'chat-composer' + (tempActive ? ' chat-composer-temp' : '')}
            onSubmit={submit}
            accept={ACCEPT}
            multiple
            globalDrop
            maxFiles={MAX_FILES}
            maxFileSize={MAX_FILE_BYTES}
            onError={(issue) => setAttachmentError(issue)}
            onSubmitCapture={(event) => {
              if (busy || needsKey || !online || stopState === 'stopping') {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <PromptInputBody>
              {editing && (
                <Alert className="mb-3">
                  <AlertDescription className="flex items-center justify-between gap-2">
                    <span>
                      Editing an earlier question. Sending replaces it, and every reply after it.
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
                      Cancel
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <StagedAttachments />
              {(webSearch || deepResearch || compare) && (
                <div className="flex flex-wrap gap-2" aria-label="Extra help for this conversation">
                  {webSearch && (
                    <Badge variant="secondary" className="gap-1 py-1.5">
                      <Globe size={12} aria-hidden="true" /> Search
                      <button
                        type="button"
                        onClick={() => setWebSearch(false)}
                        aria-label="Turn off web search"
                        /* n-search-clear: the 32px secondary-affordance
                           dismiss, the same grammar as the search field's
                           clear-X (documented in chats-screen.test.mjs). */
                        className="n-search-clear n-press"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </Badge>
                  )}
                  {deepResearch && (
                    <Badge variant="secondary" className="gap-1 py-1.5">
                      <Telescope size={12} aria-hidden="true" /> Research
                      <button
                        type="button"
                        onClick={() => setDeepResearch(false)}
                        aria-label="Turn off deep research"
                        /* n-search-clear: the 32px secondary-affordance
                           dismiss, the same grammar as the search field's
                           clear-X (documented in chats-screen.test.mjs). */
                        className="n-search-clear n-press"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </Badge>
                  )}
                  {compare && (
                    <Badge variant="secondary" className="gap-1 py-1.5">
                      <Columns2 size={12} aria-hidden="true" /> Compare answers
                      <button
                        type="button"
                        onClick={() => setCompare(false)}
                        aria-label="Turn off comparison"
                        /* n-search-clear: the 32px secondary-affordance
                           dismiss, the same grammar as the search field's
                           clear-X (documented in chats-screen.test.mjs). */
                        className="n-search-clear n-press"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </Badge>
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
                // The hint only: the row also carries the draft-saved note and
                // the context token estimate, and a screen reader was reading
                // the token count number into the composer's label.
                aria-describedby="chat-composer-hint-text"
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
              {/* The /image command hint: only while the draft actually starts
                a command, so the composer stays clean the rest of the time. */}
              <ImageCommandHint visible={imageHintVisible && !editing} />
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
                  onResearchBrief={(capabilities) =>
                    setResearchDialog({ open: true, capabilities })
                  }
                />
                {/* Temporary chat: nothing is saved. The toggle navigates to
                  (or away from) a temp- conversation the hook deletes on
                  exit; the sidebar and landing never list temp- ids. */}
                <PromptInputButton
                  type="button"
                  onClick={() => void toggleTemp()}
                  className="n-press"
                  title={
                    tempActive
                      ? 'Temporary chat is on — nothing is saved. Turn it off to go back.'
                      : 'Temporary chat — ask without saving anything'
                  }
                  aria-pressed={tempActive}
                  aria-label="Temporary chat"
                >
                  <Ghost
                    size={16}
                    className={tempActive ? 'text-primary' : undefined}
                    aria-hidden="true"
                  />
                </PromptInputButton>
                {/* Specialists for the next turn: the bottom sheet lists the
                  built-in agents with outcome descriptions and starters.
                  The side panel stays the manage-only surface. */}
                {onAgent && onOpenAgents && (
                  <AgentPicker
                    activeAgentId={activeAgentId}
                    onPick={(agent) => onAgent(agent)}
                    onStarter={chooseStarter}
                    onManage={onOpenAgents}
                  />
                )}
                {!editing && <ImageCommandButton onInsert={insertImageCommand} />}
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
                {/* Free tier indicator and one-tap upgrade path: the free tier
                  is slower and queued, a plan buys fast models. Tapping goes
                  to /pricing — it never blocks sending. */}
                {freeMode && (
                  <Link
                    href="/pricing"
                    className="chat-free-pill"
                    title="Free tier is slower and queued — a plan gets you fast models"
                  >
                    Free mode · slower — Upgrade for fast models →
                  </Link>
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
            <AttachmentErrorAlert
              issue={attachmentError}
              onDismiss={() => setAttachmentError(null)}
            />
          )}
          {needsKey && onOpenSettings && onUseFree && (
            <ConnectModelCard onUseFree={onUseFree} onOpenSettings={onOpenSettings} />
          )}
          <div className="chat-composer-hint" id="chat-composer-hint">
            {/* Two hint wordings, toggled by input modality: phones have no
              Shift+Enter, so the desktop wording is wrong there (Jev
              short-text, device report 2026-09-29). CSS shows exactly one. */}
            <span id="chat-composer-hint-text" className="chat-hint-desktop">
              Enter to send · Shift + Enter for a new line
            </span>
            <span className="chat-hint-touch">Tap the arrow to send</span>
            {draftSaved && draft && !editing && (
              <span className="chat-draft-saved">
                <Check size={12} aria-hidden="true" /> Draft saved in this tab
              </span>
            )}
            {/* The always-on estimate of context use, so the window filling
              is visible before the run's own meter appears (which stays
              hidden until the window is actually crowded). */}
            {messages.length > 0 && (
              <ContextEstimate
                messages={messages}
                contextWindow={run.contextWindow || ASSUMED_CONTEXT_TOKENS}
                className="chat-context-estimate"
              />
            )}
          </div>
        </div>
        <LearnTaskDialog
          open={learning}
          onOpenChange={setLearning}
          run={run as unknown as Record<string, unknown>}
          onStarted={onSettled}
        />
        <ResearchBriefDialog
          open={researchDialog.open}
          onOpenChange={(open) => setResearchDialog((current) => ({ ...current, open }))}
          capabilities={researchDialog.capabilities}
          onPrepare={prepareResearch}
        />
        {/* The keyboard shortcut reference, opened with ⌘/ (or the toolbar
          button). Mounted here rather than in the composer: the chords reach
          the whole window. */}
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </PricingContext.Provider>
  );
}
