import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { Knowledge } from '@/components/playground/knowledge';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Knowledge · Hikmah' };

export default async function KnowledgePage() {
  await requireChatGPTUser('/knowledge');
  return <Knowledge />;
}
