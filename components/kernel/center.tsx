'use client';
import { randomId } from '../../lib/id.ts';

import { ContextStudio } from '@/components/context-model/studio';
import { PolicyPanel } from '@/components/kernel/policy-panel';
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Switch } from '@/components/ui/switch';
import { useKernel } from './context';
import { HikmahIcon } from './icons';
import { SaveBar } from '@/components/app/save-bar';
import {
  activeVersion,
  developmentMetrics,
  policy,
  type Family,
  type KernelAction,
} from '@/lib/kernel/core';
import { predict, validateFrame, type TrainingRow } from '@/lib/engines/meaning-engine';
import { dataset } from '@/lib/playground/session';
import principles from '@/lib/kernel/principles.json';
import { downloadJson } from '@/components/playground/common';
import { toast } from 'sonner';
export function KernelCenter({
  owner = false,
  initialTab = 'context',
}: {
  owner?: boolean;
  initialTab?: string;
}) {
  const { state, ready, busy, error, act, refresh, model, role } = useKernel();
  const router = useRouter();
  const [tab, setTab] = useState(initialTab);
  const [probe, setProbe] = useState('Sara did help Lina.');
  const [language, setLanguage] = useState('en');
  const [result, setResult] = useState('');
  const [rows, setRows] = useState(JSON.stringify(dataset.good_update_train, null, 2));
  const [dev, setDev] = useState('[]');
  const [sentence, setSentence] = useState('');
  const [actor, setActor] = useState('sara');
  const [patient, setPatient] = useState('lina');
  const [action, setAction] = useState('action:qroot:ع-و-ن#help');
  const [tense, setTense] = useState('past');
  const current = activeVersion(state);
  const metrics = useMemo(() => developmentMetrics(state), [state.activeId, state.development]);
  const perform = async (a: KernelAction) => {
    try {
      await act(a);
      toast.success(
        a.type === 'teach' ? 'Examples reviewed and training pipeline updated.' : 'Saved.',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed.');
    }
  };
  // Owner controls edit a local draft; the SaveBar commits it in one request
  // (the one save convention) instead of firing per-control configures.
  const [configDraft, setConfigDraft] = useState<typeof state.config | null>(null);
  const config = configDraft ?? state.config;
  const configDirty =
    configDraft !== null &&
    (configDraft.enabled !== state.config.enabled ||
      configDraft.autoTrain !== state.config.autoTrain ||
      configDraft.collectFeedback !== state.config.collectFeedback ||
      configDraft.strategy !== state.config.strategy);
  const saveConfig = async () => {
    if (!configDraft || !configDirty || busy) return;
    try {
      await act({ type: 'configure', config: configDraft });
      toast.success('Saved.');
      setConfigDraft(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed.');
    }
  };
  const teachSentence = () => {
    try {
      const gold = validateFrame({
        agent: 'person:' + actor.trim().toLowerCase(),
        patient: 'person:' + patient.trim().toLowerCase(),
        action,
        tense,
        polarity: true,
        modality: 'assertion',
      });
      const id = 'owner-' + randomId();
      const row = {
        id,
        family: id,
        split: 'train' as const,
        language,
        text: sentence,
        category: 'owner_reviewed',
        gold,
      };
      setRows(JSON.stringify([row], null, 2));
      setTab('learning');
      toast.success('Label prepared below. Review it before submitting.');
    } catch (e) {
      toast.error(String(e));
    }
  };
  const tabs = owner
    ? [
        'training',
        'context',
        'overview',
        'learning',
        'versions',
        'runs',
        'policy',
        'architecture',
        'controls',
      ]
    : ['context', 'overview', 'learning', 'versions', 'architecture'];
  return (
    <div className="kernel-page">
      <header className="kernel-page-header">
        {/* size-9, because the vendored default is size-7 — 28px, under any
            comfortable touch target. tailwind-merge lets the call site win. */}
        <SidebarTrigger className="size-9" />
        <div>
          <span className="eyebrow">{owner ? 'OWNER CONSOLE' : 'YOUR OWN MODEL'}</span>
          <h1>{owner ? 'Super Admin' : 'Hikmah context model'}</h1>
          <p>
            {owner
              ? 'Control the intelligence layer, training and release history.'
              : 'Your own trained language factors, context graphs and reviewed learning loop.'}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => downloadJson({ state, model }, 'hikmah-co-model-checkpoint.json')}
        >
          Export rule model
        </Button>
      </header>
      {error && (
        <div className="kernel-alert" role="alert">
          {error}
          <Button variant="outline" onClick={() => void refresh()}>
            Retry sync
          </Button>
        </div>
      )}
      <nav className="kernel-tabs" aria-label="Co-model sections">
        {tabs.map((t) => (
          /* Owner tabs are routes (/superadmin/<tab>); the tab styling targets
             button elements, so this stays a button and navigates with the
             router. Non-owner tabs are in-page state. */
          <button
            key={t}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => (owner ? router.push('/superadmin/' + t) : setTab(t))}
          >
            {t === 'training'
              ? 'Train context model'
              : t === 'context'
                ? 'Understand'
                : t === 'overview'
                  ? 'Legacy model'
                  : t === 'learning'
                    ? 'Rule learning'
                    : t === 'policy'
                      ? 'Workflow policy'
                      : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'context' && <ContextStudio />}
      {tab === 'training' && <ContextStudio initialTab="learn" />}
      {tab === 'overview' && (
        <>
          <div className="kernel-hero">
            <div className="kernel-orb">
              <HikmahIcon name="orbit" size={48} />
            </div>
            <div>
              <span className="status-pill">
                {ready ? 'Connected · durable checkpoints' : 'Loading saved model'}
              </span>
              <h2>Your learning layer is here.</h2>
              <p>
                A compositional model with its own learned mappings and rules. The selected provider
                handles broader language tasks; this model owns supported interpretations and learns
                which workflow you prefer.
              </p>
            </div>
            <Button onClick={() => setTab('learning')}>Teach your model</Button>
          </div>
          <div className="kernel-metrics">
            {[
              [model.training_ids.length, 'Training examples'],
              [model.lexicon.length, 'Learned mappings'],
              [model.rules.length, 'Composition rules'],
              [state.feedbackRevision, 'Feedback updates'],
            ].map(([n, label]) => (
              <div key={label}>
                <strong>{n}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="kernel-grid">
            <section className="kernel-card">
              <h2>Try independent inference</h2>
              <p>This runs the learned model on your device. No provider key or tokens required.</p>
              <div className="kernel-fields">
                <label>
                  Language
                  <input
                    value={language}
                    maxLength={20}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                </label>
                <label>
                  Sentence
                  <input value={probe} maxLength={512} onChange={(e) => setProbe(e.target.value)} />
                </label>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  try {
                    setResult(JSON.stringify(predict(model, language, probe), null, 2));
                  } catch (e) {
                    setResult(String(e));
                  }
                }}
              >
                Interpret locally
              </Button>
              {result && <pre className="kernel-json">{result}</pre>}
              <p className="fine-print">
                Current scope: actor, action, recipient, polarity, tense and modality. Unsupported
                or ambiguous inputs abstain.
              </p>
            </section>
            <section className="kernel-card">
              <h2>Learning activity</h2>
              {state.events.length ? (
                state.events.slice(0, 5).map((e) => (
                  <div key={e.id} className="kernel-event">
                    <HikmahIcon name="learning" />
                    <div>
                      <strong>{e.kind}</strong>
                      <p>{e.detail}</p>
                      <time>{new Date(e.at).toLocaleString()}</time>
                    </div>
                  </div>
                ))
              ) : (
                <div className="honest-empty">
                  <HikmahIcon name="learning" size={32} />
                  <h3>Ready for the first update</h3>
                  <p>
                    Submit reviewed labels or rate a completed chat. Actual learning events will
                    appear here.
                  </p>
                </div>
              )}
            </section>
          </div>
          <section className="kernel-card">
            <h2>Measured local capability</h2>
            <p>
              <strong>
                {metrics.correct_frames}/{metrics.frame_scored_examples}
              </strong>{' '}
              exact representable frames on the reused development set · {metrics.abstentions}{' '}
              abstentions. This set selects updates; it is not a fresh benchmark.
            </p>
            <p>
              General task autonomy and improvement over the provider:{' '}
              <strong>not yet established</strong>.
            </p>
          </section>
        </>
      )}
      {tab === 'learning' && (
        <>
          <div className="kernel-section-intro">
            <h2>Experience → reviewed label → trained candidate → tested release</h2>
            <p>
              {state.config.autoTrain
                ? 'Automatic training is on. Every submitted batch is fitted and evaluated.'
                : 'Automatic training is paused. Submitted labels are saved for the next training run.'}{' '}
              Promotion requires new correct development frames, zero regressions and zero wrong
              emissions.
            </p>
          </div>
          <div className="kernel-grid">
            <section className="kernel-card">
              <h2>Teach a meaning</h2>
              <label className="kernel-field">
                Sentence
                <Input
                  value={sentence}
                  maxLength={512}
                  onChange={(e) => setSentence(e.target.value)}
                  placeholder="Sara helped Lina."
                />
              </label>
              <div className="kernel-fields">
                <label>
                  Actor ID
                  <Input value={actor} onChange={(e) => setActor(e.target.value)} />
                </label>
                <label>
                  Recipient ID
                  <Input value={patient} onChange={(e) => setPatient(e.target.value)} />
                </label>
              </div>
              <label className="kernel-field">
                Action sense
                <select value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="action:qroot:ع-و-ن#help">Help · ع و ن</option>
                  <option value="action:qroot:ش-ك-ر#thank">Thank · ش ك ر</option>
                  <option value="action:qroot:ذ-ك-ر#remember">Remember · ذ ك ر</option>
                </select>
              </label>
              <div className="kernel-fields">
                <label>
                  Language
                  <Input value={language} onChange={(e) => setLanguage(e.target.value)} />
                </label>
                <label>
                  Tense
                  <select value={tense} onChange={(e) => setTense(e.target.value)}>
                    {['past', 'present', 'future'].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
              </div>
              <Button variant="outline" disabled={!sentence.trim()} onClick={teachSentence}>
                Prepare labeled example
              </Button>
              <p className="fine-print">
                The simple form uses positive assertions. Advanced labels below also support
                negation and questions. Varied examples help the model separate word meanings.
              </p>
            </section>
            <section className="kernel-card">
              <h2>Review and submit examples</h2>
              <div className="kernel-actions">
                <Button
                  variant="outline"
                  onClick={() => setRows(JSON.stringify(dataset.good_update_train, null, 2))}
                >
                  Load verified fixture
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRows(JSON.stringify(dataset.bad_update_train, null, 2))}
                >
                  Load regression fixture
                </Button>
              </div>
              <label className="kernel-field">
                Training labels
                <Textarea
                  aria-label="Reviewed training labels"
                  value={rows}
                  onChange={(e) => setRows(e.target.value)}
                  className="kernel-training-input"
                  maxLength={200000}
                />
              </label>
              <details>
                <summary>Independent development examples</summary>
                <p>
                  Use split “development”, different sentences and semantic families. These labels
                  are also reviewed by you.
                </p>
                <Textarea
                  aria-label="Independent development labels"
                  value={dev}
                  onChange={(e) => setDev(e.target.value)}
                  maxLength={70000}
                />
              </details>
              <div className="kernel-actions">
                <Button
                  disabled={!ready || busy}
                  onClick={() => {
                    try {
                      void perform({
                        type: 'teach',
                        rows: JSON.parse(rows),
                        development: JSON.parse(dev),
                      });
                    } catch (e) {
                      toast.error('Check the example JSON.');
                    }
                  }}
                >
                  {busy ? 'Training and checking…' : 'Approve labels & learn'}
                </Button>
                <Button
                  variant="outline"
                  disabled={!ready || busy || !state.examples.length}
                  onClick={() => void perform({ type: 'train' })}
                >
                  Train saved labels
                </Button>
              </div>
              <p className="fine-print">
                The fixtures demonstrate the algorithm; their results are not evidence of general
                intelligence. Raw model suggestions and unrated chats never become trusted labels.
              </p>
            </section>
          </div>
          {state.lastGate && (
            <section className="kernel-card">
              <h2>
                {state.lastGate.approved
                  ? 'Candidate promoted'
                  : 'Candidate held — active model preserved'}
              </h2>
              <p>
                {state.lastGate.reason.replaceAll('_', ' ')} · {state.lastGate.new_correct_frames}{' '}
                new correct · {state.lastGate.regressions.length} regressions ·{' '}
                {state.lastGate.wrong_emitted_frames.length} wrong emissions
              </p>
              <details>
                <summary>Inspect gate receipt</summary>
                <pre className="kernel-json">{JSON.stringify(state.lastGate, null, 2)}</pre>
              </details>
            </section>
          )}
          <section className="kernel-card">
            <h2>Learned workflow preference</h2>
            <p>
              Beta counts are replayed from the latest 500 recorded runs. Changing a rating replaces
              its previous contribution. Preference is not factual accuracy.
            </p>
            {/* tabIndex and a role, because it scrolls: a region that overflows and
                cannot be focused is one a keyboard user cannot scroll at all.
                Named so a screen reader says what it landed in. */}
            <div className="kernel-table-wrap" tabIndex={0} role="region" aria-label="Table">
              <table>
                <thead>
                  <tr>
                    <th>Task family</th>
                    <th>Workflow</th>
                    <th>Ratings</th>
                    <th>α / β</th>
                    <th>Preference estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {(['conversation', 'coding', 'research', 'analysis'] as Family[]).flatMap((f) =>
                    policy(state, f).map((p) => (
                      <tr key={f + p.strategy}>
                        <td>{f}</td>
                        <td>{p.strategy}</td>
                        <td>{p.examples}</td>
                        <td>
                          {p.alpha} / {p.beta}
                        </td>
                        <td>{p.examples ? (p.mean * 100).toFixed(0) + '%' : 'Unmeasured'}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {tab === 'versions' && (
        <section className="kernel-card">
          <h2>Version history & rollback</h2>
          <p>
            The seed and 11 latest promoted checkpoints are retained. Export a checkpoint for
            long-term archival. Rollback restores its labels and rules.
          </p>
          {state.versions.map((v) => (
            <div className="checkpoint-row" key={v.id}>
              <HikmahIcon name="learning" />
              <div>
                <strong>
                  {v.id === 'seed-v1' ? 'Initial supervised model' : v.id.slice(0, 8)}{' '}
                  {v.id === state.activeId && <span className="status-pill">Active</span>}
                </strong>
                <p>
                  {v.lexicon} mappings · {v.rules} rules · {v.rows.length} added labels
                </p>
                <small>{v.reason}</small>
              </div>
              <Button
                variant="outline"
                disabled={busy || !ready || v.id === state.activeId}
                onClick={() => void perform({ type: 'rollback', versionId: v.id })}
              >
                Restore
              </Button>
            </div>
          ))}
          <details>
            <summary>Inspect current learned structures</summary>
            <pre className="kernel-json">
              {JSON.stringify(
                {
                  checkpoint: current.id,
                  hash: current.hash,
                  lexicon: model.lexicon,
                  rules: model.rules,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </section>
      )}
      {tab === 'runs' && (
        <section className="kernel-card">
          <h2>Actual run history</h2>
          <p>
            Provider tokens, elapsed time and outcomes recorded by the workspace. Chat text and
            credentials are excluded from this telemetry. Comparison runs do not train the policy.
          </p>
          {!state.runs.length ? (
            <div className="honest-empty">
              No runs yet. Complete a chat to record your first run.
            </div>
          ) : (
            <div className="kernel-table-wrap" tabIndex={0} role="region" aria-label="Table">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Model</th>
                    <th>Workflow</th>
                    <th>Outcome</th>
                    <th>Tokens</th>
                    <th>Time</th>
                    <th>Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {state.runs.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.at).toLocaleString()}</td>
                      <td>{r.model}</td>
                      <td>{r.evaluation ? 'comparison' : r.strategy}</td>
                      {/* The runs tab is owner-only (not in the non-owner tab
                          list), so this badge mapping restyles nothing on
                          /kernel: complete reads evergreen, error reads
                          destructive, the rest neutral. */}
                      <td>
                        <Badge
                          variant={
                            r.status === 'complete'
                              ? 'default'
                              : r.status === 'error'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td>{r.tokens.toLocaleString()}</td>
                      <td>{(r.latencyMs / 1000).toFixed(1)}s</td>
                      <td>{r.rating ?? 'Unrated'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {/* The v5 workflow policy inspector: per-arm A_a diagonals, the feedback
          it learned from, and the selection audit log. Owner only. */}
      {owner && tab === 'policy' && <PolicyPanel />}
      {tab === 'architecture' && (
        <>
          <div className="kernel-section-intro">
            <h2>One owned middle layer. Increasing local competence.</h2>
            <p>
              The existing Quran-informed research supplies inspectable engineering principles. The
              compositional learner supplies actual local predictions; the provider remains the
              broad language engine.
            </p>
          </div>
          <div className="kernel-flow">
            {[
              ['Understand', 'Typed interpretation; abstain beyond learned scope'],
              ['Choose', 'Learned workflow preference, within owner controls'],
              ['Act & check', 'Tools, questions, optional critique and repair'],
              ['Learn', 'Reviewed labels, candidate fit, regression gate, promotion'],
            ].map(([t, d], i) => (
              <div key={t}>
                <span>{i + 1}</span>
                <strong>{t}</strong>
                <p>{d}</p>
              </div>
            ))}
          </div>
          <div className="kernel-grid">
            <section className="kernel-card">
              <h2>The mathematics we execute</h2>
              <p>Lexical candidates:</p>
              <code>C(w) = intersection of atoms(y) for examples containing w</code>
              <p>
                Unique lexical matches become role slots in learned surface templates. Ambiguous
                parses abstain.
              </p>
              <p>Workflow preference:</p>
              <code>p̂ = (1 + positive ratings) / (2 + all ratings)</code>
              <p>Promotion:</p>
              <code>gain &gt; 0 AND regressions = 0 AND wrong emissions = 0</code>
              <p>
                Training changes mappings and rules; feedback changes preference parameters. Neither
                changes provider weights.
              </p>
            </section>
            <section className="kernel-card">
              <h2>Research coverage</h2>
              <p>
                <strong>6,236 ayahs · 114 surahs · 22 principle patterns.</strong> Recorded AI
                contextual first pass: 1,541 candidates, 2,180 with no direct analogy, 2,048 context
                only, 467 needing deeper review.
              </p>
              <p>
                The original full package is recovered and its 191 files pass the recorded hash
                checks. All 6,236 first-pass rows and context memberships are present. This is not
                independently verified full tafsir.
              </p>
              <div className="kernel-actions">
                <a href="/research/v5/source-coverage.json" target="_blank" rel="noreferrer">
                  Coverage record
                </a>
                <a href="/research/v5/root-study.json" target="_blank" rel="noreferrer">
                  Root study
                </a>
                <a href="/research/v5/architecture.md" target="_blank" rel="noreferrer">
                  Full architecture
                </a>
              </div>
            </section>
          </div>
          <section className="kernel-card">
            <h2>Principles → operating behavior</h2>
            <p>
              These are engineering interpretations with preserved research IDs, not claims that the
              source specifies these algorithms.
            </p>
            {principles.map((p) => (
              <details key={p.id} className="principle-detail">
                <summary>
                  <span>{p.id}</span>
                  {p.name}
                </summary>
                <p>{p.instruction}</p>
                <p>Proposed enforcement: {p.enforcement}</p>
                <small>{p.status.replaceAll('_', ' ')}</small>
              </details>
            ))}
          </section>
          <section className="kernel-card">
            <h2>Path toward a more independent model</h2>
            <ol className="capability-roadmap">
              <li>
                <strong>Available:</strong> learned single-event interpretation, reviewed updates,
                workflow preference and checkpoints.
              </li>
              <li>
                <strong>Next research gate:</strong> induce executable procedures and validate them
                on new task families.
              </li>
              <li>
                <strong>Then:</strong> delegate bounded tasks locally when unseen task tests
                demonstrate reliable performance.
              </li>
              <li>
                <strong>Longer-term research:</strong> larger semantics, local language generation
                and broader task autonomy require their own data, compute and evaluations.
              </li>
            </ol>
            <p>
              Arabic root labels are one semantic vocabulary. Universal Arabic ancestry, universal
              sound–meaning equations and eventual AGI are not established results.
            </p>
          </section>
        </>
      )}
      {tab === 'controls' && (
        <section className="kernel-card">
          <h2>Owner controls</h2>
          <p>
            These changes are authorized on the server for the configured owner. Workspace admin
            continues to manage your provider, media, skills and connector settings.
          </p>
          {(
            [
              [
                'enabled',
                'Enable the Hikmah middle layer',
                'Interpret locally, choose a workflow and apply the principle registry.',
              ],
              [
                'autoTrain',
                'Automatically train reviewed rule examples',
                'Fit, evaluate and promote passing candidates after each approved batch.',
              ],
              [
                'collectFeedback',
                'Learn from explicit feedback',
                'Use helpful / unhelpful ratings to update workflow preference.',
              ],
            ] as const
          ).map(([key, title, description]) => (
            <div className="kernel-setting" key={key}>
              <div>
                <strong>{title}</strong>
                <p>{description}</p>
              </div>
              <Switch
                aria-label={title}
                checked={config[key]}
                disabled={busy || !ready}
                onCheckedChange={(value) => setConfigDraft({ ...config, [key]: value })}
              />
            </div>
          ))}
          <label className="kernel-field">
            Workflow strategy
            <select
              value={config.strategy}
              disabled={busy || !ready}
              onChange={(e) =>
                setConfigDraft({
                  ...config,
                  strategy: e.target.value as 'adaptive' | 'direct' | 'verify',
                })
              }
            >
              <option value="adaptive">Adaptive — use learned preference when supported</option>
              <option value="direct">Direct — one generation workflow</option>
              <option value="verify">Verify — review, then repair named defects if needed</option>
            </select>
          </label>
          <p className="fine-print">
            Verification can add one review and one repair request. It is a model judgment unless a
            tool or source supplies an independent check. Provider limits and charges still apply.
          </p>
          <div className="kernel-setting">
            <div>
              <strong>Owner access</strong>
              <p>
                {role === 'super_admin'
                  ? 'Authenticated owner; server-enforced permission checks are active.'
                  : 'Owner access is unavailable.'}
              </p>
            </div>
            <HikmahIcon name="ownerAdmin" size={32} />
          </div>
          <p>
            Training runs when reviewed experience arrives; there is no autonomous background
            training job without new data. No chat content is sent to another provider for training.
          </p>
          <SaveBar
            dirty={configDirty}
            busy={busy}
            onSave={() => void saveConfig()}
            onDiscard={() => setConfigDraft(null)}
          />
        </section>
      )}
    </div>
  );
}
