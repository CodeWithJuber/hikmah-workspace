import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireChatGPTUser } from '../../../chatgpt-auth';
import { labs } from '@/components/app/labs-data';
import { MeaningLab } from '@/components/app/meaning-lab';
import { Learn } from '@/components/playground/learn';
import { AgentTasks } from '@/components/playground/agent-tasks';
import { SoundLab } from '@/components/playground/sound';
import { Maths } from '@/components/playground/maths';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Research labs · Hikmah' };

/** One lab, full-bleed. The native shell is a sticky header with the back
 * affordance and the lab's name; the lab itself keeps its own components —
 * they are the experiment, not the chrome. */
export default async function LabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lab = labs.find((l) => l.id === id);
  if (!lab) notFound();
  await requireChatGPTUser('/labs/' + lab.id);
  const Icon = lab.icon;
  return (
    <div className="n-page n-screen-in">
      <header className="n-header">
        <Link href="/labs" className="n-icon-btn n-press" aria-label="All labs">
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
        <h1>{lab.name}</h1>
        <div className="n-header-actions">
          <span className="n-row-avatar" aria-hidden="true">
            <Icon size={20} />
          </span>
        </div>
      </header>
      <p className="n-note">
        {lab.description} Local experiments — they work without a provider connection.
      </p>
      {lab.id === 'meaning' ? (
        <MeaningLab />
      ) : lab.id === 'learn' ? (
        <Learn />
      ) : lab.id === 'planning' ? (
        <AgentTasks />
      ) : lab.id === 'sound' ? (
        <SoundLab />
      ) : (
        <Maths />
      )}
    </div>
  );
}
