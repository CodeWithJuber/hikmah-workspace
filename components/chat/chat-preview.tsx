'use client';
/** Client wrapper that supplies run configuration and history to the chat.
 *
 * Both are loaded before the chat mounts rather than filled in afterwards.
 * useChat captures its starting messages when the conversation is created, so a
 * transcript that arrives later would never be shown; and a run started against
 * the fallback connection would use the wrong model. Waiting costs one frame and
 * avoids both.
 *
 * The provider key is deliberately absent: the server resolves it from a saved
 * secret name, so the browser never holds it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UIMessage } from 'ai';
import { ChatView } from './chat-view';
import type { Agent } from './agents-panel';
import { HIKMAH_CORE } from '@/lib/playground/agent-prompts';
import { listModels } from '@/lib/playground/transport';
import { priceKind } from '@/lib/playground/model-catalog';
import { defaultProvider } from '@/lib/playground/session';
import type { ChatSettings } from '@/lib/chat/settings';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { HikmahIcon } from '@/components/kernel/icons';

/** The same openers the workspace offers, so the two surfaces do not disagree
 * about what this assistant is for. */
const STARTERS = [
  'Turn my client brief into a clear proposal.',
  'Help me write and adapt content for my audience.',
  'Review code or notes from an attached file.',
];

/** Openers for an agent that has its own kind of work.
 *
 * This is what the workspace's four modes were mostly for: `coding` differed
 * from `chat` by three starter prompts and one sentence appended to the
 * instructions, which is precisely what an agent already is here. Keyed by name
 * rather than id, because the built-in templates are seeded per owner and get a
 * fresh id each time. An agent with nothing listed falls back to the general
 * three, so a custom one is never left with an empty screen. */
const AGENT_STARTERS: Record<string, string[]> = {
  'Code partner': [
    'Build a clean calculator with HTML, CSS and JavaScript.',
    'Create a responsive support request form.',
    'Review my workspace files and suggest improvements.',
  ],
  'Research partner': [
    'Compare two approaches to a reliable support workflow.',
    'Find and cite the primary sources on this question.',
    'Summarise what is settled here and what is still open.',
  ],
  Operations: [
    'Check what is running on my server and report back.',
    'Walk through this deployment and tell me what would break first.',
  ],
};

type RunConfig = {
  baseUrl: string;
  model: string;
  freeOnly: boolean;
  apiKeySecret?: string;
  instructions: string;
};

const FALLBACK: RunConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/free',
  freeOnly: true,
  instructions: HIKMAH_CORE,
};

type Loaded = { config: RunConfig; messages: UIMessage[] };

/** The connection the workspace already has, so this surface talks to the same
 * provider as the rest of the app. */
async function loadConfig(): Promise<RunConfig> {
  // The chat's own settings first. This used to read the workspace blob only,
  // which meant the connection could be set in one place and used in another —
  // and an owner who never opened the workspace got the keyless fallback and a
  // run that failed against the provider.
  try {
    const response = await fetch('/api/chat-settings', { credentials: 'same-origin' });
    if (response.ok) {
      const saved = ((await response.json()) as { settings?: { connection?: SavedConnection } })
        .settings?.connection;
      if (saved?.baseUrl && saved.model)
        return {
          baseUrl: saved.baseUrl,
          model: saved.model,
          freeOnly: saved.freeOnly !== false,
          apiKeySecret: saved.apiKeySecret || undefined,
          instructions: HIKMAH_CORE,
        };
    }
  } catch {
    /* fall through to the workspace's own connection */
  }
  // Then the workspace, so an owner who configured it there before this panel
  // existed is not asked to do it again.
  try {
    const response = await fetch('/api/workspace-state', { credentials: 'same-origin' });
    if (!response.ok) return FALLBACK;
    const payload = (await response.json()) as { session?: string };
    if (!payload?.session) return FALLBACK;
    const saved = JSON.parse(payload.session)?.connection;
    if (!saved?.baseUrl || !saved?.model) return FALLBACK;
    return {
      baseUrl: saved.baseUrl,
      model: saved.model,
      freeOnly: saved.freeOnly !== false,
      apiKeySecret: saved.apiKeySecret || undefined,
      instructions: HIKMAH_CORE,
    };
  } catch {
    // Keep the free-only default; the run route now reports a real error.
    return FALLBACK;
  }
}

type SavedConnection = {
  baseUrl?: string;
  model?: string;
  freeOnly?: boolean;
  apiKeySecret?: string;
};

async function loadMessages(conversationId: string): Promise<UIMessage[]> {
  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        credentials: 'same-origin',
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as { messages?: UIMessage[] };
    return payload.messages ?? [];
  } catch {
    // An unreadable transcript is worth starting without; refusing to open the
    // chat over it would be a worse answer than an empty one.
    return [];
  }
}

