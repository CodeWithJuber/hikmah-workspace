'use client';
/** The chat page: conversations on the left, the workspace on the right. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Blocks, BookOpenCheck, CreditCard, LayoutGrid, PanelLeft, X } from 'lucide-react';
import { HikmahIcon } from '@/components/kernel/icons';
import { ChatPreview } from './chat-preview';
import { ConversationList } from './conversation-list';
import { FilesPanel } from './files-panel';
import { AgentsPanel, type Agent } from './agents-panel';
import { MemoryPanel } from './memory-panel';
import { RunSettings } from './run-settings';
import { ArtifactPanel } from '@/components/kernel/artifact';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { useChatSettings } from '@/hooks/use-chat-settings';
import { withGrant, type Grant } from '@/lib/chat/approvals';
import { providerDestination } from '@/lib/ai/endpoint';
import { Toaster } from 'sonner';

/** Narrow enough that a 240px list and a 260px panel would leave the
 * conversation with less room than either of them. Matches the breakpoint the
 * drawer styling uses, and is read once rather than per render. */
const NARROW = '(max-width: 900px)';

/** Read through useSyncExternalStore rather than an effect: the width is
 * external state that exists before this renders, and setting it from an
 * effect would paint the desktop layout once on every phone load. The server
 * snapshot is `false` because the server has no viewport, and the wide layout
 * is the one that degrades gracefully. */
