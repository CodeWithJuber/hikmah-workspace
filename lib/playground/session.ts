import { parseSecretRef } from './secret-reference.ts';
import { randomId } from '../id.ts';
import { parseKnowledge, type KnowledgeItem } from './knowledge';
import {
  parseExecution,
  parseComparison,
  type ExecutionView,
  type ComparisonView,
} from './execution';
import {
  train,
  validateRows,
  compareCandidates,
  type Row,
  type Model,
  type TrainingRow,
} from '@/lib/engines/meaning-engine';
import corpus from './frozen-dataset.json';
export const dataset = corpus;
export const baseRows = validateRows(corpus.base_train, 'train') as TrainingRow[];
export const initialModel = train(baseRows);
export type { ProviderConfig } from './transport';
import type { ProviderConfig, Usage } from './transport';
import type { RunCheckpoint } from './agent-runner';
import { parseCheckpoint } from './checkpoint';
import { parseWorkspaceConfig, type WorkspaceConfig } from './workspace-config';
import type { MediaAsset } from './media-client';
export type ChatMode = 'chat' | 'coding' | 'agent' | 'compare';
export type Preferences = {
  toolboxVersion?: number;
  theme: 'light' | 'dark';
  responseStyle: 'concise' | 'balanced' | 'detailed';
  instructions: string;
  enterToSend: boolean;
  maxRounds: number;
  contextBudget: number;
  allowEdits: boolean;
  enableCoModel: boolean;
  execution: 'continuous' | 'stepwise';
  autoContinue: boolean;
  showActivity: boolean;
  explainDecisions: boolean;
  enabledTools: string[];
};
export const defaultPreferences: Preferences = {
  toolboxVersion: 2,
  theme: 'light',
  responseStyle: 'balanced',
  instructions: '',
  enterToSend: true,
  maxRounds: 10,
  contextBudget: 12000,
  allowEdits: true,
  enableCoModel: true,
  execution: 'continuous',
  autoContinue: true,
  showActivity: true,
  explainDecisions: false,
  enabledTools: [
    'run_javascript',
    'search_reference',
    'read_webpage',
    'search_web',
    'research_quran',
    'calculate',
    'list_files',
    'read_file',
    'write_file',
    'update_plan',
    'interpret_meaning',
    'simulate_plan',
    'transition_estimate',
  ],
};
export function parsePreferences(x: unknown): Preferences {
  const p = (x && typeof x === 'object' ? x : {}) as Partial<Preferences>;
  return {
    toolboxVersion: 2,
    theme: p.theme === 'dark' ? 'dark' : 'light',
    responseStyle: ['concise', 'detailed'].includes(p.responseStyle ?? '')
      ? p.responseStyle!
      : 'balanced',
    instructions: typeof p.instructions === 'string' ? p.instructions.slice(0, 4000) : '',
    enterToSend: p.enterToSend !== false,
    maxRounds: Math.min(100, Math.max(1, Math.floor(Number(p.maxRounds) || 10))),
    contextBudget: Math.min(30000, Math.max(500, Math.floor(Number(p.contextBudget) || 12000))),
    allowEdits: p.execution === undefined ? true : p.allowEdits === true,
    enableCoModel: p.enableCoModel !== false,
    execution: p.execution === 'stepwise' ? 'stepwise' : 'continuous',
    autoContinue: p.autoContinue !== false,
    showActivity: p.showActivity !== false,
    explainDecisions: p.explainDecisions === true,
    enabledTools: Array.isArray(p.enabledTools)
      ? [
          ...new Set([
            ...p.enabledTools.filter(
              (x): x is string =>
                typeof x === 'string' && defaultPreferences.enabledTools.includes(x),
            ),
            ...(p.toolboxVersion === undefined
              ? ['run_javascript', 'search_reference', 'read_webpage']
              : []),
            ...((p.toolboxVersion ?? 0) < 2 ? ['search_web', 'research_quran'] : []),
          ]),
        ]
      : defaultPreferences.enabledTools,
  };
}
export const defaultProvider: ProviderConfig = {
  freeOnly: true,
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'openrouter/free',
  maxTokens: 8192,
  temperature: 0.3,
  customSampling: false,
  stream: true,
  tokenParameter: 'max_tokens',
};
export type TraceEntry = {
  id: string;
  name: string;
  input: string;
  output: string;
  status: 'success' | 'error';
};
export type ChatEntry = {
  memoryUsed?: { id: string; title: string }[];
  execution?: ExecutionView;
  kernel?: {
    runId: string;
    version: string;
    strategy: 'direct' | 'verify';
    family: string;
    reason: string;
  };
  comparison?: ComparisonView;
  id: string;
  role: 'user' | 'assistant';
  text: string;
  trace?: TraceEntry[];
  usage?: Usage;
  model?: string;
  status?: 'running' | 'complete' | 'error' | 'stopped' | 'paused';
  error?: {
    message: string;
    code?: string;
    action?: string;
    model?: string;
    provider?: string;
    status?: number;
    retryAfterSeconds?: number;
  };
  mediaOperation?: 'image' | 'speech' | 'video' | 'transcription';
  media?: MediaAsset[];
  checkpoint?: RunCheckpoint;
  pauseReason?: string;
  plan?: { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
  rating?: 'up' | 'down';
  attachments?: { name: string; content: string }[];
};
export type Conversation = { id: string; title: string; messages: ChatEntry[] };
export type WorkspaceFiles = Record<string, string>;
export const starterFiles: WorkspaceFiles = {
  'index.html':
    '<main>\n  <h1>My first experiment</h1>\n  <p>Edit the files or ask your connected model to build something.</p>\n  <button id="count">Count: 0</button>\n</main>',
  'style.css':
    'body { font-family: system-ui; padding: 32px; color: #17212b; }\nbutton { background: #2457dc; color: white; border: 0; border-radius: 6px; padding: 12px 18px; cursor: pointer; }',
  'script.js':
    'let count = 0;\nconst button = document.querySelector("#count");\nbutton?.addEventListener("click", () => {\n  count += 1;\n  button.textContent = `Count: ${count}`;\n});',
};
export const newConversation = (): Conversation => ({
  id: randomId(),
  title: 'New conversation',
  messages: [],
});
export function validateFiles(value: unknown): WorkspaceFiles {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Files must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 12) throw Error('Up to 12 workspace files are supported.');
  let total = 0;
  const files: WorkspaceFiles = {};
  for (const [name, text] of entries) {
    if (
      !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,79}$/.test(name) ||
      name.includes('..') ||
      ['constructor', 'prototype', '__proto__'].includes(name)
    )
      throw Error('Use a simple filename without directories.');
    if (typeof text !== 'string' || text.length > 80000)
      throw Error('Each file must be text, up to 80,000 characters.');
    total += text.length;
    files[name] = text;
  }
  if (total > 240000) throw Error('Workspace is limited to 240,000 characters.');
  return files;
}
export function validateConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value) || value.length > 500)
    throw Error('This import contains too many conversations.');
  return value.map((c) => {
    if (
      !c ||
      typeof c.id !== 'string' ||
      c.id.length > 80 ||
      typeof c.title !== 'string' ||
      c.title.length > 120 ||
      !Array.isArray(c.messages) ||
      c.messages.length > 2000
    )
      throw Error('Invalid conversation.');
    return {
      id: c.id,
      title: c.title,
      messages: c.messages.map((m: ChatEntry) => {
        if (
          !m ||
          !['user', 'assistant'].includes(m.role) ||
          typeof m.id !== 'string' ||
          m.id.length > 80 ||
          typeof m.text !== 'string' ||
          m.text.length > 2000000
        )
          throw Error('Invalid chat message.');
        const legacy =
          m.role === 'assistant' ? m.text.match(/\[Request ended: ([\s\S]*?)\]$/) : null;
        const trace = Array.isArray(m.trace)
          ? m.trace.map((t) => {
              if (
                !t ||
                typeof t.id !== 'string' ||
                t.id.length > 65536 ||
                typeof t.name !== 'string' ||
                t.name.length > 256 ||
                typeof t.input !== 'string' ||
                t.input.length > 100000 ||
                typeof t.output !== 'string' ||
                t.output.length > 300000 ||
                !['success', 'error'].includes(t.status)
              )
                throw Error('Invalid tool receipt.');
              return { id: t.id, name: t.name, input: t.input, output: t.output, status: t.status };
            })
          : undefined;
        if (trace && trace.length > 50) throw Error('Too many tool receipts.');
        const usage =
          m.usage &&
          Object.fromEntries(
            Object.entries(m.usage).filter(
              ([k, v]) =>
                [
                  'prompt_tokens',
                  'completion_tokens',
                  'total_tokens',
                  'reasoning_tokens',
                  'cost',
                ].includes(k) &&
                typeof v === 'number' &&
                Number.isFinite(v) &&
                v >= 0 &&
                v < 1000000000,
            ),
          );
        return {
          memoryUsed: Array.isArray(m.memoryUsed)
            ? m.memoryUsed
                .slice(0, 8)
                .filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string')
                .map((x) => ({ id: x.id.slice(0, 80), title: x.title.slice(0, 120) }))
            : undefined,
          kernel:
            m.kernel &&
            typeof m.kernel.runId === 'string' &&
            typeof m.kernel.version === 'string' &&
            ['direct', 'verify'].includes(m.kernel.strategy)
              ? {
                  runId: m.kernel.runId.slice(0, 80),
                  version: m.kernel.version.slice(0, 100),
                  strategy: m.kernel.strategy,
                  family: String(m.kernel.family).slice(0, 40),
                  reason: String(m.kernel.reason).slice(0, 500),
                }
              : undefined,
          execution: parseExecution(m.execution),
          comparison: parseComparison(m.comparison),
          id: m.id,
          role: m.role,
          text: legacy ? m.text.slice(0, legacy.index).trimEnd() : m.text,
          trace,
          usage: usage || undefined,
          model: typeof m.model === 'string' ? m.model.slice(0, 256) : undefined,
          status: legacy
            ? 'error'
            : m.status === 'running'
              ? 'stopped'
              : ['complete', 'error', 'stopped', 'paused'].includes(m.status ?? '')
                ? m.status
                : undefined,
          mediaOperation: ['image', 'speech', 'video', 'transcription'].includes(
            m.mediaOperation ?? '',
          )
            ? m.mediaOperation
            : undefined,
          media: Array.isArray(m.media)
            ? m.media
                .filter(
                  (a) =>
                    a &&
                    typeof a.id === 'string' &&
                    a.id.length <= 80 &&
                    ['image', 'audio', 'video'].includes(a.kind) &&
                    typeof a.label === 'string',
                )
                .slice(0, 10)
                .map((a) => ({
                  id: a.id,
                  kind: a.kind,
                  label: a.label.slice(0, 150),
                  jobId:
                    typeof a.jobId === 'string' && /^[A-Za-z0-9_.:-]{1,240}$/.test(a.jobId)
                      ? a.jobId
                      : undefined,
                  status: a.status === 'pending' ? 'pending' : 'ready',
                }))
            : undefined,
          checkpoint: parseCheckpoint(m.checkpoint),
          pauseReason: typeof m.pauseReason === 'string' ? m.pauseReason.slice(0, 1000) : undefined,
          plan: Array.isArray(m.plan)
            ? m.plan
                .filter(
                  (p) =>
                    p &&
                    typeof p.step === 'string' &&
                    ['pending', 'in_progress', 'completed'].includes(p.status),
                )
                .slice(0, 20)
                .map((p) => ({ step: p.step.slice(0, 300), status: p.status }))
            : undefined,
          error:
            m.error && typeof m.error.message === 'string'
              ? {
                  model:
                    typeof m.error.model === 'string' ? m.error.model.slice(0, 256) : undefined,
                  provider:
                    typeof m.error.provider === 'string'
                      ? m.error.provider.slice(0, 256)
                      : undefined,
                  status:
                    Number.isInteger(m.error.status) &&
                    m.error.status! >= 400 &&
                    m.error.status! <= 599
                      ? m.error.status
                      : undefined,
                  retryAfterSeconds:
                    typeof m.error.retryAfterSeconds === 'number' &&
                    m.error.retryAfterSeconds > 0 &&
                    m.error.retryAfterSeconds <= 86400
                      ? m.error.retryAfterSeconds
                      : undefined,
                  message: m.error.message.slice(0, 1000),
                  code: typeof m.error.code === 'string' ? m.error.code.slice(0, 100) : undefined,
                  action:
                    typeof m.error.action === 'string' ? m.error.action.slice(0, 1000) : undefined,
                }
              : legacy
                ? {
                    message: 'This earlier response did not finish.',
                    code: 'previous_request_failed',
                    action:
                      'Retry with custom sampling off, or open Connection settings to test your selected model.',
                  }
                : undefined,
          rating: m.rating === 'up' || m.rating === 'down' ? m.rating : undefined,
          attachments: validateAttachments(m.attachments),
        };
      }),
    };
  });
}
export function validateAttachments(
  value: unknown,
): { name: string; content: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3)
    throw Error('Up to 3 text attachments per message.');
  return value.map((a) => {
    if (
      !a ||
      typeof a.name !== 'string' ||
      a.name.length > 128 ||
      typeof a.content !== 'string' ||
      a.content.length > 40000
    )
      throw Error('Invalid text attachment.');
    return { name: a.name, content: a.content };
  });
}
export type SavedSession = {
  version: 1;
  knowledge?: KnowledgeItem[];
  additions: TrainingRow[];
  experimental: boolean;
  conversations: Conversation[];
  files: WorkspaceFiles;
  connection: Omit<ProviderConfig, 'apiKey'>;
  preferences?: Preferences;
  workspace?: WorkspaceConfig;
};
export function parseSession(text: string): SavedSession {
  if (text.length > 20000000) throw Error('Session files must be under 20 MB.');
  const x = JSON.parse(text);
  if (x.version !== 1) throw Error('Unsupported session version.');
  const additions = validateRows(x.additions, 'train') as TrainingRow[];
  if (additions.length > 400) throw Error('At most 400 added training examples.');
  if (additions.length) {
    const gate = compareCandidates(
      initialModel,
      fitAdditions(additions),
      corpus.development as Row[],
    );
    if (gate.receipt.wrong_emitted_frames.length || gate.receipt.regressions.length)
      throw Error(
        'Imported training fails the development gate. The current session is unchanged.',
      );
    x.experimental = !!x.experimental || !gate.receipt.approved;
  }
  const p = x.connection;
  if (
    !p ||
    typeof p.baseUrl !== 'string' ||
    p.baseUrl.length > 500 ||
    typeof p.model !== 'string' ||
    p.model.length > 200
  )
    throw Error('Invalid provider settings.');
  return {
    version: 1,
    knowledge: parseKnowledge(x.knowledge),
    additions,
    experimental: !!x.experimental,
    conversations: validateConversations(x.conversations),
    files: validateFiles(x.files),
    connection: {
      apiKeySecret: parseSecretRef(p.apiKeySecret),
      freeOnly: p.freeOnly !== false,
      baseUrl: p.baseUrl,
      model: p.model,
      maxTokens: Math.min(131072, Math.max(128, Number(p.maxTokens) || 8192)),
      temperature: Math.min(2, Math.max(0, Number(p.temperature) || 0)),
      reasoningEffort: [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ].includes(p.reasoningEffort)
        ? p.reasoningEffort
        : 'default',
      customSampling: p.customSampling === true,
      stream: p.stream !== false,
      tokenParameter:
        p.tokenParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
    },
    preferences: parsePreferences(x.preferences),
    workspace: parseWorkspaceConfig(x.workspace),
  };
}
export function fitAdditions(rows: TrainingRow[]): Model {
  return train([...baseRows, ...rows]);
}
