import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { LabsPage } from '@/components/app/labs-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Research labs · Hikmah' };

export default async function LabsRoutePage() {
  await requireChatGPTUser('/labs');
  return <LabsPage />;
}
