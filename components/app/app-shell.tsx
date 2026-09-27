'use client';
import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  useSidebar,
} from '@/components/ui/sidebar';
import { PlaygroundProvider, usePlayground } from '@/components/playground/context';
import { KernelProvider } from '@/components/kernel/context';
import { HikmahIcon } from '@/components/kernel/icons';
import { Settings } from '@/components/playground/settings';
import { ProductNav } from './product-nav';
import { APP_RELEASE, BUILD_ID } from '@/lib/release';

/** The product mark: orbit icon + wordmark. Copied from the old workspace
 * shell so every surface keeps the same brand. */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={'hikmah-brand' + (compact ? ' compact' : '')}>
      <HikmahIcon name="orbit" size={32} />
      {!compact && <span>Hikmah</span>}
    </span>
  );
}

/** Renders inside PlaygroundProvider: it reads the workspace state for the
 * footer (model connection, storage status, release label). */
function ShellContent({ children }: { children: ReactNode }) {
  const { openSettings, storageMessage, restoreFailed } = usePlayground();
  const { setOpenMobile } = useSidebar();
  return (
    <>
      <Sidebar className="workspace-sidebar">
        <SidebarHeader className="workspace-sidebar-header">
          <Brand />
          <Link className="new-chat" href="/chat">
            <HikmahIcon name="compose" size={20} />
            New chat
          </Link>
        </SidebarHeader>
        <SidebarContent className="workspace-sidebar-content">
          <ProductNav onNavigate={() => setOpenMobile(false)} />
        </SidebarContent>
        <SidebarFooter className="workspace-sidebar-footer">
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
      <SidebarInset className="workspace-main">{children}</SidebarInset>
    </>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <PlaygroundProvider onSettings={() => setSettingsOpen(true)}>
      <KernelProvider>
        <ShellContent>{children}</ShellContent>
        <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
      </KernelProvider>
    </PlaygroundProvider>
  );
}

/** The one shell for the whole product: every route under app/(app) renders
 * inside this. No Toaster here — the root layout mounts ToasterOnce. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider
      className="app-shell studio-shell"
      style={{ '--sidebar-width': '232px' } as CSSProperties}
    >
      <ShellInner>{children}</ShellInner>
    </SidebarProvider>
  );
}
