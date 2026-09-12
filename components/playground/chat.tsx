'use client';
import { withinDeadline } from '@/lib/playground/run-preparation';
import { randomId } from '../../lib/id.ts';

import { AgentSelector } from './agents-home';
import { HikmahReceipt } from './hikmah-receipt';
import { VoiceInput, ReadAloud } from '@/components/chat/voice-controls';
import { agentScope, agentInstructions } from '@/lib/playground/agents';
import { builtInTools, executeBuiltin } from '@/lib/playground/builtin-tools';
import { ToolsMenu } from './tools-menu';
import { KnowledgeEditor, newKnowledge } from './knowledge';
import { retrieveKnowledge, knowledgePrompt, type KnowledgeItem } from '@/lib/playground/knowledge';
import { resolveRunTools } from '@/lib/playground/tool-registry';
import { ExecutionProgress, DirectComparison } from './execution-view';
import { shouldRenderMessageText } from '@/lib/playground/execution';
import type { ExecutionView, RunStage, ComparisonView } from '@/lib/playground/execution';
import { analyzeContext } from '@/lib/context-model/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Square,
  X,
  Copy,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  Pencil,
  SlidersHorizontal,
  LoaderCircle,
  Code2,
  Bot,
  MessageSquare,
  GitCompareArrows,
  ChevronDown,
  FileText,
  Check,
  Play,
  BrainCircuit,
  Download,
  Infinity as InfinityIcon,
  Image as ImageIcon,
  Film,
  Volume2,
  Mic,
  Plug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  complete,
  validateConfig,
  ProviderTransportError,
  type ChatMessage,
  type CompletionResult,
} from '@/lib/playground/transport';
import { enabledSkillPrompt } from '@/lib/playground/workspace-config';
import { callMcp } from '@/lib/playground/mcp-client';
import { connectorTools as connectorDefinitions } from '@/lib/playground/connector-tools';
import {
  mediaFetch,
  decodeImage,
  audioBase64,
  parseMediaImages,
  parseVideoJob,
  parseTranscription,
  type MediaAsset,
} from '@/lib/playground/media-client';
import { saveMediaAsset } from '@/lib/playground/storage';
import { MediaOutput } from './media-output';
import { runAgent, type RunCheckpoint } from '@/lib/playground/agent-runner';
import { workspacePrompt } from '@/lib/playground/agent-prompts';
import { executeWorkspaceTool } from '@/lib/playground/workspace-tools';
import { predict } from '@/lib/engines/meaning-engine';
import {
  newConversation,
  validateFiles,
  type ChatEntry,
  type TraceEntry,
  type ChatMode,
} from '@/lib/playground/session';
import { contextMessages, entryText } from '@/lib/playground/chat-context';
import { useKernel } from '@/components/kernel/context';
import { HikmahIcon } from '@/components/kernel/icons';
import { classify, chooseStrategy } from '@/lib/kernel/core';
import { kernelPrompt, questionTool, questionSchema, reviewDraft } from '@/lib/kernel/controller';
import { artifactFiles } from '@/lib/kernel/artifacts';
import { InlineArtifact, ArtifactPanel } from '@/components/kernel/artifact';
import { ClarificationCard, type Question } from '@/components/kernel/question';
import { usePlayground } from './context';
import { CodeWorkspace } from './code-workspace';
import { ModelPicker } from './model-picker';
import { MessageContent } from './message-content';
import { RunSettings } from './run-settings';
import { ErrorCard, copyText, type DisplayError } from './error-card';
import { errorMessage, downloadText } from './common';
import { toast } from 'sonner';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import type { StickToBottomContext } from 'use-stick-to-bottom';
/** Per-message attachment cap, enforced once in `attach`. */
const MAX_ATTACHMENTS = 3;
/** Stream callbacks fire per token; each one rebuilds the whole conversations
 * array, so coalesce them onto this cadence. */
const STREAM_FLUSH_MS = 90;
/** Coalesce a high-frequency stream callback. `apply` reads the latest value
 * from its closure, so a coalesced burst always writes the newest state. */
function createFlusher(apply: () => void) {
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    pending = undefined;
    last = performance.now();
    apply();
  };
  return {
    schedule() {
      if (performance.now() - last > STREAM_FLUSH_MS) run();
      else if (!pending) pending = setTimeout(run, STREAM_FLUSH_MS);
    },
    now() {
      if (pending) clearTimeout(pending);
      run();
    },
  };
}
const modeLabels: Record<ChatMode, string> = {
  chat: 'Chat',
  coding: 'Coding',
  agent: 'Agent',
  compare: 'Compare',
};
function fileName(language: string) {
  return language === 'html'
    ? 'index.html'
    : language === 'css'
      ? 'style.css'
      : ['js', 'javascript'].includes(language)
        ? 'script.js'
        : ['py', 'python'].includes(language)
          ? 'main.py'
          : ['ts', 'typescript'].includes(language)
            ? 'main.ts'
            : language === 'json'
              ? 'data.json'
              : 'notes.md';
}
/**
 * The control that returns a reader to the live edge.
 *
 * A child of StickToBottom because the follow state lives in its context, and a
 * sibling of the scrolled element rather than a member of it: overlaid, so that
 * showing or hiding it cannot change the scroll container's height. The old
 * version sat in normal flow, and its own appearance shifted the container by
 * about forty pixels — which fed straight back into the test that decided
 * whether to keep following.
 */
function JumpToLatest({ show, instant }: { show: boolean; instant: boolean }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (!show || isAtBottom) return null;
  return (
    <button
      type="button"
      className="jump-to-latest"
      onClick={() => void scrollToBottom({ animation: instant ? 'instant' : undefined })}
    >
      <ChevronDown size={16} aria-hidden="true" />
      Jump to latest
    </button>
  );
}

