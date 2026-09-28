import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { LearningHome, OwnerAccess } from '@/components/playground/learning-home';
import { AdminBreadcrumb } from '@/components/admin/admin-breadcrumb';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Super Admin · Hikmah' };

export default async function SuperadminPage() {
  await requireChatGPTUser('/superadmin');
  return (
    <OwnerAccess crumb={<AdminBreadcrumb trail={[{ label: 'Super Admin' }]} />}>
      <LearningHome owner />
    </OwnerAccess>
  );
}
