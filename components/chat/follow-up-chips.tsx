'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export type FollowUpChipsProps = {
  /** Plain-language follow-ups the product proposes after an answer.
   * At most four are shown. */
  suggestions: string[];
  /** Fills the composer with the suggestion; never sends it. */
  onSelect: (suggestion: string) => void;
  /** While the next set of suggestions is being worked out. */
  loading?: boolean;
};

/**
 * Follow-up chips at the end of an assistant answer: navigation aids
 * disguised as suggestions, keeping the conversation alive. Selecting one
 * fills the composer as an editable draft — the user stays in control and
 * learns what the product can do, turn by turn.
 *
 * The chips wrap to multiple lines (the shared .n-chip-row pattern, with a
 * wrap override in chat-experience.css): on a 390px phone the horizontal
 * scroll row left the last chip half-cut with no scroll affordance, reading
 * as broken. Wrapped chips flow to the next line, so nothing is ever cut
 * off. shrink-0 keeps every chip at its natural width; the transcript's
 * min-width:0 chain keeps the "Keep going" label from clipping at the
 * message's overflow edge.
 */
export function FollowUpChips({ suggestions, onSelect, loading = false }: FollowUpChipsProps) {
  if (loading) {
    return (
      <div
        data-slot="follow-up-chips"
        className="n-chip-row items-center"
        role="group"
        aria-label="Follow-up ideas"
      >
        <Skeleton className="h-10 w-32 shrink-0 rounded-full" />
        <Skeleton className="h-10 w-40 shrink-0 rounded-full" />
      </div>
    );
  }
  const shown = suggestions.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div
      data-slot="follow-up-chips"
      className="n-chip-row items-center"
      role="group"
      aria-label="Follow-up ideas"
    >
      <span className="shrink-0 text-xs text-muted-foreground">Keep going</span>
      {/* Text-only chips: an icon on every chip was visual noise next to the
          label, and Perplexity's follow-ups read as plain text suggestions.
          h-10 keeps them thumb-sized. */}
      {shown.map((suggestion) => (
        <Button
          key={suggestion}
          type="button"
          variant="outline"
          size="sm"
          className="h-10 shrink-0 rounded-full px-4"
          onClick={() => onSelect(suggestion)}
        >
          {suggestion}
        </Button>
      ))}
    </div>
  );
}
