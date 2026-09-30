import { requireChatGPTUser } from '../chatgpt-auth';
import { BillingPanel } from '@/components/billing/billing-panel';
import { BetaBilling } from '@/components/settings/billing';

export const dynamic = 'force-dynamic';

export default async function Billing() {
  await requireChatGPTUser('/billing');
  return (
    <main className="billing-page">
      <BillingPanel />
      <BetaBilling />
    </main>
  );
}
