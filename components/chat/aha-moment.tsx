'use client';
/** The "maza aaye" moment: a learned rule or memory fired and changed an
 * answer, so the answer says so — warmly, once, in one line.
 *
 * This is not a badge and not a log line. It is the product gravity pattern
 * (#10): memory the person can see working, in the exact turn where it paid
 * off. Dignified delight only — no streaks, no confetti, no gamification.
 *
 * Aha-worthy is decided by the caller via `describeAha` below: only a memory
 * the person taught or corrected *recently* qualifies, so this line stays rare
 * enough to mean something.
 */
import { Sparkles } from 'lucide-react';
import { recentDayLabel } from './memory-annotations';

export type AhaMemory = {
  /** The memory's title, shown as what changed the answer. */
  title: string;
  /** ISO timestamp the memory was created. */
  createdAt: string;
  /** ISO timestamp the memory was last updated (a correction). */
  updatedAt: string;
};

/** How recently a memory must have been taught or corrected to earn an aha.
 * Older than this, the memory showing up in an answer is just plumbing. */
const AHA_RECENCY_DAYS = 7;

/** When a used memory qualifies for the aha moment, and what it should say.
 *
 * `updatedAt > createdAt` means the person corrected an existing memory —
 * "your correction from last Tuesday just paid off". A fresh memory is
 * something the person taught — "what you taught me last Tuesday is already
 * helping". Both name the memory, so the line is about *their* teaching, not
 * about the machine.
 *
 * Returns null when the memory is older than the recency window: nothing to
 * celebrate, and the caller falls back to the plain annotation line.
 */
export function describeAha(
  memory: AhaMemory,
  now: Date = new Date(),
): { sourceLabel: string; detail: string } | null {
  const label = recentDayLabel(memory.updatedAt, now, AHA_RECENCY_DAYS);
  if (!label) return null;
  const corrected = memory.updatedAt > memory.createdAt;
  return corrected
    ? {
        sourceLabel: `Your correction from ${label} just paid off`,
        detail: memory.title,
      }
    : {
        sourceLabel: `What you taught me ${label} is already helping`,
        detail: memory.title,
      };
}

const frame =
  'inline-flex max-w-full items-start gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2 py-1 text-xs leading-snug';

export function AhaMoment({
  sourceLabel,
  detail,
  onJump,
}: {
  /** The delight line, e.g. "Your correction from last Tuesday just paid off". */
  sourceLabel: string;
  /** What changed, e.g. the memory's title. */
  detail: string;
  /** Optional: jump to the memory behind this. When absent, a plain line. */
  onJump?: () => void;
}) {
  const inner = (
    <>
      <Sparkles size={14} aria-hidden className="mt-px shrink-0 text-primary" />
      <span>
        <strong className="font-medium text-foreground">{sourceLabel}</strong>
        {detail ? <span className="text-muted-foreground"> — {detail}</span> : null}
      </span>
    </>
  );
  if (!onJump) {
    return (
      <p className={frame} role="note">
        {inner}
      </p>
    );
  }
  return (
    <button
      type="button"
      className={frame + ' cursor-pointer transition-colors hover:border-primary/40'}
      onClick={onJump}
      title="See the memory behind this"
    >
      {inner}
    </button>
  );
}
