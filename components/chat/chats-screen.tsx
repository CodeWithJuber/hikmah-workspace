'use client';
/** The native Chats screen: the mobile full-screen conversation list.
 *
 * Shares useConversations with the desktop drawer — one fetch, one poll
 * loop, one set of actions — and wears the native primitives instead of the
 * sidebar chrome: a frosted header with compose, sticky search, 68px rows
 * with avatar, preview line and time rail, and a long-press action sheet.
 */
import { useRef, useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check,
  ChevronLeft,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Search,
  Share2,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import {
  useConversations,
  RECENCY_LABELS,
  RECENCY_ORDER,
  type ConversationSummary,
  type Project,
} from './use-conversations';
import { relativeTime } from '@/lib/chat/relative-time';
import { ShareDialog } from './share-dialog';

/** Long-press opens the row's action sheet; the tap that follows a long-press
 * is swallowed so the row never navigates by accident. Right-click is
 * suppressed for the same reason on desktop. 550ms: long enough to be
 * deliberate, short enough to feel instant on a phone. */
const LONG_PRESS_MS = 550;
function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  return {
    onTouchStart: () => {
      fired.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, ms);
    },
    onTouchMove: clear,
    onTouchEnd: clear,
    onTouchCancel: clear,
    onContextMenu: (event: React.SyntheticEvent) => event.preventDefault(),
    onClickCapture: (event: React.SyntheticEvent) => {
      if (fired.current) {
        event.preventDefault();
        event.stopPropagation();
        fired.current = false;
      }
    },
  };
}

/** A stable 0–3 from the id, so a conversation keeps its tint across loads. */
function tintFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 4;
}

