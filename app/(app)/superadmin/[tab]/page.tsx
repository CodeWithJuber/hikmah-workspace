import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '../../../chatgpt-auth';
import { KernelCenter } from '@/components/kernel/center';
import { OwnerAccess } from '@/components/playground/learning-home';

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

export default async function SuperadminTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!tabs.includes(tab)) notFound();
  await requireChatGPTUser('/superadmin/' + tab);
  // Keyed so switching tabs remounts the center on the new tab's state, like
  // the old shell's key={page}.
  return (
    <OwnerAccess>
      <KernelCenter key={tab} owner initialTab={tab} />
    </OwnerAccess>
  );
}
