'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Download, FlaskConical, Info, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  EpisodeModel,
  EPISODE_LIMITS,
  EPISODE_PROVENANCE,
  type EpisodeResult,
  type EpisodeSnapshot,
} from '@/lib/research/episode-model';
import { saveDownload } from './shared';

// Keep synchronous browser experiments smaller than the engine's general
// ceiling, while respecting any tighter bounds introduced by the engine.
const interactiveLimits = {
  cells: Math.min(8, EPISODE_LIMITS.cells),
  keys: Math.min(6, EPISODE_LIMITS.keys),
  senses: Math.min(8, EPISODE_LIMITS.sensesPerKey),
  observations: Math.min(24, EPISODE_LIMITS.observations),
};

function exampleSnapshot(shared: boolean): EpisodeSnapshot {
  const model = new EpisodeModel(
    ['scene-1', 'scene-2'],
    { anchor: ['RED', 'BLUE'], symbol: ['CUP', 'BALL'] },
    { scopeId: 'research:browser-session' },
  );
  model.add({
    rowId: 'anchor-1',
    key: 'anchor',
    sense: 'RED',
    allowed: ['scene-1'],
    source: 'Illustrative supplied label',
  });
  model.add({
    rowId: 'anchor-2',
    key: 'anchor',
    sense: 'BLUE',
    allowed: ['scene-2'],
    source: 'Illustrative supplied label',
  });
  model.add({
    rowId: 'partial-anchor',
    key: 'anchor',
    sense: 'RED',
    allowed: ['scene-1', 'scene-2'],
    ...(shared ? { episode: 'recorded-instant' } : {}),
    source: 'Illustrative partial observation',
  });
  model.add({
    rowId: 'partial-symbol',
    key: 'symbol',
    sense: 'CUP',
    allowed: ['scene-1', 'scene-2'],
    ...(shared ? { episode: 'recorded-instant' } : {}),
    source: 'Illustrative partial observation',
  });
  return model.snapshot();
}

const resultLabels: Record<EpisodeResult['status'], string> = {
  ENTAILED: 'Entailed within this experiment',
  AMBIGUOUS: 'More than one meaning remains',
  INCONSISTENT: 'Evidence is inconsistent',
  RESOURCE_LIMIT: 'Search limit reached',
};

