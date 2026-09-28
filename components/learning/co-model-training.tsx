'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronDown,
  Download,
  FileCode2,
  FlaskConical,
  Info,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { clientFetch } from '@/lib/client/request';
import { invalidateField, loadReleasedField } from '@/lib/context-model/client';
import { parseConllu } from '@/lib/context-model/conllu';
import { MAX_CORPUS, MAX_SUBMISSION } from '@/lib/context-model/training';
import type { FieldModel, Sentence } from '@/lib/context-model/field-model';
import { readableDate, saveDownload } from './shared';

const languages: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  hi: 'Hindi',
  es: 'Spanish',
  tr: 'Turkish',
};
type Metrics = { las: number; uas: number; posAccuracy: number; tokenCount: number };
type Version = {
  id: string;
  language: string;
  created_at: string;
  receipt: {
    approved: boolean;
    reason: string;
    gain: number;
    sha256: string;
    current: Metrics;
    regressions: string[];
  };
};
type Registry = { versions: Version[]; active: { language: string; version_id: string }[] };
type Candidate = { model: FieldModel; reviewed: Sentence[] };
type CandidateRow = { fingerprint: string; annotation: Sentence };
const percent = (value: number) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'Not measured';
const exampleRows = [
  {
    id: 'reviewed-example-1',
    groupId: 'owner/document-1',
    split: 'train',
    text: 'Mira writes notes.',
    tokens: [
      {
        id: 1,
        form: 'Mira',
        lemma: 'Mira',
        upos: 'PROPN',
        head: 2,
        deprel: 'nsubj',
        feats: { Number: 'Sing' },
      },
      {
        id: 2,
        form: 'writes',
        lemma: 'write',
        upos: 'VERB',
        head: 0,
        deprel: 'root',
        feats: { Tense: 'Pres' },
      },
      {
        id: 3,
        form: 'notes',
        lemma: 'note',
        upos: 'NOUN',
        head: 2,
        deprel: 'obj',
        feats: { Number: 'Plur' },
      },
      { id: 4, form: '.', lemma: '.', upos: 'PUNCT', head: 2, deprel: 'punct', feats: {} },
    ],
  },
];

