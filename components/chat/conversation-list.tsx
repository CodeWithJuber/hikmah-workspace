'use client';
/** The conversation sidebar.
 *
 * Reads from the server rather than from workspace state: conversations are
 * rows now, and the list has to agree with what the runs route will accept.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export type ConversationSummary = {
  id: string;
  title: string;
  running: boolean;
  /** Stopped mid-answer on a tool that needs the owner's say-so. */
  waiting: 'approval' | 'answer' | null;
  updatedAt: string;
};

export function ConversationList({
  activeId,
  revision,
}: {
  /** The conversation on screen, highlighted in the list. */
  activeId: string;
  /** Bumped by the chat when a run settles, so a new conversation appears with
   * the title it was just given. */
  revision: number;
}) {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The effect owns the fetch and drops a reply that arrives after this list
    // has moved on, so a slow response cannot overwrite a newer one.
    let live = true;
    void fetch('/api/conversations', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { conversations: [] }))
      .then((payload: { conversations?: ConversationSummary[] }) => {
        if (live) setConversations(payload.conversations ?? []);
      })
      .catch(() => {
        if (live) setConversations([]);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const startNew = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const { id } = (await response.json()) as { id?: string };
      // Falling back to the current conversation is better than navigating
      // nowhere: the composer still works and the owner sees why nothing moved.
      if (id) router.push(`/chat/${id}`);
    } finally {
      setBusy(false);
    }
  }, [router]);

  const remove = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return;
      setConversations((current) => current?.filter((entry) => entry.id !== id) ?? null);
      // Standing on a conversation that no longer exists would show an empty
      // chat that cannot be written to, so leave for a fresh one.
      if (id === activeId) router.push('/chat');
      else router.refresh();
    },
    [activeId, router],
  );

  return (
    <nav className="conversation-list" aria-label="Conversations">
      <button
        type="button"
        className="conversation-new"
        onClick={() => void startNew()}
        disabled={busy}
      >
        New chat
      </button>

      {conversations === null && <p className="conversation-note">Loading…</p>}
      {conversations?.length === 0 && <p className="conversation-note">No conversations yet.</p>}

      <ul>
        {conversations?.map((conversation) => (
          <li key={conversation.id} className={conversation.id === activeId ? 'is-active' : ''}>
            <a href={`/chat/${conversation.id}`} aria-current={conversation.id === activeId}>
              {/* A conversation that opened with a file rather than words has no
                  title, and saying so is more use than calling every one of
                  them the same thing. */}
              <span className="conversation-title">{conversation.title || 'Untitled'}</span>
              {/* A paused run needs the owner, not patience, so it is not shown
                  as if it were working. */}
              {conversation.waiting && (
                <span
                  className="conversation-waiting"
                  title={
                    conversation.waiting === 'approval'
                      ? 'Waiting for your approval'
                      : 'Waiting for your answer'
                  }
                >
                  Waiting for you
                </span>
              )}
              {conversation.running && !conversation.waiting && (
                <span className="conversation-running" title="Still answering">
                  ●
                </span>
              )}
            </a>
            <button
              type="button"
              className="conversation-delete"
              aria-label={`Delete ${conversation.title || 'this conversation'}`}
              onClick={() => void remove(conversation.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
