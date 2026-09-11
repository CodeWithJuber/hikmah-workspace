'use client';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  transitionEstimate,
  evaluateEvidence,
  selectContext,
  type ContextItem,
  type Assertion,
} from '@/lib/engines/agent-math';
import { graphSpectrum, diffuseGraph } from '@/lib/engines/graph-math';
import { DataTable, Equation, Metric, Notice, JsonView, Choice, downloadJson } from './common';
const contextItems: ContextItem[] = [
  {
    id: 'scope',
    text: 'These observations concern service A, staging environment, this test run.',
    requires: [],
    kind: 'scope',
  },
  {
    id: 'positive',
    text: 'The initial health check reports that service A is healthy.',
    requires: ['scope'],
    kind: 'evidence',
  },
  {
    id: 'negative',
    text: 'A later independent check reports that service A is not healthy.',
    requires: ['scope'],
    kind: 'negation',
  },
  {
    id: 'decision',
    text: 'Health is disputed. Recheck the service before declaring the repair complete.',
    requires: ['positive', 'negative'],
    kind: 'claim',
  },
  {
    id: 'unrelated',
    text: 'The unrelated design discussion asks whether a future dashboard should use blue buttons or green buttons. It has no bearing on current service health.',
    requires: [],
    kind: 'context',
  },
];
const scope = { tenant: 'local', project: 'service-a', context: 'test-1' };
export function Maths() {
  const [successes, setSuccesses] = useState(8);
  const [failures, setFailures] = useState(2);
  const [cost, setCost] = useState(3);
  const [support, setSupport] = useState(true);
  const [refute, setRefute] = useState(true);
  const [otherScope, setOtherScope] = useState(false);
  const [wordBudget, setWordBudget] = useState(65);
  const [missing, setMissing] = useState(false);
  const [diffusionTime, setDiffusionTime] = useState(1);
  const [graphKind, setGraphKind] = useState('path');
  const estimate = transitionEstimate({ successes, failures });
  const query = { id: 'service-healthy', scope };
  const assertions: Assertion[] = [
    ...(support
      ? [
          {
            id: 'check-a',
            proposition: query,
            polarity: 'positive' as const,
            sourceRef: 'configured-check-a',
          },
        ]
      : []),
    ...(refute
      ? [
          {
            id: 'check-b',
            proposition: {
              id: query.id,
              scope: otherScope ? { ...scope, project: 'service-b' } : scope,
            },
            polarity: 'negative' as const,
            sourceRef: 'configured-check-b',
          },
        ]
      : []),
  ];
  const evidence = evaluateEvidence(query, assertions);
  const context = selectContext(
    missing ? contextItems.filter((i) => i.id !== 'negative') : contextItems,
    ['decision'],
    wordBudget,
  );
  const adjacency =
    graphKind === 'path'
      ? [
          [0, 1, 0],
          [1, 0, 1],
          [0, 1, 0],
        ]
      : [
          [0, 1, 1],
          [1, 0, 1],
          [1, 1, 0],
        ];
  const graph = useMemo(() => graphSpectrum(adjacency), [graphKind]);
  const diffusion = useMemo(
    () => diffuseGraph(adjacency, [1, 0, 0], diffusionTime),
    [graphKind, diffusionTime],
  );
  return (
    <>
      <p>
        Change an assumption and inspect the mathematical consequence. The core combines learned
        symbolic mappings, explicit state transitions, evidence scope, and measured outcomes.
      </p>
      <div className="math-flow">
        <div>
          <h3>Represent</h3>
          <p>
            Words → candidate senses → typed event with actor, action, recipient, polarity and time.
          </p>
        </div>
        <div>
          <h3>Reason and act</h3>
          <p>
            Construct bounded plans, check dependencies, execute permitted tools and inspect
            results.
          </p>
        </div>
        <div>
          <h3>Learn and verify</h3>
          <p>
            Propose updates from examples. Select versions using development evidence and preserve
            counterexamples.
          </p>
        </div>
      </div>
      <section className="section">
        <h2>1. Learn from transition outcomes</h2>
        <div className="fields">
          {[
            { label: 'Successes', value: successes, set: setSuccesses },
            { label: 'Failures', value: failures, set: setFailures },
            { label: 'Action cost', value: cost, set: setCost },
          ].map((c) => (
            <div className="field" key={c.label}>
              <label htmlFor={c.label}>{c.label}</label>
              <Input
                id={c.label}
                type="number"
                min={c.label === 'Action cost' ? 1 : 0}
                max={1000}
                value={c.value}
                onChange={(e) =>
                  c.set(
                    Math.min(
                      1000,
                      Math.max(
                        c.label === 'Action cost' ? 1 : 0,
                        Math.floor(Number(e.target.value) || 0),
                      ),
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
        <Equation description="A Beta(1,1) prior with configured successes s and failures f produces a posterior. This assumes repeated, comparable Bernoulli outcomes; it is not measured live reliability.">
          p | data ∼ Beta(1+s, 1+f){'\n'}E[p] = α/(α+β) · Var[p] = αβ / [(α+β)²(α+β+1)]
        </Equation>
        <div className="metric-row">
          <Metric value={estimate.mean.toFixed(4)} label="posterior mean" />
          <Metric value={estimate.variance.toFixed(6)} label="posterior variance" />
          <Metric
            value={(estimate.expectedVarianceReduction / cost).toFixed(6)}
            label="expected variance reduction / cost"
          />
        </div>
        <Equation description="A one-observation utility favors experiments that reduce uncertainty per unit cost. This exact reduction is in parameter variance; it is not Shannon information in bits.">
          U(a) = {'{ Var[p] − Eᵧ[Var(p | y)] }'} / cost(a){'\n'} = Var[p] / [(α+β+1) · cost(a)]
        </Equation>
      </section>
      <section className="section">
        <h2>2. Preserve contradictory evidence</h2>
        <div className="two-columns">
          <div>
            <label className="check-row">
              <Checkbox checked={support} onCheckedChange={(v) => setSupport(!!v)} />
              Include a positive health report
            </label>
            <label className="check-row">
              <Checkbox checked={refute} onCheckedChange={(v) => setRefute(!!v)} />
              Include a negative health report
            </label>
            <label className="check-row">
              <Checkbox checked={otherScope} onCheckedChange={(v) => setOtherScope(!!v)} />
              The negative report concerns another service
            </label>
            <Equation description="Presence of support and refutation produces four evidence states. Different tenant, project, context or event time means a different proposition.">
              E(q) = (support present, refutation present)
            </Equation>
          </div>
          <div>
            <DataTable
              heads={['Measure', 'Computed result']}
              rows={[
                ['Evidence state', <strong>{evidence.state}</strong>],
                ['Supporting sources', evidence.distinctSupportingSources.length],
                ['Refuting sources', evidence.distinctRefutingSources.length],
                ['Ignored different scopes', evidence.ignoredDifferentPropositionsOrScopes],
              ]}
            />
            <p className="small-note" style={{ marginTop: 12 }}>
              “Both” keeps the disagreement visible. It does not decide which source is correct or
              turn votes into a truth probability.
            </p>
          </div>
        </div>
      </section>
      <section className="section">
        <h2>3. Compress context without dropping dependencies</h2>
        <div className="two-columns">
          <div>
            <div className="number-row">
              <label>Context budget</label>
              <output>{wordBudget} whitespace words</output>
            </div>
            <Slider
              aria-label="Context word budget"
              min={10}
              max={100}
              step={1}
              value={[wordBudget]}
              onValueChange={([v]) => setWordBudget(v)}
            />
            <label className="check-row">
              <Checkbox checked={missing} onCheckedChange={(v) => setMissing(!!v)} />
              Remove a required source
            </label>
            <Equation description="Take the transitive dependency closure of the requested decision. If a source is missing or the entire closure does not fit, do not deliver a truncated claim.">
              C* = closure({'{ decision }'}, requires){'\n'}deliver(C*) ⇔ complete(C*) ∧ words(C*) ≤
              B
            </Equation>
          </div>
          <div>
            <Notice error={context.status !== 'ready'}>
              <strong>{context.status.replace(/_/g, ' ')}</strong> · required{' '}
              {context.requiredUnits} words
              {context.missingIds.length > 0 ? ` · missing ${context.missingIds.join(', ')}` : ''}
            </Notice>
            {context.payload && (
              <pre className="json-view" style={{ marginTop: 14 }}>
                {context.payload}
              </pre>
            )}
            <p className="small-note" style={{ marginTop: 12 }}>
              The unrelated design discussion is omitted. Only declared dependencies are preserved.
              These are word counts, not provider tokens or a measured token-saving claim.
            </p>
          </div>
        </div>
        <JsonView value={context} label="Inspect the dependency closure" />
      </section>
      <section className="section">
        <h2>4. Graph frequencies and diffusion</h2>
        <div className="fields">
          <Choice
            label="Graph topology"
            value={graphKind}
            onChange={setGraphKind}
            options={[
              { value: 'path', label: 'Three-node path' },
              { value: 'triangle', label: 'Three-node triangle' },
            ]}
          />
          <div className="field">
            <div className="number-row">
              <label>Diffusion time</label>
              <output>{diffusionTime.toFixed(1)}</output>
            </div>
            <Slider
              aria-label="Graph diffusion time"
              value={[diffusionTime]}
              onValueChange={([v]) => setDiffusionTime(v)}
              min={0}
              max={5}
              step={0.1}
            />
          </div>
        </div>
        <div className="two-columns">
          <div>
            <svg
              className="chart"
              viewBox="0 0 540 180"
              role="img"
              aria-label="Three node graph with calculated diffusion values"
            >
              <path d="M70 90L270 90L470 90" stroke="#a6b7d1" strokeWidth="2" fill="none" />
              {graphKind === 'triangle' && (
                <path d="M70 90Q270 -20 470 90" stroke="#a6b7d1" strokeWidth="2" fill="none" />
              )}
              {diffusion.diffusedSignal.map((v, i) => (
                <g key={i}>
                  <circle
                    cx={70 + i * 200}
                    cy={90}
                    r={28}
                    fill={`rgba(36,87,220,${0.1 + 0.8 * v})`}
                    stroke="#2457dc"
                  />
                  <text
                    x={70 + i * 200}
                    y={96}
                    textAnchor="middle"
                    fill={v > 0.5 ? 'white' : '#17212b'}
                    fontSize="15"
                  >
                    {i + 1}
                  </text>
                  <text x={70 + i * 200} y={148} textAnchor="middle" fontSize="15" fill="#17212b">
                    {v.toFixed(4)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <DataTable
            heads={['Invariant', 'Computed result']}
            rows={[
              ['Laplacian eigenvalues', graph.eigenvalues.map((v) => v.toFixed(3)).join(', ')],
              [
                'Signal sum',
                `${diffusion.sumBefore.toFixed(4)} → ${diffusion.sumAfter.toFixed(4)}`,
              ],
              [
                'Dirichlet energy',
                `${diffusion.energyBefore.toFixed(5)} → ${diffusion.energyAfter.toFixed(5)}`,
              ],
              ['Eigen residual', graph.maxEigenResidual.toExponential(2)],
            ]}
          />
        </div>
        <Equation description="This standard heat operator spreads an initial [1,0,0] signal across an undirected graph. Eigenvalues are graph modes, not acoustic hertz. Diffusion does not establish semantic truth, and directed meaning edges are not silently made symmetric.">
          L = D − A · Lφₖ = λₖφₖ{'\n'}h(t) = exp(−tL)h(0)
        </Equation>
      </section>
      <section className="section">
        <h2>5. The architecture we can test</h2>
        <Equation description="Research objective, not an implemented joint training loss: balance outcome error, semantic distortion, resource cost and unsupported claims. Each coefficient and metric needs an independent evaluation design before optimization.">
          J(θ) = L_outcome + λ₁ L_semantics + λ₂ Cost + λ₃ Unsupported
        </Equation>
        <DataTable
          heads={['Layer', 'Working now', 'Research still needed']}
          rows={[
            [
              'Meaning',
              'Supervised lexical intersection and reusable surface templates',
              'Broader ontology, morphology, multilingual human annotation',
            ],
            [
              'Planning',
              'Bounded finite-state search and explicit tool orchestration',
              'Learned dynamics and long-horizon calibration',
            ],
            [
              'Learning',
              'Candidate versions and development regression gate',
              'Independent continual-learning studies and forgetting controls',
            ],
            [
              'Sound',
              'Invertible complex transforms and magnitude counterexamples',
              'Controlled speech datasets; no universal root law assumed',
            ],
            [
              'Provider',
              'OpenAI-compatible chat, code workspace and bounded local tool loop',
              'Provider-specific adapters, production persistence and distributed execution',
            ],
          ]}
        />
        <div className="actions">
          <Button
            variant="outline"
            onClick={() =>
              downloadJson(
                { transition: estimate, evidence, context, graph, diffusion },
                'hikmah-math-experiment.json',
              )
            }
          >
            Export this experiment
          </Button>
        </div>
      </section>
      <details className="disclosure">
        <summary>Research, deeper derivations and reproducible methods</summary>
        <ul className="source-list">
          <li>
            <a href="/research/architecture-refinement.md" target="_blank">
              Refined architecture: algorithms, authority, learning and evaluation
            </a>
          </li>
          <li>
            <a href="/research/architecture.md" target="_blank">
              Full trainable architecture research
            </a>
          </li>
          <li>
            <a href="/research/meaning-mathematics.md" target="_blank">
              Meaning induction: derivations and invariants
            </a>
          </li>
          <li>
            <a href="/research/agent-mathematics.md" target="_blank">
              Planning, outcome learning and context mathematics
            </a>
          </li>
          <li>
            <a href="/research/sound-mathematics.md" target="_blank">
              Sound and graph numerical methods
            </a>
          </li>
          <li>
            <a href="https://corpus.quran.com/documentation/" target="_blank" rel="noreferrer">
              Quranic Arabic Corpus: annotation documentation
            </a>
          </li>
          <li>
            <a
              href="https://pmc.ncbi.nlm.nih.gov/articles/PMC5047153/"
              target="_blank"
              rel="noreferrer"
            >
              Blasi et al.: sound–meaning associations across languages
            </a>
          </li>
          <li>
            <a
              href="https://openrouter.ai/docs/api/reference/streaming"
              target="_blank"
              rel="noreferrer"
            >
              OpenRouter: streaming protocol
            </a>
          </li>
        </ul>
        <p className="small-note">
          This playground is an implemented research combination. It does not establish AGI,
          human-equivalent cognition, universal derivation from Quranic Arabic, or a new
          foundational mathematical method. The full literature report separates evidence from
          proposals.
        </p>
      </details>
    </>
  );
}
