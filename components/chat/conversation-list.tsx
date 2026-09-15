'use client';
/** The conversation sidebar.
 *
 * Reads from the server rather than from workspace state: conversations are
 * rows now, and the list has to agree with what the runs route will accept.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientFetch } from '@/lib/client/request';

/** How often the list asks again while a background task is working. */
const TASK_POLL_MS = 5000;

export type ConversationSummary = {
  id: string;
  title: string;
  /** A chat, or a background task the owner handed off. */
  mode?: 'chat' | 'task';
  running: boolean;
  /** Stopped mid-answer on a tool that needs the owner's say-so. */
  waiting: 'approval' | 'answer' | null;
  /** How the last run ended, for a task: it has no live tab to say so. */
  ended?: 'done' | 'stopped' | null;
  /** Suggestions a task filed that nobody has looked at yet. */
  toReview?: number;
  updatedAt: string;
};

/** What a task's row says beside its name. */
function taskState(task: ConversationSummary): string {
  if (task.running) return 'Working…';
  if (task.waiting) return 'Waiting for you';
  if (task.ended === 'stopped') return 'Stopped';
  if (task.toReview) return task.toReview === 1 ? '1 to review' : task.toReview + ' to review';
  return task.ended === 'done' ? 'Done' : '';
}

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
  /** The last load did not come back. Separate from the list itself, so a
   * failure never overwrites conversations that are already on screen. */
  const [failed, setFailed] = useState(false);
  /** Bumped by Retry, which is what re-runs the effect below. */
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  // A background task finishes with no tab tailing it, so nothing bumps
  // `revision` on its behalf. While one is working the list asks again on its
  // own; otherwise it is as quiet as it was.
  const [poll, setPoll] = useState(0);
  const working = conversations?.some((entry) => entry.mode === 'task' && entry.running) ?? false;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setPoll((value) => value + 1), TASK_POLL_MS);
    return () => clearInterval(timer);
  }, [working]);

  useEffect(() => {
    // The effect owns the fetch and drops a reply that arrives after this list
    // has moved on, so a slow response cannot overwrite a newer one.
    let live = true;
    void clientFetch('/api/conversations')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { conversations?: ConversationSummary[] };
        if (!live) return;
        setConversations(payload.conversations ?? []);
        setFailed(false);
      })
      .catch(() => {
        // Not an empty list. This used to `setConversations([])`, so a request
        // that failed rendered as "No conversations yet." — telling someone with
        // two hundred conversations that they had none, which is worse than
        // saying nothing. What is on screen stays, and the failure is said out
        // loud with a way to try again.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [revision, poll, attempt]);

  const startNew = useCallback(async () => {
    setBusy(true);
    try {
      const response = await clientFetch('/api/conversations', {
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
      const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, {
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

  // Tasks are listed apart: they were handed off rather than had, and mixing
  // them into the chats would make a finished task look like the last thing
  // the owner said.
  const chats = conversations?.filter((entry) => entry.mode !== 'task');
  const tasks = conversations?.filter((entry) => entry.mode === 'task') ?? [];

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

      {failed ? (
        <p className="conversation-note conversation-failed" role="status">
          Couldn&rsquo;t load your conversations.
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : conversations === null ? (
        <p className="conversation-note">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="conversation-note">No conversations yet.</p>
      ) : null}

      <ul>
        {chats?.map((conversation) => (
          <li key={conversation.id} className={conversation.id === activeId ? 'is-active' : ''}>
            <a href={`/chat/${conversation.id}`} aria-current={conversation.id === activeId}>
              {/* A conversation that opened with a file rather than words has no
                  title, and saying so is more use than calling every one of
                  them the same thing. */}
              <span className="conversation-title">{conversation.title || 'New chat'}</span>
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

      {tasks.length > 0 && (
        <section className="conversation-tasks" aria-label="Background tasks">
          <h3 className="conversation-group">Background tasks</h3>
          <ul>
            {tasks.map((task) => (
              <li key={task.id} className={task.id === activeId ? 'is-active' : ''}>
                <a href={`/chat/${task.id}`} aria-current={task.id === activeId}>
                  <span className="conversation-title">{task.title || 'Untitled task'}</span>
                  <span
                    className={
                      'conversation-task-state' +
                      (task.toReview && !task.running ? ' has-review' : '')
                    }
                  >
                    {taskState(task)}
                  </span>
                </a>
                <button
                  type="button"
                  className="conversation-delete"
                  aria-label={`Delete ${task.title || 'this task'}`}
                  onClick={() => void remove(task.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
