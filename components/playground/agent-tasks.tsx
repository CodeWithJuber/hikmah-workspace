'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import {
  createPreset,
  PRESETS,
  plan,
  executePlan,
  type PlanningProblem,
  type PlanResult,
} from '@/lib/engines/agent-math';
import { Choice, Notice, Metric, DataTable, JsonView, pretty, errorMessage } from './common';
export function AgentTasks() {
  const [scenario, setScenario] = useState('hosting');
  const [problem, setProblem] = useState<PlanningProblem>(() => createPreset('hosting'));
  const [result, setResult] = useState<PlanResult | null>(null);
  const [execution, setExecution] = useState<ReturnType<typeof executePlan> | null>(null);
  const [failure, setFailure] = useState('none');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const update = (p: PlanningProblem) => {
    setProblem(p);
    setResult(null);
    setExecution(null);
    setError('');
  };
  const selectScenario = (id: string) => {
    setScenario(id);
    update(createPreset(id));
    setFailure('none');
    setHistory([]);
  };
  const findPlan = () => {
    try {
      setResult(plan(problem));
      setExecution(null);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const simulate = (steps?: number) => {
    if (!result) return;
    try {
      setExecution(
        executePlan(problem, result.actionIds, {
          outcomes: failure === 'none' ? {} : { [failure]: 'failure' },
          stepLimit: steps,
        }),
      );
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <div className="fields">
        <Choice
          label="Use case"
          value={scenario}
          onChange={selectScenario}
          options={[
            { value: 'hosting', label: 'Repair a service' },
            { value: 'research', label: 'Research a claim' },
            { value: 'document', label: 'Prepare a document' },
          ]}
        />
        <div className="field">
          <div className="number-row">
            <label htmlFor="plan-budget">Simulation budget</label>
            <output>{problem.budget} units</output>
          </div>
          <Slider
            id="plan-budget"
            aria-label="Simulation budget"
            min={0}
            max={20}
            step={1}
            value={[problem.budget]}
            onValueChange={([v]) => update({ ...problem, budget: v })}
          />
        </div>
      </div>
      <p>{problem.label}.</p>
      <p className="small-note">
        This lab executes finite state transitions on this device. Chat & code has the connected
        model and real workspace tools.
      </p>
      <div className="two-columns section">
        <section>
          <h2>Allowed actions</h2>
          {PRESETS[scenario].permissions.map((permission) => (
            <label className="check-row" key={permission}>
              <Checkbox
                aria-label={permission}
                checked={problem.permissions.includes(permission)}
                onCheckedChange={(v) =>
                  update({
                    ...problem,
                    permissions: v
                      ? [...problem.permissions, permission]
                      : problem.permissions.filter((p) => p !== permission),
                  })
                }
              />
              <span>{permission}</span>
            </label>
          ))}
          <div className="actions">
            <Button onClick={findPlan}>Find a plan</Button>
            <Button variant="outline" onClick={() => selectScenario(scenario)}>
              Reset scenario
            </Button>
          </div>
        </section>
        <section>
          <h2>Goal conditions</h2>
          <DataTable
            heads={['Fact', 'Required']}
            rows={problem.goals.map((g) => [pretty(g.fact), String(g.value)])}
          />
          <details className="disclosure">
            <summary>Edit initial facts</summary>
            {Object.entries(problem.initial).map(([k, v]) => (
              <label className="check-row" key={k}>
                <Checkbox
                  aria-label={`Initial ${k}`}
                  checked={v}
                  onCheckedChange={(checked) =>
                    update({ ...problem, initial: { ...problem.initial, [k]: !!checked } })
                  }
                />
                {pretty(k)}
              </label>
            ))}
          </details>
        </section>
      </div>
      {error && <Notice error>{error}</Notice>}
      {result && (
        <>
          <section className="section">
            <div className="metric-row">
              <Metric
                value={
                  result.status === 'found'
                    ? 'Found'
                    : result.status === 'blocked'
                      ? 'Blocked'
                      : 'Limit reached'
                }
                label="plan status"
              />
              <Metric value={result.actionIds.length} label="steps" />
              <Metric value={result.totalCost} label="simulation cost" />
              <Metric value={result.expansions} label="states expanded" />
            </div>
            {result.status === 'found' ? (
              <div className="two-columns">
                <section>
                  <h2>Planned steps</h2>
                  <ol className="timeline">
                    {result.trace.map((s) => (
                      <li key={s.actionId} data-step={s.index}>
                        <h3>{s.label}</h3>
                        <p>
                          {s.cost} units · total {s.cumulativeCost} · preconditions{' '}
                          {s.preconditions.every((p) => p.satisfied) ? 'satisfied' : 'unmet'}
                        </p>
                        <details>
                          <summary className="small-note">Inspect dependencies</summary>
                          <pre className="json-view">
                            {JSON.stringify(
                              { before: s.before, after: s.after, preconditions: s.preconditions },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                </section>
                <section>
                  <h2>Test execution</h2>
                  <Choice
                    label="Inject a simulated failure"
                    value={failure}
                    onChange={(v) => {
                      setFailure(v);
                      setExecution(null);
                    }}
                    options={[
                      { value: 'none', label: 'No injected failure' },
                      ...problem.actions.map((a) => ({
                        value: a.id,
                        label: a.label.replace('simulated ', '').replace('Simulate a ', ''),
                      })),
                    ]}
                  />
                  <div className="actions">
                    <Button onClick={() => simulate()}>Run simulation</Button>
                    <Button
                      variant="outline"
                      onClick={() => simulate((execution?.trace.length ?? 0) + 1)}
                      disabled={
                        execution?.status === 'goal_reached' || execution?.status === 'failed'
                      }
                    >
                      Step once
                    </Button>
                  </div>
                  {execution && (
                    <>
                      <Notice
                        error={execution.status === 'failed' || execution.status === 'blocked'}
                      >
                        <strong>
                          {execution.goalVerifiedInSimulation
                            ? 'Goal verified in simulation'
                            : execution.status.replace(/_/g, ' ')}
                        </strong>
                        <p>{execution.reason}</p>
                        <p>
                          {execution.spent} units spent · {execution.remainingBudget} remaining ·{' '}
                          {execution.externalOperations} external operations.
                        </p>
                      </Notice>
                      <DataTable
                        heads={['Step', 'Outcome']}
                        rows={execution.trace.map((s) => [
                          s.actionId,
                          <span className={s.outcome === 'success' ? 'outcome' : 'failure'}>
                            {s.outcome}
                          </span>,
                        ])}
                      />
                      {!execution.goalVerifiedInSimulation && (
                        <div className="actions">
                          <Button
                            variant="outline"
                            onClick={() => {
                              const next = {
                                ...problem,
                                initial: execution.finalState,
                                budget: execution.remainingBudget,
                              };
                              setHistory((h) => [
                                ...h,
                                `${execution.status}: ${execution.trace.length} steps, ${execution.spent} units spent`,
                              ]);
                              setProblem(next);
                              setResult(plan(next));
                              setExecution(null);
                              setFailure('none');
                            }}
                          >
                            Replan from this state
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            ) : (
              <Notice error>
                The configured permissions, budget or facts do not produce a completed plan.{' '}
                {result.unresolvedGoals.map((g) => pretty(g.fact)).join(', ')} remain unresolved.
              </Notice>
            )}
          </section>
          {history.length > 0 && (
            <p className="small-note">Previous attempts: {history.join(' · ')}</p>
          )}
          <JsonView
            value={{ plan: result, execution }}
            label="Inspect the complete planning and execution record"
          />
        </>
      )}
      <details className="disclosure">
        <summary>Algorithm and editable action model</summary>
        <p className="small-note">
          Uniform-cost search expands the cheapest remaining explicit state. A visited-state cost
          table prevents cycles; permissions, preconditions, budget and expansion limits are
          checked. Optimality applies only to this finite model under declared success effects.
          Real-world outcomes require real observations.
        </p>
        <DataTable
          heads={['Action', 'Cost', 'Preconditions', 'Effects']}
          rows={problem.actions.map((a) => [
            a.id,
            a.cost,
            a.requires.map((r) => `${r.fact}=${r.value}`).join(', '),
            a.effects.map((r) => `${r.fact}=${r.value}`).join(', '),
          ])}
        />
        <JsonView value={problem} />
      </details>
    </>
  );
}
