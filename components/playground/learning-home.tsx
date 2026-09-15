'use client';
import { useState, type ReactNode } from 'react';
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
import { SidebarTrigger } from '@/components/ui/sidebar';
import { usePlayground } from './context';
import { useMemory } from '@/hooks/use-memory';
import { useKernel } from '@/components/kernel/context';
import { KnowledgeEditor, newKnowledge } from './knowledge';
import { VitalsPanel } from '@/components/settings/vitals-panel';
import type { KnowledgeItem } from '@/lib/playground/knowledge';

export function OwnerAccess({ children }: { children: ReactNode }) {
  const kernel = useKernel();
  if (kernel.ready && kernel.role === 'super_admin') return children;
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>Owner console</h1>
      </header>
      <div className="access-panel">
        <LockKeyhole size={32} />
        <h2>
          {kernel.access === 'loading'
            ? 'Checking owner access…'
            : kernel.access === 'forbidden'
              ? 'Owner account required'
              : 'Connect your owner account'}
        </h2>
        <p>{kernel.error || 'Loading the server-verified owner role and saved learning state.'}</p>
        <p>
          Training, model releases and shared knowledge are available to the configured owner. Your
          model provider key does not grant admin access.
        </p>
        <Button disabled={kernel.access === 'loading'} onClick={() => void kernel.refresh()}>
          <RefreshCw size={16} />
          Check access again
        </Button>
        {kernel.access === 'signed_out' && (
          <a href="/sign-in" target="_top">
            Sign in to your workspace
          </a>
        )}
      </div>
    </div>
  );
}

export function LearningHome({ owner = false }: { owner?: boolean }) {
  const { setWorkspacePage, storageMessage, preferences, provider } = usePlayground();
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
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>{owner ? 'Owner console · Super Admin' : 'Memory & learning'}</h1>
        <Button variant="outline" onClick={() => setDraft(newKnowledge())}>
          <BookOpen size={16} />
          Remember something
        </Button>
      </header>
      <div className="learning-home">
        <div className="learning-home-title">
          <span className="eyebrow">{owner ? 'OWNER CONSOLE' : 'YOUR INTELLIGENCE LAYER'}</span>
          <h2>
            {owner ? 'Training and control, in one place.' : 'See what stays. See what changes.'}
          </h2>
          <p>
            {owner
              ? 'Owner access verified. Choose the model pipeline you want to manage.'
              : 'Memory supplies reusable context. Feedback adjusts workflow preferences. Reviewed annotations train the local model.'}
          </p>
        </div>
        <div className="learning-status-grid">
          <div>
            <BookOpen size={20} />
            <strong>{counts.saved}</strong>
            <span>Saved memories</span>
          </div>
          <div>
            <BrainCircuit size={20} />
            <strong>{counts.suggested}</strong>
            <span>Awaiting your review</span>
          </div>
          <div>
            <Activity size={20} />
            <strong>{kernel.ready ? kernel.state.feedbackRevision : '—'}</strong>
            <span>Feedback updates</span>
          </div>
        </div>
        {counts.suggested > 0 && (
          <div className="memory-review-banner" role="status">
            <span>
              <strong>
                {counts.suggested} memory suggestion{counts.suggested > 1 ? 's' : ''}
              </strong>{' '}
              ready to review before use.
            </span>
            <Button onClick={() => setWorkspacePage('knowledge')}>Review</Button>
          </div>
        )}
        <div className="learning-links">
          {links.map((l) => (
            <button key={l.page} onClick={() => setWorkspacePage(l.page)}>
              <l.icon size={24} />
              <div>
                <strong>{l.title}</strong>
                <p>{l.text}</p>
              </div>
              <ArrowUpRight size={20} />
            </button>
          ))}
        </div>
        {owner && <VitalsPanel />}
        <div className="learning-live-grid">
          <section>
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
                  {provider.freeOnly
                    ? 'Free models only · no paid fallback'
                    : 'Provider rates apply'}
                </dd>
              </div>
            </dl>
            <p className="fine-print">
              Saving memories and training local models do not require a provider API key. Raw chats
              do not automatically become trusted training labels.
            </p>
          </section>
          <section>
            <h3>Recent learning activity</h3>
            {activity.length ? (
              activity.map((e) => (
                <article className="learning-event" key={e.id}>
                  <strong>{e.title}</strong>
                  <p>{e.detail}</p>
                  <time>{new Date(e.at).toLocaleString()}</time>
                </article>
              ))
            ) : (
              <div className="learning-empty">
                <BrainCircuit size={32} />
                <p>
                  No updates yet. Save a memory, review an example or rate a completed response.
                </p>
              </div>
            )}
          </section>
        </div>
        <div className="learning-sync">
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
          className="learning-research"
          href="/research/v7/memory-research.md"
          target="_blank"
          rel="noreferrer"
        >
          Memory research, Quranic context and mathematics ↗
        </a>
      </div>
      {draft && <KnowledgeEditor key={draft.id} value={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}
