'use client';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { McpServers } from '@/components/settings/mcp-servers';

/** One integrations hub: every service the assistant can use lives here. */
export function ConnectionsPage() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <SidebarTrigger />
        <div>
          <h1>Integrations</h1>
          <p>Services the assistant can use in your workspace.</p>
        </div>
      </header>
      <div className="px-6 pb-8 grid gap-10 max-w-4xl">
        <section aria-label="AI services">
          <h2 className="section-label">AI services</h2>
          <McpServers />
        </section>
      </div>
    </div>
  );
}
