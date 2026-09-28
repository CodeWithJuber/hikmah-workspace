'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { BookOpenCheck, Bot, Menu, Moon, Settings, Sun, X } from 'lucide-react';
import { ProductNav } from '@/components/app/product-nav';
import { KernelProvider } from '@/components/kernel/context';
import { HikmahIcon } from '@/components/kernel/icons';
import { PlaygroundProvider } from '@/components/playground/context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ChatPreview } from './chat-preview';
import { ConversationList, type ConversationSummary } from './conversation-list';
import { FilesPanel } from './files-panel';
import { AgentsPanel, type Agent } from './agents-panel';
import { MemoryPanel } from './memory-panel';
import { TypeformPanel } from '@/components/integrations/typeform-panel';
import { RunSettings } from './run-settings';
import { ArtifactPanel } from '@/components/kernel/artifact';
import { WorkspaceCommands } from './workspace-commands';
import type { WorkspaceFiles } from '@/lib/playground/session';
import { useChatSettings } from '@/hooks/use-chat-settings';
import { withGrant, type Grant } from '@/lib/chat/approvals';
import { providerDestination } from '@/lib/ai/endpoint';
import { themeCookie, type Theme } from '@/lib/theme';
import { toast } from 'sonner';
import { clientFetch } from '@/lib/client/request';
import { useKeyboardShortcuts } from '@/lib/chat/shortcuts';

