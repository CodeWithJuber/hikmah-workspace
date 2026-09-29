'use client';
/** The learning lab, restructured as a 60-second loop: Show it → Teach it →
 * Try it.
 *
 * Before, this page opened on an editable JSON textarea with three "Load"
 * buttons — a machine's view of teaching. Now the first thing on screen is
 * a live probe: what the model hears in a sentence, as labeled chips. Then
 * one button trains a candidate. Then the same probe shows before and after.
 * The JSON, the equation and the reference checks still exist, one
 * disclosure level down, for the owners who want them.
 */
import { randomId } from '../../lib/id.ts';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  train,
  predict,
  evaluate,
  parseRowsJson,
  compareCandidates,
  type TrainingRow,
  type Row,
  type Frame,
} from '@/lib/engines/meaning-engine';
import { baseRows, dataset } from '@/lib/playground/session';
import { usePlayground } from './context';
import { useKernel } from '@/components/kernel/context';
import {
  Choice,
  DataTable,
  Notice,
  JsonView,
  Metric,
  Equation,
  errorMessage,
  pretty,
} from './common';
import wb from './workbench.module.css';
import { languageOptions } from './meaning';

type Candidate = {
  rows: TrainingRow[];
  result: ReturnType<typeof compareCandidates>;
};

/** The 60-second guided first teach: one tap adds a complete, correct
 * example ("Sara helped Lina.") so the first train → apply loop needs no
 * JSON, no forms, no decisions. */
const GUIDED = {
  sentence: 'Sara helped Lina.',
  agentName: 'sara',
  patientName: 'lina',
  action: 'action:qroot:ع-و-ن#help',
  tense: 'past' as const,
  polarity: 'positive' as const,
  language: 'en',
};

/** The key the chat watches: after a successful teach the next chat visit
 * surfaces one AhaMoment line — then it is done. */
const LAST_TEACH_KEY = 'hikmah:ui:last-teach';

