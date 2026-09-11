'use client';
import { useState, useMemo, type CSSProperties } from 'react';
import {
  MessageSquare,
  Code2,
  Bot,
  FlaskConical,
  Settings as SettingsIcon,
  Search,
  MoreHorizontal,
  Trash2,
  Pencil,
  Download,
  BookOpen,
  BrainCircuit,
  Waves,
  Sigma,
  Workflow,
  ArrowLeft,
  ArrowUpRight,
  TerminalSquare,
  Plug,
} from 'lucide-react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Toaster } from 'sonner';
import { PlaygroundProvider, usePlayground } from './context';
import { KernelProvider, useKernel } from '@/components/kernel/context';
import { KernelCenter } from '@/components/kernel/center';
import { HikmahIcon } from '@/components/kernel/icons';
import { LearningHome, OwnerAccess } from './learning-home';
import { AgentsHome } from './agents-home';
import { RuntimeHome } from './runtime-home';
import { TerminalPage } from '@/components/workbench/terminal-page';
import { McpServers } from '@/components/settings/mcp-servers';
import { Knowledge } from './knowledge';
import { Settings } from './settings';
import { WorkspaceAdmin } from './admin';
import { Meaning } from './meaning';
import { Learn } from './learn';
import { AgentTasks } from './agent-tasks';
import { SoundLab } from './sound';
import { Maths } from './maths';
import { Chat } from './chat';
import { newConversation, type ChatMode } from '@/lib/playground/session';
import { downloadText } from './common';
import { APP_RELEASE, BUILD_ID } from '@/lib/release';
const labs = [
  {
    id: 'meaning',
    name: 'Meaning',
    description: 'Explore how the small symbolic learner represents a sentence.',
    icon: BrainCircuit,
  },
  {
    id: 'learn',
    name: 'Learning',
    description: 'Teach with examples and compare the candidate model.',
    icon: BookOpen,
  },
  {
    id: 'planning',
    name: 'Planning',
    description: 'Simulate a workflow with costs, failures and verification.',
    icon: Workflow,
  },
  {
    id: 'sound',
    name: 'Sound',
    description: 'Compare frequencies and the information they preserve.',
    icon: Waves,
  },
  {
    id: 'maths',
    name: 'Mathematics',
    description: 'Explore evidence, budgets and graph algorithms.',
    icon: Sigma,
  },
];
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={'hikmah-brand' + (compact ? ' compact' : '')}>
      <HikmahIcon name="orbit" size={30} />
      {!compact && <span>Hikmah</span>}
    </span>
  );
}
function ShellInner() {
  const [settings, setSettings] = useState(false);
  return (
    <PlaygroundProvider onSettings={() => setSettings(true)}>
      <KernelProvider>
        <ShellContent />
        <Settings open={settings} onOpenChange={setSettings} />
      </KernelProvider>
    </PlaygroundProvider>
  );
}
function ShellContent() {
  const kernel = useKernel();
  const {
    conversations,
    setConversations,
    activeId,
    setActiveId,
    mode,
    setMode,
    openSettings,
    isRunning,
    preferences,
    knowledge,
    storageMessage,
    workspacePage: page,
    setWorkspacePage: setPage,
  } = usePlayground();
  const { setOpenMobile } = useSidebar();
  const [lab, setLab] = useState('');
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState('');
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState('');
  const navigate = (next: ChatMode) => {
    if (isRunning) return;
    setMode(next);
    setPage('workspace');
    setOpenMobile(false);
  };
  const create = () => {
    if (isRunning) return;
    const c = newConversation();
    setConversations((cs) => [c, ...cs]);
    setActiveId(c.id);
    setPage('workspace');
    setOpenMobile(false);
  };
  const visibleChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.messages.some((m) => m.text.toLowerCase().includes(q)),
        )
      : conversations;
  }, [conversations, search]);
  const selected = conversations.find((c) => c.id === activeId) ?? conversations[0];
  return (
    <>
      <Sidebar className="workspace-sidebar">
        <SidebarHeader className="workspace-sidebar-header">
          <Brand />
          <Button className="new-chat" onClick={create} disabled={isRunning}>
            <HikmahIcon name="compose" size={19} />
            New chat
          </Button>
        </SidebarHeader>
        <SidebarContent className="workspace-sidebar-content">
          <nav aria-label="Main navigation" className="primary-nav">
            {(
              [
                { id: 'chat', name: 'Chat', icon: MessageSquare },
                { id: 'coding', name: 'Coding', icon: Code2 },
                { id: 'agent', name: 'Agents', icon: Bot },
                { id: 'compare', name: 'Compare', icon: Workflow },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                className={page === 'workspace' && mode === item.id ? 'selected' : ''}
                disabled={isRunning}
                onClick={() => navigate(item.id)}
              >
                <HikmahIcon
                  name={
                    item.id === 'chat'
                      ? 'conversation'
                      : item.id === 'coding'
                        ? 'artifact'
                        : item.id === 'agent'
                          ? 'agent'
                          : 'compare'
                  }
                  size={20}
                />
                {item.name}
              </button>
            ))}
          </nav>
          <button
            className={'knowledge-nav' + (page === 'tools' ? ' selected' : '')}
            disabled={isRunning}
            onClick={() => {
              setPage('tools');
              setOpenMobile(false);
            }}
          >
            <HikmahIcon name="tools" />
            Tools & runtimes
          </button>
          <button
            className={'knowledge-nav' + (page === 'connections' ? ' selected' : '')}
            onClick={() => {
              setPage('connections');
              setOpenMobile(false);
            }}
          >
            <Plug size={20} />
            Connections
          </button>
          <button
            className={'knowledge-nav' + (page === 'terminal' ? ' selected' : '')}
            onClick={() => {
              setPage('terminal');
              setOpenMobile(false);
            }}
          >
            <TerminalSquare size={20} />
            Terminal
          </button>
          <button
            className={'knowledge-nav' + (page === 'knowledge' ? ' selected' : '')}
            disabled={isRunning}
            onClick={() => {
              setPage('knowledge');
              setOpenMobile(false);
            }}
          >
            <BookOpen size={20} />
            Memory{' '}
            <span className="nav-count">
              {knowledge.filter((k) => k.status !== 'suggested' && k.enabled).length}
            </span>
          </button>
          <button
            className={'knowledge-nav' + (page === 'learning' ? ' selected' : '')}
            disabled={isRunning}
            onClick={() => {
              setPage('learning');
              setOpenMobile(false);
            }}
          >
            <BrainCircuit size={20} />
            Learning{' '}
            <span className="nav-count">
              {knowledge.filter((k) => k.status === 'suggested').length || ''}
            </span>
          </button>
          <button
            className={'co-model-nav' + (page === 'kernel' ? ' selected' : '')}
            disabled={isRunning}
            onClick={() => {
              setPage('kernel');
              setOpenMobile(false);
            }}
          >
            <HikmahIcon name="learning" />
            <span>
              Context model
              <small>
                {kernel.ready ? 'Understand documents locally' : '5 released language models'}
              </small>
            </span>
            <span className={kernel.ready ? 'live-dot' : 'pending-dot'} />
          </button>
          <div className="recent-heading">
            <span>Recent</span>
            <span>{conversations.length}</span>
          </div>
          {
            <div className="chat-search">
              <Search size={15} />
              <Input
                aria-label="Search conversations"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search chats"
              />
            </div>
          }
          <div className="recent-chats">
            {visibleChats.map((c) => (
              <div
                key={c.id}
                className={
                  'recent-row' + (page === 'workspace' && selected?.id === c.id ? ' active' : '')
                }
              >
                <button
                  className="recent-title"
                  disabled={isRunning}
                  onClick={() => {
                    setActiveId(c.id);
                    setPage('workspace');
                    setOpenMobile(false);
                  }}
                  title={c.title}
                >
                  {c.title}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="icon-button recent-menu"
                      aria-label={'Actions for ' + c.title}
                      disabled={isRunning}
                    >
                      <MoreHorizontal size={17} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenaming(c.id);
                        setTitle(c.title);
                      }}
                    >
                      <Pencil size={15} />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        downloadText(
                          c.messages
                            .map((m) => `## ${m.role === 'user' ? 'You' : 'Hikmah'}\n\n${m.text}`)
                            .join('\n\n'),
                          'hikmah-chat.md',
                        )
                      }
                    >
                      <Download size={15} />
                      Export chat
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDeleting(c.id)}>
                      <Trash2 size={15} />
                      Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
            {!conversations.length && <p className="no-recents">Your conversations appear here.</p>}
            {search &&
              !conversations.some((c) => c.title.toLowerCase().includes(search.toLowerCase())) && (
                <span className="sr-only">Search includes message text.</span>
              )}
          </div>
        </SidebarContent>
        <SidebarFooter className="workspace-sidebar-footer">
          <button
            disabled={isRunning}
            className={page === 'labs' ? 'selected' : ''}
            onClick={() => {
              setPage('labs');
              setLab('');
              setOpenMobile(false);
            }}
          >
            <FlaskConical size={20} />
            Research labs
          </button>
          <button
            disabled={isRunning}
            className={page === 'admin' ? 'selected' : ''}
            onClick={() => {
              setPage('admin');
              setOpenMobile(false);
            }}
          >
            <HikmahIcon name="workspaceAdmin" size={20} />
            Workspace settings
          </button>
          {
            <button
              disabled={isRunning}
              className={page.startsWith('superadmin') ? 'selected owner-nav' : 'owner-nav'}
              onClick={() => {
                setPage('superadmin');
                setOpenMobile(false);
              }}
            >
              <HikmahIcon name="ownerAdmin" size={20} />
              Owner console<span>{kernel.ready ? 'Owner' : 'Access'}</span>
            </button>
          }
          <button onClick={openSettings}>
            <SettingsIcon size={20} />
            Model connection
          </button>
          <span
            className={
              'local-save' +
              (storageMessage.includes('full') || storageMessage.includes('could not')
                ? ' storage-warning'
                : '')
            }
            role="status"
          >
            {storageMessage}
          </span>
          <span className="release-label" title={'Deployed revision: ' + BUILD_ID}>
            App v{APP_RELEASE} · {BUILD_ID.slice(0, 7)} <a href="/sign-out">Sign out</a>
          </span>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="workspace-main">
        {page === 'workspace' ? (
          <Chat />
        ) : page === 'agents' ? (
          <AgentsHome />
        ) : page === 'tools' ? (
          <RuntimeHome />
        ) : page === 'terminal' ? (
          <TerminalPage />
        ) : page === 'connections' ? (
          <div className="lab-page">
            <header className="lab-header">
              <SidebarTrigger />
              <div>
                <h1>Connections</h1>
                <p>Servers the assistant can call tools on.</p>
              </div>
            </header>
            <McpServers />
          </div>
        ) : page === 'knowledge' ? (
          <Knowledge />
        ) : page === 'learning' ? (
          <LearningHome />
        ) : page.startsWith('admin') ? (
          <WorkspaceAdmin key={page} initialTab={page.split('/')[1] ?? 'overview'} />
        ) : page.startsWith('superadmin') ? (
          <OwnerAccess>
            {page === 'superadmin' ? (
              <LearningHome owner />
            ) : (
              <KernelCenter key={page} owner initialTab={page.split('/')[1]} />
            )}
          </OwnerAccess>
        ) : page === 'kernel' ? (
          <KernelCenter />
        ) : (
          <div className="lab-page">
            <header className="lab-header">
              <SidebarTrigger />
              <div>
                <h1>Research labs</h1>
                <p>Explore the ideas behind the workspace.</p>
              </div>
            </header>
            {!lab ? (
              <>
                <p className="lab-intro">
                  These are local experiments. They work without a provider connection.
                </p>
                <div className="lab-directory">
                  {labs.map((l) => (
                    <button key={l.id} onClick={() => setLab(l.id)}>
                      <l.icon size={26} />
                      <div>
                        <h2>{l.name}</h2>
                        <p>{l.description}</p>
                      </div>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="lab-switcher">
                  <Button variant="ghost" onClick={() => setLab('')}>
                    <ArrowLeft size={16} />
                    All labs
                  </Button>
                  <h2>{labs.find((l) => l.id === lab)?.name}</h2>
                </div>
                {lab === 'meaning' ? (
                  <Meaning onLearn={() => setLab('learn')} />
                ) : lab === 'learn' ? (
                  <Learn />
                ) : lab === 'planning' ? (
                  <AgentTasks />
                ) : lab === 'sound' ? (
                  <SoundLab />
                ) : (
                  <Maths />
                )}
              </>
            )}
          </div>
        )}
      </SidebarInset>
      <Dialog open={!!renaming} onOpenChange={(v) => !v && setRenaming('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Choose a name you can find later.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Chat title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            disabled={!title.trim()}
            onClick={() => {
              setConversations((cs) =>
                cs.map((c) => (c.id === renaming ? { ...c, title: title.trim() } : c)),
              );
              setRenaming('');
            }}
          >
            Save name
          </Button>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting('')}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the conversation from your saved workspace. Export it first if you want
              to keep a copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep chat</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConversations((cs) => cs.filter((c) => c.id !== deleting));
                if (activeId === deleting) setActiveId('');
                setDeleting('');
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Toaster position="bottom-right" theme={preferences.theme} richColors />
    </>
  );
}
export default function Playground() {
  return (
    <SidebarProvider
      className="app-shell studio-shell"
      style={{ '--sidebar-width': '232px' } as CSSProperties}
    >
      <ShellInner />
    </SidebarProvider>
  );
}
