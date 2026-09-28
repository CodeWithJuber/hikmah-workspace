'use client';

import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FeedbackValue } from '@/lib/chat/feedback-store';

/**
 * Thumbs up/down for one message (report §1.7).
 *
 * Props:
 * - messageId: the message being rated (for the parent's PUT/GET wiring).
 * - value: the current rating, 'up' | 'down' | null — the parent reads this
 *   from GET /api/conversations/[id]/messages/[messageId]/feedback and
 *   writes it with PUT {value} (null clears).
 * - onRate(value): called with the NEW value. Clicking the active thumb
 *   sends null (toggle off), clicking the other sends its value.
 * - disabled: while a rating is in flight or the message is streaming.
 *
 * Mount in the message row's action bar (hover-revealed like copy/regenerate
 * in report §2.3). The active thumb wears evergreen (accent); the tooltips
 * say what each does.
 */
export function FeedbackButtons({
  messageId,
  value,
  onRate,
  disabled = false,
}: {
  messageId: string;
  value: FeedbackValue | null;
  onRate: (value: FeedbackValue | null) => void;
  disabled?: boolean;
}) {
  const buttons = [
    { v: 'up' as const, label: 'Good response', Icon: ThumbsUp },
    { v: 'down' as const, label: 'Bad response', Icon: ThumbsDown },
  ];
  return (
    <div
      className="flex items-center gap-0.5"
      role="group"
      aria-label={`Rate message ${messageId}`}
    >
      {buttons.map(({ v, label, Icon }) => {
        const active = value === v;
        return (
          <Tooltip key={v}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                onClick={() => onRate(active ? null : v)}
                aria-label={label}
                aria-pressed={active}
                className={cn('size-7', active && 'text-accent hover:text-accent')}
              >
                <Icon className={cn('size-4', active && 'fill-current')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
