'use client';
/** The Terminal page: a full-height shell on the workbench container. */
import { SidebarTrigger } from '@/components/ui/sidebar';
import { SshHosts } from './ssh-hosts';
import { Terminal } from './terminal';

export function TerminalPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        {/* size-9, because the vendored default is size-7 — 28px, under any
            comfortable touch target. tailwind-merge lets the call site win. */}
        <SidebarTrigger className="size-9" />
        <div>
          <h1 className="text-base font-medium">Terminal</h1>
          <p className="text-sm text-muted-foreground">
            A shell in the workbench container, on the workspace volume. It is a separate service
            from the app, so nothing you run here can reach the workspace database or your saved
            secrets. Files under <code>/workspace</code> persist across releases.
          </p>
        </div>
      </header>
      <Terminal className="flex min-h-64 flex-1 flex-col" />
      <div className="border-t p-4">
        <SshHosts />
      </div>
    </div>
  );
}
