'use client';

import { Sparkles, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type EmptyStateOnboardingVariant = 'first-run' | 'cleared';

/** One click on a chip fills the composer — it never sends. */
export type StarterChip = {
  label: string;
  prompt: string;
  /** Optional leading icon (e.g. an agent starter's glyph). */
  icon?: LucideIcon;
};

export type EmptyStateOnboardingProps = {
  variant: EmptyStateOnboardingVariant;
  onPick: (prompt: string) => void;
  /** The primary action the empty state offers alongside the chips.
   * Defaults to filling the composer with the hero prompt. */
  onPrimary?: () => void;
  /** Override the heading (e.g. "Ask this agent" for agent starters).
   * Defaults to the variant's copy. */
  title?: string;
  /** Override the chips (e.g. an agent's starter prompts).
   * Defaults to the variant's copy. */
  chips?: StarterChip[];
};

type Copy = {
  heading: string;
  sub: string;
  primaryLabel: string;
  heroPrompt: string;
  chips: StarterChip[];
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

export function EmptyStateOnboarding({
  variant,
  onPick,
  onPrimary,
  title,
  chips,
}: EmptyStateOnboardingProps) {
  const copy = COPY[variant];
  const heading = title ?? copy.heading;
  const shown = chips ?? copy.chips;
  const primary = onPrimary ?? (() => onPick(copy.heroPrompt));
  return (
    <div
      data-slot="empty-state-onboarding"
      className="flex flex-col items-center gap-5 px-6 py-10 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-accent text-[var(--ax-text-accent)] [&_svg]:size-6">
        <Sparkles aria-hidden="true" />
      </span>
      <div className="space-y-2">
        <p className="text-3xl font-semibold tracking-tight text-foreground">{heading}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{copy.sub}</p>
      </div>
      <Button type="button" size="lg" onClick={primary}>
        {copy.primaryLabel}
      </Button>
      <div
        className="flex max-w-xl flex-wrap justify-center gap-2"
        role="group"
        aria-label="Ideas to get started"
      >
        {shown.map((chip) => {
          const Icon = chip.icon;
          return (
            <Button
              key={chip.label}
              type="button"
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-4"
              onClick={() => onPick(chip.prompt)}
            >
              {Icon ? <Icon size={16} aria-hidden="true" /> : null}
              {chip.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
