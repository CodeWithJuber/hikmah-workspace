'use client';
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
  downloadJson,
} from './common';
import { languageOptions } from './meaning';
type Candidate = {
  rows: TrainingRow[];
  result: ReturnType<typeof compareCandidates>;
  kind: string;
};
export function Learn() {
  const kernel = useKernel();
  const { model, additions, applyRows } = usePlayground();
  const [rowsJson, setRowsJson] = useState(JSON.stringify(dataset.good_update_train, null, 2));
  const [developmentJson, setDevelopmentJson] = useState('[]');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [probe, setProbe] = useState('Sara did help Lina.');
  const [probeLanguage, setProbeLanguage] = useState('en');
  const [kind, setKind] = useState('good');
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
  const load = (k: string) => {
    setKind(k);
    const rows =
      k === 'good'
        ? dataset.good_update_train
        : k === 'bad'
          ? dataset.bad_update_train
          : dataset.bad_update_train.map((r) => ({
              ...r,
              id: r.id.replace('train-future', 'user-correct-future'),
              gold: { ...r.gold, tense: 'future' },
              annotation_note: 'Correct future label, user lesson.',
            }));
    changeRows(JSON.stringify(rows, null, 2));
    setProbe(k === 'good' ? 'Sara did help Lina.' : 'Sara will help Lina.');
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
      setCandidate({ rows, result, kind });
      setError('');
      setNotice('Candidate trained and checked. The active model is unchanged until you apply it.');
    } catch (e) {
      setError(errorMessage(e));
      setCandidate(null);
    }
  };
  const addExample = () => {
    try {
      const person = (v: string) => {
        const s = v.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_-]{0,40}$/.test(s))
          throw Error('Person IDs should use simple lowercase names such as zoya.');
        return 'person:' + s;
      };
      const frame: Frame = {
        agent: person(agentName),
        patient: person(patientName),
        action,
        polarity: polarity === 'positive',
        tense: tense as Frame['tense'],
        modality: 'assertion',
      };
      const row = {
        id: 'user-' + randomId(),
        family: [frame.agent, frame.action, frame.patient, frame.polarity].join('/'),
        split: 'train',
        language,
        category: 'user_teaching',
        text: sentence,
        gold: frame,
      };
      const old = parseRowsJson(rowsJson, 'train');
      changeRows(JSON.stringify([...old, row], null, 2));
      setKind('custom');
      setError('');
      setNotice(
        'Example added. Add varied names and actions so lexical intersections can separate the roles.',
      );
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
  return (
    <>
      <div className="metric-row">
        <Metric value={model.training_ids.length} label="active training examples" />
        <Metric value={model.lexicon.length} label="learned token mappings" />
        <Metric value={model.rules.length} label="learned constructions" />
      </div>
      <div className="two-columns">
        <section>
          <h2>Teach a construction</h2>
          <p className="small-note">
            Train a candidate, compare it against development examples, then apply an approved
            update. These are real local computations.
          </p>
          <div className="actions">
            <Button variant="outline" onClick={() => load('good')}>
              Load valid update
            </Button>
            <Button variant="outline" onClick={() => load('bad')}>
              Load corrupt update
            </Button>
            <Button variant="outline" onClick={() => load('future')}>
              Load future tense
            </Button>
          </div>
          <label
            className="small-note"
            htmlFor="training-json"
            style={{ display: 'block', margin: '18px 0 6px' }}
          >
            Paired training examples · editable JSON
          </label>
          <Textarea
            id="training-json"
            className="train-input"
            value={rowsJson}
            maxLength={500000}
            onChange={(e) => {
              setKind('custom');
              changeRows(e.target.value);
            }}
            spellCheck={false}
          />
          <div className="actions">
            <Button onClick={fit}>Train candidate</Button>
            <Button
              variant="outline"
              onClick={() =>
                downloadJson(
                  { model, training: [...baseRows, ...additions] },
                  'hikmah-learned-model.json',
                )
              }
            >
              Export learned model
            </Button>
          </div>
        </section>
        <section>
          <h2>Test before and after</h2>
          <div className="fields">
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
          {candidate && (
            <>
              <Notice error={!candidate.result.receipt.approved}>
                <strong>
                  {candidate.result.receipt.approved ? 'Update approved' : 'Update rejected'}
                </strong>
                <p>
                  {candidate.result.receipt.reason.replace(/_/g, ' ')}. New correct frames:{' '}
                  {candidate.result.receipt.new_correct_frames}. Regressions:{' '}
                  {candidate.result.receipt.regressions.length}. Wrong emitted frames:{' '}
                  {candidate.result.receipt.wrong_emitted_frames.length}.
                </p>
              </Notice>
              <div className="actions">
                <Button
                  disabled={!candidate.result.receipt.approved}
                  onClick={async () => {
                    try {
                      await kernel.act({
                        type: 'teach',
                        rows: candidate.rows,
                        development: parseRowsJson(developmentJson, 'development'),
                      });
                      setCandidate(null);
                      setNotice(
                        'Reviewed examples saved and processed by the durable training pipeline. Inspect the co-model center for its release decision.',
                      );
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
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
              <JsonView value={candidate.result.receipt} label="Inspect the development decision" />
            </>
          )}
          <p className="small-note" style={{ marginTop: 18 }}>
            A no-gain candidate needs independent development examples. More observations are not a
            confidence probability. Final test labels never select updates.
          </p>
        </section>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <details className="disclosure">
        <summary>Add your own labeled sentence</summary>
        <div className="fields">
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
        <div className="fields">
          <div className="field">
            <label htmlFor="agent-name">Actor ID</label>
            <Input
              id="agent-name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </div>
          <div className="field">
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
        <div className="actions">
          <Button variant="outline" onClick={addExample}>
            Add to training examples
          </Button>
        </div>
      </details>
      <details className="disclosure">
        <summary>Add independent development examples</summary>
        <p className="small-note">
          Same row format; set split to “development”. Use different sentences and semantic families
          from training. These labels affect the gate, so keep a separate untouched final
          evaluation.
        </p>
        <Textarea
          className="train-input"
          aria-label="Development examples JSON"
          value={developmentJson}
          maxLength={500000}
          onChange={(e) => {
            setDevelopmentJson(e.target.value);
            setCandidate(null);
          }}
        />
      </details>
      <details className="disclosure">
        <summary>Inspect learned rules and reference results</summary>
        <DataTable
          heads={['Language', 'Learned construction', 'Constants', 'Observations']}
          rows={model.rules.map((r) => [
            r.language,
            <code>{r.pattern.map(([k, v]) => (k === 'slot' ? `[${v}]` : v)).join(' ')}</code>,
            `${r.constants.polarity ? 'positive' : 'negative'}, ${r.constants.tense}`,
            r.observations,
          ])}
        />
        <div className="actions">
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
      <section className="section">
        <h2>What the algorithm learns</h2>
        <Equation description="For each word, intersect the semantic atoms of every labeled sentence containing it. A unique surviving atom becomes a lexical entry. Multiple candidates remain unresolved.">
          C(w) = ⋂ {'{ atoms(yᵢ) : w ∈ tokens(xᵢ) }'}
        </Equation>
        <p className="small-note">
          Aligned actor, action and recipient positions become variables. Literal cues preserve word
          order, negation and tense. This is a small supervised symbolic learner with a supplied
          schema; the system has not learned unrestricted language or a new universal foundation
          model.
        </p>
      </section>
    </>
  );
}
