'use client';

import { useMemo } from 'react';
import { Progress } from '@/components/ui/progress';
import { CHARS_PER_TOKEN } from '@/lib/ai/context';
import { cn } from '@/lib/utils';

type TextPart = { type?: string; text?: string };

/** Characters of user-visible prose in one message's parts. Tool calls,
 * tool results and attachments are skipped: they travel to the model in
 * other envelopes and are not the "messages" the estimate promises. */
function messageChars(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  return (parts as TextPart[])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .reduce((n, p) => n + (p.text as string).length, 0);
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * An always-visible estimate of context use, for the composer footer
 * (report §2.2: the context usage gauge sits near the input).
 *
 * This is the estimate variant. chat-view.tsx already renders the precise
 * variant — the ai-elements <Context> meter fed by the run's real usage —
 * but deliberately only once the window is actually filling up (>60% of
 * the model window), to keep a diagnostic off the row the send button
 * needs. This component is the complement: a cheap, always-on estimate of
 * the CURRENT messages against the model window, so the person sees the
 * window filling before the run's own meter would appear.
 *
 * Props:
 * - messages: the conversation's messages as {parts} — text parts only
 *   are counted, at CHARS_PER_TOKEN from lib/ai/context.ts (the same
 *   deliberate undercount the budget uses for Arabic/Urdu/Hindi).
 * - contextWindow: the model's token window; the parent already has this
 *   from the run/model (falls back the same way chat-view does).
 *
 * Renders a compact meter: a progress bar and "12.4k / 128k". This is an
 * estimate, not the run's measured usage — the label says so.
 */
export function ContextEstimate({
  messages,
  contextWindow,
  className,
}: {
  messages: { parts: unknown }[];
  contextWindow: number;
  className?: string;
}) {
  const { tokens, window } = useMemo(() => {
    const chars = messages.reduce((n, m) => n + messageChars(m.parts), 0);
    return { tokens: chars / CHARS_PER_TOKEN, window: contextWindow };
  }, [messages, contextWindow]);

  if (!Number.isFinite(window) || window <= 0) return null;
  const pct = Math.min(100, Math.max(0, (tokens / window) * 100));

  return (
    <div
      className={cn('flex w-full max-w-44 items-center gap-2', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={window}
      aria-valuenow={Math.round(tokens)}
      aria-label={`Estimated context use: ${compact(tokens)} of ${compact(window)} tokens`}
      title="Estimate from the messages' text, not the run's measured usage"
    >
      <Progress value={pct} className="h-1.5" aria-hidden="true" />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {compact(tokens)} / {compact(window)}
      </span>
    </div>
  );
}