export function ResearchEvidence() {
  const [snapshot, setSnapshot] = useState(() => exampleSnapshot(true));
  const model = useMemo(() => EpisodeModel.fromSnapshot(snapshot), [snapshot]);
  const [queryKey, setQueryKey] = useState('symbol');
  const [queryCell, setQueryCell] = useState('scene-1');
  const [result, setResult] = useState<{ output: EpisodeResult; key: string; cell: string } | null>(
    null,
  );
  const [evidenceKey, setEvidenceKey] = useState('symbol');
  const [sense, setSense] = useState('CUP');
  const [allowed, setAllowed] = useState<string[]>(['scene-1', 'scene-2']);
  const [episode, setEpisode] = useState('');
  const [source, setSource] = useState('Manually supplied observation');
  const [cellsDraft, setCellsDraft] = useState('scene-1, scene-2');
  const [sensesDraft, setSensesDraft] = useState(
    JSON.stringify({ anchor: ['RED', 'BLUE'], symbol: ['CUP', 'BALL'] }, null, 2),
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(
    'Shared-episode example loaded. Run the query to inspect its result.',
  );
  const stale =
    result &&
    (!model.receiptIsCurrent(result.output) ||
      result.key !== queryKey ||
      result.cell !== queryCell);

  function run(operation: () => void) {
    setError('');
    try {
      operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The experiment could not run.');
    }
  }

  function loadExample(shared: boolean) {
    const next = exampleSnapshot(shared);
    setSnapshot(next);
    setQueryKey('symbol');
    setQueryCell('scene-1');
    setEvidenceKey('symbol');
    setSense('CUP');
    setAllowed([...next.cells]);
    setEpisode('');
    setCellsDraft(next.cells.join(', '));
    setSensesDraft(JSON.stringify(next.senses, null, 2));
    setResult(null);
    setError('');
    setNotice(
      `${shared ? 'Shared-episode' : 'Independent-observation'} example loaded. Run the query to compare the result.`,
    );
  }

  function addEvidence(event: FormEvent) {
    event.preventDefault();
    run(() => {
      if (model.rows.length >= interactiveLimits.observations)
        throw new Error(
          `This interactive experiment allows ${interactiveLimits.observations} observations. Retract a row before adding more.`,
        );
      model.add({
        rowId: `observation-${crypto.randomUUID().slice(0, 8)}`,
        key: evidenceKey,
        sense,
        allowed,
        ...(episode.trim() ? { episode: episode.trim() } : {}),
        source: source.trim() || 'Manually supplied observation',
      });
      setSnapshot(model.snapshot());
      setNotice('Observation added. Run the query again to use the current evidence.');
    });
  }

  return (
    <div className="learning-research">
      <section className="learning-section-intro">
        <div>
          <span className="learning-eyebrow">
            <FlaskConical size={16} />
            RESEARCH WORKBENCH
          </span>
          <h2>Make the evidence visible.</h2>
          <p>
            Test how an explicitly shared episode changes the meanings a finite set of observations
            can support.
          </p>
        </div>
        <span className="learning-badge">Experimental · {EPISODE_PROVENANCE.engine}</span>
      </section>
      <div className="learning-evidence-boundary">
        <Info size={20} />
        <p>
          Cells, possible meanings, and episode identities are supplied by you. The solver checks
          consistency inside those assumptions; it does not infer a language or establish factual
          truth. Verified stage 31–32 artifacts are not available in this integration.
        </p>
      </div>
      <div className="learning-research-examples">
        <span>Start with an example</span>
        <Button variant="outline" size="sm" onClick={() => loadExample(false)}>
          Independent observations
        </Button>
        <Button variant="outline" size="sm" onClick={() => loadExample(true)}>
          Shared episode
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            saveDownload(
              new Blob(
                [
                  JSON.stringify(
                    {
                      provenance: EPISODE_PROVENANCE,
                      snapshot,
                      result: result && !stale ? result : null,
                    },
                    null,
                    2,
                  ),
                ],
                { type: 'application/json' },
              ),
              'hikmah-evidence-experiment.json',
            )
          }
        >
          <Download size={16} />
          Export experiment
        </Button>
      </div>
      {error && (
        <div className="learning-alert" role="alert">
          <Info size={16} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <p className="learning-subtle-status" role="status">
          {notice}
        </p>
      )}

      <div className="learning-experiment-grid">
        <section className="learning-panel">
          <div className="learning-panel-heading">
            <div>
              <h3>Evidence ledger</h3>
              <p>Every row can be inspected or retracted.</p>
            </div>
            <span className="learning-count-label">{snapshot.rows.length} observations</span>
          </div>
          <div className="learning-context-summary">
            <div>
              <span>Context cells</span>
              <p>
                {snapshot.cells.map((cell) => (
                  <code key={cell}>{cell}</code>
                ))}
              </p>
            </div>
            <div>
              <span>Possible meanings</span>
              <p>
                {Object.entries(snapshot.senses).map(([key, values]) => (
                  <span key={key}>
                    <strong>{key}</strong> → {values.join(' / ')}
                  </span>
                ))}
              </p>
            </div>
          </div>
          <div className="learning-table-scroll">
            <table className="learning-evidence-table">
              <caption className="sr-only">
                Supplied evidence for the current local experiment
              </caption>
              <thead>
                <tr>
                  <th scope="col">Observation</th>
                  <th scope="col">Allowed cells</th>
                  <th scope="col">Episode</th>
                  <th scope="col">
                    <span className="sr-only">Retract</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((row) => (
                  <tr key={row.rowId}>
                    <td>
                      <strong>
                        {row.key} <ArrowRight size={12} aria-hidden="true" /> {row.sense}
                      </strong>
                      <small title={row.source}>{row.source}</small>
                    </td>
                    <td>{row.allowed.join(', ')}</td>
                    <td>{row.episode ?? <span className="learning-subtext">Independent</span>}</td>
                    <td>
                      <button
                        type="button"
                        className="learning-icon-button"
                        aria-label={`Retract ${row.rowId}`}
                        onClick={() =>
                          run(() => {
                            model.retract(row.rowId);
                            setSnapshot(model.snapshot());
                            setNotice(
                              'Evidence retracted. Previous results are stale until you run the query again.',
                            );
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!snapshot.rows.length && (
                  <tr>
                    <td colSpan={4}>No evidence yet. Add your first observation below.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <details className="learning-add-evidence">
            <summary>
              <Plus size={16} />
              Add an observation
            </summary>
            <form className="learning-evidence-form" onSubmit={addEvidence}>
              <div className="learning-form-pair">
                <label>
                  Symbol
                  <select
                    value={evidenceKey}
                    onChange={(event) => {
                      setEvidenceKey(event.target.value);
                      setSense(snapshot.senses[event.target.value][0]);
                    }}
                  >
                    {Object.keys(snapshot.senses).map((key) => (
                      <option key={key}>{key}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Observed meaning
                  <select value={sense} onChange={(event) => setSense(event.target.value)}>
                    {snapshot.senses[evidenceKey]?.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="learning-cell-checks">
                <legend>Allowed context cells</legend>
                {snapshot.cells.map((cell) => (
                  <label key={cell}>
                    <input
                      type="checkbox"
                      checked={allowed.includes(cell)}
                      onChange={(event) =>
                        setAllowed((current) =>
                          event.target.checked
                            ? [...current, cell]
                            : current.filter((value) => value !== cell),
                        )
                      }
                    />
                    {cell}
                  </label>
                ))}
              </fieldset>
              <label>
                Shared episode <span>(optional)</span>
                <input
                  value={episode}
                  maxLength={128}
                  placeholder="Same exact ID means the same episode"
                  onChange={(event) => setEpisode(event.target.value)}
                />
              </label>
              <label>
                Evidence source
                <input
                  value={source}
                  maxLength={500}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <Button
                type="submit"
                disabled={!allowed.length || snapshot.rows.length >= interactiveLimits.observations}
              >
                <Plus size={16} />
                Add evidence
              </Button>
            </form>
          </details>
        </section>

        <section className="learning-panel learning-query-panel">
          <div className="learning-panel-heading">
            <div>
              <h3>Ask the experiment</h3>
              <p>Which meaning is supported in this context?</p>
            </div>
          </div>
          <form
            className="learning-query-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => {
                setResult({
                  output: model.query(queryKey, { allowed: [queryCell] }),
                  key: queryKey,
                  cell: queryCell,
                });
                setNotice('Query completed against the current evidence.');
              });
            }}
          >
            <label>
              Symbol
              <select value={queryKey} onChange={(event) => setQueryKey(event.target.value)}>
                {Object.keys(snapshot.senses).map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
            </label>
            <label>
              Context cell
              <select value={queryCell} onChange={(event) => setQueryCell(event.target.value)}>
                {snapshot.cells.map((cell) => (
                  <option key={cell}>{cell}</option>
                ))}
              </select>
            </label>
            <Button type="submit">
              Run query
              <ArrowRight size={16} />
            </Button>
          </form>
          {result ? (
            <div
              className={`learning-result ${stale ? 'learning-result-stale' : `learning-result-${result.output.status.toLowerCase()}`}`}
              role="status"
            >
              <span className="learning-eyebrow">
                {stale ? 'STALE RESULT' : 'CONDITIONAL RESULT'}
              </span>
              <h4>{stale ? 'Evidence or query changed' : resultLabels[result.output.status]}</h4>
              <p>
                {stale ? (
                  'Run the query again before relying on this result.'
                ) : result.output.status === 'ENTAILED' ? (
                  <>
                    <strong>{result.output.value}</strong> is the only supported meaning under the
                    supplied assumptions.
                  </>
                ) : result.output.status === 'AMBIGUOUS' ? (
                  <>
                    Candidates: <strong>{result.output.candidates.join(', ')}</strong>. Keep this
                    uncertainty visible.
                  </>
                ) : result.output.status === 'INCONSISTENT' ? (
                  'No assignment satisfies all the supplied observations. Inspect or retract conflicting evidence.'
                ) : (
                  'The bounded search did not finish. No meaning is asserted.'
                )}
              </p>
              {!stale && (
                <>
                  <dl className="learning-result-stats">
                    <div>
                      <dt>Search</dt>
                      <dd>{result.output.searchComplete ? 'Complete' : 'Incomplete'}</dd>
                    </div>
                    <div>
                      <dt>Compatible assignments</dt>
                      <dd>{result.output.compatibleWitnessAssignments ?? 'Unknown'}</dd>
                    </div>
                  </dl>
                  <details className="learning-proof">
                    <summary>Inspect result and witness tables</summary>
                    <pre>{JSON.stringify(result.output, null, 2)}</pre>
                  </details>
                </>
              )}
            </div>
          ) : (
            <div className="learning-query-empty">
              <FlaskConical size={24} strokeWidth={1.5} />
              <p>Run a query to see its supported meanings, uncertainty, and witness tables.</p>
            </div>
          )}
          <p className="learning-query-note">
            <Info size={16} />
            This experiment stays in this page session. It does not write facts to chat memory.
          </p>
        </section>
      </div>

      <details className="learning-universe">
        <summary>Define your own finite experiment</summary>
        <p>
          Starting a new experiment replaces this page’s evidence. Export anything you want to keep
          first. This interface supports up to {interactiveLimits.cells} cells,{' '}
          {interactiveLimits.keys} symbols, {interactiveLimits.senses} meanings per symbol, and{' '}
          {interactiveLimits.observations} observations.
        </p>
        <div className="learning-form-pair">
          <label>
            Context cells, separated by commas
            <input
              value={cellsDraft}
              maxLength={600}
              onChange={(event) => setCellsDraft(event.target.value)}
            />
          </label>
          <label>
            Symbol-to-meaning inventory (JSON)
            <textarea
              rows={6}
              value={sensesDraft}
              maxLength={6000}
              spellCheck={false}
              onChange={(event) => setSensesDraft(event.target.value)}
            />
          </label>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            run(() => {
              const cells = cellsDraft
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
              const inventory: unknown = JSON.parse(sensesDraft);
              if (
                cells.length > interactiveLimits.cells ||
                !inventory ||
                typeof inventory !== 'object' ||
                Array.isArray(inventory) ||
                Object.keys(inventory).length > interactiveLimits.keys ||
                Object.values(inventory).some(
                  (value) => !Array.isArray(value) || value.length > interactiveLimits.senses,
                )
              )
                throw new Error(
                  `Use at most ${interactiveLimits.cells} context cells, ${interactiveLimits.keys} symbols, and ${interactiveLimits.senses} possible meanings per symbol.`,
                );
              const next = new EpisodeModel(cells, inventory as Record<string, string[]>, {
                scopeId: 'research:browser-session',
              });
              const firstKey = Object.keys(next.senses)[0];
              setSnapshot(next.snapshot());
              setQueryKey(firstKey);
              setQueryCell(next.cells[0]);
              setEvidenceKey(firstKey);
              setSense(next.senses[firstKey][0]);
              setAllowed([...next.cells]);
              setResult(null);
              setEpisode('');
              setNotice('New experiment started. Add evidence to begin.');
            })
          }
        >
          <RotateCcw size={16} />
          Start a new experiment
        </Button>
      </details>
      <p className="learning-footnote">
        <Info size={16} />
        Shared episode identity is an input, not a conclusion. This extension is not evidence of
        universal language understanding.
      </p>
    </div>
  );
}
