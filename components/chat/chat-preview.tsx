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

/** The same openers the workspace offers, so the two surfaces do not disagree
 * about what this assistant is for. */
const STARTERS = [
  'Turn my client brief into a clear proposal.',
  'Help me write and adapt content for my audience.',
  'Review code or notes from an attached file.',
];

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
    // Keep the free-only default; the run route reports a real error.
    return FALLBACK;
  }
}

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
  onSettled,
}: {
  conversationId: string;
  /** Applied to the next turn: its instructions are added and its tool list
   * narrows what the model is offered. */
  agent?: Agent | null;
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
            model: active ?? loaded.config.model,
          }}
          initialMessages={loaded.messages}
          onSettled={onSettled}
          starters={STARTERS}
          models={models.length > 1 ? models : []}
          onModel={pick}
          contextWindow={contextWindow}
          empty={<p className="chat-preview-empty">Ask a question to begin.</p>}
        />
      ) : (
        <p className="chat-preview-empty" aria-live="polite">
          Opening your conversation…
        </p>
      )}
    </main>
  );
}
