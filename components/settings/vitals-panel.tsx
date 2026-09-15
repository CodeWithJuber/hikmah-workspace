'use client';
/** What the site felt like, to the people who used it.
 *
 * The owner's half of the telemetry that components/vitals-reporter.tsx sends.
 * Until this existed, every performance figure about this app came from a
 * throttled Chromium in CI — which can tell you one build is faster than
 * another and can tell you nothing about a real phone on a real network.
 *
 * p75, because that is what Core Web Vitals is defined at and because one
 * twelve-second load on a train would move a mean and inform nobody.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clientFetch } from '@/lib/client/request';

type Summary = {
  route: string;
  metric: string;
  width: 'phone' | 'desktop';
  samples: number;
  p75: number;
  poor: number;
};

/** Google's own thresholds, so "good" here means what it means everywhere. */
const GOOD: Record<string, number> = { LCP: 2500, INP: 200, CLS: 0.1, FCP: 1800, TTFB: 800 };
const format = (metric: string, value: number) =>
  metric === 'CLS' ? value.toFixed(3) : `${Math.round(value)} ms`;

/** Four states, not `data ?? []`.
 *
 * Eight panels in this app caught a failed fetch into an empty array, so a
 * network failure rendered as the EMPTY state — which told an owner with a
 * month of measurements that nothing had ever been measured. */
type State =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rows: Summary[] };

export function VitalsPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // A counter rather than a callback, because the effect owns the fetch — the
  // shape conversation-list.tsx already uses. A `load()` called from the effect
  // body is a synchronous setState inside an effect as far as the compiler can
  // see, whatever the awaits inside it actually do.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => {
    // Safe here and not in the effect: this runs from a click.
    setState({ kind: 'loading' });
    setReloads((n) => n + 1);
  }, []);
  useEffect(() => {
    // Drops a reply that arrives after a newer one has been asked for, so a
    // slow response cannot overwrite a fresher answer.
    let live = true;
    void clientFetch('/api/vitals')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { vitals?: Summary[] };
        if (live) setState({ kind: 'ready', rows: body.vitals ?? [] });
      })
      .catch(() => {
        if (live) setState({ kind: 'error', message: 'Could not load the last seven days.' });
      });
    return () => {
      live = false;
    };
  }, [reloads]);

  return (
    <section className="vitals-panel">
      <h3>
        <Activity size={18} aria-hidden="true" />
        How the site performed
        <Button variant="ghost" size="sm" onClick={reload} aria-label="Reload">
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </h3>
      {state.kind === 'loading' && <p className="small-note">Reading the last seven days…</p>}
      {state.kind === 'error' && (
        <p className="small-note" role="status">
          {state.message}{' '}
          <button type="button" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {state.kind === 'ready' && state.rows.length === 0 && (
        <p className="small-note">
          Nothing measured yet. A row appears here the first time someone opens a page — including
          you, on the next reload.
        </p>
      )}
      {state.kind === 'ready' && state.rows.length > 0 && (
        <div className="vitals-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Metric</th>
                <th scope="col">On</th>
                <th scope="col">p75</th>
                <th scope="col">Visits</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                const good = GOOD[row.metric];
                return (
                  <tr key={`${row.route}-${row.metric}-${row.width}`}>
                    <td>{row.route}</td>
                    <td>{row.metric}</td>
                    <td>{row.width === 'phone' ? 'Phone' : 'Desktop'}</td>
                    <td data-poor={good !== undefined && row.p75 > good ? 'true' : undefined}>
                      {format(row.metric, row.p75)}
                    </td>
                    <td>{row.samples}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine-print">
        Measured in the browser and kept here. No address, no browser name, no session — the page
        template, the number, and whether the window was narrow.
      </p>
    </section>
  );
}
