'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  Brain,
  ChevronDown,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Info,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clientFetch } from '@/lib/client/request';
import {
  MAX_RESPONSE_CHARACTERS,
  type ExampleStatus,
  type LearningExample,
  type LearningPolicy,
} from '@/lib/learning/types';
import { LEARNING_PAGE_SIZE, useLearning, type LearningAction } from '@/hooks/use-learning';
import { AutomaticLearningCard } from './automatic-learning-card';
import { readableDate, saveDownload } from './shared';

const CoModelTraining = dynamic(
  () => import('./co-model-training').then((module) => module.CoModelTraining),
  {
    loading: () => (
      <p className="learning-subtle-status" role="status">
        Loading manual training…
      </p>
    ),
  },
);
const ResearchEvidence = dynamic(
  () => import('./research-evidence').then((module) => module.ResearchEvidence),
  {
    loading: () => (
      <p className="learning-subtle-status" role="status">
        Loading research evidence…
      </p>
    ),
  },
);

const statusLabels: Record<ExampleStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function LearningStudio({
  revision = 0,
  active = true,
  onOpenMemory,
}: {
  revision?: number;
  active?: boolean;
  onOpenMemory?: () => void;
}) {
  const [status, setStatus] = useState<ExampleStatus>('pending');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<LearningExample | null>(null);
  const [confirmation, setConfirmation] = useState<LearningExample | 'all' | null>(null);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedView, setAdvancedView] = useState('training');
  const [visited, setVisited] = useState({ training: false, research: false });
  const { snapshot, loading, busy, error, refresh, send } = useLearning(
    status,
    offset,
    revision,
    active,
  );
  const query = search.trim().toLocaleLowerCase();
  const examples = (snapshot?.examples ?? []).filter(
    (example) =>
      !query ||
      [example.prompt, example.effectiveResponse, example.model, example.provider].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
  );

  async function mutate(action: LearningAction, notice: string) {
    setActionError('');
    setMessage('');
    try {
      await send(action);
      setMessage(notice);
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The change could not be saved.');
      return false;
    }
  }

  async function exportApproved() {
    setExporting(true);
    setActionError('');
    try {
      const response = await clientFetch('/api/learning?export=approved', { cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'The export could not be downloaded.');
      }
      saveDownload(
        await response.blob(),
        `hikmah-approved-examples-${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      setMessage('Approved examples exported as JSONL.');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="learning-studio">
      <header className="learning-heading">
        <h1>Keep chatting. Learning follows.</h1>
        <p>
          Turn it on once. Hikmah prepares, trains, and checks your local co-model in the
          background.
        </p>
      </header>

      <AutomaticLearningCard
        snapshot={snapshot}
        busy={busy}
        loading={loading}
        onConfigure={(automatic) =>
          mutate(
            { action: 'configure', automatic },
            automatic
              ? 'Automatic learning enabled. Continue chatting as usual.'
              : 'Automatic learning paused. Your existing co-model stays available.',
          )
        }
        onReset={() => {
          setConfirmation('all');
          setActionError('');
        }}
      />

      {(error || actionError) && (
        <div className="learning-alert" role="alert">
          <Info size={16} />
          <span>{actionError || error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setActionError('');
              void refresh();
            }}
            disabled={loading}
          >
            <RefreshCw size={16} />
            Retry
          </Button>
        </div>
      )}
      {message && (
        <p className="learning-notice" role="status">
          <Check size={16} />
          {message}
        </p>
      )}

      <details className="learning-disclosure">
        <summary>
          <span>
            <strong>Saved examples</strong>
            <small>Review and correct responses when you want to.</small>
          </span>
          {snapshot && snapshot.counts.total > 0 && (
            <span className="learning-tab-count">{snapshot.counts.total}</span>
          )}
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="learning-disclosure-content">
          <div className="learning-example-intro">
            <p>
              Automatic training needs no review clicks. Approve examples here only if you want
              similar future chats to reuse the answer as guidance.
            </p>
            <Button
              variant="outline"
              className="learning-button"
              disabled={!snapshot || busy}
              onClick={() => setSettings(true)}
            >
              <Settings2 size={16} aria-hidden="true" /> Data settings
            </Button>
          </div>
          <div className="learning-toolbar">
            <div className="learning-search">
              <Search size={20} aria-hidden="true" />
              <input
                aria-label="Search examples on this page"
                placeholder="Search examples on this page"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={200}
              />
              {search && (
                <button
                  type="button"
                  className="learning-icon-button"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <select
              className="learning-status-select"
              aria-label="Filter examples by review status"
              value={status}
              disabled={busy}
              onChange={(event) => {
                setStatus(event.target.value as ExampleStatus);
                setOffset(0);
                setSearch('');
              }}
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                  {snapshot ? ` (${snapshot.counts[value as ExampleStatus]})` : ''}
                </option>
              ))}
            </select>
            <Button
              className="learning-button learning-export"
              disabled={!snapshot?.counts.approved || exporting}
              onClick={() => void exportApproved()}
            >
              {exporting ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
              Export approved
            </Button>
          </div>

          <div className="learning-queue" aria-busy={loading}>
            <div className="learning-table-scroll">
              <table className="learning-table">
                <caption className="sr-only">
                  Captured exchanges awaiting review. Search matches this page only.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Exchange</th>
                    <th scope="col">Model</th>
                    <th scope="col">Status</th>
                    <th scope="col">Captured</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="learning-blank-state learning-loading" role="status">
                          <LoaderCircle size={24} className="spin" />
                          <p>Loading your exchanges…</p>
                        </div>
                      </td>
                    </tr>
                  ) : error && !snapshot ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="learning-blank-state">
                          <Info size={32} />
                          <h2>Examples could not be loaded</h2>
                          <p>
                            Your saved data has not been replaced.
                            <br />
                            Retry when your connection is available.
                          </p>
                          <Button variant="outline" onClick={() => void refresh()}>
                            <RefreshCw size={16} />
                            Try again
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : examples.length ? (
                    examples.map((example) => (
                      <tr key={example.id}>
                        <td>
                          <button
                            type="button"
                            className="learning-exchange-link"
                            onClick={() => {
                              setSelected(example);
                              setActionError('');
                            }}
                          >
                            <span>{example.prompt || 'Untitled exchange'}</span>
                            <small>{example.effectiveResponse}</small>
                          </button>
                        </td>
                        <td>
                          <span className="learning-model-name" title={example.model}>
                            {example.model}
                          </span>
                          <small className="learning-subtext">{example.provider}</small>
                        </td>
                        <td>
                          <span className={`learning-badge learning-badge-${example.status}`}>
                            {statusLabels[example.status]}
                          </span>
                        </td>
                        <td>
                          <time dateTime={example.createdAt} className="learning-date">
                            {readableDate(example.createdAt)}
                          </time>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="learning-icon-button"
                            aria-label={`Inspect exchange: ${example.prompt.slice(0, 70)}`}
                            onClick={() => {
                              setSelected(example);
                              setActionError('');
                            }}
                          >
                            <ChevronRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>
                        <div className="learning-blank-state">
                          <FileText size={48} strokeWidth={1.4} />
                          <h2>
                            {query
                              ? 'No matches on this page'
                              : offset > 0
                                ? 'You’ve reached the end'
                                : snapshot?.counts.total
                                  ? `No ${status} exchanges`
                                  : 'No exchanges captured yet'}
                          </h2>
                          <p>
                            {query ? (
                              'Try another phrase or clear your search.'
                            ) : offset > 0 ? (
                              'Return to the previous page to review more examples.'
                            ) : snapshot?.counts.total ? (
                              'Choose another status to see your saved examples.'
                            ) : (
                              <>
                                {snapshot?.policy.enabled
                                  ? 'Completed text-only chats appear here. Chats using files or tools are excluded.'
                                  : 'Enable automatic learning above, or turn on capture in Data settings.'}
                              </>
                            )}
                          </p>
                          {query && (
                            <Button variant="outline" onClick={() => setSearch('')}>
                              Clear search
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {snapshot && (snapshot.counts[status] > LEARNING_PAGE_SIZE || offset > 0) && (
              <div className="learning-pagination">
                <span>
                  {examples.length && !search
                    ? `${offset + 1}–${offset + examples.length} of ${snapshot.counts[status]}`
                    : `Page ${Math.floor(offset / LEARNING_PAGE_SIZE) + 1}`}
                  {search ? ' · filtered on this page' : ''}
                </span>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading || busy || offset === 0}
                    onClick={() => setOffset((value) => Math.max(0, value - LEARNING_PAGE_SIZE))}
                  >
                    <ChevronLeft size={16} />
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading || busy || !snapshot.hasMore}
                    onClick={() => setOffset((value) => value + LEARNING_PAGE_SIZE)}
                  >
                    Next
                    <ChevronRight size={16} />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <footer className="learning-footnote">
            <p>
              <Info size={16} aria-hidden="true" /> Examples are private to your account. Known
              secrets are redacted; check sensitive content before approving.
            </p>
          </footer>
        </div>
      </details>

      <details
        className="learning-disclosure learning-advanced"
        onToggle={(event) => {
          setAdvancedOpen(event.currentTarget.open);
          if (event.currentTarget.open) setVisited((current) => ({ ...current, training: true }));
        }}
      >
        <summary>
          <span>
            <strong>Advanced</strong>
            <small>Manual training, saved memory, and research evidence.</small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="learning-disclosure-content">
          <div className="learning-advanced-intro">
            <p>These controls are optional. Automatic learning continues without them.</p>
            {onOpenMemory && (
              <Button variant="outline" onClick={onOpenMemory}>
                <Brain size={16} aria-hidden="true" /> Saved memory
              </Button>
            )}
          </div>
          <Tabs
            defaultValue="training"
            className="learning-tabs"
            onValueChange={(tab) => {
              setAdvancedView(tab);
              if (tab === 'training' || tab === 'research')
                setVisited((current) => ({ ...current, [tab]: true }));
            }}
          >
            <TabsList
              variant="line"
              className="learning-tab-list"
              aria-label="Advanced learning tools"
            >
              <TabsTrigger className="learning-tab-trigger" value="training">
                Manual co-model training
              </TabsTrigger>
              <TabsTrigger className="learning-tab-trigger" value="research">
                Research evidence
              </TabsTrigger>
            </TabsList>
            <TabsContent value="training" className="learning-tab-panel" forceMount>
              {visited.training && (
                <CoModelTraining
                  active={active && advancedOpen && advancedView === 'training'}
                  revision={`${snapshot?.policy.revision ?? 0}:${snapshot?.automatic.checkpointId ?? 'released'}`}
                />
              )}
            </TabsContent>
            <TabsContent value="research" className="learning-tab-panel" forceMount>
              {visited.research && <ResearchEvidence />}
            </TabsContent>
          </Tabs>
        </div>
      </details>

      {settings && snapshot && (
        <CaptureSettings
          policy={snapshot.policy}
          busy={busy}
          error={actionError}
          onClose={() => {
            if (!busy) {
              setSettings(false);
              setActionError('');
            }
          }}
          onSave={async (policy) => {
            if (
              await mutate(
                { action: 'configure', ...policy },
                policy.enabled
                  ? 'Capture settings saved. New successful exchanges can now be reviewed here.'
                  : 'Capture settings saved.',
              )
            )
              setSettings(false);
          }}
        />
      )}

      {selected && (
        <ExampleReview
          key={`${selected.id}:${selected.revision}`}
          example={selected}
          busy={busy}
          error={actionError}
          onClose={() => {
            if (!busy) {
              setSelected(null);
              setActionError('');
            }
          }}
          onReview={async (reviewStatus, correction) => {
            if (
              await mutate(
                {
                  action: 'review',
                  id: selected.id,
                  revision: selected.revision,
                  status: reviewStatus,
                  correction,
                },
                `Example ${reviewStatus}.`,
              )
            )
              setSelected(null);
          }}
          onDelete={() => {
            setConfirmation(selected);
            setSelected(null);
            setActionError('');
          }}
        />
      )}

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmation(null);
            setActionError('');
          }
        }}
      >
        <DialogContent className="learning-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {confirmation === 'all' ? 'Reset automatic learning?' : 'Delete this example?'}
            </DialogTitle>
            <DialogDescription>
              {confirmation === 'all'
                ? 'This erases captured examples, automatic training data and automatic checkpoints, restores the previous manual or released co-model, and turns learning and capture off. Your conversations and manual checkpoints stay available.'
                : 'This deletes the saved example and cancels its pending learning work. It cannot remove what an existing checkpoint has already learned; use Reset learning for that. The original conversation and context already prepared for running chats stay available.'}
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <p className="learning-dialog-error" role="alert">
              {actionError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !confirmation}
              onClick={async () => {
                if (!confirmation) return;
                const action: LearningAction =
                  confirmation === 'all'
                    ? { action: 'clear' }
                    : { action: 'delete', id: confirmation.id };
                if (
                  await mutate(
                    action,
                    confirmation === 'all'
                      ? 'Learning reset and paused. Your previous co-model has been restored.'
                      : 'Example deleted.',
                  )
                ) {
                  setConfirmation(null);
                  setOffset(0);
                }
              }}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
              {confirmation === 'all' ? 'Reset learning' : 'Delete example'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CaptureSettings({
  policy,
  busy,
  error,
  onClose,
  onSave,
}: {
  policy: LearningPolicy;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (policy: Omit<LearningPolicy, 'revision' | 'automatic'>) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    enabled: policy.enabled,
    useApproved: policy.useApproved,
    collectSyntax: policy.collectSyntax,
    retentionDays: policy.retentionDays,
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave(draft);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="learning-dialog" showCloseButton={!busy}>
        <form onSubmit={submit} className="learning-settings-form">
          <DialogHeader>
            <DialogTitle>Learning data settings</DialogTitle>
            <DialogDescription>
              Choose what is saved from future successful model exchanges and how it can be reused.
            </DialogDescription>
          </DialogHeader>
          <div className="learning-consent">
            <ShieldCheck size={20} />
            <p>
              Capture saves text-only chat prompts and answers, model identity, and the source
              conversation. Chats with files or tools are excluded. Known secrets are redacted
              automatically; review for sensitive content before approving an example.
            </p>
          </div>
          <label className="learning-setting-row">
            <div>
              <strong>Capture new exchanges</strong>
              <span>
                Pausing capture also pauses automatic learning. Existing examples stay saved.
              </span>
            </div>
            <Switch
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
            />
          </label>
          <label className="learning-setting-row">
            <div>
              <strong>Reuse approved examples</strong>
              <span>
                Relevant approved examples can guide new chat runs. Existing runs keep their
                prepared context.
              </span>
            </div>
            <Switch
              checked={draft.useApproved}
              disabled={busy}
              onCheckedChange={(useApproved) => setDraft((value) => ({ ...value, useApproved }))}
            />
          </label>
          <label className="learning-setting-row">
            <div>
              <strong>Collect syntax review candidates</strong>
              <span>
                Save additional candidates for manual annotation. Automatic learning prepares its
                own training labels. Owner access is required for manual training.
              </span>
            </div>
            <Switch
              checked={draft.collectSyntax}
              disabled={busy}
              onCheckedChange={(collectSyntax) =>
                setDraft((value) => ({ ...value, collectSyntax }))
              }
            />
          </label>
          <label className="learning-setting-row" htmlFor="learning-retention">
            <div>
              <strong>Queue retention</strong>
              <span>
                Older examples, syntax candidates, and automatic training labels expire. Trained
                parameters remain until you reset learning. Original chats stay available.
              </span>
            </div>
            <select
              id="learning-retention"
              value={draft.retentionDays}
              disabled={busy}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  retentionDays: Number(event.target.value) as 7 | 30 | 90,
                }))
              }
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          {error && (
            <p className="learning-dialog-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle size={16} className="spin" />}
              {!policy.enabled && draft.enabled ? 'Enable capture & save' : 'Save settings'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExampleReview({
  example,
  busy,
  error,
  onClose,
  onReview,
  onDelete,
}: {
  example: LearningExample;
  busy: boolean;
  error: string;
  onClose: () => void;
  onReview: (status: ExampleStatus, correction: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(example.correction !== null);
  const [correction, setCorrection] = useState(example.correction ?? example.response);
  const reviewedCorrection = editing && correction !== example.response ? correction : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="learning-dialog learning-review-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Review this exchange</DialogTitle>
          <DialogDescription>
            Approve only an answer you want reused. A correction preserves the original response for
            comparison.
          </DialogDescription>
        </DialogHeader>
        <div className="learning-review-meta">
          <span className={`learning-badge learning-badge-${example.status}`}>
            {statusLabels[example.status]}
          </span>
          <span>
            {example.provider} · {example.model}
          </span>
          <time dateTime={example.createdAt}>{readableDate(example.createdAt)}</time>
        </div>
        <div className="learning-review-body">
          <section className="learning-exchange-section">
            <h3>Prompt</h3>
            <p dir="auto">{example.prompt}</p>
          </section>
          <section className="learning-exchange-section">
            <h3>Original response</h3>
            <p dir="auto">{example.response}</p>
          </section>
          {example.redactions.length > 0 && (
            <p className="learning-redaction-note">
              <ShieldCheck size={16} />
              Redacted before saving: {example.redactions.join(', ')}
            </p>
          )}
          {editing ? (
            <label className="learning-correction">
              <span>Corrected answer for reuse</span>
              <textarea
                rows={7}
                dir="auto"
                value={correction}
                disabled={busy}
                maxLength={MAX_RESPONSE_CHARACTERS}
                onChange={(event) => setCorrection(event.target.value)}
              />
              <small>
                {correction.length.toLocaleString()} / {MAX_RESPONSE_CHARACTERS.toLocaleString()}{' '}
                characters
              </small>
              <button
                type="button"
                className="learning-text-button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setCorrection(example.response);
                }}
              >
                Use original response
              </button>
            </label>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              <PencilLine size={16} />
              Correct this answer
            </Button>
          )}
          <details className="learning-provenance">
            <summary>Source and provenance</summary>
            <dl>
              <div>
                <dt>Run</dt>
                <dd>{example.runId}</dd>
              </div>
              <div>
                <dt>Review revision</dt>
                <dd>{example.revision}</dd>
              </div>
              {example.reviewedAt && (
                <div>
                  <dt>Last reviewed</dt>
                  <dd>{readableDate(example.reviewedAt)}</dd>
                </div>
              )}
            </dl>
            {example.conversationId && (
              <Link
                href={`/chat/${encodeURIComponent(example.conversationId)}`}
                className="learning-inline-link"
              >
                Open source conversation
                <ArrowUpRight size={16} />
              </Link>
            )}
          </details>
        </div>
        {error && (
          <p className="learning-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="learning-review-actions">
          <Button variant="ghost" disabled={busy} onClick={onDelete} className="learning-delete">
            <Trash2 size={16} />
            Delete
          </Button>
          <div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void onReview('rejected', reviewedCorrection)}
            >
              <X size={16} />
              Reject
            </Button>
            <Button
              disabled={busy || (editing && !correction.trim())}
              onClick={() => void onReview('approved', reviewedCorrection)}
            >
              {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              {example.status === 'approved' ? 'Save approval' : 'Approve example'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
