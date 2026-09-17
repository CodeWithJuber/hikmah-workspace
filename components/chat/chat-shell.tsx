'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BookOpen,
  BookOpenCheck,
  Bot,
  Database,
  FileText,
  LayoutGrid,
  Menu,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { HikmahIcon } from '@/components/kernel/icons';
import { ChatPreview } from './chat-preview';
import { ConversationList, type ConversationSummary } from './conversation-list';
import { FilesPanel } from './files-panel';
import { AgentsPanel, type Agent } from './agents-panel';
import { MemoryPanel } from './memory-panel';
import { RunSettings } from './run-settings';
import { ArtifactPanel } from '@/components/kernel/artifact';
import { WorkspaceCommands } from './workspace-commands';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { useChatSettings } from '@/hooks/use-chat-settings';
import { withGrant, type Grant } from '@/lib/chat/approvals';
import { providerDestination } from '@/lib/ai/endpoint';
import { themeCookie, type Theme } from '@/lib/theme';
import { Toaster, toast } from 'sonner';
import { clientFetch } from '@/lib/client/request';

const LearningStudio = dynamic(
  () => import('@/components/learning/learning-studio').then((module) => module.LearningStudio),
  {
    loading: () => (
      <div className="workspace-loading" role="status">
        Opening Learning Studio…
      </div>
    ),
  },
);
const NARROW = '(max-width: 900px)';
type Panel = 'files' | 'agents' | 'memory' | 'settings';
const PANEL_LABELS: Record<Panel, string> = {
  files: 'Files',
  agents: 'Agents',
  memory: 'Memory',
  settings: 'Settings',
};
const NAV = [
  { id: 'chat', label: 'Chats', icon: MessageSquare },
  { id: 'learning', label: 'Learning studio', icon: BookOpen },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'memory', label: 'Memory', icon: Database },
] as const;
function subscribeToWidth(change: () => void) {
  const media = window.matchMedia(NARROW);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
function subscribeToTheme(change: () => void) {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function ChatShell({
  conversationId,
  task = false,
  title = 'New conversation',
}: {
  conversationId: string;
  task?: boolean;
  title?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const learning = params.get('view') === 'learning';
  const { settings, change, ready } = useChatSettings();
  const narrow = useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
  const theme = useSyncExternalStore(
    subscribeToTheme,
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    () => 'light',
  );
  const [revision, setRevision] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [learningVisited, setLearningVisited] = useState(learning);
  if (learning && !learningVisited) setLearningVisited(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [artifact, setArtifact] = useState<WorkspaceFiles | null>(null);
  const [previewBase, setPreviewBase] = useState('');
  const [managedKey, setManagedKey] = useState<boolean | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const settled = useCallback(() => setRevision((value) => value + 1), []);
  const changeTools = useCallback((disabledTools: string[]) => change({ disabledTools }), [change]);
  const onHistory = useCallback((rows: ConversationSummary[]) => setConversations(rows), []);
  const currentTitle = conversations.find((row) => row.id === conversationId)?.title || title;
  const selectView = useCallback(
    (view: 'chat' | 'learning') => {
      router.replace(
        `/chat/${encodeURIComponent(conversationId)}${view === 'learning' ? '?view=learning' : ''}`,
        { scroll: false },
      );
      setSidebarOpen(false);
      setPanel(null);
    },
    [conversationId, router],
  );
  const openPanel = useCallback((next: Panel) => {
    setPanel(next);
    setArtifact(null);
    setSidebarOpen(false);
  }, []);
  const openSettings = useCallback(() => openPanel('settings'), [openPanel]);
  const openArtifact = useCallback((files: WorkspaceFiles) => {
    setArtifact(files);
    setPanel(null);
    setSidebarOpen(false);
  }, []);
  const grant = useCallback(
    async (scope: Grant) => {
      await change({ approvals: withGrant(settings.approvals, scope) });
    },
    [change, settings.approvals],
  );
  const newChat = useCallback(async () => {
    try {
      const response = await clientFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json();
      if (!response.ok || !payload.id)
        throw new Error(payload.error || 'Could not start a conversation.');
      setSidebarOpen(false);
      setPanel(null);
      router.push(`/chat/${encodeURIComponent(payload.id)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start a conversation.');
    }
  }, [router]);
  useEffect(() => {
    let live = true;
    void clientFetch('/api/billing')
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
  useEffect(() => {
    if (!artifact || previewBase) return;
    let live = true;
    void clientFetch('/api/workspace/files')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { preview?: string } | null) => {
        if (live && payload?.preview) setPreviewBase(payload.preview);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [artifact, previewBase]);
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setArtifact(null);
    setSidebarOpen(false);
  }
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, []);
  const modalOpen = narrow && (sidebarOpen || Boolean(panel) || (!learning && Boolean(artifact)));
  useEffect(() => {
    if (!modalOpen) return;
    const root = sidebarOpen ? sidebarRef.current : panelRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].filter((item) => item.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (focusable()[0] ?? root).focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        setPanel(null);
        setArtifact(null);
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', trap);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [modalOpen, sidebarOpen, panel, artifact]);
  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.cookie = themeCookie(next);
  }
  return (
    <div className={'chat-shell workspace-experience' + (narrow ? ' is-narrow' : '')}>
      <Toaster position="top-center" />
      <a className="workspace-skip" href="#workspace-main">
        Skip to conversation
      </a>
      <header className="chat-topbar workspace-header" inert={modalOpen || undefined}>
        <button
          type="button"
          className="workspace-icon workspace-menu"
          aria-label="Conversations"
          aria-expanded={sidebarOpen}
          onClick={() => {
            setSidebarOpen(true);
            setPanel(null);
            setArtifact(null);
          }}
        >
          <Menu size={20} />
        </button>
        <div className="workspace-heading">
          <span>{learning ? 'Learning studio' : currentTitle}</span>
          {agent && !learning && (
            <button
              type="button"
              className="workspace-agent-chip"
              onClick={() => openPanel('agents')}
            >
              <Bot size={12} />
              {agent.name}
            </button>
          )}
        </div>
        <div className="workspace-header-actions">
          <button
            type="button"
            className="workspace-action"
            title="Search workspace (Ctrl/⌘ K)"
            onClick={() => setCommandsOpen(true)}
          >
            <Search size={16} />
            <span>Search</span>
          </button>
          {learning ? (
            <button type="button" className="workspace-action" onClick={() => selectView('chat')}>
              <ArrowLeft size={16} />
              <span>Back to chat</span>
            </button>
          ) : (
            <button
              type="button"
              className="workspace-action"
              onClick={() => selectView('learning')}
            >
              <BookOpen size={16} />
              <span>Learning</span>
            </button>
          )}
          <button
            type="button"
            className="workspace-action"
            aria-label="Files and agents"
            aria-expanded={Boolean(panel)}
            onClick={() => (panel ? setPanel(null) : openPanel('files'))}
          >
            <LayoutGrid size={16} />
            <span>Workspace</span>
          </button>
        </div>
      </header>
      <aside
        ref={sidebarRef}
        className={
          'workspace-sidebar chat-drawer chat-drawer-list' +
          (narrow && sidebarOpen ? ' is-open' : '')
        }
        aria-label="Workspace navigation"
        role={narrow && sidebarOpen ? 'dialog' : undefined}
        aria-modal={(narrow && sidebarOpen) || undefined}
        inert={(narrow && !sidebarOpen) || undefined}
        tabIndex={-1}
      >
        <div className="workspace-brand">
          <HikmahIcon name="orbit" size={32} />
          <strong>Hikmah</strong>
          <button
            type="button"
            className="workspace-icon workspace-sidebar-close"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <ConversationList
          activeId={conversationId}
          revision={revision}
          onNew={newChat}
          onConversations={onHistory}
          onActivate={() => setSidebarOpen(false)}
          navigation={
            <div className="workspace-navigation" aria-label="Workspace sections">
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  aria-current={
                    (
                      id === 'learning'
                        ? learning
                        : id === 'chat'
                          ? !learning && !panel
                          : panel === id
                    )
                      ? 'page'
                      : undefined
                  }
                  onClick={() =>
                    id === 'chat' || id === 'learning' ? selectView(id) : openPanel(id)
                  }
                >
                  <Icon size={20} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          }
        />
        <div className="workspace-sidebar-footer">
          <button type="button" onClick={openSettings}>
            <Settings size={16} />
            Settings
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
            <span className="workspace-theme-state">Change</span>
          </button>
        </div>
      </aside>
      <main id="workspace-main" className="chat-body workspace-body" tabIndex={-1}>
        <section
          className="workspace-chat-pane"
          hidden={learning}
          inert={learning || modalOpen || undefined}
          aria-label="Conversation"
        >
          <ChatPreview
            key={conversationId}
            conversationId={conversationId}
            agent={agent}
            settings={settings}
            settingsReady={ready}
            onArtifact={openArtifact}
            onTools={changeTools}
            onSettled={settled}
            needsKey={needsKey}
            onOpenSettings={openSettings}
            onGrant={grant}
            banner={
              task ? (
                <div className="chat-task-banner" role="note">
                  <BookOpenCheck size={16} />
                  <span>A background task. Suggestions wait for your review.</span>
                  <button type="button" onClick={() => openPanel('memory')}>
                    Review what it learned
                  </button>
                </div>
              ) : null
            }
          />
        </section>
        {learningVisited && (
          <section
            className="workspace-learning-pane"
            hidden={!learning}
            aria-label="Learning studio"
            inert={!learning || modalOpen || undefined}
          >
            <LearningStudio revision={revision} />
          </section>
        )}
        {(panel || (!learning && artifact)) && (
          <div
            ref={panelRef}
            className={
              'workspace-detail chat-drawer chat-drawer-panel' + (narrow ? ' is-open' : '')
            }
            role={narrow ? 'dialog' : undefined}
            aria-modal={narrow || undefined}
            aria-label={panel ? PANEL_LABELS[panel] : 'Artifact preview'}
            tabIndex={-1}
          >
            {artifact && !panel ? (
              <ArtifactPanel
                files={artifact}
                previewBase={previewBase || undefined}
                onClose={() => setArtifact(null)}
                onEdit={() => openPanel('files')}
              />
            ) : (
              panel && (
                <aside className="workspace-panel" aria-label="Workspace">
                  <div className="workspace-detail-heading">
                    <h2>{PANEL_LABELS[panel]}</h2>
                    <button
                      type="button"
                      className="workspace-icon"
                      aria-label="Close workspace panel"
                      onClick={() => setPanel(null)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="workspace-detail-tabs" role="group" aria-label="Workspace tools">
                    {(Object.keys(PANEL_LABELS) as Panel[]).map((key) => (
                      <button
                        type="button"
                        key={key}
                        aria-pressed={panel === key}
                        onClick={() => setPanel(key)}
                      >
                        {PANEL_LABELS[key]}
                      </button>
                    ))}
                  </div>
                  {panel === 'files' ? (
                    <FilesPanel revision={revision} />
                  ) : panel === 'agents' ? (
                    <AgentsPanel
                      activeId={agent?.id ?? null}
                      onPick={(next) => {
                        setAgent(next);
                        setPanel(null);
                        selectView('chat');
                      }}
                    />
                  ) : panel === 'memory' ? (
                    <MemoryPanel />
                  ) : (
                    <>
                      <RunSettings settings={settings} onChange={change} />
                      <nav className="workspace-account-links" aria-label="Account">
                        <Link href="/workspace" title="Workspace" aria-label="Workspace">
                          Research labs & terminal
                        </Link>
                        <Link href="/billing">Plan and usage</Link>
                        <Link href="/sign-out" title="Sign out" aria-label="Sign out">
                          Sign out
                        </Link>
                      </nav>
                    </>
                  )}
                </aside>
              )
            )}
          </div>
        )}
      </main>
      {modalOpen && (
        <button
          type="button"
          className="chat-drawer-scrim workspace-scrim"
          aria-label="Close panel"
          tabIndex={-1}
          onClick={() => {
            setSidebarOpen(false);
            setPanel(null);
            setArtifact(null);
          }}
        />
      )}
      <WorkspaceCommands
        open={commandsOpen}
        onOpenChange={setCommandsOpen}
        conversations={conversations}
        onNew={() => void newChat()}
        onLearning={() => selectView('learning')}
        onPanel={openPanel}
      />
    </div>
  );
}