const NARROW = '(max-width: 900px)';
type Panel = 'files' | 'agents' | 'memory' | 'typeform' | 'settings';
const PANEL_LABELS: Record<Panel, string> = {
  files: 'Files',
  agents: 'Agents',
  memory: 'Saved memory',
  typeform: 'Typeform',
  settings: 'Settings',
};
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
  const requestedSettings = params.get('settings') === 'connection';
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
  const [panel, setPanel] = useState<Panel | null>(requestedSettings ? 'settings' : null);
  const [settingsRequested, setSettingsRequested] = useState(requestedSettings);
  if (requestedSettings !== settingsRequested) {
    setSettingsRequested(requestedSettings);
    setPanel(requestedSettings ? 'settings' : null);
  }
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // ⌘. toggles the conversation sidebar. The chat view wires its own
  // instance of this hook for the composer-scoped chords; this one owns the
  // shell-scoped chord, and each instance only handles the ids it is given.
  useKeyboardShortcuts({
    'toggle-sidebar': () => setSidebarOpen((open) => !open),
  });
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [settingsVisited, setSettingsVisited] = useState(requestedSettings);
  if (panel === 'settings' && !settingsVisited) setSettingsVisited(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [artifact, setArtifact] = useState<WorkspaceFiles | null>(null);
  const [previewBase, setPreviewBase] = useState('');
  const [managedKey, setManagedKey] = useState<boolean | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const settled = useCallback(() => setRevision((value) => value + 1), []);
  const changeTools = useCallback((disabledTools: string[]) => change({ disabledTools }), [change]);
  const onHistory = useCallback((rows: ConversationSummary[]) => setConversations(rows), []);
  const currentTitle = conversations.find((row) => row.id === conversationId)?.title || title;
  const closePanel = useCallback(() => {
    setPanel(null);
    if (requestedSettings) {
      router.replace(`/chat/${encodeURIComponent(conversationId)}`, { scroll: false });
    }
  }, [conversationId, requestedSettings, router]);
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
  const modalOpen = narrow && (sidebarOpen || Boolean(panel) || Boolean(artifact));
  useEffect(() => {
    if (!modalOpen) {
      const previous = drawerOpenerRef.current;
      if (previous) {
        drawerOpenerRef.current = null;
        const target =
          previous.getClientRects().length && !previous.closest('[inert]')
            ? previous
            : navigationButtonRef.current;
        target?.focus();
      }
      return;
    }
    const root = sidebarOpen ? sidebarRef.current : panelRef.current;
    if (!root) return;
    if (!drawerOpenerRef.current) {
      drawerOpenerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : navigationButtonRef.current;
    }
    const focusable = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],summary,input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].filter((item) => item.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (focusable()[0] ?? root).focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        closePanel();
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
    };
  }, [modalOpen, sidebarOpen, panel, artifact, closePanel]);
  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.cookie = themeCookie(next);
  }
  return (
    <TooltipProvider>
      <PlaygroundProvider onSettings={openSettings}>
        <KernelProvider>
          <div className={'chat-shell workspace-experience' + (narrow ? ' is-narrow' : '')}>
            <a className="workspace-skip" href="#workspace-main">
              Skip to conversation
            </a>
            <header className="chat-topbar workspace-header" inert={modalOpen || undefined}>
              <Button
                ref={navigationButtonRef}
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Conversations"
                aria-expanded={sidebarOpen}
                onClick={() => {
                  setSidebarOpen(true);
                  setPanel(null);
                  setArtifact(null);
                }}
              >
                <Menu size={20} />
              </Button>
              <div className="workspace-heading">
                <span>{currentTitle}</span>
                {agent && (
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close navigation"
                  onClick={() => setSidebarOpen(false)}
                >
                  <X size={20} />
                </Button>
              </div>
              <ConversationList
                activeId={conversationId}
                revision={revision}
                onNew={newChat}
                onConversations={onHistory}
                onActivate={() => setSidebarOpen(false)}
                navigation={<ProductNav onNavigate={() => setSidebarOpen(false)} />}
              />
              <div className="flex flex-col gap-1 border-t border-border p-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start"
                  onClick={openSettings}
                >
                  <Settings size={16} aria-hidden="true" />
                  Settings
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-start"
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                  {theme === 'dark' ? (
                    <Sun size={16} aria-hidden="true" />
                  ) : (
                    <Moon size={16} aria-hidden="true" />
                  )}
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </Button>
              </div>
            </aside>
            <main id="workspace-main" className="chat-body workspace-body" tabIndex={-1}>
              <section
                className="workspace-chat-pane"
                inert={modalOpen || undefined}
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
              {(settingsVisited || panel || artifact) && (
                <div
                  ref={panelRef}
                  className={
                    'workspace-detail chat-drawer chat-drawer-panel' + (narrow ? ' is-open' : '')
                  }
                  role={narrow ? 'dialog' : undefined}
                  aria-modal={narrow || undefined}
                  aria-label={panel ? PANEL_LABELS[panel] : 'Artifact preview'}
                  hidden={!panel && !artifact}
                  inert={(!panel && !artifact) || undefined}
                  tabIndex={-1}
                >
                  {artifact && !panel && (
                    <ArtifactPanel
                      files={artifact}
                      previewBase={previewBase || undefined}
                      onClose={() => setArtifact(null)}
                      onEdit={() => openPanel('files')}
                    />
                  )}
                  {(panel || settingsVisited) && (
                    <aside
                      className="workspace-panel"
                      aria-label="Workspace"
                      hidden={!panel}
                      inert={!panel || undefined}
                    >
                      <div className="flex items-center justify-between border-b border-border px-4 py-3">
                        <h2 className="text-base font-semibold">
                          {panel ? PANEL_LABELS[panel] : 'Settings'}
                        </h2>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Close workspace panel"
                          onClick={closePanel}
                        >
                          <X size={16} />
                        </Button>
                      </div>
                      {panel === 'files' ? (
                        <FilesPanel revision={revision} />
                      ) : panel === 'agents' ? (
                        <AgentsPanel
                          activeId={agent?.id ?? null}
                          onPick={(next) => {
                            setAgent(next);
                            setPanel(null);
                          }}
                        />
                      ) : panel === 'memory' ? (
                        <MemoryPanel />
                      ) : panel === 'typeform' ? (
                        <TypeformPanel embedded />
                      ) : null}
                      {settingsVisited && (
                        <div
                          className="workspace-settings-content"
                          hidden={panel !== 'settings'}
                          inert={panel !== 'settings' || undefined}
                        >
                          <RunSettings
                            settings={settings}
                            onChange={change}
                            active={panel === 'settings'}
                          />
                          <nav className="workspace-account-links" aria-label="Account">
                            <Link href="/billing">Plan and usage</Link>
                            <Link href="/sign-out" title="Sign out" aria-label="Sign out">
                              Sign out
                            </Link>
                          </nav>
                        </div>
                      )}
                    </aside>
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
                  closePanel();
                  setArtifact(null);
                }}
              />
            )}
            <WorkspaceCommands
              open={commandsOpen}
              onOpenChange={setCommandsOpen}
              conversations={conversations}
              onNew={() => void newChat()}
              onPanel={openPanel}
            />
          </div>
        </KernelProvider>
      </PlaygroundProvider>
    </TooltipProvider>
  );
}