/** One 68px row: avatar, title + preview, time + status rail. */
function ChatRow({
  entry,
  index,
  onLongPress,
}: {
  entry: ConversationSummary;
  index: number;
  onLongPress: (entry: ConversationSummary) => void;
}) {
  const press = useLongPress(() => onLongPress(entry));
  const title = entry.title || 'New chat';
  const preview = entry.snippet
    ? entry.snippetRole === 'user'
      ? `You: ${entry.snippet}`
      : entry.snippet
    : '';
  return (
    <li style={{ '--i': index } as CSSProperties}>
      <Link
        href={`/chat/${entry.id}`}
        className="n-row n-press-tint"
        aria-label={`${title}${preview ? `, ${preview}` : ''}`}
        {...press}
      >
        <span className={`n-row-avatar n-av-${tintFor(entry.id)}`} aria-hidden="true">
          {(title[0] ?? 'N').toUpperCase()}
        </span>
        <span className="n-row-body">
          <span className="n-row-title">{title}</span>
          {preview ? (
            <span className="n-row-snippet">{preview}</span>
          ) : (
            <span className="n-row-snippet n-row-snippet-empty">No messages yet</span>
          )}
        </span>
        <span className="n-row-side">
          <span className="n-row-time">{relativeTime(entry.updatedAt)}</span>
          {entry.waiting ? (
            <span className="n-badge">Waiting</span>
          ) : entry.running ? (
            <span className="n-dot" title="Still answering" aria-label="Still answering" />
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/** One task row: the task's state reads as its preview line. */
function TaskRow({ entry, index }: { entry: ConversationSummary; index: number }) {
  const state = entry.running
    ? 'Working…'
    : entry.waiting
      ? 'Waiting for you'
      : entry.ended === 'stopped'
        ? 'Stopped'
        : entry.toReview
          ? entry.toReview === 1
            ? '1 to review'
            : `${entry.toReview} to review`
          : 'Done';
  return (
    <li style={{ '--i': index } as CSSProperties}>
      <Link
        href={`/chat/${entry.id}`}
        className="n-row n-press-tint"
        aria-label={`${entry.title || 'Untitled task'}, ${state}`}
      >
        <span className="n-row-avatar n-av-1" aria-hidden="true">
          {(entry.title?.[0] ?? 'T').toUpperCase()}
        </span>
        <span className="n-row-body">
          <span className="n-row-title">{entry.title || 'Untitled task'}</span>
          <span className="n-row-snippet">{state}</span>
        </span>
        <span className="n-row-side">
          <span className="n-row-time">{relativeTime(entry.updatedAt)}</span>
          {entry.running ? (
            <span className="n-dot" title="Working" aria-label="Working" />
          ) : entry.toReview && !entry.running ? (
            <span className="n-badge">{entry.toReview}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="n-section-title">{title}</h2>
      <ul className="n-list n-stagger">{children}</ul>
    </section>
  );
}

type SheetMode = 'menu' | 'rename' | 'move' | 'delete';

/** The rename step, mounted only when the sheet is in rename mode so its
 * mount effect can take focus — the autoFocus prop is a no-go here. */
function RenameStep({
  initial,
  onBack,
  onCommit,
}: {
  initial: string;
  onBack: () => void;
  onCommit: (title: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const valid = draft.trim().length > 0 && draft.trim() !== initial;
  return (
    <>
      <div className="n-sheet-scroll">
        <label className="n-sheet-field">
          <span>Conversation name</span>
          <input
            ref={inputRef}
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && valid) onCommit(draft);
            }}
          />
        </label>
      </div>
      <div className="n-sheet-foot">
        <button type="button" className="n-cta n-cta-ghost" onClick={onBack}>
          <ChevronLeft size={16} /> Back
        </button>
        <button type="button" className="n-cta" disabled={!valid} onClick={() => onCommit(draft)}>
          Save
        </button>
      </div>
    </>
  );
}

/** The long-press action sheet: pin, rename, share, file, delete. */
function ConversationSheet({
  entry,
  projects,
  onClose,
  onTogglePin,
  onCommitRename,
  onShare,
  onMove,
  onDelete,
}: {
  entry: ConversationSummary | null;
  projects: Project[];
  onClose: () => void;
  onTogglePin: (entry: ConversationSummary) => void;
  onCommitRename: (entry: ConversationSummary, title: string) => void;
  onShare: (entry: ConversationSummary) => void;
  onMove: (entry: ConversationSummary, projectId: string | null) => void;
  onDelete: (id: string) => void;
}) {
  // The parent keys this sheet by conversation id, so state starts fresh per
  // row — no render-time resets, no stale modes leaking between rows.
  const [mode, setMode] = useState<SheetMode>('menu');
  const open = entry !== null;

  const close = () => {
    setMode('menu');
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="n-sheet-overlay" />
        <Dialog.Content className="n-sheet" aria-describedby={undefined}>
          <span className="n-sheet-handle" aria-hidden="true" />
          <Dialog.Title className="n-sheet-title">{entry?.title || 'New chat'}</Dialog.Title>
          {mode === 'menu' && entry && (
            <div className="n-sheet-scroll">
              <button
                type="button"
                className="n-action-row"
                onClick={() => {
                  onTogglePin(entry);
                  close();
                }}
              >
                {entry.pinned ? <PinOff size={20} /> : <Pin size={20} />}
                {entry.pinned ? 'Unpin from top' : 'Pin to top'}
              </button>
              <button type="button" className="n-action-row" onClick={() => setMode('rename')}>
                <Pencil size={20} /> Rename
              </button>
              <button
                type="button"
                className="n-action-row"
                onClick={() => {
                  onShare(entry);
                  close();
                }}
              >
                <Share2 size={20} /> Share
              </button>
              <button type="button" className="n-action-row" onClick={() => setMode('move')}>
                <FolderInput size={20} /> Move to project
              </button>
              <button
                type="button"
                className="n-action-row is-destructive"
                onClick={() => setMode('delete')}
              >
                <Trash2 size={20} /> Delete
              </button>
            </div>
          )}
          {mode === 'rename' && entry && (
            <RenameStep
              initial={entry.title}
              onBack={() => setMode('menu')}
              onCommit={(title) => {
                onCommitRename(entry, title);
                close();
              }}
            />
          )}
          {mode === 'move' && entry && (
            <div className="n-sheet-scroll">
              {projects.length === 0 && (
                <p className="n-sheet-note">No projects yet — create one from the sidebar.</p>
              )}
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="n-action-row"
                  disabled={entry.projectId === project.id}
                  onClick={() => {
                    onMove(entry, project.id);
                    close();
                  }}
                >
                  {entry.projectId === project.id ? (
                    <Check size={20} />
                  ) : (
                    <span className="n-action-gap" />
                  )}
                  {project.name}
                </button>
              ))}
              {entry.projectId && (
                <button
                  type="button"
                  className="n-action-row"
                  onClick={() => {
                    onMove(entry, null);
                    close();
                  }}
                >
                  <X size={20} /> Remove from project
                </button>
              )}
            </div>
          )}
          {mode === 'delete' && entry && (
            <div className="n-sheet-scroll">
              <p className="n-sheet-note">
                “{entry.title || 'Untitled conversation'}” and its messages will be permanently
                deleted. This cannot be undone.
              </p>
            </div>
          )}
          {mode !== 'rename' && (
            <div className="n-sheet-foot">
              {mode === 'menu' ? (
                <button type="button" className="n-cta n-cta-ghost" onClick={close}>
                  Cancel
                </button>
              ) : mode === 'delete' && entry ? (
                <>
                  <button
                    type="button"
                    className="n-cta n-cta-ghost"
                    onClick={() => setMode('menu')}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="n-cta n-cta-destructive"
                    onClick={() => {
                      onDelete(entry.id);
                      close();
                    }}
                  >
                    Delete conversation
                  </button>
                </>
              ) : (
                <button type="button" className="n-cta n-cta-ghost" onClick={() => setMode('menu')}>
                  <ChevronLeft size={16} /> Back
                </button>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The mobile Chats screen. Full-screen native list; row tap opens the chat. */
export function ChatsScreen() {
  const list = useConversations({ activeId: '', revision: 0 });
  const {
    conversations,
    failed,
    busy,
    query,
    setQuery,
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
    setShareFor,
    shareFor,
    projects,
    retry,
  } = list;
  const [sheetFor, setSheetFor] = useState<ConversationSummary | null>(null);

  // Sections in display order. The stagger index runs down the whole screen
  // rather than restarting per section, so the list walks in as one cascade.
  const rawSections: {
    key: string;
    title: string;
    kind: 'chat' | 'task';
    entries: ConversationSummary[];
  }[] = [
    ...(pinnedChats.length > 0
      ? [{ key: 'pinned', title: 'Pinned', kind: 'chat' as const, entries: pinnedChats }]
      : []),
    ...visibleProjects.flatMap((project) => {
      const entries = entriesFor(project.id);
      return entries.length > 0
        ? [{ key: project.id, title: project.name, kind: 'chat' as const, entries }]
        : [];
    }),
    ...(searching
      ? [{ key: 'results', title: 'Results', kind: 'chat' as const, entries: unfiledChats ?? [] }]
      : RECENCY_ORDER.flatMap((bucket) => {
          const entries = recencyGroups[bucket];
          return entries.length > 0
            ? [{ key: bucket, title: RECENCY_LABELS[bucket], kind: 'chat' as const, entries }]
            : [];
        })),
    ...(tasks.length > 0
      ? [{ key: 'tasks', title: 'Background tasks', kind: 'task' as const, entries: tasks }]
      : []),
  ];
  // Section start indexes, derived without mutation: section si starts where
  // the previous sections' rows end.
  const sectionStarts = rawSections.reduce<number[]>(
    (acc, s) => [...acc, (acc.length > 0 ? acc[acc.length - 1] : 0) + s.entries.length],
    [],
  );
  const startOf = (si: number) => (si === 0 ? 0 : sectionStarts[si - 1]);

  return (
    <div className="n-page n-screen-in">
      <header className="n-header">
        <h1>Chats</h1>
        <div className="n-header-actions">
          <button
            type="button"
            className="n-icon-btn n-press"
            aria-label="Start a new chat"
            disabled={busy}
            onClick={() => void startNew()}
          >
            <SquarePen size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="n-search n-search-sticky" role="search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
        {query && (
          <button
            type="button"
            className="n-search-clear"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {failed ? (
        <div className="n-error" role="alert">
          <h2>Couldn’t load your chats</h2>
          <p>Check your connection and try again — nothing was lost.</p>
          <button type="button" className="n-cta" onClick={retry}>
            Try again
          </button>
        </div>
      ) : conversations === null ? (
        <ul className="n-list" aria-label="Loading chats">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="n-row" aria-hidden="true">
              <span className="n-row-avatar n-shimmer-line" />
              <span className="n-row-body">
                <span className="n-shimmer-line" style={{ width: '55%' }} />
                <span className="n-shimmer-line" style={{ width: '80%' }} />
              </span>
            </li>
          ))}
        </ul>
      ) : conversations.length === 0 ? (
        <div className="n-empty">
          <h2>No chats yet</h2>
          <p>Ask anything — your conversations will appear here.</p>
          <button type="button" className="n-cta" onClick={() => void startNew()} disabled={busy}>
            {busy ? 'Opening…' : 'Start a chat'}
          </button>
        </div>
      ) : (
        <>
          {rawSections.map((section, si) =>
            section.kind === 'task' ? (
              <Section key={section.key} title={section.title}>
                {section.entries.map((task, i) => (
                  <TaskRow key={task.id} entry={task} index={startOf(si) + i} />
                ))}
              </Section>
            ) : (
              <Section key={section.key} title={section.title}>
                {section.entries.map((entry, i) => (
                  <ChatRow
                    key={entry.id}
                    entry={entry}
                    index={startOf(si) + i}
                    onLongPress={setSheetFor}
                  />
                ))}
              </Section>
            ),
          )}
          {searching &&
            (unfiledChats ?? []).length === 0 &&
            pinnedChats.length === 0 &&
            tasks.length === 0 && <p className="n-note">No chats match this search.</p>}
        </>
      )}

      {/* Keyed by conversation: a fresh sheet per row, so rename drafts and
          modes never leak from one row to the next. */}
      <ConversationSheet
        key={sheetFor?.id ?? 'closed'}
        entry={sheetFor}
        projects={projects}
        onClose={() => setSheetFor(null)}
        onTogglePin={togglePin}
        onCommitRename={commitRename}
        onShare={(entry) => setShareFor(entry)}
        onMove={moveToProject}
        onDelete={(id) => void remove(id)}
      />
      <ShareDialog
        conversationId={shareFor?.id ?? null}
        conversationTitle={shareFor?.title ?? ''}
        open={shareFor !== null}
        onOpenChange={(open) => {
          if (!open) setShareFor(null);
        }}
      />
    </div>
  );
}
