'use client';
/** Client wrapper that supplies run configuration to the new chat surface.
 *
 * Configuration still comes from the saved workspace for now. The provider key
 * is deliberately absent: the server resolves it from a saved secret name, so
 * the browser never holds it.
 */
import { useEffect, useState } from 'react';
import { ChatView } from './chat-view';
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

export function ChatPreview() {
  const [config, setConfig] = useState<RunConfig>(FALLBACK);

  useEffect(() => {
    // Read the connection the workspace already has, so this surface talks to
    // the same provider the rest of the app does.
    let cancelled = false;
    fetch('/api/workspace-state', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.session) return;
        const saved = JSON.parse(payload.session)?.connection;
        if (!saved?.baseUrl || !saved?.model) return;
        setConfig({
          baseUrl: saved.baseUrl,
          model: saved.model,
          freeOnly: saved.freeOnly !== false,
          apiKeySecret: saved.apiKeySecret || undefined,
          instructions: HIKMAH_CORE,
        });
      })
      .catch(() => {
        /* Keep the free-only default; the run route reports a real error. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="chat-preview">
      <header className="chat-preview-header">
        <h1>Chat</h1>
        <p>
          Runs on the server: the answer continues even while this tab is busy, and the provider key
          never reaches the browser.
        </p>
      </header>
      <ChatView
        id="workspace-chat"
        run={config}
        empty={<p className="chat-preview-empty">Ask a question to begin.</p>}
      />
    </main>
  );
}
