'use client';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { McpServers } from '@/components/settings/mcp-servers';

export function ConnectionsPage() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <SidebarTrigger />
        <div>
          <h1>Connections</h1>
          <p>Servers the assistant can call tools on.</p>
        </div>
      </header>
      <div className="px-6 pb-4">
        <Button variant="outline" asChild>
          <Link href="/typeform">
            <FileText size={16} />
            Typeform forms
          </Link>
        </Button>
        <p className="mt-2 text-sm text-muted-foreground">
          Read surveys shared with your account and use them in chat.
        </p>
      </div>
      <McpServers />
    </div>
  );
}
