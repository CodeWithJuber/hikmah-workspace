'use client';

import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SendStopState = 'idle' | 'sending' | 'streaming';

export type SendStopButtonProps = {
  state: SendStopState;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  className?: string;
};

const LABEL: Record<SendStopState, string> = {
  idle: 'Send message',
  sending: 'Sending message',
  streaming: 'Stop response',
};

/**
 * Send → stop morph. One button stays mounted across the whole composer
 * state machine — only the glyph, label and handler change, so the action
 * feels continuous instead of blinking out and back in.
 */
export function SendStopButton({
  state,
  onSend,
  onStop,
  disabled = false,
  className,
}: SendStopButtonProps) {
  const streaming = state === 'streaming';
  const sending = state === 'sending';
  return (
    <Button
      type="button"
      size="icon"
      variant={streaming ? 'outline' : 'default'}
      disabled={disabled || sending}
      // In a form the parent's Enter-to-send still goes through its own
      // submit path; this button is the single click target for both
      // actions so the glyph can morph without remounting.
      onClick={streaming ? onStop : onSend}
      aria-label={LABEL[state]}
      title={LABEL[state]}
      className={cn(
        'transition-transform duration-150 motion-safe:active:scale-90',
        streaming && 'motion-safe:animate-pulse',
        className,
      )}
    >
      {sending ? (
        <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
      ) : streaming ? (
        <Square size={16} aria-hidden="true" />
      ) : (
        <ArrowUp size={20} aria-hidden="true" />
      )}
      <span className="sr-only">{LABEL[state]}</span>
    </Button>
  );
}
