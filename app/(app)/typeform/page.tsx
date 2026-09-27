import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { TypeformPage } from '@/components/app/typeform-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Integrations · Hikmah' };

export default async function TypeformRoutePage() {
  await requireChatGPTUser('/typeform');
  return <TypeformPage />;
}
