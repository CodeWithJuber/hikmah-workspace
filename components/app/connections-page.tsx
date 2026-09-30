'use client';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { McpServers } from '@/components/settings/mcp-servers';
import { GithubConnection } from '@/components/settings/github-connection';
import { GmailPanel } from '@/components/settings/gmail';
import { ConnectorCatalog } from '@/components/settings/catalog';

/** One integrations hub: every service the assistant can use lives here. */
export function ConnectionsPage() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <SidebarTrigger />
        <div>
          <h1>Integrations</h1>
          <p>
            External services the assistant can use. Model API keys live separately, under{' '}
            <strong>Model connection</strong> in the sidebar footer.
          </p>
        </div>
      </header>
      <div className="px-6 pb-8 grid gap-10 max-w-4xl">
        <section aria-label="Tool servers">
          <h2 className="section-label">Tool servers</h2>
          <McpServers />
        </section>
        <section aria-label="GitHub">
          <h2 className="section-label">GitHub</h2>
          <GithubConnection />
        </section>
        <section aria-label="Gmail">
          <h2 className="section-label">Gmail</h2>
          <GmailPanel />
        </section>
        <section aria-label="Connector catalog">
          <h2 className="section-label">Connector catalog</h2>
          <ConnectorCatalog />
        </section>
      </div>
    </div>
  );
}
