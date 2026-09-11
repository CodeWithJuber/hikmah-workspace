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
import { useEffect, useState } from 'react';
import type { UIMessage } from 'ai';
import { ChatView } from './chat-view';
import type { Agent } from './agents-panel';
import { HIKMAH_CORE } from '@/lib/playground/agent-prompts';

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

  useEffect(() => {
    let live = true;
    void Promise.all([loadConfig(), loadMessages(conversationId)]).then(([config, messages]) => {
      if (live) setLoaded({ config, messages });
    });
    return () => {
      live = false;
    };
  }, [conversationId]);

  return (
    <main className="chat-preview">
      <header className="chat-preview-header">
        <h1>Chat</h1>
        <p>
          Runs on the server: the answer continues even while this tab is busy, and the provider key
          never reaches the browser.
        </p>
      </header>
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
            // Only when the agent names one, so picking an agent cannot quietly
            // move the conversation to a different provider.
            model: agent?.model || loaded.config.model,
          }}
          initialMessages={loaded.messages}
          onSettled={onSettled}
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
