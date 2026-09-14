import type { Metadata } from 'next';
import { LegalShell, PrivacyBody } from '@/components/marketing/legal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Privacy · Hikmah',
  description: 'What Hikmah keeps, who else sees it, and what is never done with it.',
};

export default function Privacy() {
  return (
    <LegalShell title="Privacy">
      <PrivacyBody />
    </LegalShell>
  );
}
