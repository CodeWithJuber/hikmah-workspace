import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '../../../chatgpt-auth';
import { WorkspaceAdmin } from '@/components/playground/admin';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Admin · Hikmah' };

// The shell's Secrets tab has real content (SecretsSettings) even though the
// old hash router never had a page for it — it is kept here rather than 404ing
// a working tab.
const tabs = ['overview', 'providers', 'media', 'connectors', 'secrets', 'skills', 'plan'];

export default async function AdminTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!tabs.includes(tab)) notFound();
  await requireChatGPTUser('/admin/' + tab);
  // Keyed like the old shell's key={page}: switching tabs remounts the admin
  // so each tab opens on its own state.
  return <WorkspaceAdmin key={tab} initialTab={tab} />;
}
