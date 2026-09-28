'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Message branching UI, LibreChat-style. Pure presentational and props-driven:
 * the parent owns the branch state and the API calls, these components only
 * render and report intent.
 */

type SiblingSwitcherProps = {
  /** Zero-based index of the visible branch. */
  index: number;
  /** Number of branches in the sibling group. */
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

/** The "‹ 1/3 ›" branch switcher shown under a message with siblings. */
export function SiblingSwitcher({ index, total, onPrev, onNext }: SiblingSwitcherProps) {
  if (total < 2) return null;
  const button =
    'rounded p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-30';
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Message branches">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={button}
            onClick={onPrev}
            disabled={index <= 0}
            aria-label="Previous branch"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Previous branch</TooltipContent>
      </Tooltip>
      <span
        className="min-w-8 text-center text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {index + 1}/{total}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={button}
            onClick={onNext}
            disabled={index >= total - 1}
            aria-label="Next branch"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Next branch</TooltipContent>
      </Tooltip>
    </div>
  );
}
