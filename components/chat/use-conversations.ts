'use client';
/** The conversation list's data and actions, without any rendering.
 *
 * Extracted from ConversationList so the native Chats screen (mobile
 * full-screen list) and the desktop drawer share one source of truth: one
 * fetch, one poll loop, one set of rename/pin/move/delete actions. The two
 * renderers only differ in chrome — the drawer keeps its sidebar classes,
 * the Chats screen wears the native ones.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { clientFetch } from '@/lib/client/request';
import { groupByRecency, RECENCY_ORDER } from '@/lib/chat/grouping';

export { RECENCY_ORDER };
export { RECENCY_LABELS } from '@/lib/chat/grouping';

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
  /** Pinned chats float to the top of the sidebar, in their own section. */
  pinned?: boolean;
  /** Which project folder this conversation is filed in, if any. */
  projectId?: string | null;
  /** The last message's preview line, for the native Chats screen. */
  snippet?: string;
  /** Who wrote the last message — 'user', 'assistant', or a tool role. */
  snippetRole?: string | null;
};

export type Project = {
  id: string;
  name: string;
  conversationCount: number;
};

export type ProjectDialogState = { mode: 'create' } | { mode: 'rename'; id: string; name: string };

export function useConversations({
  activeId,
  revision,
  onNew,
  onConversations,
}: {
  /** The conversation on screen, highlighted in the list. */
  activeId: string;
  /** Bumped by the chat when a run settles, so a new conversation appears with
   * the title it was just given. */
  revision: number;
  onNew?: () => Promise<void>;
  onConversations?: (rows: ConversationSummary[]) => void;
}) {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  /** The last load did not come back. Separate from the list itself, so a
   * failure never overwrites conversations that are already on screen. */
  const [failed, setFailed] = useState(false);
  /** Bumped by Retry, which is what re-runs the effect below. */
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const [removing, setRemoving] = useState(false);
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

  // Chat v2 organization state. Projects load next to the conversations; if
  // they fail, the conversations still stand — organization is additive, and a
  // failed projects request must never take the list down with it.
  const [projects, setProjects] = useState<Project[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<ConversationSummary | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projectSaving, setProjectSaving] = useState(false);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [removingProject, setRemovingProject] = useState(false);

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
    void clientFetch('/api/projects')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { projects?: Project[] };
        if (!live) return;
        setProjects(payload.projects ?? []);
      })
      .catch(() => {
        // Projects are additive chrome around the list. Losing them is a
        // missing convenience, not a missing conversation, so the failure is
        // swallowed here rather than shown.
      });
    return () => {
      live = false;
    };
  }, [revision, poll, attempt]);

  useEffect(() => {
    if (conversations) onConversations?.(conversations);
  }, [conversations, onConversations]);

  const startNew = useCallback(async () => {
    setBusy(true);
    try {
      if (onNew) {
        await onNew();
        return;
      }
      const response = await clientFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const { id } = (await response.json()) as { id?: string };
      // Falling back to the current conversation is better than navigating
      // nowhere: the composer still works and the owner sees why nothing moved.
      if (!response.ok || !id) throw new Error('Could not start a conversation. Try again.');
      router.push(`/chat/${id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start a conversation.');
    } finally {
      setBusy(false);
    }
  }, [router, onNew]);

  const remove = useCallback(
    async (id: string) => {
      setRemoving(true);
      try {
        const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) throw new Error('Could not delete this conversation. Try again.');
        setConversations((current) => current?.filter((entry) => entry.id !== id) ?? null);
        setDeleting(null);
        // Standing on a conversation that no longer exists would show an empty
        // chat that cannot be written to, so leave for a fresh one.
        if (id === activeId) router.push('/chat');
        else router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not delete the conversation.');
      } finally {
        setRemoving(false);
      }
    },
    [activeId, router],
  );

  /** Apply a rename/pin/move to one conversation, then mirror it locally so
   * the list answers at once instead of waiting for the next poll. */
  const patchConversation = useCallback(
    async (
      id: string,
      patch: { title?: string; pinned?: boolean; projectId?: string | null },
      apply: (entry: ConversationSummary) => ConversationSummary,
      failure: string,
    ) => {
      const response = await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(failure);
      setConversations(
        (current) => current?.map((entry) => (entry.id === id ? apply(entry) : entry)) ?? null,
      );
    },
    [],
  );

  const commitRename = useCallback(
    (entry: ConversationSummary, title: string) => {
      setRenamingId(null);
      const trimmed = title.trim();
      if (!trimmed || trimmed === entry.title) return;
      void patchConversation(
        entry.id,
        { title: trimmed },
        (current) => ({ ...current, title: trimmed }),
        'Could not rename this conversation. Try again.',
      ).catch((error: Error) => toast.error(error.message));
    },
    [patchConversation],
  );

  const togglePin = useCallback(
    (entry: ConversationSummary) => {
      const pinned = !entry.pinned;
      void patchConversation(
        entry.id,
        { pinned },
        (current) => ({ ...current, pinned }),
        'Could not pin this conversation. Try again.',
      ).catch((error: Error) => toast.error(error.message));
    },
    [patchConversation],
  );

  const moveToProject = useCallback(
    (entry: ConversationSummary, projectId: string | null) => {
      void patchConversation(
        entry.id,
        { projectId },
        (current) => ({ ...current, projectId }),
        'Could not move this conversation. Try again.',
      ).catch((error: Error) => toast.error(error.message));
    },
    [patchConversation],
  );

  const submitProjectDialog = useCallback(
    async (name: string) => {
      if (!projectDialog) return;
      setProjectSaving(true);
      try {
        if (projectDialog.mode === 'create') {
          const response = await clientFetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!response.ok) throw new Error('Could not create the project.');
          const { project } = (await response.json()) as { project?: Project };
          if (!project) throw new Error('Could not create the project.');
          setProjects((current) => [project, ...current]);
        } else {
          const response = await clientFetch(
            `/api/projects/${encodeURIComponent(projectDialog.id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            },
          );
          if (!response.ok) throw new Error('Could not rename the project.');
          setProjects((current) =>
            current.map((project) =>
              project.id === projectDialog.id ? { ...project, name } : project,
            ),
          );
        }
        setProjectDialog(null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not save the project.');
      } finally {
        setProjectSaving(false);
      }
    },
    [projectDialog],
  );

  const removeProject = useCallback(async (project: Project) => {
    setRemovingProject(true);
    try {
      const response = await clientFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error('Could not delete the project. Try again.');
      setProjects((current) => current.filter((entry) => entry.id !== project.id));
      // Deleting a project unfiles its conversations; the server does this
      // through ON DELETE SET NULL, and the list mirrors it.
      setConversations(
        (current) =>
          current?.map((entry) =>
            entry.projectId === project.id ? { ...entry, projectId: null } : entry,
          ) ?? null,
      );
      setDeletingProject(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the project.');
    } finally {
      setRemovingProject(false);
    }
  }, []);

  // Tasks are listed apart: they were handed off rather than had, and mixing
  // them into the chats would make a finished task look like the last thing
  // the owner said.
  const matches = (entry: ConversationSummary) =>
    !query.trim() || entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const chats = conversations?.filter((entry) => entry.mode !== 'task' && matches(entry));
  const tasks = conversations?.filter((entry) => entry.mode === 'task' && matches(entry)) ?? [];

  // Pinned chats get their own section on top; filed chats live under their
  // project; the rest stay where they always were. A pinned chat shows only in
  // the pinned section, so unpinning is what returns it to its project.
  const pinnedChats = chats?.filter((entry) => entry.pinned) ?? [];
  const entriesFor = (projectId: string) =>
    chats?.filter((entry) => !entry.pinned && entry.projectId === projectId) ?? [];
  const unfiledChats = chats?.filter((entry) => !entry.pinned && !entry.projectId);
  // Temporal sections are recency buckets on Dubai-calendar days (the
  // owner's timezone); while a search is running the list stays flat,
  // because sections would fight the query.
  const recencyGroups = groupByRecency(unfiledChats ?? []);
  const searching = query.trim().length > 0;
  // With a search running, a project section shows only when it has something
  // to show; without one, empty projects stay visible so they can be renamed,
  // deleted, or filled.
  const visibleProjects = query.trim()
    ? projects.filter((project) => entriesFor(project.id).length > 0)
    : projects;

  return {
    conversations,
    failed,
    busy,
    query,
    setQuery,
    deleting,
    setDeleting,
    removing,
    projects,
    renamingId,
    setRenamingId,
    shareFor,
    setShareFor,
    projectDialog,
    setProjectDialog,
    projectSaving,
    deletingProject,
    setDeletingProject,
    removingProject,
    chats,
    tasks,
    pinnedChats,
    entriesFor,
    unfiledChats,
    recencyGroups,
    searching,
    visibleProjects,
    startNew,
    remove,
    commitRename,
    togglePin,
    moveToProject,
    submitProjectDialog,
    removeProject,
    retry: () => setAttempt((n) => n + 1),
  };
}