export function ChatPreview({
  conversationId,
  agent,
  settings,
  onTools,
  onArtifact,
  onSettled,
}: {
  conversationId: string;
  /** Applied to the next turn: its instructions are added and its tool list
   * narrows what the model is offered. */
  agent?: Agent | null;
  /** The owner's chat preferences, loaded once by the shell. Folded into every
   * turn, so a change applies from the next message rather than needing a
   * reload. */
  settings: ChatSettings;
  /** Saves a change to which tools the run may use. */
  onTools?: (disabledTools: string[]) => Promise<void> | void;
  /** Opens a page an answer produced, in the side panel. */
  onArtifact?: (files: WorkspaceFiles) => void;
  /** Called when a run finishes, so the conversation list can catch up. */
  onSettled?: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [catalog, setCatalog] = useState<{ id: string; label: string; contextWindow?: number }[]>(
    [],
  );
  // Chosen for the next turn only. Null means "whatever the workspace is set
  // to", so changing the saved connection still takes effect here.
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([loadConfig(), loadMessages(conversationId)]).then(([config, messages]) => {
      if (live) setLoaded({ config, messages });
    });
    return () => {
      live = false;
    };
  }, [conversationId]);

  // The catalog is a convenience, not a precondition: a provider that publishes
  // no model list still works, the composer just does not offer a picker. The
  // request carries a secret reference rather than a key, and goes through the
  // relay, so this stays as key-free as the rest of the surface.
  const config = loaded?.config;
  useEffect(() => {
    if (!config) return;
    const controller = new AbortController();
    void listModels(
      {
        ...defaultProvider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKeySecret: config.apiKeySecret,
        freeOnly: config.freeOnly,
      },
      controller.signal,
    )
      .then((rows) => {
        const usable = config.freeOnly ? rows.filter((row) => priceKind(row) === 'free') : rows;
        setCatalog(
          usable
            .map((row) => ({
              id: row.id,
              label: row.name || row.id,
              contextWindow: row.context_length,
            }))
            .slice(0, 200),
        );
      })
      .catch(() => setCatalog([]));
    return () => controller.abort();
  }, [config]);

  const models = useMemo(() => {
    if (!config) return [];
    // The connection's own model belongs in the list even when the catalog does
    // not name it, or the picker would show a value it cannot select back to.
    return catalog.some((row) => row.id === config.model)
      ? catalog
      : [{ id: config.model, label: config.model }, ...catalog];
  }, [catalog, config]);

  const pick = useCallback((model: string) => setChosen(model), []);

  const active = chosen || agent?.model || loaded?.config.model;
  const contextWindow = models.find((row) => row.id === active)?.contextWindow;

  return (
    <main className="chat-preview">
      {/* No page heading here: the topbar already names the app, and a
          paragraph explaining that runs are server-side was repeating an
          implementation detail above every conversation. */}
      {loaded ? (
        <ChatView
          id={conversationId}
          run={{
            ...loaded.config,
            // Appended rather than replacing: the workspace's own instructions
            // say true things about this deployment that an agent should not be
            // able to switch off by accident.
            instructions: agent?.instructions
              ? `${loaded.config.instructions}\n\n${agent.instructions}`
              : loaded.config.instructions,
            enabledTools: agent?.tools?.length ? agent.tools : undefined,
            // The owner's own choice first, then the agent's, then the saved
            // connection: picking an agent should not quietly override a model
            // the owner just selected.
            model: active ?? settings.connection.model ?? loaded.config.model,
            // From the live settings, not the copy read when this mounted:
            // saving a key and sending a message in the same visit has to work,
            // and reading it once meant the run still went out keyless until
            // the owner happened to reload.
            baseUrl: settings.connection.baseUrl || loaded.config.baseUrl,
            freeOnly: settings.connection.freeOnly,
            apiKeySecret: settings.connection.apiKeySecret || loaded.config.apiKeySecret,
            maxSteps: settings.maxSteps,
            contextCharacters: settings.contextCharacters,
            // An agent's allowlist and the owner's off-switches are different
            // decisions: the agent says which tools it works with, the owner
            // says which they will let run at all.
            disabledTools: settings.disabledTools,
          }}
          initialMessages={loaded.messages}
          onSettled={onSettled}
          starters={(agent && AGENT_STARTERS[agent.name]) || STARTERS}
          models={models.length > 1 ? models : []}
          onModel={pick}
          contextWindow={contextWindow}
          showActivity={settings.showActivity}
          onTools={onTools}
          onArtifact={onArtifact}
          empty={
            <div className="chat-greeting">
              <HikmahIcon name="orbit" size={34} />
              <h2>What are we working on?</h2>
            </div>
          }
        />
      ) : (
        // A line of grey text on an empty screen reads as a page that failed,
        // especially on a phone where it sits alone above a metre of white.
        // The skeleton is the shape the transcript is about to take, so the
        // load resolves into the page instead of replacing it.
        <div className="chat-skeleton" aria-busy="true" aria-live="polite">
          <span className="sr-only">Opening your conversation</span>
          <div className="chat-skeleton-turn chat-skeleton-you">
            <span style={{ width: '58%' }} />
          </div>
          <div className="chat-skeleton-turn">
            <span style={{ width: '92%' }} />
            <span style={{ width: '80%' }} />
            <span style={{ width: '86%' }} />
            <span style={{ width: '44%' }} />
          </div>
          <div className="chat-skeleton-turn chat-skeleton-you">
            <span style={{ width: '38%' }} />
          </div>
          <div className="chat-skeleton-turn">
            <span style={{ width: '88%' }} />
            <span style={{ width: '62%' }} />
          </div>
        </div>
      )}
    </main>
  );
}
