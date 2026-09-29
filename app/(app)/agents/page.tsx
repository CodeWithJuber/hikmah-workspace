import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { AgentsHome } from '@/components/playground/agents-home';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Assistants · Hikmah' };

export default async function AgentsPage() {
  await requireChatGPTUser('/agents');
  return <AgentsHome />;
}
