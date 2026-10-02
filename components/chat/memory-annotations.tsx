'use client';
/** Inline proof that the person's memory worked — under the answer that used it.
 *
 * The run streams a `data-memories` part naming every memory the prompt drew
 * on (lib/runs/service.ts). This reads that part and renders one small, warm
 * line per memory — "Used your preference: concise summaries" — a button that
 * jumps to the memory row. Non-technical copy, zero confusion: the person sees
 * *their* context doing its job.
 *
 * When a used memory was taught or corrected recently, `describeAha` (from
 * ./aha-moment) earns the bigger moment instead; this keeps the quiet line for
 * ordinary reuse.
 */
import { useMemo } from 'react';
import { Bookmark } from 'lucide-react';
import { AhaMoment, describeAha, type AhaMemory } from './aha-moment';

/** One memory the run's prompt drew on, as streamed in `data-memories`. */
export type UsedMemory = {
  id: string;
  title: string;
  kind: 'preference' | 'reference';
};

/** What the annotation needs from the person's store row to earn the aha.
 * A structural type on purpose: the caller passes what it has, and this
 * never reaches for the store itself. */
export type MemoryForAha = AhaMemory;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Whole calendar days between two dates, in the local timezone. NaN on
 * an unreadable `when`, so callers can fall back honestly. */
export function dayDiff(when: string, now: Date = new Date()): number {
  const then = new Date(when);
  if (Number.isNaN(then.getTime())) return Number.NaN;
  return Math.round((startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000);
}

/** A human word for a past timestamp, for the memory rows: "today",
 * "yesterday", "last Tuesday", or a short date for anything older. Never
 * claims precision a date cannot give. */
export function dayWord(when: string, now: Date = new Date()): string {
  const diff = dayDiff(when, now);
  if (Number.isNaN(diff)) return 'recently';
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return 'last ' + new Date(when).toLocaleDateString('en-US', { weekday: 'long' });
  return new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Like dayWord, but null past the recency window (and for the future):
 * the callers that need a moment, not a row label. */
export function recentDayLabel(
  when: string,
  now: Date = new Date(),
  maxDays: number = 7,
): string | null {
  const diff = dayDiff(when, now);
  if (Number.isNaN(diff) || diff < 0 || diff >= maxDays) return null;
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return 'last ' + new Date(when).toLocaleDateString('en-US', { weekday: 'long' });
}

/** The growth story the panel header shows: total memories and how many were
 * used in the last seven days — progress the person can feel, counted from
 * `lastUsedAt`, never invented. */
export function growthStory(
  memories: { lastUsedAt: string | null }[],
  now: Date = new Date(),
): { total: number; usedThisWeek: number } {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  let usedThisWeek = 0;
  for (const memory of memories) {
    if (!memory.lastUsedAt) continue;
    const at = new Date(memory.lastUsedAt).getTime();
    // Strictly inside the window: exactly-seven-days-ago is last week, not this one.
    if (!Number.isNaN(at) && at > weekAgo && at <= now.getTime()) usedThisWeek += 1;
  }
  return { total: memories.length, usedThisWeek };
}

/** The memories an answer drew on, defensively read.
 *
 * `data-memories` arrives from the server, and the parts array is typed loose
 * on the client — so a part with no data, a `used` that is not an array, or
 * entries missing id/title are all skipped rather than rendered half-empty.
 */
export function extractUsedMemories(message: { parts?: unknown }): UsedMemory[] {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const part = parts.find(
    (candidate): candidate is { data?: unknown } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === 'data-memories',
  );
  const data = part && typeof part.data === 'object' && part.data !== null ? part.data : null;
  const used = data && (data as { used?: unknown }).used;
  if (!Array.isArray(used)) return [];
  const clean: UsedMemory[] = [];
  for (const entry of used) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title, kind } = entry as { id?: unknown; title?: unknown; kind?: unknown };
    if (typeof id !== 'string' || !id || typeof title !== 'string' || !title) continue;
    clean.push({ id, title, kind: kind === 'preference' ? 'preference' : 'reference' });
  }
  return clean;
}

const copyFor = (memory: UsedMemory) =>
  memory.kind === 'preference'
    ? `Used your preference: ${memory.title}`
    : `Used what you saved: ${memory.title}`;

export function MemoryAnnotations({
  message,
  memoryById,
  onJump,
  now,
}: {
  /** The assistant message, read for its `data-memories` part. */
  message: { parts?: unknown };
  /** The person's memory rows, for aha detection. Missing rows are fine —
   * those memories simply get the quiet line. */
  memoryById?: Map<string, MemoryForAha>;
  /** One-click jump to the memory row (opens the Memory tab / screen). */
  onJump?: (memoryId: string) => void;
  /** "Now" for the recency check; defaults to the current time (tests pin it). */
  now?: Date;
}) {
  const used = useMemo(() => extractUsedMemories(message), [message]);
  if (used.length === 0) return null;
  return (
    <div className="flex flex-col items-start gap-1" aria-label="Memories this answer used">
      {used.map((memory) => {
        const row = memoryById?.get(memory.id);
        const aha = row ? describeAha(row, now) : null;
        if (aha)
          return (
            <AhaMoment
              key={memory.id}
              sourceLabel={aha.sourceLabel}
              detail={aha.detail}
              onJump={onJump ? () => onJump(memory.id) : undefined}
            />
          );
        return (
          <button
            key={memory.id}
            type="button"
            className="inline-flex max-w-full items-center gap-1.5 truncate rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-primary"
            onClick={onJump ? () => onJump(memory.id) : undefined}
            title={onJump ? 'See this memory' : copyFor(memory)}
          >
            <Bookmark size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{copyFor(memory)}</span>
          </button>
        );
      })}
    </div>
  );
}
