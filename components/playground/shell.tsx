'use client';
import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import {
  FlaskConical,
  Settings as SettingsIcon,
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
import { useMemory } from '@/hooks/use-memory';
import { Settings } from './settings';
import { WorkspaceAdmin } from './admin';
import { Meaning } from './meaning';
import { Learn } from './learn';
import { AgentTasks } from './agent-tasks';
import { SoundLab } from './sound';
import { Maths } from './maths';
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
    openSettings,
    preferences,
    storageMessage,
    restoreFailed,
    workspacePage: page,
    setWorkspacePage: setPage,
  } = usePlayground();
  // The memories table, not the blob: the counts every answer's store agrees with.
  const { counts: memoryCounts } = useMemory();
  const { setOpenMobile } = useSidebar();
  const [lab, setLab] = useState('');
  return (
    <>
      <Sidebar className="workspace-sidebar">
        <SidebarHeader className="workspace-sidebar-header">
          <Brand />
          {/* Conversations belong to the server now and are listed by the surface
              that owns them. A second list here, over the workspace blob, would
              be a second set of conversations that could never hold an answer. */}
          <Link className="new-chat" href="/chat">
            <HikmahIcon name="compose" size={19} />
            New chat
          </Link>
        </SidebarHeader>
        <SidebarContent className="workspace-sidebar-content">
          {/* The chat is a route of its own and is what opens by default, so
              this is the way back to it rather than a curiosity. */}
          <Link className="knowledge-nav" href="/chat">
            <HikmahIcon name="conversation" size={20} />
            Chat
          </Link>
          <button
            className={'knowledge-nav' + (page === 'tools' ? ' selected' : '')}
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
            onClick={() => {
              setPage('knowledge');
              setOpenMobile(false);
            }}
          >
            <BookOpen size={20} />
            Memory <span className="nav-count">{memoryCounts.saved}</span>
          </button>
          <button
            className={'knowledge-nav' + (page === 'learning' ? ' selected' : '')}
            onClick={() => {
              setPage('learning');
              setOpenMobile(false);
            }}
          >
            <BrainCircuit size={20} />
            Learning <span className="nav-count">{memoryCounts.suggested || ''}</span>
          </button>
          <button
            className={'co-model-nav' + (page === 'kernel' ? ' selected' : '')}
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
        </SidebarContent>
        <SidebarFooter className="workspace-sidebar-footer">
          <button
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
              // Keyed on the actual condition rather than on words in the
              // message: the restore-failure text contained neither "full" nor
              // "could not", so the one state that most needed the warning
              // styling never got it.
              (restoreFailed || storageMessage.includes('full') ? ' storage-warning' : '')
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
        {/* On a phone the sidebar is closed and every page opens on its own
            heading, with no way back to the conversation but the browser.
            One link, top right, where the eye goes looking for it. */}
        <Link href="/chat" className="workspace-chat-link">
          Chat
        </Link>
        {page === 'agents' ? (
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
