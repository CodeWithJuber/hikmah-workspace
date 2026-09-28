import type { Metadata } from 'next';
import { requireChatGPTUser } from '../chatgpt-auth';
import { AppShell } from '@/components/app/app-shell';
import { CompareView } from '@/components/compare/compare-view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Compare · Hikmah' };

/** One question, two answers: the raw model beside the same model with the
 * person's workspace. Rendered inside the product shell so the nav the
 * coordinator adds in `components/app/product-nav.tsx` shows here too. */
export default async function ComparePage() {
  await requireChatGPTUser('/compare');
  return (
    <AppShell>
      <CompareView />
    </AppShell>
  );
}
