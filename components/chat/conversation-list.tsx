'use client';
/** The conversation sidebar.
 *
 * Reads from the server rather than from workspace state: conversations are
 * rows now, and the list has to agree with what the runs route will accept.
 *
 * Chat v2 organization lives here too: pinned chats float to the top, projects
 * are collapsible folders a conversation can be filed into, and each row gets
 * rename / pin / share / move actions. All of it is additive — the tasks
 * section, the delete flow, search, skeletons, and the polling below are
 * exactly what they were.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronDown,
  FolderPlus,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Scale,
  Search,
  Share2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { clientFetch } from '@/lib/client/request';
import { ShareDialog } from './share-dialog';
import { ProjectDialog } from './project-dialog';

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
};

type Project = {
  id: string;
  name: string;
  conversationCount: number;
};

/** What a task's row says beside its name. */
function taskState(task: ConversationSummary): string {
  if (task.running) return 'Working…';
  if (task.waiting) return 'Waiting for you';
  if (task.ended === 'stopped') return 'Stopped';
  if (task.toReview) return task.toReview === 1 ? '1 to review' : task.toReview + ' to review';
  return task.ended === 'done' ? 'Done' : '';
}

/** The inline rename field. Local draft state, so typing never re-renders the
 * whole list; Enter commits through the parent, Escape backs out. */
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus on mount, via ref rather than the autoFocus prop.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Input
      ref={inputRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      aria-label="Conversation name"
      maxLength={200}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft);
        else if (event.key === 'Escape') onCancel();
      }}
      onBlur={onCancel}
      className="conversation-rename"
    />
  );
}

/** One chat row: the link (or the rename field), plus its actions. The waiting
 * and running badges are the same ones the row always wore. */
function ChatRow({
  entry,
  activeId,
  renaming,
  projects,
  onActivate,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onShare,
  onMove,
  onDelete,
}: {
  entry: ConversationSummary;
  activeId: string;
  renaming: boolean;
  projects: Project[];
  onActivate?: () => void;
  onBeginRename: (entry: ConversationSummary) => void;
  onCommitRename: (entry: ConversationSummary, title: string) => void;
  onCancelRename: () => void;
  onTogglePin: (entry: ConversationSummary) => void;
  onShare: (entry: ConversationSummary) => void;
  onMove: (entry: ConversationSummary, projectId: string | null) => void;
  onDelete: (entry: ConversationSummary) => void;
}) {
  const title = entry.title || 'New chat';
  return (
    <li className={entry.id === activeId ? 'is-active' : ''}>
      {renaming ? (
        <RenameField
          initial={entry.title}
          onCommit={(next) => onCommitRename(entry, next)}
          onCancel={onCancelRename}
        />
      ) : (
        <Link href={`/chat/${entry.id}`} onClick={onActivate} aria-current={entry.id === activeId}>
          {/* A conversation that opened with a file rather than words has no
              title, and saying so is more use than calling every one of
              them the same thing. */}
          <span className="conversation-title">{title}</span>
          {/* A paused run needs the owner, not patience, so it is not shown
              as if it were working. */}
          {entry.waiting && (
            <span
              className="conversation-waiting"
              title={
                entry.waiting === 'approval'
                  ? 'Waiting for your approval'
                  : 'Waiting for your answer'
              }
            >
              Waiting for you
            </span>
          )}
          {entry.running && !entry.waiting && (
            <span className="conversation-running" title="Still answering">
              ●
            </span>
          )}
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`More actions for ${title}`}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onBeginRename(entry)}>
            <Pencil size={16} aria-hidden="true" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onTogglePin(entry)}>
            {entry.pinned ? (
              <PinOff size={16} aria-hidden="true" />
            ) : (
              <Pin size={16} aria-hidden="true" />
            )}
            {entry.pinned ? 'Unpin' : 'Pin to top'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShare(entry)}>
            <Share2 size={16} aria-hidden="true" /> Share
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput size={16} aria-hidden="true" /> Move to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {projects.length === 0 && (
                <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
              )}
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => onMove(entry, project.id)}
                  disabled={entry.projectId === project.id}
                >
                  {project.name}
                </DropdownMenuItem>
              ))}
              {entry.projectId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onMove(entry, null)}>
                    Remove from project
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`Delete ${title}`}
        onClick={() => onDelete(entry)}
      >
        <Trash2 size={12} aria-hidden="true" />
      </Button>
    </li>
  );
}