export function Chat() {
  const [memoryDraft, setMemoryDraft] = useState<KnowledgeItem | null>(null);
  const [comparisonModel, setComparisonModel] = useState('');
  const kernel = useKernel();
  const [question, setQuestion] = useState<Question | null>(null);
  const [artifact, setArtifact] = useState<Record<string, string> | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [replaceArtifact, setReplaceArtifact] = useState(false);
  const {
    prepareRunConnections,
    knowledge,
    setKnowledge,
    refreshSharedKnowledge,
    workspace,
    mediaKey,
    connectorKeys,
    connectorTools,
    setWorkspacePage,
    provider,
    model: legacyModel,
    models,
    conversations,
    setConversations,
    files,
    setFiles,
    openSettings,
    mode,
    setMode,
    activeId,
    setActiveId,
    isRunning,
    setIsRunning,
    preferences,
    restoreFailed,
    runSettingsOpen,
    setRunSettingsOpen,
  } = usePlayground();
  const selectedAgent = workspace.agents.find((a) => a.id === workspace.activeAgentId);
  const scope = agentScope(selectedAgent, preferences, workspace.connectors);
  const model = kernel.ready ? kernel.model : legacyModel;
  const [outputMode, setOutputMode] = useState<
    'text' | 'image' | 'speech' | 'video' | 'transcription'
  >('text');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [approval, setApproval] = useState<{
    name: string;
    tool: string;
    input: string;
    resolve: (allow: boolean) => void;
  } | null>(null);
  const effectiveMediaSecret =
    workspace.media.secretRef ||
    (!mediaKey && provider.baseUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1'
      ? provider.apiKeySecret
      : '');
  const effectiveMediaKey =
    mediaKey ||
    (provider.baseUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1'
      ? provider.apiKey
      : '');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; content: string }[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<DisplayError | null>(null);
  const [contextNote, setContextNote] = useState('');
  const [localResult, setLocalResult] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [saveDraft, setSaveDraft] = useState<{ path: string; code: string } | null>(null);
  const [desktop, setDesktop] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // The scroll library owns follow-and-escape; this is only a handle for the
  // one place that has to command it (sending a message).
  const stickRef = useRef<StickToBottomContext>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const draftKeyRef = useRef<string | null>(null);
  const inputRef = useRef('');
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  // The 300 px desktop inspector that docs/workspace-design.md specifies is not
  // wired up yet; until it is, run settings always open in the Sheet. Kept as a
  // named flag so the dead branches below stay visible to whoever finishes it.
  const inspectorInline = false;
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1180px)');
    const change = () => setDesktop(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  // Mirror the composer value into a ref so the conversation-switch effect can
  // read it without listing `input` as a dependency (which would re-run it on
  // every keystroke). Written in an effect, never during render.
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    // Restoring the workspace flips active?.id from undefined to a real id long
    // after mount. Treat that as hydration, not a conversation switch: carry the
    // pending draft across instead of overwriting whatever has been typed.
    const key = 'hikmah-draft-' + (active?.id ?? 'new');
    const previous = draftKeyRef.current;
    if (previous === key) return;
    draftKeyRef.current = key;
    const carried = previous === 'hikmah-draft-new' && inputRef.current ? inputRef.current : null;
    try {
      if (carried) sessionStorage.setItem(key, carried);
      else setInput(sessionStorage.getItem(key) ?? '');
    } catch {
      if (!carried) setInput('');
    }
    if (carried) return;
    setAttachments([]);
    setEditing(null);
    setError(null);
    setStatus('');
    setArtifact(null);
    setWorkspaceOpen(false);
    setQuestion(null);
  }, [active?.id]);
  const updateAssistant = (id: string, messageId: string, change: Partial<ChatEntry>) =>
    setConversations((cs) =>
      cs.map((c) =>
        c.id !== id
          ? c
          : {
              ...c,
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...change } : m)),
            },
      ),
    );
  const saveCode = useCallback(
    (language: string, code: string) => setSaveDraft({ path: fileName(language), code }),
    [],
  );
  const attach = async (incoming: FileList | File[]) => {
    // Collect first, then apply once. Reporting the limit from inside a state
    // updater made the toast impure and duplicated it under StrictMode, and the
    // updater's own result could not be observed at the call site.
    const accepted: { name: string; content: string }[] = [];
    let room = MAX_ATTACHMENTS - attachments.length;
    let overflow = false;
    for (const file of Array.from(incoming)) {
      if (
        !/\.(txt|md|json|html|css|js|ts|tsx|jsx|py|java|sql|csv|yaml|yml|xml|sh)$/i.test(
          file.name,
        ) ||
        file.size > 40000
      ) {
        toast.error('Attach a text or code file up to 40 KB.');
        continue;
      }
      const text = await file.text();
      if (text.includes('\u0000')) {
        toast.error('This file does not look like plain text.');
        continue;
      }
      if (room <= 0) {
        overflow = true;
        continue;
      }
      room--;
      accepted.push({ name: file.name.slice(0, 128), content: text });
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    if (overflow) toast.error(`Up to ${MAX_ATTACHMENTS} files per message.`);
  };
  const generateMedia = async () => {
    if (isRunning || abortRef.current) return;
    if (provider.freeOnly) {
      setError({
        message: 'Media generation is blocked by Free models only.',
        action: 'No request was sent. Free-only chat and local model training remain available.',
      });
      return;
    }
    const field =
      outputMode === 'image'
        ? 'imageModel'
        : outputMode === 'speech'
          ? 'speechModel'
          : outputMode === 'video'
            ? 'videoModel'
            : 'transcriptionModel';
    const chosen = workspace.media[field];
    if (
      (!effectiveMediaKey && !effectiveMediaSecret) ||
      !chosen ||
      (outputMode === 'speech' && !workspace.media.voice)
    ) {
      setError({
        message:
          'Configure an OpenRouter media key and the selected media model in Workspace admin.',
        action: 'Open Workspace admin → Media. Speech also requires a supported voice.',
      });
      return;
    }
    if (outputMode === 'transcription' && !audioFile) {
      setError({ message: 'Choose a WAV or MP3 file first.' });
      return;
    }
    const prompt = outputMode === 'transcription' ? 'Transcribe ' + audioFile!.name : input.trim();
    if (!prompt) return;
    const c = active ?? newConversation();
    const id = randomId();
    const user: ChatEntry = { id: randomId(), role: 'user', text: prompt };
    const answer: ChatEntry = {
      id,
      role: 'assistant',
      text: '',
      model: chosen,
      status: 'running',
      mediaOperation: outputMode === 'text' ? undefined : outputMode,
    };
    setConversations((cs) =>
      active
        ? cs.map((x) =>
            x.id === c.id
              ? {
                  ...x,
                  title: x.messages.length ? x.title : prompt.slice(0, 55),
                  messages: [...x.messages, user, answer],
                }
              : x,
          )
        : [{ ...c, title: prompt.slice(0, 55), messages: [user, answer] }, ...cs],
    );
    setActiveId(c.id);
    setIsRunning(true);
    setInput('');
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus(
      outputMode === 'transcription'
        ? 'Transcribing audio'
        : outputMode === 'video'
          ? 'Submitting video job'
          : 'Generating ' + outputMode,
    );
    try {
      let response: Response;
      if (outputMode === 'transcription')
        response = await mediaFetch(effectiveMediaKey, 'transcribe', {
          secretRef: effectiveMediaSecret,
          body: {
            model: chosen,
            input_audio: {
              data: await audioBase64(audioFile!),
              format: audioFile!.name.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3',
            },
          },
          signal: controller.signal,
        });
      else
        response = await mediaFetch(effectiveMediaKey, outputMode, {
          secretRef: effectiveMediaSecret,
          body: {
            model: chosen,
            prompt,
            ...(outputMode === 'speech' ? { voice: workspace.media.voice } : {}),
          },
          signal: controller.signal,
        });
      const assets: MediaAsset[] = [];
      let text = '';
      if (outputMode === 'image') {
        for (const item of parseMediaImages(await response.json())) {
          const assetId = randomId();
          const blob = decodeImage(item.b64_json, item.media_type);
          await saveMediaAsset(assetId, blob);
          assets.push({
            id: assetId,
            kind: 'image',
            label:
              'hikmah-image.' +
              (blob.type === 'image/jpeg'
                ? 'jpg'
                : blob.type === 'image/webp'
                  ? 'webp'
                  : blob.type === 'image/gif'
                    ? 'gif'
                    : 'png'),
            status: 'ready',
          });
        }
      } else if (outputMode === 'speech') {
        const assetId = randomId();
        await saveMediaAsset(assetId, await response.blob());
        assets.push({ id: assetId, kind: 'audio', label: 'hikmah-speech.mp3', status: 'ready' });
      } else if (outputMode === 'video') {
        const job = parseVideoJob(await response.json());
        assets.push({
          id: randomId(),
          kind: 'video',
          label: 'hikmah-video.mp4',
          jobId: job.id,
          status: 'pending',
        });
        text = 'Your video job has been submitted. Use Check video to retrieve the result.';
      } else {
        text = parseTranscription(await response.json());
        setAudioFile(null);
      }
      updateAssistant(c.id, id, { text, media: assets, status: 'complete' });
    } catch (e) {
      updateAssistant(c.id, id, {
        status: controller.signal.aborted ? 'stopped' : 'error',
        error: controller.signal.aborted
          ? undefined
          : {
              message: errorMessage(e),
              action:
                'Check media settings and provider status before submitting another generation.',
            },
        pauseReason: controller.signal.aborted
          ? 'Request stopped. A submitted provider job may still continue.'
          : undefined,
      });
    } finally {
      setIsRunning(false);
      abortRef.current = null;
      setStatus('');
    }
  };
  const send = async (retryAt?: number, resumeId?: string) => {
    if (outputMode !== 'text' && retryAt === undefined && !resumeId) {
      await generateMedia();
      return;
    }
    if (abortRef.current || isRunning) return;
    const resumed = resumeId ? active?.messages.find((m) => m.id === resumeId) : undefined;
    const retryUser = retryAt !== undefined ? active?.messages[retryAt] : undefined;
    const prompt =
      resumed?.checkpoint?.goal.content ??
      retryUser?.text ??
      (input.trim() || (attachments.length ? 'Please review the attached files.' : ''));
    if (!resumed?.checkpoint && !prompt) return;
    setError(null);
    let config;
    try {
      config = validateConfig(provider);
    } catch (e) {
      setError({
        message: errorMessage(e),
        action: 'Open Settings, choose your provider and model, then try again.',
      });
      return;
    }
    const selectedModel = models.find((m) => m.id === config.model);
    const started = performance.now();
    const family = classify(prompt || resumed?.checkpoint?.goal.content || '', mode);
    const decision = chooseStrategy(kernel.state, family);
    if (kernel.state.config.enabled && (mode === 'compare' || selectedAgent?.review))
      decision.strategy = 'verify';
    if (selectedAgent && !selectedAgent.review && mode !== 'compare') decision.strategy = 'direct';

    const c = active ?? newConversation();
    const editingAt = editing ? c.messages.findIndex((m) => m.id === editing) : -1;
    const cut = retryAt ?? (editingAt >= 0 ? editingAt : c.messages.length);
    const before = c.messages.slice(0, cut);
    const messageId = resumed?.id ?? randomId();
    const user: ChatEntry = retryUser ?? {
      id: editing ?? randomId(),
      role: 'user',
      text: prompt,
      attachments: attachments.length ? attachments : undefined,
    };
    if (resumed)
      updateAssistant(c.id, messageId, {
        status: 'running',
        error: undefined,
        pauseReason: undefined,
      });
    else {
      const assistant: ChatEntry = {
        id: messageId,
        role: 'assistant',
        text: '',
        status: 'running',
        model: config.model,
        kernel: {
          runId: messageId,
          version: kernel.state.activeId,
          strategy: decision.strategy,
          family,
          reason: decision.reason,
        },
      };
      setConversations((cs) =>
        active
          ? cs.map((x) =>
              x.id === c.id
                ? {
                    ...x,
                    title: before.length ? x.title : prompt.slice(0, 55),
                    messages: [...before, user, assistant],
                  }
                : x,
            )
          : [{ ...c, title: prompt.slice(0, 55), messages: [user, assistant] }, ...cs],
      );
    }
    setActiveId(c.id);
    if (!resumed) {
      setInput('');
      try {
        sessionStorage.removeItem('hikmah-draft-' + (active?.id ?? 'new'));
      } catch {}
      setAttachments([]);
      setEditing(null);
    }
    setIsRunning(true);
    setWorkspaceOpen(false);
    setArtifact(null);
    // The user's own message has not rendered yet; this marks the transcript as
    // followed so the growth it causes is allowed to scroll.
    stickRef.current?.scrollToBottom({ animation: reducedMotion ? 'instant' : undefined });
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = resumed?.checkpoint?.output ?? '';
    let trace: TraceEntry[] = [...(resumed?.trace ?? [])];
    let workingFiles = { ...files };
    const usage: CompletionResult['usage'] = { ...(resumed?.usage ?? {}) };
    let providerModel = config.model;
    let lastUpdate = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let checkpoint: RunCheckpoint | undefined = resumed?.checkpoint;
    let baselineTask: Promise<void> | undefined;
    let currentStage = '';
    const stageStarts = new Map<string, number>();
    let execution: ExecutionView = {
      provider: new URL(config.baseUrl).hostname,
      stages: [...(resumed?.execution?.stages ?? [])],
      contribution: {
        agentName: selectedAgent?.name ?? 'Hikmah',
        context: 'off',
        memory: selectedAgent?.memory !== false,
        skills: workspace.skills.filter((s) => s.enabled).map((s) => s.name),
      },
    };
    const patchStage = (id: string, patch: Partial<RunStage>) => {
      const previous = execution.stages.find((s) => s.id === id);
      const next: RunStage = {
        id,
        name: previous?.name ?? id,
        requestedModel: config.model,
        status: 'running',
        ...previous,
        ...patch,
        elapsedMs: performance.now() - (stageStarts.get(id) ?? performance.now()),
      };
      execution = {
        ...execution,
        stages: [...execution.stages.filter((s) => s.id !== id), next].slice(-30),
      };
      updateAssistant(c.id, messageId, { execution });
    };
    const flush = () => {
      lastUpdate = performance.now();
      updateAssistant(c.id, messageId, { text: streamed });
    };
    const onOutput = (text: string) => {
      if (text && currentStage) {
        const st = execution.stages.find((s) => s.id === currentStage);
        if (st?.firstTextMs === undefined)
          patchStage(currentStage, {
            firstTextMs: performance.now() - (stageStarts.get(currentStage) ?? performance.now()),
          });
      }
      streamed = text;
      if (performance.now() - lastUpdate > 90) flush();
      else if (!pending)
        pending = setTimeout(() => {
          pending = undefined;
          flush();
        }, 90);
    };
    let latestReasoning = '';
    const reasoningFlush = createFlusher(() => {
      if (currentStage) patchStage(currentStage, { explanation: latestReasoning });
    });
    const record = (t: TraceEntry) => {
      trace = [
        ...trace,
        { ...t, input: t.input.slice(0, 5000), output: t.output.slice(0, 12000) },
      ].slice(-50);
      updateAssistant(c.id, messageId, { trace });
    };
    const addUsage = (u: CompletionResult['usage'], modelName?: string) => {
      for (const k of [
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'reasoning_tokens',
        'cost',
      ] as const)
        if (typeof u[k] === 'number') usage[k] = (usage[k] ?? 0) + u[k]!;
      if (modelName) {
        providerModel = modelName;
        if (currentStage)
          patchStage(currentStage, { model: modelName, usage: u, status: 'complete' });
      }
    };
    try {
      const memory = contextMessages(before, preferences.contextBudget);
      setContextNote(
        memory.words + ' words included; ' + memory.omittedTurns + ' older turns omitted.',
      );
      const connectionsTask = prepareRunConnections(scope.connectors, controller.signal).catch(
        (e) => {
          if (controller.signal.aborted) return connectorTools;
          throw e;
        },
      );
      const sharedTask = withinDeadline(refreshSharedKnowledge(), controller.signal, 5000).catch(
        () => [],
      );
      let co = '';
      if (preferences.enableCoModel) {
        setStatus('Reading document context locally');
        try {
          const context = await withinDeadline(
            analyzeContext(
              [
                ...memory.messages
                  .filter((m) => m.role === 'user')
                  .slice(-3)
                  .map((m) => m.content ?? ''),
                prompt,
              ].join('\n'),
            ),
            controller.signal,
            6000,
          );
          co = context.summary;
          execution = {
            ...execution,
            contextSummary: co,
            contribution: { ...execution.contribution!, context: 'used' },
          };
          updateAssistant(c.id, messageId, { execution });
        } catch {
          execution = {
            ...execution,
            contribution: { ...execution.contribution!, context: 'unavailable' },
          };
          co =
            'Local context model could not load. Use the original conversation; no local meaning claim is available.';
        }
      }
      setLocalResult(co);
      if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const [runCatalogs, sharedForRun] = await Promise.all([connectionsTask, sharedTask]);
      if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const recalled =
        selectedAgent?.memory === false
          ? []
          : retrieveKnowledge([...knowledge, ...sharedForRun], prompt);
      updateAssistant(c.id, messageId, {
        memoryUsed: recalled.map((k) => ({ id: k.id, title: k.title })),
      });
      const connectionNote = scope.connectors.length
        ? '\nConnection availability for this run: ' +
          scope.connectors
            .map(
              (c) =>
                c.name +
                ': ' +
                (runCatalogs[c.id]?.length ? 'connected' : 'unavailable; do not claim access'),
            )
            .join('; ')
        : '';
      const savedContext = knowledgePrompt(recalled) + connectionNote;
      for (const c of scope.connectors)
        if (!runCatalogs[c.id]?.length)
          record({
            id: randomId(),
            name: 'connector_connect',
            input: c.name,
            output: 'This connection is unavailable. Other tools can continue.',
            status: 'error',
          });
      const baselineMessages: ChatMessage[] = [
        {
          role: 'system',
          content:
            workspacePrompt(
              mode,
              preferences,
              '',
              enabledSkillPrompt(workspace) + agentInstructions(selectedAgent),
            ) + savedContext,
        },
        ...memory.messages,
        { role: 'user', content: entryText(user) },
      ];
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            workspacePrompt(
              mode,
              preferences,
              co,
              enabledSkillPrompt(workspace) + agentInstructions(selectedAgent),
            ) +
            (kernel.state.config.enabled ? kernelPrompt() : '') +
            savedContext,
        },
        ...memory.messages,
        { role: 'user', content: entryText(user) },
      ];
      if (mode === 'compare' && !resumed) {
        const requested = comparisonModel || config.model;
        const baselineConfig = {
          ...config,
          model: requested,
          maxTokens: Math.min(
            config.maxTokens,
            models.find((m) => m.id === requested)?.max_output_tokens ?? config.maxTokens,
          ),
          reasoningEffort:
            requested === config.model ? config.reasoningEffort : ('default' as const),
        };
        const baselineStarted = performance.now();
        let view: ComparisonView = {
          text: '',
          model: requested,
          requestedModel: requested,
          provider: new URL(config.baseUrl).hostname,
          status: 'running',
          latencyMs: 0,
        };
        const sync = () =>
          updateAssistant(c.id, messageId, {
            comparison: { ...view, latencyMs: performance.now() - baselineStarted },
          });
        // The comparison lane streamed at one full conversations rebuild per
        // token. Coalesce the streaming writes; terminal states still sync
        // immediately so the final answer is never left behind a timer.
        const baselineFlush = createFlusher(sync);
        sync();
        baselineTask = complete(baselineConfig, baselineMessages, {
          signal: controller.signal,
          onText: (delta) => {
            view = {
              ...view,
              text: view.text + delta,
              firstTextMs: view.firstTextMs ?? performance.now() - baselineStarted,
            };
            baselineFlush.schedule();
          },
          onReasoning: (text) => {
            view = { ...view, explanation: text };
            baselineFlush.schedule();
          },
          onMeta: (meta) => {
            view = { ...view, ...meta };
            baselineFlush.schedule();
          },
        })
          .then((value) => {
            view = {
              ...view,
              text: value.content,
              model: value.model,
              usage: value.usage,
              tokens: value.usage.total_tokens,
              status: 'complete',
            };
            baselineFlush.now();
            addUsage(value.usage);
          })
          .catch((e) => {
            if (view.usage) addUsage(view.usage);
            view = {
              ...view,
              status: controller.signal.aborted ? 'stopped' : 'error',
              error: controller.signal.aborted
                ? 'Stopped by you. Partial answer preserved.'
                : errorMessage(e),
            };
            baselineFlush.now();
          });
      }
      const connected = scope.connectors.filter((c) => c.enabled && runCatalogs[c.id]?.length);
      const enabled = resolveRunTools({
        modelTools: selectedModel?.tools,
        preferences: scope.preferences,
        connectors: scope.connectors,
        catalogs: runCatalogs,
        memory: selectedAgent?.memory,
        question: kernel.state.config.enabled ? questionTool : undefined,
      });
      const contextCharacters = Math.max(
        12000,
        Math.min(
          170000,
          selectedModel?.context_length
            ? Math.max(
                4000,
                selectedModel.context_length -
                  Math.min(config.maxTokens, selectedModel.context_length / 2) -
                  2000,
              ) * 3
            : 170000,
        ),
      );
      const result = await runAgent({
        config,
        messages,
        checkpoint,
        tools: enabled,
        execution: preferences.execution,
        reviewEvery: preferences.maxRounds,
        autoContinue: preferences.autoContinue,
        contextCharacters,
        signal: controller.signal,
        onRequest: (index) => {
          currentStage = 'request-' + index + '-' + randomId().slice(0, 8);
          stageStarts.set(currentStage, performance.now());
          patchStage(currentStage, { name: 'Generate · request ' + index, status: 'running' });
        },
        onReasoning: (text) => {
          latestReasoning = text;
          reasoningFlush.schedule();
        },
        onMeta: (meta) => patchStage(currentStage, meta),
        onText: onOutput,
        onProgress: (p) =>
          setStatus(p.phase + ' · ' + p.requests + ' requests · ' + p.tools + ' actions'),
        onReceipt: record,
        onUsage: addUsage,
        onCheckpoint: (cp) => {
          checkpoint = cp;
          updateAssistant(c.id, messageId, { checkpoint: cp });
        },
        execute: async (call) => {
          try {
            if (builtInTools.some((t) => t.function.name === call.name)) {
              const value = await executeBuiltin(call.name, call.arguments, controller.signal);
              return {
                output: JSON.stringify(value),
                status:
                  typeof value === 'object' && value && 'error' in value && value.error
                    ? 'error'
                    : 'success',
              };
            }
            if (call.name === 'suggest_memory') {
              const args = JSON.parse(call.arguments);
              if (
                !args ||
                typeof args.title !== 'string' ||
                typeof args.quote !== 'string' ||
                !args.quote.trim() ||
                args.quote.length > 12000 ||
                !prompt.includes(args.quote) ||
                !['preference', 'reference'].includes(args.kind)
              )
                throw Error('Memory suggestions must quote the current user message exactly.');
              const item = {
                ...newKnowledge(
                  args.quote,
                  'You · ' + (before.length ? c.title : prompt.slice(0, 55)),
                ),
                title: args.title.slice(0, 120),
                kind: args.kind as KnowledgeItem['kind'],
                status: 'suggested' as const,
              };
              if (knowledge.length >= 500 && !knowledge.some((k) => k.content === item.content))
                throw Error('Knowledge is full. Review existing items before adding more.');
              setKnowledge((items) =>
                items.some((k) => k.content === item.content) || items.length >= 500
                  ? items
                  : [item, ...items],
              );
              toast('Open Memory after this response to review saved items.');
              return {
                output: JSON.stringify({
                  status: 'awaiting_user_review',
                  location: 'Memory',
                  message:
                    'Suggestion saved for review. It is not yet used for answers or model training.',
                }),
                status: 'success',
              };
            }
            if (call.name === 'ask_user') {
              const q = questionSchema.parse(JSON.parse(call.arguments));
              setWorkspaceOpen(false);
              setArtifact(null);
              setStatus('Waiting for your answer');
              const answer = await new Promise<string>((resolve, reject) => {
                const stop = () => {
                  setQuestion(null);
                  reject(new DOMException('Stopped', 'AbortError'));
                };
                const finish = (answer: string) => {
                  controller.signal.removeEventListener('abort', stop);
                  setQuestion(null);
                  resolve(answer);
                };
                controller.signal.addEventListener('abort', stop, { once: true });
                if (controller.signal.aborted) {
                  stop();
                  return;
                }
                setQuestion({ ...q, resolve: finish });
              });
              return {
                output: JSON.stringify({ question: q.question, answer, source: 'user' }),
                status: 'success',
              };
            }
            if (call.name === 'connector_catalog' || call.name === 'connector_call') {
              const args = JSON.parse(call.arguments);
              if (!args || typeof args !== 'object' || Array.isArray(args))
                throw Error('Invalid connector arguments.');
              const connection = connected.find((c) => c.id === args.connection);
              if (call.name === 'connector_catalog') {
                const value = !connection
                  ? connected.map((c) => ({
                      id: c.id,
                      name: c.name,
                      tools: runCatalogs[c.id].length,
                    }))
                  : args.tool
                    ? runCatalogs[connection.id].find((t) => t.name === args.tool)
                    : runCatalogs[connection.id].map((t) => ({
                        name: t.name,
                        description: t.description.slice(0, 250),
                      }));
                return {
                  output: JSON.stringify(value ?? { error: 'Tool not found' }),
                  status: 'success',
                };
              }
              if (!connection) throw Error('Choose an enabled, connected server.');
              const tool = runCatalogs[connection.id].find((t) => t.name === args.tool);
              if (
                !tool ||
                !args.arguments ||
                typeof args.arguments !== 'object' ||
                Array.isArray(args.arguments)
              )
                throw Error('Use a discovered tool and its argument schema.');
              if (connection.approval === 'ask') {
                setStatus('Waiting for your tool approval');
                const allowed = await new Promise<boolean>((resolve) => {
                  const finish = (v: boolean) => {
                    controller.signal.removeEventListener('abort', stop);
                    setApproval(null);
                    resolve(v);
                  };
                  const stop = () => finish(false);
                  controller.signal.addEventListener('abort', stop, { once: true });
                  if (controller.signal.aborted) {
                    finish(false);
                    return;
                  }
                  setApproval({
                    name: connection.name,
                    tool: tool.name,
                    input: JSON.stringify(args.arguments, null, 2).slice(0, 10000),
                    resolve: finish,
                  });
                });
                if (!allowed) throw Error('The user did not approve this external call.');
              }
              const value = await callMcp(
                connection,
                connectorKeys[connection.id] ?? '',
                tool,
                args.arguments,
                controller.signal,
              );
              let output = JSON.stringify(value);
              for (const secret of [connectorKeys[connection.id], config.apiKey, effectiveMediaKey])
                if (secret) output = output.replaceAll(secret, '[credential redacted]');
              if (output.length > 30000)
                output = JSON.stringify({
                  truncated: true,
                  preview: output.slice(0, 28000),
                  note: 'Ask this tool for a smaller result or a page of data.',
                });
              return {
                output,
                status:
                  value && typeof value === 'object' && (value as { isError?: boolean }).isError
                    ? 'error'
                    : 'success',
              };
            }
            const r = executeWorkspaceTool(
              call.name,
              call.arguments,
              model,
              workingFiles,
              scope.preferences.allowEdits,
            );
            if (r.files) {
              workingFiles = r.files;
              setFiles(r.files);
            }
            if (call.name === 'update_plan')
              updateAssistant(c.id, messageId, {
                plan: (r.result as { steps: NonNullable<ChatEntry['plan']> }).steps,
              });
            return { output: JSON.stringify(r.result), status: 'success' };
          } catch (e) {
            return { output: JSON.stringify({ error: errorMessage(e) }), status: 'error' };
          }
        },
      });
      if (result.status === 'complete' && decision.strategy === 'verify' && streamed.trim()) {
        try {
          streamed = await reviewDraft({
            config,
            messages,
            goal: checkpoint?.goal.content ?? prompt,
            draft: streamed,
            evidence: trace,
            signal: controller.signal,
            onUsage: addUsage,
            record,
            onStatus: setStatus,
            onStage: (name, patch) => {
              const id = 'stage-' + name;
              if (!stageStarts.has(id)) stageStarts.set(id, performance.now());
              patchStage(id, { name, ...patch });
            },
          });
          onOutput(streamed);
        } catch (e) {
          execution.stages
            .filter((s) => s.status === 'running')
            .forEach((s) => {
              if (s.usage) addUsage(s.usage);
              patchStage(s.id, { status: controller.signal.aborted ? 'stopped' : 'error' });
            });
          if (controller.signal.aborted) {
            checkpoint = undefined;
            throw e;
          }
          record({
            id: randomId(),
            name: 'kernel_review',
            input: 'Optional review',
            output: 'Review unavailable: ' + errorMessage(e) + '. Original answer retained.',
            status: 'error',
          });
        }
      }
      if (baselineTask) {
        setStatus('Waiting for direct comparison');
        await baselineTask;
      }
      if (pending) clearTimeout(pending);
      updateAssistant(c.id, messageId, {
        text:
          streamed ||
          (result.status === 'complete'
            ? 'The model returned no visible answer. Try more output tokens or lower reasoning effort.'
            : ''),
        trace,
        usage,
        model: providerModel,
        status: result.status,
        pauseReason: result.reason,
        checkpoint: result.status === 'complete' ? undefined : result.checkpoint,
      });
      setStatus(result.status === 'complete' ? 'Complete' : 'Paused');
      if (kernel.ready)
        void kernel
          .act({
            type: 'run',
            run: {
              id: messageId,
              model: providerModel,
              family,
              strategy: decision.strategy,
              status: result.status,
              tokens: Math.round(usage.total_tokens ?? 0),
              latencyMs: Math.round(performance.now() - started),
              tools: result.checkpoint.toolCount,
              evaluation: mode === 'compare',
            },
          })
          .catch((e) => toast.error('Run sync: ' + errorMessage(e)));
    } catch (e) {
      if (pending) clearTimeout(pending);
      const stopped = controller.signal.aborted || (e instanceof Error && e.name === 'AbortError');
      execution.stages
        .filter((s) => s.status === 'running')
        .forEach((s) => {
          if (s.usage) addUsage(s.usage);
          patchStage(s.id, { status: stopped ? 'stopped' : 'error' });
        });
      if (checkpoint?.phase === 'complete') checkpoint = undefined;
      const d = e instanceof ProviderTransportError ? e.diagnostic : undefined;
      const display: DisplayError = {
        message: errorMessage(e),
        code: d?.code ?? (e instanceof ProviderTransportError ? e.code : undefined),
        action: d?.action,
        model: providerModel,
        provider: new URL(config.baseUrl).hostname,
        status: d?.status ?? (e instanceof ProviderTransportError ? e.status : undefined),
        retryAfterSeconds: d?.retryAfterSeconds,
      };
      updateAssistant(c.id, messageId, {
        text: streamed,
        trace,
        usage,
        model: providerModel,
        checkpoint,
        status: stopped ? 'stopped' : 'error',
        error: stopped ? undefined : display,
        pauseReason: stopped
          ? checkpoint
            ? 'Partial response and completed actions saved. Continue from this point.'
            : 'Review stopped. The completed draft is preserved.'
          : undefined,
      });
      setStatus(stopped ? 'Stopped' : 'Response failed');
      if (kernel.ready)
        void kernel
          .act({
            type: 'run',
            run: {
              id: messageId,
              model: providerModel,
              family,
              strategy: decision.strategy,
              status: stopped ? 'stopped' : 'error',
              tokens: Math.round(usage.total_tokens ?? 0),
              latencyMs: Math.round(performance.now() - started),
              tools: trace.filter((t) => !t.name.startsWith('kernel_')).length,
              evaluation: mode === 'compare',
            },
          })
          .catch(() => {});
    } finally {
      if (baselineTask) await baselineTask;
      if (pending) clearTimeout(pending);
      updateAssistant(c.id, messageId, { usage });
      setIsRunning(false);
      abortRef.current = null;
    }
  };
  const lastUserAt = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (active?.messages[i].role === 'user') return i;
    return undefined;
  };
  const prompts =
    mode === 'coding'
      ? [
          'Build a clean calculator with HTML, CSS and JavaScript.',
          'Create a responsive support request form.',
          'Review my workspace code and suggest improvements.',
        ]
      : mode === 'agent'
        ? [
            'Plan and build a client proposal template with scope, milestones and assumptions.',
            'Inspect the workspace and complete a useful improvement.',
            'Calculate the monthly cost of 12 servers at $45 each, plus 8% overhead.',
          ]
        : mode === 'compare'
          ? [
              'Compare two approaches to a reliable support workflow.',
              'Review the trade-offs between a queue and a direct API call.',
            ]
          : [
              'Turn my client brief into a clear proposal.',
              'Help me write and adapt content for my audience.',
              'Review code or notes from an attached file.',
            ];
  const hasPanel = workspaceOpen || !!artifact;
  const modeIcon =
    mode === 'coding' ? (
      <Code2 size={17} />
    ) : mode === 'agent' ? (
      <Bot size={17} />
    ) : mode === 'compare' ? (
      <GitCompareArrows size={17} />
    ) : (
      <MessageSquare size={17} />
    );
  return (
    <div className={'chat-frame' + (runSettingsOpen && inspectorInline ? ' with-inspector' : '')}>
      <div className="chat-workspace">
        <header className="workspace-header">
          <SidebarTrigger className="nav-toggle" />
          <h1>{active?.messages.length ? active.title : 'New chat'}</h1>
          <div className="header-actions">
            <button
              className="kernel-header-chip"
              disabled={isRunning}
              onClick={() => setWorkspacePage('learning')}
            >
              <HikmahIcon name="learning" size={16} />
              <span>Learning</span>
            </button>
            <Button
              variant="ghost"
              className="chat-memory-button"
              disabled={isRunning}
              onClick={() => setWorkspacePage('knowledge')}
            >
              <BrainCircuit size={16} />
              Memory{' '}
              <span>
                {knowledge.filter((k) => k.status === 'suggested').length
                  ? knowledge.filter((k) => k.status === 'suggested').length + ' to review'
                  : knowledge.filter((k) => k.enabled).length}
              </span>
            </Button>
            <ModelPicker />
            <Button
              variant="ghost"
              className="icon-button"
              aria-label="Toggle files and preview"
              onClick={() => {
                setArtifact(null);
                setWorkspaceOpen(!workspaceOpen);
              }}
            >
              <HikmahIcon name="artifact" />
            </Button>
            <Button
              variant="ghost"
              className={'icon-button' + (runSettingsOpen ? ' active' : '')}
              aria-label="Workspace controls"
              aria-expanded={runSettingsOpen}
              onClick={() => setRunSettingsOpen(!runSettingsOpen)}
            >
              <SlidersHorizontal size={18} />
              <span className="controls-button-label">Controls</span>
            </Button>
          </div>
        </header>
        {mode === 'compare' && (
          <div className="comparison-toolbar">
            <div>
              <strong>A · Hikmah + tools</strong>
              <ModelPicker label="Hikmah model" />
            </div>
            <div>
              <strong>B · Direct answer</strong>
              <ModelPicker
                label="Direct answer model"
                value={comparisonModel || provider.model}
                onSelect={setComparisonModel}
              />
            </div>
            <p>
              Same question. A uses allowed tools and review; B makes one request. Both use your
              saved knowledge.
            </p>
          </div>
        )}
        <div className={'workspace-body unified-workspace' + (hasPanel ? ' has-artifact' : '')}>
          <section className="conversation-pane">
            {/* A failed restore used to look exactly like a workspace with
                nothing in it, while saving was quietly switched off — so the
                obvious next move, typing, produced work that was never kept.
                Said here rather than in the footer, because it changes what
                this screen means. */}
            {restoreFailed && (
              <div className="restore-failed" role="alert">
                <strong>Your saved workspace could not be loaded.</strong>
                <p>
                  This is not an empty workspace — nothing here is being saved, so that whatever is
                  stored is not overwritten. Reload to try again.
                </p>
                <button type="button" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </div>
            )}
            {/* Keyed per conversation so opening one starts at its live edge and
                the previous conversation's escape state does not carry over. */}
            <StickToBottom
              key={active?.id ?? 'new'}
              className="conversation-scroll"
              contextRef={stickRef}
              role="log"
              aria-busy={isRunning}
              initial={reducedMotion ? 'instant' : 'smooth'}
              resize={reducedMotion ? 'instant' : 'smooth'}
            >
              <StickToBottom.Content
                className="conversation-track"
                scrollClassName="conversation-scroller"
              >
                {!active?.messages.length ? (
                  <div className="welcome">
                    <HikmahIcon name="orbit" size={48} />
                    <h2>
                      {mode === 'coding'
                        ? 'What would you like to build?'
                        : mode === 'agent'
                          ? 'Give your agent a clear task.'
                          : mode === 'compare'
                            ? 'Which answer works better for you?'
                            : 'What would you like to work on?'}
                    </h2>
                    <p>
                      {mode === 'coding'
                        ? 'Build and edit files, then try your page in the preview.'
                        : mode === 'agent'
                          ? 'Set a goal. Your agent can use the workspace tools and show its activity.'
                          : mode === 'compare'
                            ? 'Compare the direct answer with a tool-assisted, reviewed answer. Use the same model to compare workflows, or choose a different model above.'
                            : 'Ask, research or build. Hikmah chooses the available tools here and shows the answer when ready.'}
                    </p>
                    <div className="welcome-mode-pills" hidden>
                      {(['chat', 'coding', 'agent', 'compare'] as ChatMode[]).map((item) => (
                        <button
                          key={item}
                          aria-pressed={mode === item}
                          onClick={() => setMode(item)}
                        >
                          {modeLabels[item]}
                        </button>
                      ))}
                    </div>
                    <div className="starter-prompts">
                      {prompts.map((p) => (
                        <button
                          key={p}
                          onClick={() => {
                            setInput(p);
                            composerRef.current?.focus();
                          }}
                        >
                          {p}
                          <ArrowUp size={16} />
                        </button>
                      ))}
                    </div>
                    {mode === 'agent' && !preferences.allowEdits && (
                      <button className="text-action" onClick={() => setRunSettingsOpen(true)}>
                        Workspace is read-only · manage permissions
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="conversation-content">
                    {active.messages.map((m, index) => {
                      const previous = lastUserAt(index);
                      const bundle =
                        m.role === 'assistant' && m.status === 'complete'
                          ? artifactFiles(m.text)
                          : null;
                      return (
                        <article key={m.id} className={'chat-message ' + m.role}>
                          <div className="chat-message-inner">
                            {m.role === 'assistant' && (
                              <div className="assistant-label">
                                <HikmahIcon name="orbit" size={25} />
                                <span>{m.execution?.contribution?.agentName ?? 'Hikmah'}</span>
                                {m.status === 'running' && (
                                  <span className="working-label" role="status">
                                    <LoaderCircle className="spin" size={14} />
                                    {status || 'Working'}
                                  </span>
                                )}
                              </div>
                            )}
                            <div
                              className={
                                m.comparison ? 'response-comparison-grid' : 'response-single'
                              }
                            >
                              <section
                                className="primary-response"
                                aria-live={m.status === 'running' ? 'polite' : 'off'}
                                aria-atomic="false"
                              >
                                {m.comparison && (
                                  <header className="primary-response-title">
                                    <HikmahIcon name="orbit" size={18} />
                                    <strong>A · Hikmah + tools</strong>
                                    <span>{m.model}</span>
                                  </header>
                                )}
                                {shouldRenderMessageText(m) && (
                                  <MessageContent
                                    text={m.text}
                                    onSave={
                                      m.role === 'assistant' && m.status === 'complete'
                                        ? saveCode
                                        : undefined
                                    }
                                  />
                                )}{' '}
                                {bundle && (
                                  <InlineArtifact
                                    files={bundle}
                                    onOpen={(f) => {
                                      setArtifact(f);
                                      setWorkspaceOpen(false);
                                    }}
                                  />
                                )}
                                {m.role === 'assistant' &&
                                  m.status === 'complete' &&
                                  m.trace?.some(
                                    (t) => t.name === 'write_file' && t.status === 'success',
                                  ) && (
                                    <Button
                                      variant="outline"
                                      className="completed-files"
                                      onClick={() => {
                                        setArtifact(null);
                                        setWorkspaceOpen(true);
                                      }}
                                    >
                                      <Code2 size={16} />
                                      View workspace files
                                    </Button>
                                  )}
                                {m.role === 'assistant' && (
                                  <ExecutionProgress value={m.execution} />
                                )}
                              </section>
                              {m.comparison && <DirectComparison value={m.comparison} />}
                            </div>
                            {question && m.status === 'running' && (
                              <ClarificationCard key={question.question} value={question} />
                            )}
                            {!!m.memoryUsed?.length && (
                              <details className="memory-receipt">
                                <summary>
                                  <BrainCircuit size={14} />
                                  Used {m.memoryUsed.length} saved item
                                  {m.memoryUsed.length > 1 ? 's' : ''}
                                </summary>
                                {m.memoryUsed.map((k) => (
                                  <p key={k.id}>{k.title}</p>
                                ))}
                              </details>
                            )}
                            {m.media?.map((asset) => (
                              <MediaOutput
                                key={asset.id}
                                asset={asset}
                                mediaKey={effectiveMediaKey}
                                secretRef={effectiveMediaSecret}
                                onReady={() =>
                                  updateAssistant(active.id, m.id, {
                                    media: m.media?.map((a) =>
                                      a.id === asset.id ? { ...a, status: 'ready' } : a,
                                    ),
                                  })
                                }
                              />
                            ))}
                            <div className="message-attachments">
                              {m.attachments?.map((a, i) => (
                                <details key={i}>
                                  <summary>
                                    <FileText size={14} />
                                    {a.name}
                                  </summary>
                                  <pre>{a.content}</pre>
                                </details>
                              ))}
                            </div>
                            {m.role === 'assistant' && m.status === 'running' && (
                              <div
                                className="thinking-indicator"
                                aria-label="Working on your request"
                              >
                                <span />
                                <span />
                                <span />
                              </div>
                            )}
                            {m.error && (
                              <ErrorCard
                                error={m.error}
                                onSettings={
                                  m.mediaOperation
                                    ? () => setWorkspacePage('admin/media')
                                    : openSettings
                                }
                                disabled={isRunning}
                                onRetry={
                                  !m.mediaOperation &&
                                  index === active.messages.length - 1 &&
                                  previous !== undefined
                                    ? () =>
                                        void send(
                                          m.checkpoint ? undefined : previous,
                                          m.checkpoint ? m.id : undefined,
                                        )
                                    : undefined
                                }
                              />
                            )}{' '}
                            {(m.status === 'paused' || m.status === 'stopped') && (
                              <div className="run-paused">
                                <p>
                                  {m.pauseReason || 'Work paused. Completed actions remain saved.'}
                                </p>
                                {m.checkpoint && index === active.messages.length - 1 && (
                                  <Button
                                    variant="outline"
                                    disabled={isRunning}
                                    onClick={() => void send(undefined, m.id)}
                                  >
                                    <Play size={15} />
                                    Continue task
                                  </Button>
                                )}
                              </div>
                            )}
                            {preferences.showActivity && m.plan?.length ? (
                              <div className="task-plan">
                                <h3>
                                  <BrainCircuit size={17} />
                                  Task plan
                                </h3>
                                {m.plan.map((p, i) => (
                                  <div className={'plan-step ' + p.status} key={i}>
                                    {p.status === 'completed' ? (
                                      <Check size={16} />
                                    ) : p.status === 'in_progress' ? (
                                      <LoaderCircle size={16} className="spin" />
                                    ) : (
                                      <span className="plan-number">{i + 1}</span>
                                    )}
                                    <span>{p.step}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {preferences.showActivity && !!m.trace?.length && (
                              /* One disclosure, not two: every call's name and
                                 status is a row you can read without clicking,
                                 so only the payload is behind a disclosure. */
                              <div className="activity-group">
                                <p className="activity-head">
                                  <Bot size={16} />
                                  {m.trace.length} action{m.trace.length === 1 ? '' : 's'}
                                </p>
                                <div className="activity-list">
                                  {m.trace.map((t, i) => (
                                    <details key={t.id + '-' + i} className="activity-item">
                                      <summary>
                                        {t.status === 'success' ? (
                                          <Check size={15} />
                                        ) : (
                                          <X size={15} />
                                        )}
                                        <span>{t.name.replace(/_/g, ' ')}</span>
                                        <small>{t.status}</small>
                                        <ChevronDown
                                          size={14}
                                          className="activity-caret"
                                          aria-hidden="true"
                                        />
                                      </summary>
                                      <pre>
                                        Input: {t.input}
                                        {'\n\n'}Result: {t.output}
                                      </pre>
                                    </details>
                                  ))}
                                </div>
                              </div>
                            )}
                            {m.role === 'assistant' && m.status !== 'running' && (
                              <HikmahReceipt message={m} />
                            )}
                            {m.role === 'assistant' && m.status !== 'running' && (
                              <div className="message-actions">
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Copy response"
                                  onClick={() => void copyText(m.text)}
                                >
                                  <Copy size={16} />
                                </Button>
                                <ReadAloud text={m.text} />
                                {(['up', 'down'] as const).map((r) => (
                                  <Button
                                    key={r}
                                    variant="ghost"
                                    className={'icon-button' + (m.rating === r ? ' active' : '')}
                                    aria-label={
                                      r === 'up'
                                        ? 'Mark response helpful'
                                        : 'Mark response unhelpful'
                                    }
                                    aria-pressed={m.rating === r}
                                    onClick={async () => {
                                      const next = m.rating === r ? undefined : r;
                                      try {
                                        if (m.kernel) {
                                          await kernel.act({
                                            type: 'feedback',
                                            runId: m.kernel.runId,
                                            rating: next ?? null,
                                          });
                                        }
                                        updateAssistant(active.id, m.id, { rating: next });
                                        toast.success('Feedback saved.');
                                      } catch (e) {
                                        toast.error(errorMessage(e));
                                      }
                                    }}
                                  >
                                    {r === 'up' ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />}
                                  </Button>
                                ))}
                                {index === active.messages.length - 1 &&
                                  !m.error &&
                                  !m.mediaOperation &&
                                  previous !== undefined && (
                                    <Button
                                      variant="ghost"
                                      className="icon-button"
                                      aria-label="Regenerate response"
                                      disabled={isRunning}
                                      onClick={() => void send(previous)}
                                    >
                                      <RefreshCw size={16} />
                                    </Button>
                                  )}
                                {m.usage?.total_tokens !== undefined && (
                                  <span>
                                    {m.usage.total_tokens.toLocaleString()}{' '}
                                    {m.comparison ? 'combined tokens' : 'reported tokens'}
                                  </span>
                                )}
                                {m.usage?.cost !== undefined && (
                                  <span title="Provider-reported cost in USD">
                                    ${m.usage.cost.toFixed(4)}
                                  </span>
                                )}
                                {m.usage?.reasoning_tokens !== undefined && (
                                  <span>
                                    {m.usage.reasoning_tokens.toLocaleString()} reasoning tokens
                                  </span>
                                )}
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Remember response"
                                  onClick={() =>
                                    setMemoryDraft(newKnowledge(m.text, 'Chat: ' + active.title))
                                  }
                                >
                                  <BrainCircuit size={16} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Download response"
                                  onClick={() => downloadText(m.text, 'hikmah-response.md')}
                                >
                                  <Download size={16} />
                                </Button>
                                <span className="message-model" title={m.model}>
                                  {m.model}
                                </span>
                              </div>
                            )}
                            {m.role === 'user' && !isRunning && (
                              <div className="user-actions">
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Remember message"
                                  onClick={() =>
                                    setMemoryDraft(newKnowledge(m.text, 'You · ' + active.title))
                                  }
                                >
                                  <BrainCircuit size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Edit message"
                                  onClick={() => {
                                    setEditing(m.id);
                                    setInput(m.text);
                                    setAttachments(m.attachments ?? []);
                                    composerRef.current?.focus();
                                  }}
                                >
                                  <Pencil size={14} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="icon-button"
                                  aria-label="Copy message"
                                  onClick={() => void copyText(m.text)}
                                >
                                  <Copy size={14} />
                                </Button>
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </StickToBottom.Content>
              <JumpToLatest show={!!active?.messages.length} instant={reducedMotion} />
            </StickToBottom>
            <div className="composer-dock">
              {outputMode === 'text' &&
                !provider.apiKey &&
                !provider.apiKeySecret &&
                !provider.baseUrl.includes('localhost') && (
                  <div className="connect-banner">
                    <div>
                      <strong>Connect your model</strong>
                      <span>Add a provider key to start a conversation.</span>
                    </div>
                    <Button variant="outline" onClick={openSettings}>
                      Connect
                    </Button>
                  </div>
                )}
              {error && (
                <ErrorCard
                  error={error}
                  onSettings={
                    outputMode === 'text' ? openSettings : () => setWorkspacePage('admin/media')
                  }
                />
              )}{' '}
              {editing && (
                <div className="edit-banner">
                  <span>Editing message · later replies will be replaced on send</span>
                  <button
                    aria-label="Cancel editing"
                    onClick={() => {
                      setEditing(null);
                      setInput('');
                      setAttachments([]);
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <AgentSelector />
              <div className="composer-mode-heading">
                {outputMode !== 'text' && (
                  <>
                    <span>
                      {outputMode === 'image'
                        ? 'Create image'
                        : outputMode === 'speech'
                          ? 'Text to speech'
                          : outputMode === 'video'
                            ? 'Create video'
                            : 'Transcribe audio'}
                    </span>
                    <button disabled={isRunning} onClick={() => setWorkspacePage('admin/media')}>
                      Configure media
                    </button>
                    <button
                      aria-label="Return to text chat"
                      disabled={isRunning}
                      onClick={() => setOutputMode('text')}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
              <div
                className="composer"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!isRunning && outputMode === 'text') void attach(e.dataTransfer.files);
                }}
              >
                {outputMode === 'transcription' && (
                  <div className="audio-upload-row">
                    <input
                      ref={audioInput}
                      type="file"
                      accept=".wav,.mp3,audio/wav,audio/mpeg"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          if (file.size > 8000000 || !/\.(wav|mp3)$/i.test(file.name))
                            toast.error('Choose a WAV or MP3 file up to 8 MB.');
                          else setAudioFile(file);
                        }
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outline"
                      disabled={isRunning}
                      onClick={() => audioInput.current?.click()}
                    >
                      <Mic size={16} />
                      {audioFile?.name || 'Choose audio file'}
                    </Button>
                  </div>
                )}
                <div className="attachment-chips">
                  {attachments.map((a, i) => (
                    <span key={i}>
                      <FileText size={14} />
                      {a.name}
                      <button
                        aria-label={'Remove ' + a.name}
                        onClick={() => setAttachments((prev) => prev.filter((_, j) => i !== j))}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
                <Textarea
                  ref={composerRef}
                  aria-label="Message Hikmah"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    try {
                      sessionStorage.setItem(
                        'hikmah-draft-' + (active?.id ?? 'new'),
                        e.target.value,
                      );
                    } catch {}
                  }}
                  maxLength={12000}
                  placeholder={
                    outputMode === 'image'
                      ? 'Describe the image you want to create…'
                      : outputMode === 'video'
                        ? 'Describe your video…'
                        : outputMode === 'speech'
                          ? 'Enter the text to read aloud…'
                          : outputMode === 'transcription'
                            ? 'Choose an audio file above, then send.'
                            : mode === 'coding'
                              ? 'Describe what you want to build…'
                              : 'Message Hikmah…'
                  }
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (
                      e.key === 'Enter' &&
                      (e.metaKey || e.ctrlKey || (preferences.enterToSend && !e.shiftKey))
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-controls">
                  <input
                    ref={uploadRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.sql,.csv,.yaml,.yml,.xml,.sh"
                    hidden
                    onChange={(e) => {
                      if (e.target.files) void attach(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    variant="ghost"
                    className="icon-button attach-button"
                    aria-label="Attach text or code files"
                    disabled={isRunning || outputMode !== 'text'}
                    onClick={() => uploadRef.current?.click()}
                  >
                    <HikmahIcon name="attachment" size={20} />
                  </Button>
                  <VoiceInput
                    disabled={isRunning || outputMode !== 'text'}
                    onText={(text) => setInput((v) => ((v ? v + ' ' : '') + text).slice(0, 12000))}
                  />
                  <ToolsMenu />
                  <Button
                    variant="ghost"
                    className="composer-remember"
                    aria-label="Remember composer text"
                    disabled={!input.trim() || isRunning}
                    onClick={() =>
                      setMemoryDraft(newKnowledge(input, 'Your message · saved directly'))
                    }
                  >
                    <BrainCircuit size={16} />
                    Remember
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="composer-create-menu" disabled={isRunning}>
                        <HikmahIcon name="tools" size={18} />
                        Create
                        <ChevronDown size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onSelect={() => setOutputMode('text')}>
                        <MessageSquare size={16} />
                        Text conversation
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setOutputMode('image');
                          setAttachments([]);
                        }}
                      >
                        <ImageIcon size={16} />
                        Create image
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setOutputMode('video');
                          setAttachments([]);
                        }}
                      >
                        <Film size={16} />
                        Create video
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setOutputMode('speech');
                          setAttachments([]);
                        }}
                      >
                        <Volume2 size={16} />
                        Text to speech
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setOutputMode('transcription');
                          setAttachments([]);
                        }}
                      >
                        <Mic size={16} />
                        Transcribe audio
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setWorkspacePage('admin/connectors')}>
                        <Plug size={16} />
                        Skills & connectors
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="composer-workflow" disabled={isRunning}>
                        {modeIcon}
                        {modeLabels[mode]}
                        <ChevronDown size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {(['chat', 'coding', 'agent', 'compare'] as ChatMode[]).map((item) => (
                        <DropdownMenuItem key={item} onSelect={() => setMode(item)}>
                          {modeLabels[item]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="composer-run-mode">
                    {preferences.execution === 'continuous' ? <InfinityIcon size={16} /> : modeIcon}
                    {preferences.execution === 'continuous'
                      ? 'Continuous · stop anytime'
                      : 'Review mode'}
                  </span>
                  <span className="composer-hint">
                    {preferences.enterToSend
                      ? 'Shift + Enter for a new line'
                      : 'Ctrl/⌘ + Enter to send'}
                  </span>
                  {isRunning ? (
                    <Button
                      className="send-button"
                      aria-label="Stop response"
                      onClick={() => abortRef.current?.abort()}
                    >
                      <Square size={17} fill="currentColor" />
                    </Button>
                  ) : (
                    <Button
                      className="send-button"
                      aria-label={editing ? 'Send edited message' : 'Send message'}
                      disabled={
                        !input.trim() &&
                        !attachments.length &&
                        !(outputMode === 'transcription' && audioFile)
                      }
                      onClick={() => void send()}
                    >
                      <HikmahIcon name="send" size={21} />
                    </Button>
                  )}
                </div>
              </div>
              <div className="composer-footnote">
                <span>
                  {isRunning
                    ? status
                    : mode === 'compare'
                      ? 'A uses your tools and review · B is a direct answer · both may incur provider charges.'
                      : 'Review important details before taking action.'}
                </span>
                {
                  <button onClick={() => setRunSettingsOpen(true)}>
                    {preferences.allowEdits ? 'Workspace edits on' : 'Workspace read only'}
                  </button>
                }
              </div>
            </div>
          </section>
          {artifact ? (
            desktop ? (
              <ArtifactPanel
                files={artifact}
                onClose={() => setArtifact(null)}
                onEdit={() => setReplaceArtifact(true)}
              />
            ) : (
              <Sheet open onOpenChange={(v) => !v && setArtifact(null)}>
                <SheetContent className="artifact-sheet" showCloseButton={false}>
                  <SheetTitle className="sr-only">Artifact preview</SheetTitle>
                  <SheetDescription className="sr-only">
                    Inspect generated code and its preview.
                  </SheetDescription>
                  <ArtifactPanel
                    files={artifact}
                    onClose={() => setArtifact(null)}
                    onEdit={() => setReplaceArtifact(true)}
                  />
                </SheetContent>
              </Sheet>
            )
          ) : workspaceOpen ? (
            desktop ? (
              <div className="unified-code-panel">
                <div className="panel-close-row">
                  <span>Files & live preview</span>
                  <Button
                    variant="ghost"
                    className="icon-button"
                    aria-label="Close workspace pane"
                    onClick={() => setWorkspaceOpen(false)}
                  >
                    <HikmahIcon name="close" />
                  </Button>
                </div>
                <CodeWorkspace />
              </div>
            ) : (
              <Sheet open onOpenChange={setWorkspaceOpen}>
                <SheetContent className="artifact-sheet" showCloseButton={false}>
                  <SheetTitle className="sr-only">Files and preview</SheetTitle>
                  <SheetDescription className="sr-only">
                    Edit files and run the isolated preview.
                  </SheetDescription>
                  <div className="unified-code-panel">
                    <div className="panel-close-row">
                      <span>Files & live preview</span>
                      <Button
                        variant="ghost"
                        className="icon-button"
                        aria-label="Close workspace pane"
                        onClick={() => setWorkspaceOpen(false)}
                      >
                        <HikmahIcon name="close" />
                      </Button>
                    </div>
                    <CodeWorkspace />
                  </div>
                </SheetContent>
              </Sheet>
            )
          ) : null}
        </div>
      </div>
      {runSettingsOpen && inspectorInline && (
        <aside className="run-inspector">
          <RunSettings
            onClose={() => setRunSettingsOpen(false)}
            contextNote={contextNote}
            localResult={localResult}
          />
        </aside>
      )}
      <Sheet open={runSettingsOpen && !inspectorInline} onOpenChange={setRunSettingsOpen}>
        <SheetContent className="run-settings-sheet" showCloseButton={false}>
          <SheetTitle className="sr-only">Workspace controls</SheetTitle>
          <SheetDescription className="sr-only">
            Model, response style, permissions and request limits.
          </SheetDescription>
          <RunSettings
            onClose={() => setRunSettingsOpen(false)}
            contextNote={contextNote}
            localResult={localResult}
          />
        </SheetContent>
      </Sheet>
      {memoryDraft && (
        <KnowledgeEditor
          key={memoryDraft.id}
          value={memoryDraft}
          onClose={() => setMemoryDraft(null)}
        />
      )}
      <AlertDialog open={replaceArtifact} onOpenChange={setReplaceArtifact}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit this artifact in your workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Its generated HTML, CSS and JavaScript will replace matching workspace files. Other
              files remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep preview</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (artifact) {
                  setFiles(validateFiles({ ...files, ...artifact }));
                  setArtifact(null);
                  setWorkspaceOpen(true);
                }
              }}
            >
              Use these files
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!approval}
        onOpenChange={(v) => {
          if (!v) approval?.resolve(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow external tool call?</AlertDialogTitle>
            <AlertDialogDescription>
              {approval?.name} · {approval?.tool}. This action runs through the server’s configured
              permissions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="approval-input">{approval?.input}</pre>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => approval?.resolve(false)}>Deny</AlertDialogCancel>
            <AlertDialogAction onClick={() => approval?.resolve(true)}>
              Allow this call
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!saveDraft} onOpenChange={(v) => !v && setSaveDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save code to workspace</DialogTitle>
            <DialogDescription>
              {saveDraft && Object.hasOwn(files, saveDraft.path)
                ? 'This will replace the existing file. Review its name before saving.'
                : 'Choose a filename for this code.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Save code filename"
            value={saveDraft?.path ?? ''}
            onChange={(e) => setSaveDraft((p) => (p ? { ...p, path: e.target.value } : null))}
          />
          <Button
            disabled={isRunning}
            onClick={() => {
              if (!saveDraft) return;
              try {
                setFiles(validateFiles({ ...files, [saveDraft.path]: saveDraft.code }));
                setSaveDraft(null);
                setWorkspaceOpen(true);
                setArtifact(null);
                toast.success('Code saved to workspace');
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Save file
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
