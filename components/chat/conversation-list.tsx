'use client';
/** The conversation sidebar (desktop drawer).
 *
 * Rendering only: every fetch, poll, and action lives in useConversations,
 * which the native Chats screen shares. What is below is the sidebar chrome
 * the desktop has always worn — unchanged.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import {
  useConversations,
  RECENCY_LABELS,
  RECENCY_ORDER,
  type ConversationSummary,
  type Project,
} from './use-conversations';
/** The summary type lived here before the hook was extracted; re-exported so
 * existing importers keep working. */
export type { ConversationSummary } from './use-conversations';
import { ShareDialog } from './share-dialog';
import { ProjectDialog } from './project-dialog';

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
  const list = useConversations({ activeId, revision, onNew, onConversations });
  const {
    conversations,
    failed,
    busy,
    query,
    setQuery,
    setDeleting,
    deleting,
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
    pinnedChats,
    entriesFor,
    unfiledChats,
    recencyGroups,
    searching,
    visibleProjects,
    tasks,
    startNew,
    remove,
    commitRename,
    togglePin,
    moveToProject,
    submitProjectDialog,
    removeProject,
    retry,
  } = list;

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

  /** One chat row per entry, shared by the flat search list and the recency
   * sections so a row can never drift between the two. */
  const renderRows = (entries: ConversationSummary[]) => (
    <ul>
      {entries.map((conversation) => (
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
  );

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
            <Button size="sm" variant="outline" onClick={retry}>
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
      {!failed &&
        conversations &&
        conversations.length > 0 &&
        !list.chats?.length &&
        !tasks.length && <p className="conversation-note">No conversations match this search.</p>}

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

      {/* Pinned → projects (above) → temporal sections. Searching flattens
          the temporal sections back into one result list. */}
      {searching ? (
        renderRows(unfiledChats ?? [])
      ) : (
        <>
          {RECENCY_ORDER.map((bucket) => {
            const entries = recencyGroups[bucket];
            if (entries.length === 0) return null;
            return (
              <section key={bucket} aria-label={`${RECENCY_LABELS[bucket]} conversations`}>
                <h3 className="conversation-group">{RECENCY_LABELS[bucket]}</h3>
                {renderRows(entries)}
              </section>
            );
          })}
        </>
      )}

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
                  <Trash2 size={12} aria-hidden="true" /> Delete
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