function subscribeToWidth(onChange: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function useNarrow() {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

export function ChatShell({
  conversationId,
  task = false,
}: {
  conversationId: string;
  /** This conversation is a background task: its report is shown with a way
   * into what it left to review. */
  task?: boolean;
}) {
  const { settings, change, ready } = useChatSettings();
  const changeTools = useCallback((disabledTools: string[]) => change({ disabledTools }), [change]);
  // Bumped when a run settles. A conversation is created by its first message
  // and titled from it, so without this the list would keep showing the state
  // it had before the owner said anything.
  const [revision, setRevision] = useState(0);
  const settled = useCallback(() => setRevision((value) => value + 1), []);

  const [tab, setTab] = useState<'files' | 'agents' | 'memory' | 'settings'>('files');
  // Whether a message sent now would have a key to run on: the person's own,
  // or the deployment's for a plan that includes models. Null until known, so
  // the first-run card is never flashed at someone who does not need it.
  const [managedKey, setManagedKey] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void fetch('/api/billing', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { managedKey?: boolean } | null) => {
        if (live) setManagedKey(Boolean(payload?.managedKey));
      })
      .catch(() => {
        if (live) setManagedKey(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const needsKey =
    managedKey === false &&
    Boolean(providerDestination(settings.connection.baseUrl)) &&
    !settings.connection.apiKeySecret;
  // Applies from the next turn on, not retrospectively: an agent chosen now
  // cannot change an answer already written.
  const [agent, setAgent] = useState<Agent | null>(null);

  // A page an answer produced, opened from its inline card. Its own column on a
  // wide screen; the same drawer as the panel on a narrow one.
  const [artifact, setArtifact] = useState<WorkspaceFiles | null>(null);
  // Where the workspace's pages are served, read when a preview first opens:
  // the panel then shows the page as written, with every file it links to,
  // and can open it full screen. See lib/files/preview-link.ts.
  const [previewBase, setPreviewBase] = useState('');
  useEffect(() => {
    if (!artifact || previewBase) return;
    let live = true;
    void fetch('/api/workspace/files', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { preview?: string } | null) => {
        if (live && payload?.preview) setPreviewBase(payload.preview);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [artifact, previewBase]);

  // On a narrow screen the two side panels are drawers over the conversation
  // rather than strips above and below it, which is what left the conversation
  // itself about a quarter of the screen.
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState<'list' | 'panel' | null>(null);
  // A yes remembered from the approval card. Saved through the same store the
  // run reads when it is driven, and awaited by the card before it answers,
  // so the resumed run already knows.
  const grant = useCallback(
    async (scope: Grant) => {
      await change({ approvals: withGrant(settings.approvals, scope) });
    },
    [change, settings.approvals],
  );
  // Where the key goes: the Settings tab, opened as a drawer on a phone.
  const openSettings = useCallback(() => {
    setTab('settings');
    if (narrow) setDrawer('panel');
  }, [narrow]);

  // Reset during render rather than in an effect: an effect would paint the
  // open drawer for one frame after the conversation had already changed.
  // Opening a conversation from the drawer should close it, and the route
  // changes without unmounting the shell.
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setDrawer(null);
    // A preview belongs to the answer that produced it, so it does not follow
    // the reader into another conversation.
    setArtifact(null);
  } else if (!narrow && drawer) {
    setDrawer(null);
  }

  useEffect(() => {
    if (!drawer) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [drawer]);

  const open = narrow ? drawer : null;

  return (
    <div className={'chat-shell' + (narrow ? ' is-narrow' : '')}>
      {/* The voice controls and the background-task dialog speak through
          sonner, and nothing on this surface had mounted it: every toast went
          nowhere. The workspace shell mounts its own; this one is the chat's. */}
      <Toaster position="top-center" />
      <header className="chat-topbar">
        {narrow && (
          <button
            type="button"
            className="chat-topbar-toggle"
            aria-expanded={drawer === 'list'}
            aria-label="Conversations"
            onClick={() => setDrawer(drawer === 'list' ? null : 'list')}
          >
            <PanelLeft size={18} />
          </button>
        )}
        <span className="chat-topbar-brand">
          <HikmahIcon name="orbit" size={24} />
          <strong>Hikmah</strong>
        </span>
        {/* Text links on a phone wrapped "Sign out" onto two lines and left the
            row crowded, so on a narrow screen they are icons with their names
            as labels. Everything this surface does not carry — the labs,
            settings, the owner console, the terminal — lives through the first
            one. */}
        <nav className={'chat-topbar-links' + (narrow ? ' is-compact' : '')} aria-label="Workspace">
          <Link href="/workspace" title="Workspace" aria-label="Workspace">
            {narrow ? <Blocks size={17} /> : 'Workspace'}
          </Link>
          <Link href="/billing" title="Plan and usage" aria-label="Plan and usage">
            {narrow ? <CreditCard size={17} /> : 'Plan'}
          </Link>
          {/* Not on a phone: an unlabelled sign-out icon beside the workspace
              and plan icons was one thumb-slip from losing the session. On a
              narrow screen it lives at the end of Settings, in words. */}
          {!narrow && (
            <Link href="/sign-out" title="Sign out" aria-label="Sign out">
              Sign out
            </Link>
          )}
        </nav>
        {narrow && (
          <button
            type="button"
            className="chat-topbar-toggle"
            aria-expanded={drawer === 'panel'}
            aria-label="Files and agents"
            onClick={() => setDrawer(drawer === 'panel' ? null : 'panel')}
          >
            <LayoutGrid size={18} />
          </button>
        )}
      </header>

      <div className="chat-body">
        {/* Rendered in both layouts and positioned by CSS, so a drawer keeps its
            scroll position and its fetched list when it closes. */}
        <div className={'chat-drawer chat-drawer-list' + (open === 'list' ? ' is-open' : '')}>
          <ConversationList activeId={conversationId} revision={revision} />
        </div>

        {/* Keyed by conversation so moving between them rebuilds the chat rather
            than showing the previous transcript under the new id: useChat holds
            its messages per instance. */}
        <ChatPreview
          key={conversationId}
          conversationId={conversationId}
          agent={agent}
          settings={settings}
          settingsReady={ready}
          onArtifact={setArtifact}
          onTools={changeTools}
          onSettled={settled}
          needsKey={needsKey}
          onOpenSettings={openSettings}
          onGrant={grant}
          banner={
            task ? (
              <div className="chat-task-banner" role="note">
                <BookOpenCheck size={16} aria-hidden="true" />
                <span>
                  A background task. What it kept is waiting for your review, and nothing is used
                  until you accept it.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setTab('memory');
                    if (narrow) setDrawer('panel');
                  }}
                >
                  Review what it learned
                </button>
              </div>
            ) : null
          }
        />

        {artifact && (
          <ArtifactPanel
            files={artifact}
            previewBase={previewBase || undefined}
            onClose={() => setArtifact(null)}
            onEdit={() => {
              // The files are rows already, written by the tool that made them,
              // so editing means opening the panel that reads those rows.
              setArtifact(null);
              setTab('files');
              if (narrow) setDrawer('panel');
            }}
          />
        )}

        <div className={'chat-drawer chat-drawer-panel' + (open === 'panel' ? ' is-open' : '')}>
          <aside className="workspace-panel" aria-label="Workspace">
            <div className="workspace-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'files'}
                onClick={() => setTab('files')}
              >
                Files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'agents'}
                onClick={() => setTab('agents')}
              >
                Agents
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'memory'}
                onClick={() => setTab('memory')}
              >
                Memory
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'settings'}
                onClick={() => setTab('settings')}
              >
                Settings
              </button>
              {narrow && (
                <button
                  type="button"
                  className="workspace-tabs-close"
                  aria-label="Close"
                  onClick={() => setDrawer(null)}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            {/* Files reload on the same signal as the conversation list: a run
                that just finished may have written one, and a panel showing the
                state from before it is worse than no panel. */}
            {tab === 'files' ? (
              <FilesPanel revision={revision} />
            ) : tab === 'agents' ? (
              <AgentsPanel activeId={agent?.id ?? null} onPick={setAgent} />
            ) : tab === 'memory' ? (
              <MemoryPanel />
            ) : (
              <RunSettings settings={settings} onChange={change} />
            )}
          </aside>
        </div>

        {open && (
          <button
            type="button"
            className="chat-drawer-scrim"
            aria-label="Close panel"
            onClick={() => setDrawer(null)}
          />
        )}
      </div>
    </div>
  );
}
