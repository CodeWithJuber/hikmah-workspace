'use client';

import { Check } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export type PipelineStep = {
  id: string;
  /** The plain-language name of the stage, shown while the run works. */
  label: string;
};

/**
 * The richer pipeline, narrated. ChatGPT shows a dead spinner; this names
 * the stages so every second feels like the product doing something real —
 * and it is differentiation: our memory + tools pipeline is the thing being
 * narrated, which theirs cannot copy.
 */
export const HIKMAH_PIPELINE_STEPS: PipelineStep[] = [
  { id: 'memory', label: 'Consulting your memory' },
  { id: 'tools', label: 'Checking tools' },
  { id: 'planning', label: 'Planning the answer' },
  { id: 'writing', label: 'Writing the answer' },
];

export type StagedLoadingProps = {
  /** The pipeline stages in order. */
  steps?: PipelineStep[];
  /** Index of the stage currently running. Stages before it read as done. */
  currentIndex?: number;
  /** Elapsed whole seconds, when the caller tracks it. After ~20s the copy
   * switches to a longer-work note instead of pretending this is quick. */
  elapsedSeconds?: number;
  /** The stage list starts expanded. Useful where the pipeline is the point —
   * the differentiation story only lands if the user sees the stages. */
  defaultExpanded?: boolean;
  className?: string;
};

export function StagedLoading({
  steps = HIKMAH_PIPELINE_STEPS,
  currentIndex = 0,
  elapsedSeconds,
  defaultExpanded = false,
  className,
}: StagedLoadingProps) {
  const current = steps[Math.min(Math.max(currentIndex, 0), steps.length - 1)];
  if (steps.length === 0) return null;
  const longRun = (elapsedSeconds ?? 0) >= 20;
  return (
    <div data-slot="staged-loading" role="status" className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" aria-hidden="true" />
        <span aria-live="polite">
          {longRun ? 'Still working — some answers take a moment.' : current.label}
          <span aria-hidden="true" className="motion-safe:animate-pulse">
            …
          </span>
        </span>
      </div>
      <Collapsible defaultOpen={defaultExpanded}>
        <CollapsibleTrigger className="w-fit text-xs text-muted-foreground underline-offset-4 hover:underline">
          What it is doing
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="mt-1 flex flex-col gap-1">
            {steps.map((step, index) => {
              const done = index < currentIndex;
              const active = index === currentIndex;
              return (
                <li
                  key={step.id}
                  className={cn(
                    'flex items-center gap-2 text-xs',
                    done && 'text-muted-foreground',
                    active && 'font-medium text-foreground',
                    !done && !active && 'text-muted-foreground/70',
                  )}
                >
                  {done ? (
                    <Check size={16} className="text-primary" aria-hidden="true" />
                  ) : active ? (
                    <Spinner className="size-4" aria-hidden="true" />
                  ) : (
                    <span className="size-4 rounded-full border border-border" aria-hidden="true" />
                  )}
                  <span>
                    {step.label}
                    {active ? <span className="sr-only"> (in progress)</span> : null}
                    {done ? <span className="sr-only"> (done)</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
