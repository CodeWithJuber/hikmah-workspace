'use client';
import { useKernel } from '@/components/kernel/context';
import { RootResearch, CorpusExplorer } from './root-research';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Download,
  FlaskConical,
  Languages,
  LoaderCircle,
  Network,
  Play,
  RotateCcw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  analyzeContext,
  arabicCandidates,
  loadReleasedField,
  invalidateField,
} from '@/lib/context-model/client';
import { languageNames, type ContextGraph } from '@/lib/context-model/discourse';
import type { FieldModel, Sentence } from '@/lib/context-model/field-model';
import { parseConllu, type ParseProblem } from '@/lib/context-model/conllu';
import { MAX_CORPUS, MAX_SUBMISSION } from '@/lib/context-model/training';
import { downloadJson } from '@/components/playground/common';
type Evaluation = { las: number; uas: number; posAccuracy: number; tokenCount: number };
type ModelReport = {
  language: string;
  training: { sentences: number; tokens: number };
  development: Evaluation;
  test: Evaluation;
  sha256?: string;
};
type SavedVersion = {
  id: string;
  language: string;
  created_at: string;
  receipt: {
    approved: boolean;
    reason: string;
    gain: number;
    sha256: string;
    current: Evaluation;
    regressions: string[];
  };
};
type FormalRecord = {
  id: string;
  language: string;
  text: string;
  documentId: string;
  graph: { clauses: { box: string; predicate: string; args: string[] }[]; boxes: string[] };
};
const samples: Record<string, string> = {
  en: 'Mira said that Omar did not send the report. He may send it tomorrow. Keep the budget at 250 dollars.',
  hi: 'मीरा ने कहा कि उमर ने रिपोर्ट नहीं भेजी। वह कल इसे भेज सकता है। बजट 250 रुपये रखें।',
  ar: 'قالت مريم إن عمر لم يرسل التقرير. قد يرسله غدا. احتفظ بالميزانية عند 250 دولارا.',
  es: 'María dijo que Omar no envió el informe. Él puede enviarlo mañana. El presupuesto es de 250 euros.',
  tr: 'Meryem raporu göndermedi. O yarın gönderebilir. Bütçe 250 lira.',
};
const reviewedSample = [
  {
    id: 'owner-example-1',
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
const percent = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : 'Not measured');
async function jsonRequest(url: string, body?: unknown) {
  const r = await fetch(
    url,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store' },
  );
  const x = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw Error(String(x.error ?? 'Request failed.'));
  return x;
}
export function ContextGraphView({ graph }: { graph: ContextGraph }) {
  const label = (id: string) =>
    graph.entities.find((e) => e.id === id)?.label ?? id.replace('unresolved:', '? ');
  return (
    <div className="context-graph-view">
      <div className="context-stat-strip">
        <span>
          <strong>{graph.coverage.parsedSentences}</strong> sentences parsed
        </span>
        <span>
          <strong>{graph.events.length}</strong> event hypotheses
        </span>
        <span>
          <strong>{graph.references.length}</strong> references to review
        </span>
        <span>
          <strong>
            {graph.coverage.tokens ? percent(graph.coverage.known / graph.coverage.tokens) : '—'}
          </strong>{' '}
          known surface vocabulary
        </span>
      </div>
      <p className="context-hypothesis-note">
        The learned parser supplies syntax. Explicit compiler rules propose the event graph. These
        edges have not been scored against a semantic benchmark.
      </p>
      <div className="event-card-grid">
        {graph.events.map((e) => (
          <article key={e.id} className="context-event">
            <div className="event-index">
              S{e.sentence} · {languageNames[e.language]} · hypothesis
            </div>
            <div className="event-proposition">
              <span>
                {e.actor.map(label).join(', ') || 'Who?'}
                <small>actor candidate</small>
              </span>
              <ArrowRight size={17} />
              <strong>
                {e.surface}
                <small>{e.predicate}</small>
              </strong>
              <ArrowRight size={17} />
              <span>
                {e.patient.map(label).join(', ') || 'What / whom?'}
                <small>object candidate</small>
              </span>
            </div>
            {e.scopes.length > 0 && (
              <div className="scope-chips">
                {e.scopes.map((s, i) => (
                  <span key={i}>
                    {s.kind}: {s.cue}
                  </span>
                ))}
              </div>
            )}
            {e.parent && <small>Nested event candidate · {e.parent}</small>}
          </article>
        ))}
      </div>
      {!!graph.references.length && (
        <section className="reference-review">
          <h3>Keep ambiguity visible</h3>
          {graph.references.map((r, i) => (
            <p key={i}>
              <strong>
                S{r.sentence} · {r.mention}
              </strong>
              <span>
                {r.status === 'speaker-relative'
                  ? 'Needs the speaker/addressee of the original turn'
                  : r.candidates.length
                    ? 'Candidates: ' + r.candidates.map(label).join(' · ')
                    : 'No reliable referent found'}
              </span>
            </p>
          ))}
        </section>
      )}
      {graph.literals.length > 0 && (
        <div className="literal-strip">
          <strong>Preserved literals</strong>
          {graph.literals.map((l, i) => (
            <code key={i}>{l}</code>
          ))}
        </div>
      )}
      <details className="context-details">
        <summary>Source sentences & predicted dependencies</summary>
        {graph.sentences.map((s) => (
          <div key={s.id}>
            <p dir="auto">
              <strong>S{s.id}</strong> {s.text}
            </p>
            {s.error ? (
              <p role="alert">{s.error}</p>
            ) : (
              <div className="context-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Lemma</th>
                      <th>POS</th>
                      <th>Head → relation</th>
                      <th>Vocabulary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.parse?.tokens.map((t) => (
                      <tr key={t.id}>
                        <td dir="auto">{t.form}</td>
                        <td dir="auto">{t.lemma}</td>
                        <td>{t.upos}</td>
                        <td>
                          {t.head} → {t.relation}
                        </td>
                        <td>{t.known ? 'Seen in training' : 'Unseen'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </details>
      <details className="context-details">
        <summary>Coverage & unresolved assumptions</summary>
        {graph.warnings.map((w, i) => (
          <p key={i}>{w}</p>
        ))}
      </details>
      <Button variant="outline" onClick={() => downloadJson(graph, 'hikmah-context-graph.json')}>
        <Download size={16} />
        Export context graph
      </Button>
    </div>
  );
}
export function ContextStudio({ initialTab = 'understand' }: { initialTab?: string }) {
  const { role, ready } = useKernel();
  const canTrain = ready && role === 'super_admin';
  const [tab, setTab] = useState(initialTab),
    [language, setLanguage] = useState('auto'),
    [input, setInput] = useState(samples.en),
    [graph, setGraph] = useState<ContextGraph | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [reports, setReports] = useState<ModelReport[]>([]),
    [versions, setVersions] = useState<SavedVersion[]>([]),
    [active, setActive] = useState<{ language: string; version_id: string }[]>([]),
    [trainLanguage, setTrainLanguage] = useState('en'),
    [rows, setRows] = useState(JSON.stringify(reviewedSample, null, 2)),
    [autoPromote, setAutoPromote] = useState(true),
    [candidate, setCandidate] = useState<{ model: FieldModel; reviewed: Sentence[] } | null>(null),
    [saved, setSaved] = useState<SavedVersion | null>(null),
    // What an upload could not read, kept beside the box rather than thrown:
    // one bad token in a 300-sentence file used to lose the whole file.
    [problems, setProblems] = useState<ParseProblem[]>([]),
    // How many sentences this owner has already saved for this language. The
    // corpus is cumulative and capped, and until now the only way to discover
    // that was to hit the cap.
    [counted, setCounted] = useState<number | null>(null),
    // How many sentences the owner's own chats have queued for review, per
    // language. Every turn is parsed already; this is what that parse measured.
    [waiting, setWaiting] = useState<Record<string, number>>({}),
    // The fingerprints currently loaded into the box, so training can mark them
    // dealt with and the queue stops offering them.
    [loaded, setLoaded] = useState<string[]>([]);
  const [pivotWord, setPivotWord] = useState('knowledge'),
    [pivotLanguage, setPivotLanguage] = useState('en'),
    [pivot, setPivot] = useState<Awaited<ReturnType<typeof arabicCandidates>> | null>(null),
    [formal, setFormal] = useState<FormalRecord[]>([]),
    [formalId, setFormalId] = useState('');
  const workerRef = useRef<Worker | null>(null);
  const refresh = async () => {
    const x = await jsonRequest('/api/context-model');
    setVersions(x.versions as SavedVersion[]);
    setActive(x.active as { language: string; version_id: string }[]);
  };
  useEffect(() => {
    void fetch('/research/v6/models/manifest.json')
      .then((r) => r.json())
      .then((x) => setReports((x as { languages: ModelReport[] }).languages))
      .catch(() => setError('Evaluation report could not load.'));
    void refresh().catch((e) => setError(e.message));
    void fetch('/research/v6/formal-graph-fixtures.json')
      .then((r) => r.json())
      .then((x) => setFormal((x as { records: FormalRecord[] }).records))
      .catch(() => {});
    return () => workerRef.current?.terminate();
  }, []);
  const analyze = async () => {
    setBusy(true);
    setError('');
    setMessage('Loading the trained language checkpoint and compiling document context…');
    try {
      setGraph(await analyzeContext(input, language));
      setMessage('Local inference complete. No provider request or generation tokens used.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Context analysis failed.');
    } finally {
      setBusy(false);
    }
  };
  const activate = async (version: SavedVersion) => {
    setBusy(true);
    setError('');
    try {
      await jsonRequest('/api/context-model', {
        action: 'activate',
        id: version.id,
        language: version.language,
      });
      invalidateField(version.language);
      await refresh();
      setMessage('Saved checkpoint activated for ' + languageNames[version.language] + '.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveCandidate = async (value: { model: FieldModel; reviewed: Sentence[] }) => {
    setMessage('Checking the candidate on the server and saving its parameters…');
    const result = (await jsonRequest('/api/context-model', {
      action: 'save',
      model: value.model,
      reviewedRows: value.reviewed,
    })) as unknown as SavedVersion;
    setSaved(result);
    await refresh();
    if (autoPromote && result.receipt.approved) {
      await jsonRequest('/api/context-model', {
        action: 'activate',
        id: result.id,
        language: result.language,
      });
      invalidateField(result.language);
      await refresh();
      setMessage('Development gate passed. Candidate saved and activated.');
    } else setMessage('Candidate saved. ' + result.receipt.reason);
  };
  // How much of the corpus is already used, for the language now selected. The
  // cap is cumulative, so a number the owner cannot see is a wall they walk
  // into.
  useEffect(() => {
    let live = true;
    void jsonRequest('/api/context-model?candidates=')
      .then((data) => {
        if (live) setWaiting((data.waiting as Record<string, number>) ?? {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [trainLanguage, saved]);

  useEffect(() => {
    let live = true;
    void jsonRequest('/api/context-model?language=' + trainLanguage)
      .then((previous) => {
        if (live) setCounted(((previous.reviewedRows as unknown[] | undefined) ?? []).length);
      })
      .catch(() => {
        if (live) setCounted(null);
      });
    return () => {
      live = false;
    };
  }, [trainLanguage, saved]);

  /** Whatever is already in the box, as rows, so an upload or a queue load
   *  adds to a review in progress instead of discarding it. */
  const boxRows = (): unknown[] => {
    const current = rows.trim();
    if (!current) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      throw Error('The box does not hold valid JSON, so nothing can be added to it.');
    }
    return Array.isArray(parsed) ? parsed : [];
  };

  /**
   * Put the sentences your own chats found hardest into the box.
   *
   * They arrive already parsed by the active checkpoint, so this is a
   * correction rather than an annotation from nothing — which is the whole
   * reason the queue is worth having. Appended, like an upload, so a review
   * session can mix chat sentences with a file.
   */
  const loadFromChats = async () => {
    setError('');
    setProblems([]);
    try {
      const data = await jsonRequest(
        '/api/context-model?candidates=' + trainLanguage + '&limit=20',
      );
      const rows = (data.candidates as { fingerprint: string; annotation: unknown }[]) ?? [];
      if (!rows.length) throw Error('Nothing from your chats is waiting in this language yet.');
      const current = boxRows();
      setRows(JSON.stringify([...current, ...rows.map((r) => r.annotation)], null, 2));
      setLoaded(rows.map((r) => r.fingerprint));
      setMessage(
        `Loaded ${rows.length} sentence${rows.length === 1 ? '' : 's'} your chats found hardest. Correct them, then train.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Read a dropped file into the box, alongside whatever is already there.
   *
   * Added rather than replacing, so several files can be combined before one
   * fit — and parsed here rather than on the server so a malformed line is
   * named while the owner still has the file open. `validateTeaching` remains
   * the only thing that decides what may be trained.
   */
  const addFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setProblems([]);
    try {
      const text = await file.text();
      const conllu = !/\.json$/i.test(file.name) && !text.trimStart().startsWith('[');
      const group = 'owner/' + file.name.replace(/\.[^.]+$/, '').slice(0, 120);
      const parsed = conllu ? parseConllu(text, group) : { rows: JSON.parse(text), problems: [] };
      if (!Array.isArray(parsed.rows)) throw Error('That file is not a list of sentences.');
      if (!parsed.rows.length)
        throw Error(
          parsed.problems.length
            ? 'No sentence in that file could be read. ' + parsed.problems[0].reason
            : 'That file has no sentences in it.',
        );
      if (parsed.rows.length > MAX_SUBMISSION)
        throw Error(
          `That file has ${parsed.rows.length} sentences; ${MAX_SUBMISSION} is the most that can be added at once.`,
        );
      setRows(JSON.stringify([...boxRows(), ...parsed.rows], null, 2));
      setProblems(parsed.problems);
      setMessage(
        `Added ${parsed.rows.length} sentence${parsed.rows.length === 1 ? '' : 's'} from ${file.name}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const countLabel =
    counted === null
      ? ''
      : `${counted.toLocaleString()} of ${MAX_CORPUS.toLocaleString()} saved for ${languageNames[trainLanguage] ?? trainLanguage}`;

  const train = async () => {
    setBusy(true);
    setError('');
    setSaved(null);
    setMessage('Loading licensed training data and your saved corrections…');
    try {
      const parsed = JSON.parse(rows);
      const [source, released, previous] = await Promise.all([
        fetch('/research/v6/data/ud-pud-' + trainLanguage + '.json').then((r) => {
          if (!r.ok) throw Error('Training data unavailable.');
          return r.json() as Promise<{ sentences: Sentence[] }>;
        }),
        loadReleasedField(trainLanguage),
        jsonRequest('/api/context-model?language=' + trainLanguage),
      ]);
      const all = [...((previous.reviewedRows as Sentence[] | undefined) ?? []), ...parsed];
      const value = await new Promise<{ model: FieldModel; reviewed: Sentence[] }>(
        (resolve, reject) => {
          const worker = new Worker('/research/v6/train-worker.js', { type: 'module' });
          workerRef.current = worker;
          worker.onmessage = (e) => {
            if (e.data.error) {
              worker.terminate();
              reject(Error(e.data.error));
            } else if (e.data.done) {
              worker.terminate();
              resolve(e.data.value);
            } else setMessage(e.data.stage);
          };
          worker.onerror = () => {
            worker.terminate();
            reject(Error('Training worker failed. Your corrections are preserved.'));
          };
          worker.postMessage({ base: source.sentences, rows: all, released });
        },
      );
      setCandidate(value);
      await saveCandidate(value);
      // Dealt with, so the queue stops offering them. After the save, not
      // before: a training run that failed leaves them waiting, which is right.
      if (loaded.length) {
        await jsonRequest('/api/context-model', {
          action: 'reviewed',
          language: trainLanguage,
          fingerprints: loaded,
        }).catch(() => {});
        setLoaded([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      workerRef.current = null;
      setBusy(false);
    }
  };
  const selectedFormal = formal.find((f) => f.id === formalId) ?? formal[0];
  return (
    <div className="context-studio">
      <section className="context-intro">
        <div>
          <span className="context-version">CONTEXT FIELD · RESEARCH MODEL v6</span>
          <h2>Meaning needs the whole context.</h2>
          <p>
            Inspect your own learned parser, keep ambiguous meanings visible, and improve its
            parameters with reviewed examples.
          </p>
        </div>
        <div className="context-architecture-badge">
          <Network size={25} />
          <span>
            Sparse factors
            <br />
            <strong>No transformer in this model</strong>
          </span>
        </div>
      </section>
      <div className="context-stat-strip headline-stats">
        <span>
          <strong>5</strong> trained syntax languages
        </span>
        <span>
          <strong>4,135</strong> training sentences
        </span>
        <span>
          <strong>87,703</strong> training tokens
        </span>
        <span>
          <strong>16,619</strong> lexical associations
        </span>
      </div>
      <nav className="context-nav" aria-label="Context model workspace">
        {[
          ['understand', 'Understand', Network],
          ...(canTrain ? [['learn', 'Train & versions', FlaskConical]] : []),
          ['evidence', 'Research & results', BookOpen],
        ].map(([id, label, Icon]) => (
          <button
            key={String(id)}
            aria-current={tab === id ? 'page' : undefined}
            disabled={busy}
            onClick={() => setTab(String(id))}
          >
            {typeof Icon !== 'string' && <Icon size={17} />}
            <span>{String(label)}</span>
          </button>
        ))}
      </nav>
      {error && (
        <div className="kernel-alert" role="alert">
          {error}
        </div>
      )}
      {message && (
        <p className="context-status" role="status">
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} {message}
        </p>
      )}
      {tab === 'understand' && (
        <>
          <section className="context-input-card">
            <div className="context-input-heading">
              <h3>Read a document, not just a word</h3>
              <label>
                <Languages size={16} />
                <select
                  aria-label="Analysis language"
                  value={language}
                  disabled={busy}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  <option value="auto">Detect language · experimental</option>
                  {Object.entries(languageNames).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                      {id === 'ur' ? ' · lexical model only' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Textarea
              aria-label="Document to interpret"
              value={input}
              maxLength={12000}
              dir="auto"
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="context-input-footer">
              <div>
                {Object.keys(samples).map((l) => (
                  <button
                    key={l}
                    disabled={busy}
                    onClick={() => {
                      setLanguage(l);
                      setInput(samples[l]);
                      setGraph(null);
                    }}
                  >
                    {languageNames[l]}
                  </button>
                ))}
              </div>
              <Button disabled={busy || !input.trim()} onClick={() => void analyze()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}Interpret
                locally
              </Button>
            </div>
            <p>
              Raw-text tokenization differs from the gold-token evaluation below. Romanized Hindi,
              Urdu syntax and arbitrary code switching are not supported by a measured parser.
            </p>
          </section>
          {graph && <ContextGraphView graph={graph} />}
          <section className="context-card">
            <h3>Explore an Arabic word bridge</h3>
            <p>
              Learned token associations preserve alternatives. An Arabic surface word is not a
              verified Quranic root or a proof of language ancestry.
            </p>
            <div className="pivot-form">
              <select
                aria-label="Source word language"
                value={pivotLanguage}
                onChange={(e) => setPivotLanguage(e.target.value)}
              >
                {Object.entries(languageNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                aria-label="Word to associate"
                value={pivotWord}
                onChange={(e) => setPivotWord(e.target.value)}
                maxLength={100}
              />
              <Button
                variant="outline"
                disabled={busy || !pivotWord.trim()}
                onClick={() => {
                  setError('');
                  void arabicCandidates(pivotLanguage, pivotWord.trim())
                    .then(setPivot)
                    .catch((e) => setError(e.message));
                }}
              >
                Find candidates
              </Button>
            </div>
            {pivot && (
              <div className="pivot-results">
                {pivot.length ? (
                  pivot.map((p, i) => (
                    <div key={i}>
                      <span>
                        {pivotWord} → {p.via} → <strong dir="rtl">{p.arabic}</strong>
                      </span>
                      <small>
                        Path product {p.score.toFixed(4)} · support {p.support || 'surface only'}
                      </small>
                    </div>
                  ))
                ) : (
                  <p>
                    No retained association for this word. Its original meaning is left unmapped.
                  </p>
                )}
              </div>
            )}
          </section>
        </>
      )}
      {tab === 'learn' && canTrain && (
        <>
          <section className="context-card">
            <div className="context-card-heading">
              <div>
                <h3>Train from reviewed corrections</h3>
                <p>
                  Lexical counts, sequence transitions and dependency weights are refitted. A worker
                  runs training; the server recomputes the development gate before saving. Your
                  provider&apos;s weights are unchanged.
                </p>
              </div>
              <select
                aria-label="Training language"
                value={trainLanguage}
                disabled={busy}
                onChange={(e) => setTrainLanguage(e.target.value)}
              >
                {['en', 'ar', 'hi', 'es', 'tr'].map((l) => (
                  <option key={l} value={l}>
                    {languageNames[l]}
                  </option>
                ))}
              </select>
            </div>
            <details className="context-details">
              <summary>The format, and what is accepted</summary>
              <p>
                Two ways in. <strong>Upload a file</strong> below — <code>.conllu</code>, the format
                Universal Dependencies distributes and every annotation tool exports, or{' '}
                <code>.json</code> in the shape of the example — or paste JSON into the box. An
                upload is added to whatever is already in the box rather than replacing it, so
                several files can be combined before training.
              </p>
              <p>
                Every sentence needs a unique id, a document group beginning <code>owner/</code>,
                its text, and 1&ndash;96 tokens. Every token needs its position (running 1, 2,
                3&hellip;), the <code>form</code> as written, a <code>lemma</code>, one of the
                seventeen{' '}
                <a
                  href="https://universaldependencies.org/u/pos/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  UPOS tags
                </a>
                , a <code>head</code> (the position of the word it depends on, or 0 for the root)
                and a <code>deprel</code> relation label &mdash; <code>root</code> exactly where the
                head is 0. Each sentence needs exactly one root and no cycles.
              </p>
              <p>
                Corrections from the active checkpoint are included in the next fit, so the corpus
                below is cumulative and capped at {MAX_CORPUS.toLocaleString()} sentences per
                language, {MAX_SUBMISSION} per upload. Unactivated candidates do not silently become
                training data; automatic chat collection and unreviewed provider answers are not
                ground truth. The server scores syntax, not meaning or factual truth.
              </p>
            </details>
            <div className="context-upload">
              <label className="context-upload-button">
                <input
                  type="file"
                  accept=".conllu,.conll,.txt,.json,application/json,text/plain"
                  disabled={busy}
                  onChange={(event) => void addFile(event.target.files?.[0])}
                />
                <Upload size={15} aria-hidden="true" />
                Add a file
              </label>
              {/* Every chat is parsed already to build its context notes, and
                  that parse measures how sure the model was. These are the
                  sentences it was least sure of — correcting them is the one
                  thing a conversation can honestly teach a parser fitted on
                  gold annotations. */}
              <button
                type="button"
                className="context-upload-button"
                disabled={busy || !waiting[trainLanguage]}
                onClick={() => void loadFromChats()}
              >
                <Sparkles size={15} aria-hidden="true" />
                {waiting[trainLanguage]
                  ? `From your chats (${waiting[trainLanguage]})`
                  : 'Nothing from your chats yet'}
              </button>
              <span>{counted === null ? '\u00a0' : countLabel}</span>
            </div>
            {!!problems.length && (
              <div className="context-problems" role="status">
                <strong>
                  {problems.length} sentence{problems.length === 1 ? '' : 's'} could not be read.
                  The rest were added.
                </strong>
                <ul>
                  {problems.slice(0, 8).map((problem, index) => (
                    <li key={index}>
                      Line {problem.line} &mdash; {problem.sentence}: {problem.reason}
                    </li>
                  ))}
                </ul>
                {problems.length > 8 && <p>&hellip; and {problems.length - 8} more.</p>}
              </div>
            )}
            <Textarea
              className="annotation-editor"
              aria-label="Reviewed dependency annotations JSON"
              value={rows}
              disabled={busy}
              onChange={(e) => setRows(e.target.value)}
              spellCheck={false}
            />
            <label className="setting-switch">
              <div>
                <strong>Activate passing candidates automatically</strong>
                <span>
                  Requires a development LAS gain and zero per-sentence LAS/POS regressions against
                  the current checkpoint.
                </span>
              </div>
              <Switch checked={autoPromote} disabled={busy} onCheckedChange={setAutoPromote} />
            </label>
            <div className="context-actions">
              <Button disabled={busy || !rows.trim()} onClick={() => void train()}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <FlaskConical size={16} />}
                Train, evaluate & save
              </Button>
              {candidate && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => downloadJson(candidate, 'hikmah-context-candidate.json')}
                  >
                    <Download size={16} />
                    Export candidate
                  </Button>
                  {!saved && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await saveCandidate(candidate);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Upload size={16} />
                      Retry save
                    </Button>
                  )}
                </>
              )}
            </div>
            {saved && (
              <div className={'training-receipt ' + (saved.receipt.approved ? 'passed' : 'held')}>
                <strong>
                  {saved.receipt.approved
                    ? 'Development gate passed'
                    : 'Candidate held for inspection'}
                </strong>
                <p>{saved.receipt.reason}</p>
                <p>
                  LAS {percent(saved.receipt.current.las)} · {saved.receipt.regressions.length}{' '}
                  sentence regressions · SHA-256 {saved.receipt.sha256.slice(0, 16)}…
                </p>
              </div>
            )}
          </section>
          <section className="context-card">
            <h3>Durable parameter versions</h3>
            <p>
              Activation changes the model used by local context analysis and chat. The latest 50
              saved versions are listed. These remain experimental syntax checkpoints; stale gates
              cannot replace a newer active version.
            </p>
            {['en', 'ar', 'hi', 'es', 'tr'].map((l) => (
              <div className="active-model-row" key={l}>
                <strong>{languageNames[l]}</strong>
                <span>
                  {active.find((v) => v.language === l)?.version_id.slice(0, 12) ??
                    'Released v6 checkpoint'}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy || !active.some((v) => v.language === l)}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await jsonRequest('/api/context-model', { action: 'reset', language: l });
                      invalidateField(l);
                      await refresh();
                      setMessage('Released ' + languageNames[l] + ' checkpoint restored.');
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <RotateCcw size={15} />
                  Restore released
                </Button>
              </div>
            ))}
            {!versions.length ? (
              <p className="context-empty">
                No owner-trained checkpoints yet. The five released checkpoints above contain the
                fitted parameters.
              </p>
            ) : (
              versions.map((v) => (
                <div className="saved-model-row" key={v.id}>
                  <div>
                    <strong>
                      {languageNames[v.language]} · {new Date(v.created_at).toLocaleString()}
                    </strong>
                    <p>{v.receipt.reason}</p>
                    <small>
                      {v.id} · LAS {percent(v.receipt.current.las)}
                    </small>
                  </div>
                  <div>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void jsonRequest('/api/context-model?id=' + v.id)
                          .then((x) => downloadJson(x, 'context-' + v.id + '.json'))
                          .catch((e) => setError(e.message))
                      }
                    >
                      <Download size={15} />
                      Export
                    </Button>
                    {v.receipt.approved && (
                      <Button
                        disabled={busy || active.some((a) => a.version_id === v.id)}
                        onClick={() => void activate(v)}
                      >
                        {active.some((a) => a.version_id === v.id) ? 'Active' : 'Activate'}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}
      {tab === 'evidence' && (
        <>
          <RootResearch />
          <section className="context-card">
            <h3>Measured syntax performance</h3>
            <p>
              UD PUD internal document-group split: 827 train, 97 development and 76 test sentences
              per language. Parallel translations stay in the same split. This is one split, not
              completed ten-fold cross-validation.
            </p>
            <div className="context-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Language</th>
                    <th>Train tokens</th>
                    <th>Dev LAS</th>
                    <th>Test LAS</th>
                    <th>Test POS</th>
                    <th>Parameters</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.language}>
                      <td>{languageNames[r.language]}</td>
                      <td>{r.training.tokens.toLocaleString()}</td>
                      <td>{percent(r.development.las)}</td>
                      <td>{percent(r.test.las)}</td>
                      <td>{percent(r.test.posAccuracy)}</td>
                      <td>
                        <a href={'/research/v6/models/' + r.language + '.model.json'} download>
                          Download JSON
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              LAS = correctly attached and labeled dependency edges. Gold basic-token segmentation;
              predicted POS; base relation labels; gold punctuation excluded. These numbers are not
              meaning, translation or general intelligence accuracy.
            </p>
            <p>
              Four factor configurations were compared on development data. Parser correctness fixes
              were applied after inspection, then the same selected parameters were re-evaluated.
              This test is no longer a fresh unseen checkpoint-selection gate.
            </p>
          </section>
          <section className="context-card">
            <h3>Arabic roots, senses and full context</h3>
            <p>
              The original package is recovered: 191/191 file hashes match, with 6,236 review rows,
              6,236 context memberships and 114 cached tafsir files. Its 22 engineering patterns
              remain preserved.
            </p>
            <p>
              The reviewed root seed is much smaller: 7 root families, 18 words and 15 ayahs. A
              contextual first pass across the Quran is not an independently adjudicated meaning
              corpus. Word sense, operators, participants, temporal reference and exceptions must
              stay distinct from a root.
            </p>
            <div className="research-link-grid">
              <a href="/research/v6/research.md" target="_blank" rel="noreferrer">
                Full architecture, mathematics & findings <ArrowRight size={15} />
              </a>
              <a
                href="/research/v6/quran-context-and-language-report.md"
                target="_blank"
                rel="noreferrer"
              >
                Quran context research <ArrowRight size={15} />
              </a>
              <a href="/research/v6/quran-original-audit.json" target="_blank" rel="noreferrer">
                Original corpus integrity audit <ArrowRight size={15} />
              </a>
              <a
                href="/research/v6/root-context-seed-contrasts.json"
                target="_blank"
                rel="noreferrer"
              >
                Root and contextual sense contrasts <ArrowRight size={15} />
              </a>
              <a href="/research/v6/root-context-experiments.json" target="_blank" rel="noreferrer">
                Falsification & ablation protocol <ArrowRight size={15} />
              </a>
              <a href="/research/v6/source-notices/README.md" target="_blank" rel="noreferrer">
                Data provenance & licenses <ArrowRight size={15} />
              </a>
            </div>
          </section>
          <CorpusExplorer />
          <section className="context-card">
            <h3>Inspect formal context boxes</h3>
            <p>
              Fourteen licensed PMB gold-status fixtures in German, Italian and Dutch demonstrate
              formal scopes and role relations. They are inspection fixtures; this parser was not
              trained or evaluated to recover these graphs.
            </p>
            <select
              aria-label="Formal meaning example"
              value={selectedFormal?.id ?? ''}
              onChange={(e) => setFormalId(e.target.value)}
            >
              {formal.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.language} · {r.documentId}
                </option>
              ))}
            </select>
            {selectedFormal && (
              <>
                <blockquote dir="auto">{selectedFormal.text}</blockquote>
                <div className="context-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Context box</th>
                        <th>Predicate</th>
                        <th>Arguments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedFormal.graph.clauses.map((c, i) => (
                        <tr key={i}>
                          <td>{c.box}</td>
                          <td>{c.predicate}</td>
                          <td>{c.args.join(' · ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
