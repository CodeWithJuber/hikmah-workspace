import type { Metadata } from 'next';
import { LegalShell, TermsBody } from '@/components/marketing/legal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Terms · Hikmah',
  description: 'The terms you agree to by using the Hikmah workspace.',
};

export default function Terms() {
  return (
    <LegalShell title="Terms">
      <TermsBody />
    </LegalShell>
  );
}
