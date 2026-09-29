import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireChatGPTUser } from '../../../chatgpt-auth';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { labs } from '@/components/app/labs-page';
import { MeaningLab } from '@/components/app/meaning-lab';
import { Learn } from '@/components/playground/learn';
import { AgentTasks } from '@/components/playground/agent-tasks';
import { SoundLab } from '@/components/playground/sound';
import { Maths } from '@/components/playground/maths';
import styles from '@/components/app/sections.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Research labs · Hikmah' };

export default async function LabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lab = labs.find((l) => l.id === id);
  if (!lab) notFound();
  await requireChatGPTUser('/labs/' + lab.id);
  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          <SidebarTrigger className="size-9" />
          <div className={styles.headerText}>
            <h1>Research labs</h1>
            <p className={styles.headerSub}>
              These are local experiments. They work without a provider connection.
            </p>
          </div>
        </header>
        <div className={styles.switcher}>
          <Button variant="ghost" asChild>
            <Link href="/labs">
              <ArrowLeft size={16} />
              All labs
            </Link>
          </Button>
          <h2>{lab.name}</h2>
        </div>
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
    </div>
  );
}