/** One collapsible project folder with its chats, and the folder's own
 * rename/delete menu. Own open state, so toggling one never touches the
 * others. */
function ProjectSection({
  project,
  entries,
  activeId,
  renamingId,
  projects,
  onActivate,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onShare,
  onMove,
  onDelete,
  onRenameProject,
  onDeleteProject,
}: {
  project: Project;
  entries: ConversationSummary[];
  activeId: string;
  renamingId: string | null;
  projects: Project[];
  onActivate?: () => void;
  onBeginRename: (entry: ConversationSummary) => void;
  onCommitRename: (entry: ConversationSummary, title: string) => void;
  onCancelRename: () => void;
  onTogglePin: (entry: ConversationSummary) => void;
  onShare: (entry: ConversationSummary) => void;
  onMove: (entry: ConversationSummary, projectId: string | null) => void;
  onDelete: (entry: ConversationSummary) => void;
  onRenameProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="conversation-project">
      <div className="conversation-project-header">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="flex-1 justify-start gap-2"
            aria-label={`${open ? 'Collapse' : 'Expand'} project ${project.name}`}
          >
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={open ? '' : 'conversation-project-collapsed'}
            />
            <span className="conversation-project-name">{project.name}</span>
            <span className="conversation-project-count">{entries.length}</span>
          </Button>
        </CollapsibleTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`More actions for project ${project.name}`}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRenameProject(project)}>
              <Pencil size={16} aria-hidden="true" /> Rename project
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDeleteProject(project)}
              className="text-destructive"
            >
              <Trash2 size={16} aria-hidden="true" /> Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CollapsibleContent>
        {entries.length > 0 ? (
          <ul>
            {entries.map((entry) => (
              <ChatRow
                key={entry.id}
                entry={entry}
                activeId={activeId}
                renaming={renamingId === entry.id}
                projects={projects}
                onActivate={onActivate}
                onBeginRename={onBeginRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onTogglePin={onTogglePin}
                onShare={onShare}
                onMove={onMove}
                onDelete={onDelete}
              />
            ))}
          </ul>
        ) : (
          <p className="conversation-note">
            Nothing filed here yet. Open the{' '}
            <MoreHorizontal size={12} aria-hidden="true" className="inline" /> menu on any
            conversation and choose “Move to project” to file it.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConversationList({
  activeId,
  revision,
  onNew,
  navigation,
  onConversations,
  onActivate,
}: {
  /** The conversation on screen, highlighted in the list. */
  activeId: string;
  /** Bumped by the chat when a run settles, so a new conversation appears with
   * the title it was just given. */
  revision: number;
  onNew?: () => Promise<void>;
  navigation?: ReactNode;
  onConversations?: (rows: ConversationSummary[]) => void;
  onActivate?: () => void;
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
  const [projectDialog, setProjectDialog] = useState<
    { mode: 'create' } | { mode: 'rename'; id: string; name: string } | null
  >(null);
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
   * the sidebar answers at once instead of waiting for the next poll. */
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
  // With a search running, a project section shows only when it has something
  // to show; without one, empty projects stay visible so they can be renamed,
  // deleted, or filled.
  const visibleProjects = query.trim()
    ? projects.filter((project) => entriesFor(project.id).length > 0)
    : projects;

  const rowHandlers = {
    onActivate,
    onBeginRename: (entry: ConversationSummary) => setRenamingId(entry.id),
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingId(null),
    onTogglePin: togglePin,
    onShare: (entry: ConversationSummary) => setShareFor(entry),
    onMove: moveToProject,
    onDelete: (entry: ConversationSummary) => setDeleting(entry),
  };

  return (
    <nav className="conversation-list" aria-label="Conversations">
      <Button
        type="button"
        className="w-full justify-start"
        onClick={() => void startNew()}
        disabled={busy}
      >
        <Plus size={16} aria-hidden="true" /> {busy ? 'Opening…' : 'New chat'}
      </Button>
      {/* Compare is a chat mode, not a destination: it lives where the
          conversations live, one tap under New chat. */}
      <Button type="button" variant="outline" className="w-full justify-start" asChild>
        <Link href="/compare">
          <Scale size={16} aria-hidden="true" /> Compare answers
        </Link>
      </Button>

      <label className="workspace-conversation-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
        />
      </label>
      {navigation}
      <h2 className="workspace-history-heading">Recent conversations</h2>

      {failed ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>Couldn&rsquo;t load your conversations.</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : conversations === null ? (
        <div
          className="conversation-note grid gap-2"
          role="status"
          aria-label="Loading conversations"
        >
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      ) : conversations.length === 0 ? (
        <>
          <p className="conversation-note">Your conversations appear here.</p>
          <p className="conversation-note conversation-hint">
            Start with New chat above — ask anything, and it will show up in this list.
          </p>
        </>
      ) : null}
      {!failed && conversations && conversations.length > 0 && !chats?.length && !tasks.length && (
        <p className="conversation-note">No conversations match this search.</p>
      )}

      {pinnedChats.length > 0 && (
        <section className="conversation-pinned" aria-label="Pinned conversations">
          <h3 className="conversation-group">Pinned</h3>
          <ul>
            {pinnedChats.map((conversation) => (
              <ChatRow
                key={conversation.id}
                entry={conversation}
                activeId={activeId}
                renaming={renamingId === conversation.id}
                projects={projects}
                {...rowHandlers}
              />
            ))}
          </ul>
        </section>
      )}

      {visibleProjects.map((project) => (
        <ProjectSection
          key={project.id}
          project={{ ...project, conversationCount: entriesFor(project.id).length }}
          entries={entriesFor(project.id)}
          activeId={activeId}
          renamingId={renamingId}
          projects={projects}
          {...rowHandlers}
          onRenameProject={(entry) =>
            setProjectDialog({ mode: 'rename', id: entry.id, name: entry.name })
          }
          onDeleteProject={(entry) => setDeletingProject(entry)}
        />
      ))}

      <ul>
        {unfiledChats?.map((conversation) => (
          <ChatRow
            key={conversation.id}
            entry={conversation}
            activeId={activeId}
            renaming={renamingId === conversation.id}
            projects={projects}
            {...rowHandlers}
          />
        ))}
      </ul>

      {conversations !== null && !failed && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="conversation-new-project"
          onClick={() => setProjectDialog({ mode: 'create' })}
        >
          <FolderPlus size={16} aria-hidden="true" /> New project
        </Button>
      )}

      {tasks.length > 0 && (
        <section className="conversation-tasks" aria-label="Background tasks">
          <h3 className="conversation-group">Background tasks</h3>
          <ul>
            {tasks.map((task) => (
              <li key={task.id} className={task.id === activeId ? 'is-active' : ''}>
                <Link
                  href={`/chat/${task.id}`}
                  onClick={onActivate}
                  aria-current={task.id === activeId}
                >
                  <span className="conversation-title">{task.title || 'Untitled task'}</span>
                  <span
                    className={
                      'conversation-task-state' +
                      (task.toReview && !task.running ? ' has-review' : '')
                    }
                  >
                    {taskState(task)}
                  </span>
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Delete ${task.title || 'this task'}`}
                  onClick={() => setDeleting(task)}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !removing) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.title || 'Untitled conversation'}” and its messages will be permanently
              deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Keep conversation</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void remove(deleting.id);
              }}
            >
              {removing ? 'Deleting…' : 'Delete conversation'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deletingProject)}
        onOpenChange={(open) => {
          if (!open && !removingProject) setDeletingProject(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deletingProject?.name}” will be deleted, but its conversations stay — they move back
              to the unfiled list. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingProject}>Keep project</AlertDialogCancel>
            <AlertDialogAction
              disabled={removingProject}
              onClick={(event) => {
                event.preventDefault();
                if (deletingProject) void removeProject(deletingProject);
              }}
            >
              {removingProject ? 'Deleting…' : 'Delete project'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProjectDialog
        open={projectDialog !== null}
        onOpenChange={(open) => {
          if (!open && !projectSaving) setProjectDialog(null);
        }}
        mode={projectDialog?.mode ?? 'create'}
        initialName={projectDialog?.mode === 'rename' ? projectDialog.name : undefined}
        saving={projectSaving}
        onSubmit={(name) => void submitProjectDialog(name)}
      />

      <ShareDialog
        conversationId={shareFor?.id ?? null}
        conversationTitle={shareFor?.title ?? ''}
        open={shareFor !== null}
        onOpenChange={(open) => {
          if (!open) setShareFor(null);
        }}
      />
    </nav>
  );
}
