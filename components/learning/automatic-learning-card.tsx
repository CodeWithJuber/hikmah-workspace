'use client';

import {
  Check,
  CirclePause,
  Clock3,
  Info,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AutomaticStatus } from '@/lib/learning/automatic-types';
import type { LearningSnapshot } from '@/lib/learning/types';
import { readableDate } from './shared';

const statusTitles: Record<AutomaticStatus, string> = {
  paused: 'Learning is paused',
  waiting: 'Ready for your next conversation',
  preparing: 'Preparing a learning example',
  training: 'Training your co-model',
  evaluating: 'Checking the update',
  updated: 'Your co-model has an update',
  held: 'Your current co-model is staying in place',
  error: 'Learning needs attention',
};
const phases = ['Prepare examples', 'Train locally', 'Check improvement'];

export function AutomaticLearningCard({
  snapshot,
  busy,
  loading,
  onConfigure,
  onReset,
}: {
  snapshot: LearningSnapshot | null;
  busy: boolean;
  loading: boolean;
  onConfigure: (automatic: boolean) => Promise<boolean>;
  onReset: () => void;
}) {
  const automatic = snapshot?.automatic;
  const enabled = snapshot?.policy.automatic ?? false;
  const status = automatic?.status ?? 'paused';
  const working = ['preparing', 'training', 'evaluating'].includes(status);
  const phase =
    { preparing: 0, training: 1, evaluating: 2, updated: 3, held: automatic?.metric ? 3 : -1 }[
      status as 'preparing' | 'training' | 'evaluating' | 'updated' | 'held'
    ] ?? -1;
  // A retained checkpoint can outlive its source examples and job history.
  const canReset = !!snapshot;
  const improved = automatic?.metric?.approved && automatic.metric.gain > 0;
  const hasHistory = !!automatic?.lastAt;
  const StateIcon = working
    ? LoaderCircle
    : status === 'updated'
      ? Check
      : status === 'error' || status === 'held'
        ? Info
        : enabled
          ? Clock3
          : CirclePause;

  return (
    <section className="learning-automatic" aria-labelledby="automatic-learning-title">
      <div className="learning-automatic-topline">
        <span>
          <Sparkles size={16} aria-hidden="true" /> Automatic co-model learning
        </span>
        <span className={`learning-auto-indicator${enabled ? ' is-enabled' : ''}`}>
          {!snapshot ? (loading ? 'Loading…' : 'Unavailable') : enabled ? 'On' : 'Off'}
        </span>
      </div>

      <div className="learning-automatic-main">
        <div className="learning-automatic-copy">
          <h2 id="automatic-learning-title">
            {!snapshot ? 'Learning in the background' : statusTitles[status]}
          </h2>
          <p className="learning-auto-status" role="status" aria-live="polite" aria-atomic="true">
            <StateIcon size={16} className={working ? 'spin' : undefined} aria-hidden="true" />
            <span>
              {!snapshot
                ? loading
                  ? 'Checking your learning settings…'
                  : 'Retry below to load your settings.'
                : automatic?.reason || 'Enable learning, then keep chatting as usual.'}
            </span>
          </p>
        </div>
        <div className="learning-automatic-actions">
          <Button
            className="learning-button"
            variant={enabled ? 'outline' : 'default'}
            disabled={!snapshot || busy}
            aria-describedby={!enabled ? 'automatic-learning-consent' : undefined}
            onClick={() => void onConfigure(!enabled)}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : enabled ? (
              <CirclePause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
            {enabled
              ? 'Pause learning'
              : hasHistory
                ? 'Resume learning'
                : 'Enable automatic learning'}
          </Button>
          {canReset && (
            <Button
              className="learning-auto-reset"
              variant="ghost"
              disabled={busy}
              onClick={onReset}
            >
              <RotateCcw size={16} aria-hidden="true" /> Reset learning
            </Button>
          )}
        </div>
      </div>

      {enabled && (
        <ol className="learning-auto-phases" aria-label="Automatic learning progress">
          {phases.map((label, index) => (
            <li
              key={label}
              data-progress={phase > index ? 'complete' : phase === index ? 'current' : 'waiting'}
              aria-current={phase === index ? 'step' : undefined}
            >
              <span aria-hidden="true">{phase > index ? <Check size={12} /> : index + 1}</span>
              {label}
              {phase === index && <span className="sr-only">in progress</span>}
            </li>
          ))}
        </ol>
      )}

      {improved && automatic?.metric && (
        <div className="learning-auto-improvement">
          <Check size={16} aria-hidden="true" />
          <div>
            <strong>
              Syntax check improved by {(automatic.metric.gain * 100).toFixed(1)} percentage points
            </strong>
            <p>{automatic.metric.scope}. This does not measure overall answer quality.</p>
          </div>
        </div>
      )}

      {automatic && (enabled || hasHistory) && (
        <dl className="learning-auto-facts">
          <div>
            <dt>Extra requests today</dt>
            <dd>
              {automatic.requestsToday} / {automatic.dailyLimit}
            </dd>
          </div>
          <div>
            <dt>Waiting to learn</dt>
            <dd>
              {automatic.queued} {automatic.queued === 1 ? 'exchange' : 'exchanges'}
            </dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>
              {automatic.lastAt ? (
                <time dateTime={automatic.lastAt}>{readableDate(automatic.lastAt)}</time>
              ) : (
                'No training yet'
              )}
            </dd>
          </div>
        </dl>
      )}

      <div className="learning-auto-explanation" id="automatic-learning-consent">
        <p>
          {enabled ? 'Learning uses' : 'Enabling saves'} successful text-only chat prompts and
          answers. Chats with files or tools are excluded. Up to {automatic?.dailyLimit ?? 3} extra
          requests a day send at most {automatic?.sentencesPerRequest ?? 2} short sentences each to
          the same model provider for training labels. Your provider may charge for these requests.
        </p>
        <p>
          Hikmah trains your local syntax co-model and keeps an update only when it passes the
          development check. Your provider’s model weights stay unchanged. You can pause or reset at
          any time.
        </p>
      </div>
    </section>
  );
}
