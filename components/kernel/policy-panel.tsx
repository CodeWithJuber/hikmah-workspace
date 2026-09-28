'use client';

import { useEffect, useState } from 'react';
import { ARMS } from '@/lib/workflow/arms';
import { clientFetch } from '@/lib/client/request';

type RewardBreakdown = { total: number; quality: number; cost: number; latency: number };
type ArmScore = { arm: string; score: number; isFallback: boolean };
type PolicyData = {
  version: number;
  arms: Record<string, { aDiag: number[]; b: number[] }>;
  recentUpdates: {
    feedbackId: string;
    arm: string;
    reward: RewardBreakdown | null;
    createdAt: string;
  }[];
  recentPropensities: {
    id: number;
    runId: string;
    arm: string;
    propensity: number;
    featureVersion: number;
    scores: ArmScore[];
    createdAt: string;
  }[];
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** The A_a diagonal as ten vertical bars. The prior is λ=1 on the diagonal,
 * so 1.0 means "no updates yet" and anything above is observed feedback. */
function DiagBars({ values }: { values: number[] }) {
  const max = Math.max(1.2, ...values);
  return (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 44 }}
      role="img"
      aria-label={`A diagonal: ${values.map((v) => v.toFixed(2)).join(', ')}`}
    >
      {values.map((v, i) => (
        <div
          key={i}
          title={`x${i + 1}: ${v.toFixed(3)}`}
          style={{
            flex: '1 1 0',
            height: `${Math.max(4, (v / max) * 100)}%`,
            borderRadius: 2,
            background: v > 1.001 ? 'var(--primary, currentColor)' : 'currentColor',
            opacity: v > 1.001 ? 0.85 : 0.25,
          }}
        />
      ))}
    </div>
  );
}

function UpdatesFeed({ updates }: { updates: PolicyData['recentUpdates'] }) {
  if (!updates.length)
    return (
      <p>
        No feedback recorded yet — the policy is on its fallback prior, which selects exactly what
        today&apos;s pipeline would do.
      </p>
    );
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {updates.map((u) => (
        <li
          key={u.feedbackId}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 12px',
            alignItems: 'baseline',
            fontSize: 13,
          }}
        >
          <strong style={{ minWidth: 110 }}>{u.arm}</strong>
          {u.reward ? (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              r={u.reward.total.toFixed(3)}
              <span style={{ opacity: 0.6 }}>
                {' '}
                (q {u.reward.quality.toFixed(2)} − c {u.reward.cost.toFixed(2)} − t{' '}
                {u.reward.latency.toFixed(2)})
              </span>
            </span>
          ) : (
            <span style={{ opacity: 0.6 }}>no rating recorded — not counted</span>
          )}
          <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 12 }}>
            {when(u.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PropensityFeed({ rows }: { rows: PolicyData['recentPropensities'] }) {
  if (!rows.length)
    return (
      <p>No selections logged yet. Every policy choice is recorded here with the scores it saw.</p>
    );
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {rows.map((r) => {
        const scores = Array.isArray(r.scores) ? r.scores : [];
        const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 2);
        return (
          <li key={r.id} style={{ fontSize: 13 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px 12px',
                alignItems: 'baseline',
              }}
            >
              <code style={{ opacity: 0.7 }}>{r.runId.slice(0, 12)}…</code>
              <strong>{r.arm}</strong>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                p={r.propensity.toFixed(2)} · v{r.featureVersion}
              </span>
              <span style={{ opacity: 0.65, fontVariantNumeric: 'tabular-nums' }}>
                {top
                  .map((s) => `${s.arm} ${s.score.toFixed(3)}${s.isFallback ? '*' : ''}`)
                  .join(' · ')}
              </span>
              <span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 12 }}>
                {when(r.createdAt)}
              </span>
            </div>
            {top.some((s) => s.isFallback) && (
              <div style={{ opacity: 0.55, fontSize: 12 }}>
                * fallback prior — the arm had no learned weights yet
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Superadmin inspection view for the v5 workflow policy (§3.8). Owner only.
 *
 * Shows what the policy has actually learned — per-arm A_a diagonals, the
 * feedback it was updated on, and the propensity log of what it chose and why.
 * Scores are labelled as the model's judgment throughout, never P(correct).
 */
export function PolicyPanel() {
  const [data, setData] = useState<PolicyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the retry button; the effect below re-runs on each bump.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await clientFetch('/api/superadmin/policy', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as PolicyData;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load the policy.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (error)
    return (
      <div className="kernel-card" role="alert">
        <h2>Workflow policy</h2>
        <p>Could not load the policy state ({error}).</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </button>
      </div>
    );

  if (!data)
    return (
      <div className="kernel-card">
        <h2>Workflow policy</h2>
        <p>Loading the policy state…</p>
      </div>
    );

  const armNames = ARMS.filter((a) => data.arms[a]);

  return (
    <div>
      <div className="kernel-section-intro">
        <h2>Workflow policy</h2>
        <p>
          Which arm each run takes, chosen by a LinUCB policy (feature v{data.version}). Scores are
          the model&apos;s judgment about how to work — never the probability the answer is right.
          Missing ratings are never counted as successes.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          marginBottom: 8,
        }}
      >
        {armNames.map((arm) => (
          <div className="kernel-card" key={arm} style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>{arm}</h2>
            <DiagBars values={data.arms[arm].aDiag} />
            <p style={{ fontSize: 12, margin: '8px 0 0' }}>
              A<sub>a</sub> diagonal · 1.0 is the prior (no updates yet); above 1.0 is observed
              feedback.
            </p>
            <details style={{ fontSize: 12, marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', opacity: 0.7 }}>b vector</summary>
              <code className="kernel-json" style={{ marginTop: 6, fontSize: 11 }}>
                [{data.arms[arm].b.map((v) => v.toFixed(3)).join(', ')}]
              </code>
            </details>
          </div>
        ))}
      </div>

      <div className="kernel-card">
        <h2>Recent feedback</h2>
        <p>
          What the policy was updated on. A row with no rating consumes its id but changes nothing —
          unrated runs are not counted as good or bad.
        </p>
        <UpdatesFeed updates={data.recentUpdates} />
      </div>

      <div className="kernel-card">
        <h2>Selection log</h2>
        <p>
          Every policy choice, with the scores it saw and the probability it acted on. Replays the
          audit trail; nothing here is a claim about answer quality.
        </p>
        <PropensityFeed rows={data.recentPropensities} />
      </div>
    </div>
  );
}
