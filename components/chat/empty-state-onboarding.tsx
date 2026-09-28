'use client';

import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type EmptyStateOnboardingVariant = 'first-run' | 'cleared';

/** One click on a chip fills the composer — it never sends. */
export type EmptyStateOnboardingProps = {
  variant: EmptyStateOnboardingVariant;
  onPick: (prompt: string) => void;
  /** The primary action the empty state offers alongside the chips.
   * Defaults to filling the composer with the hero prompt. */
  onPrimary?: () => void;
};

type Copy = {
  heading: string;
  sub: string;
  primaryLabel: string;
  heroPrompt: string;
  chips: { label: string; prompt: string }[];
};

/**
 * Empty state = onboarding. One-line value prop, ONE primary action, and
 * starter chips that each fill the composer. Different copy for a first visit
 * and for a thread the user cleared — a cleared thread is not a new user.
 */
const COPY: Record<EmptyStateOnboardingVariant, Copy> = {
  'first-run': {
    heading: 'Your second brain starts here.',
    sub: 'Ask anything. It remembers what matters to you — and you can see, change, or take everything it learns.',
    primaryLabel: 'Start asking',
    heroPrompt: 'What can you do?',
    chips: [
      { label: 'Summarize something', prompt: 'Summarize this for me: ' },
      { label: 'Help me write', prompt: 'Help me write an email that is ' },
      { label: 'Explain a topic', prompt: 'Explain this in simple terms: ' },
      { label: 'Plan my week', prompt: 'Help me plan my week. My priorities are ' },
    ],
  },
  cleared: {
    heading: 'A clean slate.',
    sub: 'This thread is empty. Your saved memory stays yours — you can review it anytime.',
    primaryLabel: 'Ask something new',
    heroPrompt: 'What is a good question to start with?',
    chips: [
      { label: 'Catch me up', prompt: 'Catch me up on what we talked about before.' },
      { label: 'Start a project', prompt: 'I want to start a new project: ' },
      { label: 'Ask anything', prompt: '' },
    ],
  },
};

export function EmptyStateOnboarding({ variant, onPick, onPrimary }: EmptyStateOnboardingProps) {
  const copy = COPY[variant];
  const primary = onPrimary ?? (() => onPick(copy.heroPrompt));
  return (
    <div
      data-slot="empty-state-onboarding"
      className="flex flex-col items-center gap-4 px-6 py-8 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-6">
        <Sparkles aria-hidden="true" />
      </span>
      <div className="space-y-1.5">
        <p className="text-xl font-semibold text-foreground">{copy.heading}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{copy.sub}</p>
      </div>
      <Button type="button" size="lg" onClick={primary}>
        {copy.primaryLabel}
      </Button>
      <div
        className="flex flex-wrap justify-center gap-2"
        role="group"
        aria-label="Ideas to get started"
      >
        {copy.chips.map((chip) => (
          <Button
            key={chip.label}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPick(chip.prompt)}
          >
            {chip.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
