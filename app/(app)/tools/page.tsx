import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { RuntimeHome } from '@/components/playground/runtime-home';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Tools & runtimes · Hikmah' };

export default async function ToolsPage() {
  await requireChatGPTUser('/tools');
  return <RuntimeHome />;
}