export function Learn() {
  const kernel = useKernel();
  const { model, additions } = usePlayground();
  const [rowsJson, setRowsJson] = useState(JSON.stringify(dataset.good_update_train, null, 2));
  const [developmentJson, setDevelopmentJson] = useState('[]');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [probe, setProbe] = useState('Sara did help Lina.');
  const [probeLanguage, setProbeLanguage] = useState('en');
  const [diagnostics, setDiagnostics] = useState<ReturnType<typeof evaluate> | null>(null);
  const [sentence, setSentence] = useState('Zoya helped Sara.');
  const [agentName, setAgentName] = useState('zoya');
  const [patientName, setPatientName] = useState('sara');
  const [action, setAction] = useState('action:qroot:ع-و-ن#help');
  const [tense, setTense] = useState('past');
  const [polarity, setPolarity] = useState('positive');
  const [language, setLanguage] = useState('en');
  const changeRows = (s: string) => {
    setRowsJson(s);
    setCandidate(null);
    setNotice('');
  };
  /** Build one labeled training row from form fields. Shared by the manual
   * form and the guided example, so both validate names the same way. */
  const makeRow = (fields: {
    sentence: string;
    agentName: string;
    patientName: string;
    action: string;
    tense: Frame['tense'];
    polarity: 'positive' | 'negative';
    language: string;
  }) => {
    const person = (v: string) => {
      const s = v.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(s))
        throw Error('Person IDs should use simple lowercase names such as zoya.');
      return 'person:' + s;
    };
    const frame: Frame = {
      agent: person(fields.agentName),
      patient: person(fields.patientName),
      action: fields.action,
      polarity: fields.polarity === 'positive',
      tense: fields.tense,
      modality: 'assertion',
    };
    return {
      id: 'user-' + randomId(),
      family: [frame.agent, frame.action, frame.patient, frame.polarity].join('/'),
      split: 'train',
      language: fields.language,
      category: 'user_teaching',
      text: fields.sentence,
      gold: frame,
    };
  };
  const addExample = () => {
    try {
      const row = makeRow({
        sentence,
        agentName,
        patientName,
        action,
        tense: tense as Frame['tense'],
        polarity: polarity as 'positive' | 'negative',
        language,
      });
      const old = parseRowsJson(rowsJson, 'train');
      changeRows(JSON.stringify([...old, row], null, 2));
      setError('');
      setNotice(
        'Example added. Add varied names and actions so lexical intersections can separate the roles.',
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  /** The guided first teach: fill the form AND add the example in one tap, so
   * the owner sees the full loop — example → train → apply — in a minute. */
  const guidedExample = () => {
    setSentence(GUIDED.sentence);
    setAgentName(GUIDED.agentName);
    setPatientName(GUIDED.patientName);
    setAction(GUIDED.action);
    setTense(GUIDED.tense);
    setPolarity(GUIDED.polarity);
    setLanguage(GUIDED.language);
    try {
      const row = makeRow(GUIDED);
      const old = parseRowsJson(rowsJson, 'train');
      changeRows(JSON.stringify([...old, row], null, 2));
      setError('');
      setNotice(
        'Guided example added. Now press Train candidate below — the whole loop takes about a minute.',
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const fit = () => {
    try {
      const proposed = parseRowsJson(rowsJson, 'train') as TrainingRow[];
      const map = new Map(additions.map((r) => [r.id, r]));
      for (const row of proposed) map.set(row.id, row);
      const rows = [...map.values()];
      if (rows.length > 400) throw Error('Limit: 400 additional training rows.');
      const fitted = train([...baseRows, ...rows], { parentModelId: model.model_id });
      const extraDev = parseRowsJson(developmentJson, 'development');
      const result = compareCandidates(model, fitted, [
        ...(dataset.development as Row[]),
        ...extraDev,
      ]);
      setCandidate({ rows, result });
      setError('');
      setNotice('Candidate trained and checked. The active model is unchanged until you apply it.');
    } catch (e) {
      setError(errorMessage(e));
      setCandidate(null);
    }
  };
  const apply = async () => {
    if (!candidate) return;
    try {
      await kernel.act({
        type: 'teach',
        rows: candidate.rows,
        development: parseRowsJson(developmentJson, 'development'),
      });
      // The chat's applause: the next chat visit surfaces one AhaMoment line
      // naming what the teaching changed — then it is done.
      try {
        window.localStorage.setItem(
          LAST_TEACH_KEY,
          JSON.stringify({
            at: new Date().toISOString(),
            learned: candidate.result.receipt.new_correct_frames,
            broken: candidate.result.receipt.regressions.length,
          }),
        );
      } catch {
        // Private mode: the teach still applied; the moment just won't surface.
      }
      setCandidate(null);
      setNotice('Saved. Your next chat visit will show what your teaching changed.');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const getProbe = (m: typeof model) => {
    try {
      const p = predict(m, probeLanguage, probe);
      return p.frame
        ? `${pretty(p.frame.agent)} → ${pretty(p.frame.action)} → ${pretty(p.frame.patient)} · ${p.frame.tense} · ${p.frame.polarity ? 'positive' : 'negative'}`
        : 'No supported match';
    } catch (e) {
      return errorMessage(e);
    }
  };
  // The live probe: what the model hears in the sentence right now. A failed
  // parse is not an error — it is the honest "it hasn't learned this yet".
  const probeFrame = (() => {
    try {
      return predict(model, probeLanguage, probe).frame ?? null;
    } catch {
      return null;
    }
  })();
  // The receipt in plain words: how many new things were learned, how many
  // broke. The machine's reason stays one line below.
  const receipt = candidate?.result.receipt;
  return (
    <>
      <div className={wb.metricRow}>
        <Metric value={model.training_ids.length} label="active training examples" />
        <Metric value={model.lexicon.length} label="learned token mappings" />
        <Metric value={model.rules.length} label="learned constructions" />
      </div>

      <section className={wb.section}>
        <h2>1 · Show it</h2>
        <p className={wb.smallNote}>
          This is what the model hears in a sentence right now — who did what to whom. Type anything
          and watch it label the parts it already knows. These are real local computations.
        </p>
        <div className={wb.fields}>
          <Choice
            label="Probe language"
            value={probeLanguage}
            onChange={setProbeLanguage}
            options={languageOptions}
          />
        </div>
        <Input
          aria-label="Learning probe"
          value={probe}
          maxLength={512}
          onChange={(e) => setProbe(e.target.value)}
        />
        {probeFrame ? (
          <div className="learn-chips" role="status" aria-live="polite">
            <span className="learn-chip">
              <span className="learn-chip-label">Who</span>
              {pretty(probeFrame.agent)}
            </span>
            <span className="learn-chip">
              <span className="learn-chip-label">Did</span>
              {pretty(probeFrame.action)}
            </span>
            <span className="learn-chip">
              <span className="learn-chip-label">Whom</span>
              {pretty(probeFrame.patient)}
            </span>
            <span className="learn-chip">
              <span className="learn-chip-label">When</span>
              {probeFrame.tense}
            </span>
            <span className="learn-chip">
              <span className="learn-chip-label">How</span>
              {probeFrame.polarity ? 'positive' : 'negative'}
            </span>
          </div>
        ) : (
          <p className={wb.smallNote} role="status">
            No match yet — it hasn&rsquo;t learned this construction. Teach it below.
          </p>
        )}
      </section>

      <section className={wb.section}>
        <h2>2 · Teach it</h2>
        <div className="learn-guided">
          <p>
            <strong>First time?</strong> One tap adds a complete example. Then train, then apply —
            the whole loop takes about a minute.
          </p>
          <Button type="button" variant="outline" onClick={guidedExample}>
            Start with: &ldquo;Sara helped Lina.&rdquo;
          </Button>
        </div>
        <div className={wb.actions}>
          <Button onClick={fit}>Train candidate</Button>
        </div>
        <p className={wb.smallNote}>
          Trains a candidate and checks it against development examples. The active model is
          unchanged until you apply it.
        </p>
        {candidate && receipt && (
          <>
            <Notice error={!receipt.approved}>
              <strong>
                {receipt.approved
                  ? `✓ ${receipt.new_correct_frames} new ${
                      receipt.new_correct_frames === 1 ? 'thing' : 'things'
                    } learned, ${receipt.regressions.length} broken.`
                  : '✗ Nothing learned this time — nothing changed.'}
              </strong>
              <p>{receipt.reason.replace(/_/g, ' ')}.</p>
            </Notice>
            <div className={wb.actions}>
              <Button disabled={!receipt.approved} onClick={() => void apply()}>
                Apply approved update
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setCandidate(null);
                  setNotice('Candidate discarded.');
                }}
              >
                Discard candidate
              </Button>
            </div>
            <JsonView value={receipt} label="Inspect the development decision" />
          </>
        )}
        <details className={wb.disclosure}>
          <summary>Advanced: edit the training JSON</summary>
          <label
            className={wb.smallNote}
            htmlFor="training-json"
            style={{ display: 'block', margin: '18px 0 6px' }}
          >
            Paired training examples · editable JSON
          </label>
          <Textarea
            id="training-json"
            className={wb.trainInput}
            value={rowsJson}
            maxLength={500000}
            onChange={(e) => changeRows(e.target.value)}
            spellCheck={false}
          />
        </details>
      </section>

      <section className={wb.section}>
        <h2>3 · Try it</h2>
        <p className={wb.smallNote}>
          The same probe, before and after your candidate — proof the teaching worked.
        </p>
        <DataTable
          heads={['Version', 'Prediction']}
          rows={[
            ['Active model', getProbe(model)],
            [
              'Candidate',
              candidate
                ? getProbe(
                    candidate.result.candidateEvaluation
                      ? train([...baseRows, ...candidate.rows])
                      : model,
                  )
                : 'Train a candidate to compare',
            ],
          ]}
        />
        <p className={wb.smallNote} style={{ marginTop: 18 }}>
          A no-gain candidate needs independent development examples. More observations are not a
          confidence probability. Final test labels never select updates.
        </p>
      </section>

      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <details className={wb.disclosure}>
        <summary>Add your own labeled sentence</summary>
        <div className={wb.fields}>
          <Choice
            label="Example language"
            value={language}
            onChange={setLanguage}
            options={languageOptions}
          />
          <Choice
            label="Action sense"
            value={action}
            onChange={setAction}
            options={[
              { value: 'action:qroot:ع-و-ن#help', label: 'Help · ع و ن' },
              { value: 'action:qroot:ش-ك-ر#thank', label: 'Thank · ش ك ر' },
              { value: 'action:qroot:ذ-ك-ر#remember', label: 'Remember · ذ ك ر' },
            ]}
          />
          <Choice
            label="Tense"
            value={tense}
            onChange={setTense}
            options={['past', 'present', 'future'].map((v) => ({ value: v, label: v }))}
          />
          <Choice
            label="Polarity"
            value={polarity}
            onChange={setPolarity}
            options={[
              { value: 'positive', label: 'Positive' },
              { value: 'negative', label: 'Negative' },
            ]}
          />
        </div>
        <div className={wb.fields}>
          <div className={wb.field}>
            <label htmlFor="agent-name">Actor ID</label>
            <Input
              id="agent-name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </div>
          <div className={wb.field}>
            <label htmlFor="patient-name">Recipient ID</label>
            <Input
              id="patient-name"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
            />
          </div>
        </div>
        <Input
          aria-label="Sentence to teach"
          value={sentence}
          maxLength={512}
          onChange={(e) => setSentence(e.target.value)}
        />
        <div className={wb.actions}>
          <Button variant="outline" onClick={addExample}>
            Add to training examples
          </Button>
        </div>
      </details>
      <details className={wb.disclosure}>
        <summary>Add independent development examples</summary>
        <p className={wb.smallNote}>
          Same row format; set split to “development”. Use different sentences and semantic families
          from training. These labels affect the gate, so keep a separate untouched final
          evaluation.
        </p>
        <Textarea
          className={wb.trainInput}
          aria-label="Development examples JSON"
          value={developmentJson}
          maxLength={500000}
          onChange={(e) => {
            setDevelopmentJson(e.target.value);
            setCandidate(null);
          }}
        />
      </details>
      <details className={wb.disclosure}>
        <summary>Inspect learned rules and reference results</summary>
        <DataTable
          heads={['Language', 'Learned construction', 'Constants', 'Observations']}
          rows={model.rules.map((r, ruleIndex) => [
            r.language,
            <code key={'pattern-' + r.language + '-' + ruleIndex}>
              {r.pattern.map(([k, v]) => (k === 'slot' ? `[${v}]` : v)).join(' ')}
            </code>,
            `${r.constants.polarity ? 'positive' : 'negative'}, ${r.constants.tense}`,
            r.observations,
          ])}
        />
        <div className={wb.actions}>
          <Button
            variant="outline"
            onClick={() => setDiagnostics(evaluate(model, dataset.final_test as Row[]))}
          >
            Run frozen reference check
          </Button>
        </div>
        {diagnostics && (
          <>
            <Notice>
              {diagnostics.correct_frames}/{diagnostics.frame_scored_examples} exact representable
              frames; {diagnostics.emitted_frames}/{diagnostics.examples} requests covered;{' '}
              {diagnostics.abstentions} abstentions. Repeated interactive use makes this a
              diagnostic reference, not a fresh independent benchmark.
            </Notice>
            <JsonView value={diagnostics} label="Inspect every scored prediction" />
          </>
        )}
      </details>
      <details className={wb.disclosure}>
        <summary>Advanced: what the algorithm learns</summary>
        <Equation description="For each word, intersect the semantic atoms of every labeled sentence containing it. A unique surviving atom becomes a lexical entry. Multiple candidates remain unresolved.">
          C(w) = ⋂ {'{ atoms(yᵢ) : w ∈ tokens(xᵢ) }'}
        </Equation>
        <p className={wb.smallNote}>
          Aligned actor, action and recipient positions become variables. Literal cues preserve word
          order, negation and tense. This is a small supervised symbolic learner with a supplied
          schema; the system has not learned unrestricted language or a new universal foundation
          model.
        </p>
      </details>
    </>
  );
}
