import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { ConnectionsPage } from '@/components/app/connections-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Integrations · Hikmah' };

export default async function ConnectionsRoutePage() {
  await requireChatGPTUser('/connections');
  return <ConnectionsPage />;
}
