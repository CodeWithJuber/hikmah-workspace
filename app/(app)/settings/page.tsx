import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { SettingsPage } from '@/components/app/settings-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Settings · Hikmah' };

export default async function SettingsRoutePage() {
  await requireChatGPTUser('/settings');
  return <SettingsPage />;
}
