'use client';
/** The growth story: how the workspace is learning, visually.
 *
 * Not a log and not a game — no streaks, no badges. Four honest weeks of what
 * the person actually taught it: saved memories and reviewed examples. The
 * copy never says the model learns; the workspace does, and the panel names
 * the mechanism (reviewed examples, saved memories) rather than hiding it.
 */
import Link from 'next/link';
import { Sprout } from 'lucide-react';
import type { Memory } from '@/lib/memory/store';
import type { LearningExample } from '@/lib/learning/types';
import { Skeleton } from '@/components/ui/skeleton';

const WEEKS = 4;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const count = (value: number) => new Intl.NumberFormat('en-US').format(value);

function weekBuckets(dates: (string | null | undefined)[]): number[] {
  const now = Date.now();
  const buckets = new Array<number>(WEEKS).fill(0);
  for (const date of dates) {
    if (!date) continue;
    const time = new Date(date).getTime();
    if (!Number.isFinite(time) || time > now) continue;
    const index = Math.floor((now - time) / WEEK_MS);
    if (index < WEEKS) buckets[index] += 1;
  }
  return buckets;
}

const weekLabel = (index: number) =>
  index === 0 ? 'This week' : index === 1 ? 'Last week' : `${index} weeks ago`;

export function LearningStrip({
  memories,
  examples,
  loading,
}: {
  /** All saved memories, or null while loading. */
  memories: Memory[] | null;
  /** Approved learning examples (any status is tolerated; only approved count). */
  examples: LearningExample[] | null;
  loading: boolean;
}) {
  const memoryBuckets = weekBuckets((memories ?? []).map((memory) => memory.createdAt));
  const exampleBuckets = weekBuckets(
    (examples ?? [])
      .filter((example) => example.status === 'approved')
      .map((example) => example.createdAt),
  );
  const recentMemories = memoryBuckets[0];
  const recentExamples = exampleBuckets[0];
  const max = Math.max(1, ...memoryBuckets, ...exampleBuckets);
  const barHeight = (value: number) =>
    `${Math.max(value > 0 ? 12 : 4, Math.round((value / max) * 72))}px`;

  return (
    <section
      aria-label="How your workspace learns"
      className="mt-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Sprout size={16} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">How your workspace learns</h3>
          <p className="text-xs text-muted-foreground">
            Saved memories and reviewed examples — visible, editable, and yours. This changes what
            the model is told, never the model&apos;s weights.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 flex items-end gap-3" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="w-10" style={{ height: 40 + index * 8 }} />
          ))}
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-foreground">
            {recentMemories === 0 && recentExamples === 0 ? (
              <>
                Nothing new in the last 7 days —{' '}
                <span className="text-muted-foreground">
                  {count((memories ?? []).length)} memories saved in total.
                </span>
              </>
            ) : (
              <>
                In the last 7 days your workspace{' '}
                {recentExamples > 0 && (
                  <>
                    learned <strong>{count(recentExamples)}</strong>{' '}
                    {recentExamples === 1 ? 'reviewed example' : 'reviewed examples'}
                  </>
                )}
                {recentExamples > 0 && recentMemories > 0 && ' and '}
                {recentMemories > 0 && (
                  <>
                    saved <strong>{count(recentMemories)}</strong>{' '}
                    {recentMemories === 1 ? 'memory' : 'memories'}
                  </>
                )}
                .
              </>
            )}
          </p>
          <div
            className="mt-3 flex items-end gap-4"
            role="img"
            aria-label="Learning activity by week"
          >
            {memoryBuckets.map((value, index) => (
              <div key={index} className="flex flex-col items-center gap-1.5">
                <div className="flex h-[72px] items-end gap-1">
                  <div
                    className="w-5 rounded-sm bg-primary"
                    style={{ height: barHeight(value) }}
                    title={`${count(value)} memories saved ${weekLabel(index).toLowerCase()}`}
                  />
                  <div
                    className="w-5 rounded-sm bg-primary/30"
                    style={{ height: barHeight(exampleBuckets[index]) }}
                    title={`${count(exampleBuckets[index])} examples reviewed ${weekLabel(index).toLowerCase()}`}
                  />
                </div>
                <span className="text-[11px] text-muted-foreground">{weekLabel(index)}</span>
              </div>
            ))}
            <div className="ml-2 flex flex-col gap-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm bg-primary" aria-hidden="true" />
                Memories saved
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-sm bg-primary/30"
                  aria-hidden="true"
                />
                Examples reviewed
              </span>
            </div>
          </div>
        </>
      )}

      <div className="mt-3 flex gap-4 text-xs">
        <Link
          href="/learning"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Open Learning
        </Link>
        <Link
          href="/knowledge"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Open Memory
        </Link>
      </div>
    </section>
  );
}
