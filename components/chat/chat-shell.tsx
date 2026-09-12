'use client';
/** The chat page: conversations on the left, the workspace on the right. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { LayoutGrid, PanelLeft, X } from 'lucide-react';
import { HikmahIcon } from '@/components/kernel/icons';
import { ChatPreview } from './chat-preview';
import { ConversationList } from './conversation-list';
import { FilesPanel } from './files-panel';
import { AgentsPanel, type Agent } from './agents-panel';
import { RunSettings } from './run-settings';
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@/lib/chat/settings';

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

/** The owner's chat preferences, held here rather than in ChatPreview: that
 * component is keyed by conversation and remounts whenever the route changes,
 * which would refetch the settings on every click in the list. */
function useChatSettings() {
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_CHAT_SETTINGS);

  useEffect(() => {
    let live = true;
    void fetch('/api/chat-settings', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (live && payload?.settings) setSettings(payload.settings as ChatSettings);
      })
      // The defaults are usable settings, so a failed read costs nothing worth
      // interrupting the owner about.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const change = useCallback(async (patch: Partial<ChatSettings>) => {
    const response = await fetch('/api/chat-settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error('Settings were not saved.');
    // Taken from the reply rather than assumed: the server clamps, so what was
    // asked for and what is now stored are not always the same.
    const payload = (await response.json()) as { settings?: ChatSettings };
    if (payload.settings) setSettings(payload.settings);
  }, []);

  return { settings, change };
}

export function ChatShell({ conversationId }: { conversationId: string }) {
  const { settings, change } = useChatSettings();
  const changeTools = useCallback((disabledTools: string[]) => change({ disabledTools }), [change]);
  // Bumped when a run settles. A conversation is created by its first message
  // and titled from it, so without this the list would keep showing the state
  // it had before the owner said anything.
  const [revision, setRevision] = useState(0);
  const settled = useCallback(() => setRevision((value) => value + 1), []);

  const [tab, setTab] = useState<'files' | 'agents' | 'settings'>('files');
  // Applies from the next turn on, not retrospectively: an agent chosen now
  // cannot change an answer already written.
  const [agent, setAgent] = useState<Agent | null>(null);

  // On a narrow screen the two side panels are drawers over the conversation
  // rather than strips above and below it, which is what left the conversation
  // itself about a quarter of the screen.
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState<'list' | 'panel' | null>(null);

  // Reset during render rather than in an effect: an effect would paint the
  // open drawer for one frame after the conversation had already changed.
  // Opening a conversation from the drawer should close it, and the route
  // changes without unmounting the shell.
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setDrawer(null);
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
        <nav className="chat-topbar-links" aria-label="Workspace">
          {/* Without this the only way back to the rest of the workspace —
              media, compare, agents, the labs, settings — was editing the URL. */}
          <Link href="/">Workspace</Link>
          <Link href="/sign-out">Sign out</Link>
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
          onTools={changeTools}
          onSettled={settled}
        />

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
                aria-selected={tab === 'settings'}
                onClick={() => setTab('settings')}
              >
                Settings
              </button>
              {narrow && (
                <button type="button" aria-label="Close" onClick={() => setDrawer(null)}>
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
