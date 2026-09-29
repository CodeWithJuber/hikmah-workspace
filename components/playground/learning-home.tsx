'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  BrainCircuit,
  ArrowUpRight,
  ShieldCheck,
  LockKeyhole,
  RefreshCw,
  FlaskConical,
  Activity,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { usePlayground } from './context';
import { useMemory } from '@/hooks/use-memory';
import { useKernel } from '@/components/kernel/context';
import { KnowledgeEditor, newKnowledge } from './knowledge';
import { VitalsPanel } from '@/components/settings/vitals-panel';
import type { KnowledgeItem } from '@/lib/playground/knowledge';
import styles from '@/components/app/sections.module.css';

export function OwnerAccess({ children, crumb }: { children: ReactNode; crumb?: ReactNode }) {
  const kernel = useKernel();
  if (kernel.ready && kernel.role === 'super_admin')
    // The crumb is passed by the superadmin route pages and rendered above
    // the page's own scroller, so the shared LearningHome/KernelCenter markup
    // never learns about routes. Denied access keeps the plain panel.
    return crumb ? (
      <div className="admin-crumb-above">
        <div className="admin-crumb-strip">{crumb}</div>
        <div className="admin-crumb-body">{children}</div>
      </div>
    ) : (
      children
    );
  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          <SidebarTrigger className="size-9" />
          <h1>Owner console</h1>
        </header>
        <div className={styles.accessPanel}>
          <span className={styles.introIcon}>
            <LockKeyhole size={24} aria-hidden="true" />
          </span>
          <h2>
            {kernel.access === 'loading'
              ? 'Checking owner access…'
              : kernel.access === 'forbidden'
                ? 'Owner account required'
                : 'Connect your owner account'}
          </h2>
          <p>
            {kernel.error || 'Loading the server-verified owner role and saved learning state.'}
          </p>
          <p>
            Training, model releases and shared knowledge are available to the configured owner.
            Your model provider key does not grant admin access.
          </p>
          <Button disabled={kernel.access === 'loading'} onClick={() => void kernel.refresh()}>
            <RefreshCw size={16} />
            Check access again
          </Button>
          {kernel.access === 'signed_out' && (
            <a className={styles.link} href="/sign-in" target="_top">
              Sign in to your workspace
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function LearningHome({
  owner = false,
  flush = false,
}: {
  owner?: boolean;
  flush?: boolean;
}) {
  const { storageMessage, preferences, provider } = usePlayground();
  // Counts and recent activity from the memories table, the store every
  // answer reads — not the workspace blob this screen used to count.
  const { memories, counts } = useMemory();
  const kernel = useKernel();
  const [draft, setDraft] = useState<KnowledgeItem | null>(null);
  const activity = [
    ...(memories ?? []).map((k) => ({
      id: k.id,
      at: k.updatedAt,
      title: k.status === 'suggested' ? 'Memory awaiting review' : 'Memory updated',
      detail: k.title,
    })),
    ...kernel.state.events.map((e) => ({
      id: e.id,
      at: e.at,
      title: e.kind.replaceAll('_', ' '),
      detail: e.detail,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12);
  const links = owner
    ? [
        {
          title: 'Train the context model',
          text: 'Review language annotations, train parameters and inspect release gates.',
          page: 'superadmin/training',
          icon: FlaskConical,
        },
        {
          title: 'Rule learning & feedback',
          text: 'Teach supported meanings and inspect learned workflow preferences.',
          page: 'superadmin/learning',
          icon: BrainCircuit,
        },
        {
          title: 'Run history',
          text: 'See model names, outcomes, tokens and user ratings.',
          page: 'superadmin/runs',
          icon: Activity,
        },
        {
          title: 'Integrations',
          text: 'Connect the services the assistant can use in your workspace.',
          page: 'connections',
          icon: Settings2,
        },
        {
          title: 'Owner controls',
          text: 'Configure the middle layer, rule training and feedback collection.',
          page: 'superadmin/controls',
          icon: Settings2,
        },
      ]
    : [
        {
          title: 'Open memory',
          text: `${counts.saved} saved · ${counts.suggested} awaiting review. Edit, approve or forget.`,
          page: 'knowledge',
          icon: BookOpen,
        },
        {
          title: 'Train the co-model',
          text: 'Own parameters, reviewed examples and tested checkpoints.',
          page: 'superadmin/training',
          icon: FlaskConical,
        },
        {
          title: 'Understand a document',
          text: 'Run the existing local language model without provider tokens.',
          page: 'kernel',
          icon: BrainCircuit,
        },
        {
          title: 'Owner console',
          text: 'Owner access, training controls and run history.',
          page: 'superadmin',
          icon: ShieldCheck,
        },
      ];
  const body = (
    <>
      <section className={styles.hero}>
        <span className={styles.eyebrow}>
          {owner ? 'Owner console' : 'Your intelligence layer'}
        </span>
        <h2>
          {owner ? 'Training and control, in one place.' : 'See what stays. See what changes.'}
        </h2>
        <p>
          {owner
            ? 'Owner access verified. Choose the model pipeline you want to manage.'
            : 'Memory supplies reusable context. Feedback adjusts workflow preferences. Reviewed annotations train the local model.'}
        </p>
      </section>
      <div className={styles.statusGrid}>
        <div className={styles.statusCard}>
          <BookOpen size={20} aria-hidden="true" />
          <strong>{counts.saved}</strong>
          <span>Saved memories</span>
        </div>
        <div className={styles.statusCard}>
          <BrainCircuit size={20} aria-hidden="true" />
          <strong>{counts.suggested}</strong>
          <span>Awaiting your review</span>
        </div>
        <div className={styles.statusCard}>
          <Activity size={20} aria-hidden="true" />
          <strong>{kernel.ready ? kernel.state.feedbackRevision : '—'}</strong>
          <span>Feedback updates</span>
        </div>
      </div>
      {counts.suggested > 0 && (
        <div className={styles.reviewBanner} role="status">
          <span>
            <strong>
              {counts.suggested} memory suggestion{counts.suggested > 1 ? 's' : ''}
            </strong>{' '}
            ready to review before use.
          </span>
          <Button asChild>
            <Link href="/knowledge">Review</Link>
          </Button>
        </div>
      )}
      <div className={styles.directory}>
        {links.map((l) => (
          <Link key={l.page} href={'/' + l.page} className={styles.dirCard}>
            <span className={styles.dirIcon}>
              <l.icon size={24} aria-hidden="true" />
            </span>
            <span className={styles.dirCardBody}>
              <strong>{l.title}</strong>
              <p>{l.text}</p>
            </span>
            <ArrowUpRight size={20} className={styles.dirArrow} aria-hidden="true" />
          </Link>
        ))}
      </div>
      {owner && <VitalsPanel />}
      <div className={styles.liveGrid}>
        <section className={styles.livePanel}>
          <h3>What runs in real time</h3>
          <dl>
            <div>
              <dt>Personal memory</dt>
              <dd>{counts.saved ? 'Retrieved for every answer' : 'Add a memory to begin'}</dd>
            </div>
            <div>
              <dt>Memory suggestions</dt>
              <dd>Saved in your own words now; the model’s suggestions arrive with review</dd>
            </div>
            <div>
              <dt>Feedback learning</dt>
              <dd>
                {kernel.ready
                  ? kernel.state.config.collectFeedback
                    ? 'On · when you rate a response'
                    : 'Paused by owner'
                  : 'Learning connection unavailable'}
              </dd>
            </div>
            <div>
              <dt>Context in chat</dt>
              <dd>
                {preferences.enableCoModel && kernel.state.config.enabled
                  ? 'Local analysis enabled'
                  : 'Disabled in current settings'}
              </dd>
            </div>
            <div>
              <dt>Parameter training</dt>
              <dd>Starts after you submit reviewed labels</dd>
            </div>
            <div>
              <dt>Provider spending</dt>
              <dd>
                {provider.freeOnly ? 'Free models only · no paid fallback' : 'Provider rates apply'}
              </dd>
            </div>
          </dl>
          <p className={styles.note}>
            Saving memories and training local models do not require a provider API key. Raw chats
            do not automatically become trusted training labels.
          </p>
        </section>
        <section className={styles.livePanel}>
          <h3>Recent learning activity</h3>
          {activity.length ? (
            <div className={styles.eventList}>
              {activity.map((e) => (
                <article className={styles.eventCard} key={e.id}>
                  <strong>{e.title}</strong>
                  <p>{e.detail}</p>
                  <time>{new Date(e.at).toLocaleString()}</time>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<BrainCircuit size={20} />}
              title="No updates yet"
              description="Save a memory, review an example or rate a completed response."
              action={
                <Button onClick={() => setDraft(newKnowledge())}>
                  <BookOpen size={16} />
                  Remember something
                </Button>
              }
            />
          )}
        </section>
      </div>
      <div className={styles.syncRow}>
        <span role="status">{storageMessage}</span>
        <span>
          {kernel.lastSynced
            ? 'Learning synced ' + new Date(kernel.lastSynced).toLocaleTimeString()
            : 'Learning not synced'}
        </span>
        <Button
          variant="ghost"
          disabled={kernel.access === 'loading'}
          onClick={() => void kernel.refresh()}
        >
          <RefreshCw size={16} />
          Refresh learning
        </Button>
      </div>
      <a
        className={styles.researchLink}
        href="/research/v7/memory-research.md"
        target="_blank"
        rel="noreferrer"
      >
        Memory research, Quranic context and mathematics ↗
      </a>
      {draft && <KnowledgeEditor key={draft.id} value={draft} onClose={() => setDraft(null)} />}
    </>
  );
  /* The Teach Library tab renders this without page chrome: the Teach header
     and tab bar already frame it. Everywhere else it keeps its own header. */
  if (flush) return <div className={styles.pageInner}>{body}</div>;
  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          <SidebarTrigger className="size-9" />
          <div className={styles.headerText}>
            <h1>{owner ? 'Owner console · Super Admin' : 'Memory & learning'}</h1>
          </div>
          <div className={styles.headerActions}>
            <Button variant="outline" onClick={() => setDraft(newKnowledge())}>
              <BookOpen size={16} />
              Remember something
            </Button>
          </div>
        </header>
        {body}
      </div>
    </div>
  );
}
