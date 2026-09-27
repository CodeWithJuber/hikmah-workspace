import type { Metadata } from 'next';
import { requireChatGPTUser } from '../../chatgpt-auth';
// Created by another worker; the import must exist before typecheck.
import { UnifiedLearning } from '@/components/learning/unified-learning';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Learning · Hikmah' };

export default async function LearningPage() {
  await requireChatGPTUser('/learning');
  return <UnifiedLearning />;
}
