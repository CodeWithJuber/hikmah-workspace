import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '../../../chatgpt-auth';
import { KernelCenter } from '@/components/kernel/center';
import { OwnerAccess } from '@/components/playground/learning-home';
import { AdminBreadcrumb } from '@/components/admin/admin-breadcrumb';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Super Admin · Hikmah' };

const tabs = [
  'context',
  'overview',
  'versions',
  'architecture',
  'training',
  'learning',
  'runs',
  'policy',
  'controls',
  'integrations',
];

// Display names, kept in sync with the tab labels KernelCenter renders.
const tabLabels: Record<string, string> = {
  training: 'Train context model',
  context: 'Understand',
  overview: 'Legacy model',
  versions: 'Versions',
  learning: 'Rule learning',
  runs: 'Runs',
  policy: 'Workflow policy',
  architecture: 'Architecture',
  controls: 'Controls',
  integrations: 'Integrations',
};

export default async function SuperadminTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!tabs.includes(tab)) notFound();
  await requireChatGPTUser('/superadmin/' + tab);
  // Keyed so switching tabs remounts the center on the new tab's state, like
  // the old shell's key={page}.
  return (
    <OwnerAccess
      crumb={
        <AdminBreadcrumb
          trail={[{ label: 'Super Admin', href: '/superadmin' }, { label: tabLabels[tab] ?? tab }]}
        />
      }
    >
      <KernelCenter key={tab} owner initialTab={tab} />
    </OwnerAccess>
  );
}
