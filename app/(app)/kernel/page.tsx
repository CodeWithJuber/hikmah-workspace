import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { KernelCenter } from '@/components/kernel/center';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Kernel · Hikmah' };

export default async function KernelPage() {
  await requireChatGPTUser('/kernel');
  return <KernelCenter />;
}