class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function modelRequest<T>(query = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await clientFetch(
    `/api/context-model${query}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          timeoutMs: 30000,
        }
      : { cache: 'no-store', signal },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ModelRequestError(
      payload.error || 'The co-model service could not be reached.',
      response.status,
    );
  return payload as T;
}

async function fetchRegistry(signal?: AbortSignal) {
  const [savedRegistry, queue] = await Promise.allSettled([
    modelRequest<Registry>('', undefined, signal),
    modelRequest<{ waiting: Record<string, number> }>('?candidates=', undefined, signal),
  ]);
  if (savedRegistry.status === 'rejected') throw savedRegistry.reason;
  if (!Array.isArray(savedRegistry.value.versions) || !Array.isArray(savedRegistry.value.active))
    throw new Error('The checkpoint response was incomplete.');
  return {
    registry: savedRegistry.value,
    waiting: queue.status === 'fulfilled' ? (queue.value.waiting ?? {}) : null,
  };
}

export function CoModelTraining({
  active = true,
  revision = '',
}: {
  active?: boolean;
  revision?: string;
}) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState<ModelRequestError | Error | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [language, setLanguage] = useState('en');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<Record<string, string[]>>({});
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [queueError, setQueueError] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'training' | 'saving'>('idle');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [saved, setSaved] = useState<Version | null>(null);
  const [confirmation, setConfirmation] = useState<
    { action: 'activate'; version: Version } | { action: 'reset' } | null
  >(null);
  const [issues, setIssues] = useState<string[]>([]);
  const worker = useRef<{ instance: Worker; cancel: () => void } | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const hasRegistry = useRef(false);
  const lock = useRef(false);
  const rows = drafts[language] ?? '';
  const versions = registry?.versions.filter((version) => version.language === language) ?? [];
  const activeId = registry?.active.find((value) => value.language === language)?.version_id;
  const draftCount = (() => {
    try {
      const parsed = JSON.parse(rows || '[]');
      return Array.isArray(parsed) ? parsed.length : null;
    } catch {
      return null;
    }
  })();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchRegistry(signal);
    if (signal?.aborted || !mounted.current) return;
    hasRegistry.current = true;
    setRegistry(next.registry);
    if (next.waiting) {
      setWaiting(next.waiting);
      setQueueError('');
    } else
      setQueueError('The syntax review queue could not be loaded. Retry to refresh its count.');
  }, []);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setAccessError(null);
    try {
      await refresh(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setAccessError(
          cause instanceof Error ? cause : new Error('Co-model training is unavailable.'),
        );
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      worker.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!active || busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void fetchRegistry(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          hasRegistry.current = true;
          setRegistry(next.registry);
          setAccessError(null);
          if (next.waiting) {
            setWaiting(next.waiting);
            setQueueError('');
          } else
            setQueueError(
              'The syntax review queue could not be loaded. Retry to refresh its count.',
            );
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && mounted.current) {
          if (hasRegistry.current)
            setError(
              'Saved checkpoint versions could not be refreshed. Check again when your connection returns.',
            );
          else
            setAccessError(
              cause instanceof Error ? cause : new Error('Co-model training is unavailable.'),
            );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && mounted.current) setLoading(false);
      });
    return () => controller.abort();
  }, [active, revision, busy]);

  function parseDraft(): unknown[] {
    const parsed: unknown = JSON.parse(rows || '[]');
    if (!Array.isArray(parsed)) throw new Error('Reviewed annotations must be a JSON array.');
    return parsed;
  }

  function addRows(additions: unknown[]) {
    const combined = [...parseDraft(), ...additions];
    if (combined.length > MAX_SUBMISSION)
      throw new Error(`Add at most ${MAX_SUBMISSION} reviewed sentences per submission.`);
    setDrafts((current) => ({ ...current, [language]: JSON.stringify(combined, null, 2) }));
    setSaved(null);
    setCandidate(null);
  }

  async function addFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setIssues([]);
    try {
      if (file.size > 2_000_000) throw new Error('Use an annotation file smaller than 2 MB.');
      const text = await file.text();
      const result =
        /\.json$/i.test(file.name) || text.trimStart().startsWith('[')
          ? { rows: JSON.parse(text), problems: [] }
          : parseConllu(text, `owner/${file.name.replace(/\.[^.]+$/, '').slice(0, 120)}`);
      if (!Array.isArray(result.rows) || !result.rows.length)
        throw new Error('No valid sentences were found in this file.');
      addRows(result.rows);
      setIssues(result.problems.map((problem: { reason: string }) => problem.reason));
      setMessage(
        `${result.rows.length} sentence${result.rows.length === 1 ? '' : 's'} added. Review every annotation before training.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be read.');
    }
  }

  async function loadCandidates() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await modelRequest<{ candidates: CandidateRow[] }>(
        `?candidates=${language}&limit=20`,
      );
      const seen = new Set(loaded[language] ?? []);
      const additions = data.candidates.filter((item) => !seen.has(item.fingerprint));
      if (!additions.length) {
        setMessage('No new syntax candidates are available for this language.');
        return;
      }
      addRows(additions.map((item) => item.annotation));
      setLoaded((current) => ({
        ...current,
        [language]: [...(current[language] ?? []), ...additions.map((item) => item.fingerprint)],
      }));
      setMessage(
        `${additions.length} syntax candidates added. Their predicted annotations need your review.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The review queue could not be loaded.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function saveCandidate(value: Candidate) {
    setPhase('saving');
    setMessage('The server is checking the candidate against its development gate…');
    const result = await modelRequest<Version>('', {
      action: 'save',
      model: value.model,
      reviewedRows: value.reviewed,
    });
    if (!mounted.current) return;
    setSaved(result);
    setMessage(
      result.receipt.approved
        ? 'Development gate passed. Inspect the receipt before activating this checkpoint.'
        : 'Candidate saved for inspection. The development gate held activation.',
    );
    // Only queue annotations actually retained in the submitted draft may be
    // marked reviewed. A manually removed row remains available to review later.
    if (loaded[language]?.length) {
      const pending = await modelRequest<{ candidates: CandidateRow[] }>(
        `?candidates=${language}&limit=500`,
      );
      const trainedIds = new Set(value.reviewed.map((row) => row.id));
      const marked = pending.candidates
        .filter(
          (row) => loaded[language].includes(row.fingerprint) && trainedIds.has(row.annotation.id),
        )
        .map((row) => row.fingerprint);
      if (marked.length)
        await modelRequest('', { action: 'reviewed', language, fingerprints: marked });
      setLoaded((current) => ({ ...current, [language]: [] }));
    }
    await refresh();
  }

  async function train() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPhase('preparing');
    setError('');
    setSaved(null);
    setCandidate(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const newRows = parseDraft();
      if (!newRows.length || newRows.length > MAX_SUBMISSION)
        throw new Error(`Review 1–${MAX_SUBMISSION} sentences before training.`);
      setMessage('Loading the released syntax model and your active reviewed corpus…');
      const [base, released, previous] = await Promise.all([
        clientFetch(`/research/v6/data/ud-pud-${language}.json`, {
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok) throw new Error('The licensed base corpus could not be loaded.');
          return (await response.json()) as { sentences: Sentence[] };
        }),
        loadReleasedField(language),
        modelRequest<{ reviewedRows?: Sentence[] }>(
          `?language=${language}`,
          undefined,
          controller.signal,
        ),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setPhase('training');
      const value = await new Promise<Candidate>((resolve, reject) => {
        const instance = new Worker('/research/v6/train-worker.js', { type: 'module' });
        const end = () => {
          window.clearTimeout(deadline);
          instance.terminate();
          worker.current = null;
        };
        const deadline = window.setTimeout(() => {
          end();
          reject(
            new Error(
              'Training exceeded three minutes. Your annotations are preserved; try a smaller batch.',
            ),
          );
        }, 180000);
        worker.current = {
          instance,
          cancel: () => {
            end();
            reject(new Error('Training cancelled. Your annotations are preserved.'));
          },
        };
        instance.onmessage = (event) => {
          if (event.data.error) {
            end();
            reject(new Error(String(event.data.error)));
          } else if (event.data.done) {
            end();
            resolve(event.data.value as Candidate);
          } else if (typeof event.data.stage === 'string' && mounted.current)
            setMessage(event.data.stage);
        };
        instance.onerror = () => {
          end();
          reject(new Error('The training worker failed. Your annotations are preserved.'));
        };
        instance.postMessage({
          base: base.sentences,
          rows: [...(previous.reviewedRows ?? []), ...newRows],
          released,
        });
      });
      if (!mounted.current) return;
      setCandidate(value);
      await saveCandidate(value);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Training did not complete.');
    } finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(false);
        setPhase('idle');
      }
    }
  }

  async function changeCheckpoint() {
    if (!confirmation || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await modelRequest(
        '',
        confirmation.action === 'activate'
          ? {
              action: 'activate',
              id: confirmation.version.id,
              language: confirmation.version.language,
            }
          : { action: 'reset', language },
      );
      invalidateField(language);
      setConfirmation(null);
      setMessage(
        confirmation.action === 'activate'
          ? `Checkpoint activated for ${languages[language]}.`
          : `Released ${languages[language]} checkpoint restored.`,
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The checkpoint could not be changed.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="grid gap-3" role="status" aria-label="Loading co-model workspace">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  if (accessError) {
    const ownerRequired = accessError instanceof ModelRequestError && accessError.status === 403;
    const signedOut = accessError instanceof ModelRequestError && accessError.status === 401;
    return (
      <section className="learning-access">
        <LockKeyhole size={32} strokeWidth={1.5} />
        <h2>
          {ownerRequired
            ? 'Owner access is required for training'
            : signedOut
              ? 'Sign in to train your co-model'
              : 'Co-model training could not be loaded'}
        </h2>
        <p>
          {ownerRequired
            ? 'Reviewed syntax annotations change the local model used by this workspace. The server restricts checkpoint training and activation to its configured owner.'
            : accessError.message}
        </p>
        <div>
          {signedOut && (
            <Button asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
          )}
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw size={16} />
            Check again
          </Button>
        </div>
        <small>Your personal exchange review queue is available separately.</small>
      </section>
    );
  }

  return (
    <div className="learning-training">
      <section className="learning-section-intro">
        <div>
          <span className="learning-eyebrow">
            <FlaskConical size={16} />
            LOCAL CONTEXT MODEL
          </span>
          <h2>Train with evidence. Release with care.</h2>
          <p>
            Reviewed syntax annotations refit the local parser. The server evaluates each candidate
            before it can be activated.
          </p>
        </div>
        <span className="learning-badge">Experimental syntax model</span>
      </section>
      {error && (
        <div className="learning-alert" role="alert">
          <Info size={16} />
          <span>{error}</span>
        </div>
      )}
      {message && (
        <p className="learning-notice" role="status">
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
          {message}
        </p>
      )}
      <div className="learning-training-status">
        <label>
          Training language
          <div>
            <select
              value={language}
              disabled={busy}
              onChange={(event) => {
                setLanguage(event.target.value);
                setCandidate(null);
                setSaved(null);
                setMessage('');
                setError('');
                setIssues([]);
              }}
            >
              {Object.entries(languages).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        </label>
        <div>
          <span>Active checkpoint</span>
          <strong>{activeId ? `${activeId.slice(0, 12)}…` : 'Released v6 checkpoint'}</strong>
        </div>
        <div>
          <span>Syntax review queue</span>
          <strong>{queueError ? 'Unavailable' : `${waiting[language] ?? 0} candidates`}</strong>
        </div>
      </div>
      {queueError && (
        <p className="learning-dialog-error">
          {queueError}{' '}
          <button type="button" className="learning-text-button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      <div className="learning-training-grid">
        <section className="learning-panel">
          <div className="learning-panel-heading">
            <div>
              <h3>1. Review annotations</h3>
              <p>Add corrections from your chats or an annotated corpus.</p>
            </div>
            <span className="learning-count-label">
              {draftCount === null ? 'Check JSON' : `${draftCount} sentences`}
            </span>
          </div>
          <div className="learning-training-import">
            <label className={`learning-upload-button ${busy ? 'learning-disabled' : ''}`}>
              <Upload size={16} />
              Add a file
              <input
                type="file"
                accept=".json,.conllu,.conll,.txt,application/json,text/plain"
                disabled={busy}
                onChange={(event) => void addFile(event)}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !waiting[language]}
              onClick={() => void loadCandidates()}
            >
              From your chats{waiting[language] ? ` (${waiting[language]})` : ''}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                saveDownload(
                  new Blob([JSON.stringify(exampleRows, null, 2)], { type: 'application/json' }),
                  'hikmah-annotation-example.json',
                )
              }
            >
              <FileCode2 size={16} />
              Example format
            </Button>
          </div>
          <label className="learning-annotation-label" htmlFor="learning-annotations">
            Reviewed annotations · JSON
          </label>
          <textarea
            id="learning-annotations"
            className="learning-annotation-editor"
            value={rows}
            rows={12}
            spellCheck={false}
            placeholder={'[\n  Add your reviewed sentence annotations here\n]'}
            disabled={busy}
            maxLength={2_000_000}
            onChange={(event) => {
              setDrafts((current) => ({ ...current, [language]: event.target.value }));
              setCandidate(null);
              setSaved(null);
            }}
          />
          {issues.length > 0 && (
            <details className="learning-import-issues">
              <summary>
                {issues.length} import issue{issues.length === 1 ? '' : 's'} to inspect
              </summary>
              <ul>
                {issues.slice(0, 20).map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </details>
          )}
          <details className="learning-format-help">
            <summary>Annotation requirements</summary>
            <p>
              Each sentence needs a unique ID, an <code>owner/</code> document group, a{' '}
              <code>train</code> split, and 1–96 tokens. Include form, lemma, Universal Dependencies
              POS, dependency head, and relation for every token. Predicted annotations require
              correction before becoming labels.
            </p>
            <p>
              Upload JSON or CoNLL-U. Up to {MAX_SUBMISSION} sentences per submission and{' '}
              {MAX_CORPUS.toLocaleString()} cumulative reviewed sentences per language. Evaluation
              sentences are excluded from training.
            </p>
          </details>
        </section>
        <section className="learning-panel learning-train-action">
          <div className="learning-panel-heading">
            <div>
              <h3>2. Train & evaluate</h3>
              <p>Run a real local fit and inspect its saved receipt.</p>
            </div>
          </div>
          <ol className="learning-training-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Refit local parameters</strong>
                <p>Lexical counts, transitions, and dependency weights.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Check the development gate</strong>
                <p>Require an LAS gain with no per-sentence LAS or POS regressions.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Save for your review</strong>
                <p>Activation is a separate, explicit action.</p>
              </div>
            </li>
          </ol>
          <Button
            disabled={busy || !draftCount || draftCount > MAX_SUBMISSION}
            onClick={() => void train()}
          >
            {busy && phase !== 'idle' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={16} />
            )}
            Train, evaluate & save
          </Button>
          {phase === 'training' && (
            <Button variant="outline" onClick={() => worker.current?.cancel()}>
              <X size={16} />
              Cancel training
            </Button>
          )}
          {candidate && (
            <Button
              variant="outline"
              onClick={() =>
                saveDownload(
                  new Blob([JSON.stringify(candidate, null, 2)], { type: 'application/json' }),
                  `hikmah-${language}-candidate.json`,
                )
              }
            >
              <Download size={16} />
              Export candidate
            </Button>
          )}
          {candidate && !saved && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                setError('');
                try {
                  await saveCandidate(candidate);
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : 'The candidate could not be saved.',
                  );
                } finally {
                  lock.current = false;
                  setBusy(false);
                  setPhase('idle');
                }
              }}
            >
              <RefreshCw size={16} />
              Retry save
            </Button>
          )}
          <p className="learning-query-note">
            <Info size={16} />
            This trains local syntax parameters. It does not train provider model weights or
            establish semantic accuracy.
          </p>
          {saved && (
            <div
              className={`learning-training-receipt ${saved.receipt.approved ? 'learning-receipt-passed' : ''}`}
            >
              <span className="learning-eyebrow">SERVER EVALUATION</span>
              <h4>{saved.receipt.approved ? 'Development gate passed' : 'Candidate held'}</h4>
              <p>{saved.receipt.reason}</p>
              <dl>
                <div>
                  <dt>Dependency LAS</dt>
                  <dd>{percent(saved.receipt.current.las)}</dd>
                </div>
                <div>
                  <dt>Sentence regressions</dt>
                  <dd>{saved.receipt.regressions.length}</dd>
                </div>
              </dl>
              <small title={saved.receipt.sha256}>
                SHA-256 {saved.receipt.sha256.slice(0, 16)}…
              </small>
              {saved.receipt.approved && activeId !== saved.id && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmation({ action: 'activate', version: saved })}
                >
                  Review activation
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
      <section className="learning-panel learning-version-panel">
        <div className="learning-panel-heading">
          <div>
            <h3>3. Checkpoints & release</h3>
            <p>
              Your latest saved versions for {languages[language]}. Restoring returns to the shipped
              v6 checkpoint.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !activeId}
            onClick={() => setConfirmation({ action: 'reset' })}
          >
            <RotateCcw size={16} />
            Restore released
          </Button>
        </div>
        {versions.length ? (
          <div className="learning-table-scroll">
            <table className="learning-version-table">
              <caption className="sr-only">Saved {languages[language]} syntax checkpoints</caption>
              <thead>
                <tr>
                  <th scope="col">Checkpoint</th>
                  <th scope="col">Gate</th>
                  <th scope="col">LAS</th>
                  <th scope="col">Saved</th>
                  <th scope="col">
                    <span className="sr-only">Activate</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      <strong>{version.id.slice(0, 12)}…</strong>
                      <small>{version.receipt.reason}</small>
                    </td>
                    <td>
                      <span
                        className={`learning-badge ${activeId === version.id || version.receipt.approved ? 'learning-badge-approved' : ''}`}
                      >
                        {activeId === version.id
                          ? 'Active'
                          : version.receipt.approved
                            ? 'Passed'
                            : 'Held'}
                      </span>
                    </td>
                    <td>{percent(version.receipt.current.las)}</td>
                    <td>{readableDate(version.created_at)}</td>
                    <td>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !version.receipt.approved || activeId === version.id}
                        onClick={() => setConfirmation({ action: 'activate', version })}
                      >
                        {activeId === version.id ? (
                          <>
                            <Check size={12} />
                            Active
                          </>
                        ) : (
                          'Activate'
                        )}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="learning-version-empty">
            <FlaskConical size={24} />
            <p>
              No saved checkpoints for this language yet.
              <br />
              Train reviewed annotations to create your first candidate.
            </p>
          </div>
        )}
      </section>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent className="learning-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === 'reset'
                ? 'Restore the released checkpoint?'
                : 'Activate this checkpoint?'}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === 'reset'
                ? `Future ${languages[language]} context analysis will use the released v6 model. Your saved candidates remain available.`
                : `Future ${languages[language]} context analysis and enabled co-model chat will use this candidate. The server will verify that its evaluation gate still matches the active version.`}
            </DialogDescription>
          </DialogHeader>
          {confirmation?.action === 'activate' && (
            <dl className="learning-activation-details">
              <div>
                <dt>Checkpoint</dt>
                <dd>{confirmation.version.id}</dd>
              </div>
              <div>
                <dt>Development LAS</dt>
                <dd>{percent(confirmation.version.receipt.current.las)}</dd>
              </div>
              <div>
                <dt>Gate</dt>
                <dd>{confirmation.version.receipt.reason}</dd>
              </div>
            </dl>
          )}
          {error && (
            <p className="learning-dialog-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void changeCheckpoint()}>
              {busy && <LoaderCircle size={16} className="spin" />}
              {confirmation?.action === 'reset' ? 'Restore released' : 'Activate checkpoint'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
