import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { TerminalPage } from '@/components/workbench/terminal-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Terminal · Hikmah' };

export default async function TerminalRoutePage() {
  await requireChatGPTUser('/terminal');
  return <TerminalPage />;
}
