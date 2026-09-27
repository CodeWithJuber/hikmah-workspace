'use client';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { TypeformPanel } from '@/components/integrations/typeform-panel';

export function TypeformPage() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <SidebarTrigger />
        <div>
          <h1>Integrations</h1>
          <p>Use your connected services in Hikmah.</p>
        </div>
      </header>
      <TypeformPanel />
    </div>
  );
}
