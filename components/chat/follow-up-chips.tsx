'use client';

import { MessageCirclePlus } from 'lucide-react';
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
 */
export function FollowUpChips({ suggestions, onSelect, loading = false }: FollowUpChipsProps) {
  if (loading) {
    return (
      <div
        data-slot="follow-up-chips"
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Follow-up ideas"
      >
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-8 w-40 rounded-full" />
      </div>
    );
  }
  const shown = suggestions.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div
      data-slot="follow-up-chips"
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Follow-up ideas"
    >
      <span className="text-xs text-muted-foreground">Keep going</span>
      {shown.map((suggestion) => (
        <Button
          key={suggestion}
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => onSelect(suggestion)}
        >
          <MessageCirclePlus size={16} aria-hidden="true" />
          {suggestion}
        </Button>
      ))}
    </div>
  );
}
