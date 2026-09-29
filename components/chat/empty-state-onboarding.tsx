'use client';

import { useState } from 'react';
import { Brain, Code2, Play, Search, Sparkles, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AGENT_STARTERS } from '@/lib/chat/agent-starters';

/** Dismissal of the first-run AI disclosure. The repo has no shared UI-pref
 * key convention (only playground keeps its own localStorage keys), so this
 * namespaced key is the first of its kind. */
const DISCLOSURE_DISMISSED_KEY = 'hikmah:ui:disclosure-dismissed';

export type EmptyStateOnboardingVariant = 'first-run' | 'cleared';

/** One click on a chip fills the composer — it never sends. */
export type StarterChip = {
  label: string;
  prompt: string;
  /** Optional leading icon (e.g. an agent starter's glyph). */
  icon?: LucideIcon;
};

/** A specialist, surfaced on the first screen instead of buried in a panel:
 * one line on what it does for you, two starters that fill the composer. The
 * icon is a Lucide glyph like everywhere else in the product — emoji render at
 * wildly different weights across Android builds and would be the loudest
 * thing on this screen. */
export type PersonaCard = {
  icon: LucideIcon;
  name: string;
  outcome: string;
  starters: StarterChip[];
};

const PERSONAS: PersonaCard[] = [
  {
    icon: Search,
    name: 'Research',
    outcome: 'Cited answers from real sources.',
    starters: [
      { label: 'Compare approaches', prompt: AGENT_STARTERS['Research partner'][0] },
      { label: 'Find primary sources', prompt: AGENT_STARTERS['Research partner'][1] },
    ],
  },
  {
    icon: Code2,
    name: 'Code',
    outcome: 'Working apps and pages, not text walls.',
    starters: [
      { label: 'Build a calculator', prompt: AGENT_STARTERS['Code partner'][0] },
      { label: 'Make a request form', prompt: AGENT_STARTERS['Code partner'][1] },
    ],
  },
  {
    icon: Brain,
    name: 'Teach',
    outcome: 'Teach it your words — it remembers.',
    starters: [
      { label: 'How do you learn?', prompt: 'How do you learn from what I teach you?' },
      { label: 'Remember this', prompt: 'Remember this about me: ' },
    ],
  },
];

export type EmptyStateOnboardingProps = {
  variant: EmptyStateOnboardingVariant;
  onPick: (prompt: string) => void;
  /** The primary action the empty state offers alongside the chips.
   * Defaults to filling the composer with the hero prompt. */
  onPrimary?: () => void;
  /** One-tap demo turn: sends the scripted first message immediately, so the
   * first-run win actually arrives instead of waiting in the composer. */
  onDemo?: () => void;
  /** Override the heading (e.g. "Ask this agent" for agent starters).
   * Defaults to the variant's copy. */
  title?: string;
  /** Override the chips (e.g. an agent's starter prompts).
   * Defaults to the variant's copy. */
  chips?: StarterChip[];
  /** Override the persona cards. Defaults to the built-in three. */
  personas?: PersonaCard[];
};

type Copy = {
  heading: string;
  sub: string;
  primaryLabel: string;
  heroPrompt: string;
  chips: StarterChip[];
};

/**
 * Empty state = onboarding. One-line value prop, ONE primary action that
 * sends a real first turn, and persona cards that surface the built-in
 * specialists on the first screen. Different copy for a first visit and for
 * a thread the user cleared — a cleared thread is not a new user.
 */
const COPY: Record<EmptyStateOnboardingVariant, Copy> = {
  'first-run': {
    heading: 'Ask anything. Build anything. Teach it.',
    sub: 'Chat with AI specialists, get working apps instead of text walls — and everything it learns about you stays yours.',
    primaryLabel: 'Show me — build a calculator',
    heroPrompt: 'Build a clean calculator with HTML, CSS and JavaScript.',
    chips: [],
  },
  cleared: {
    heading: 'A clean slate.',
    sub: 'This thread is empty. Your saved memory stays yours — you can review it anytime.',
    primaryLabel: 'Ask something new',
    heroPrompt: 'What is a good question to start with?',
    chips: [
      {
        label: 'Summarize our last thread',
        prompt: 'Summarize what we discussed in this conversation so far.',
      },
      { label: 'Continue where we left off', prompt: 'Continue where we left off: ' },
    ],
  },
};

export function EmptyStateOnboarding({
  variant,
  onPick,
  onPrimary,
  onDemo,
  title,
  chips,
  personas,
}: EmptyStateOnboardingProps) {
  const copy = COPY[variant];
  const heading = title ?? copy.heading;
  const shown = chips ?? copy.chips;
  const cards = personas ?? PERSONAS;
  // The demo turn sends; everything else fills the composer for review.
  const primary = onDemo ?? onPrimary ?? (() => onPick(copy.heroPrompt));

  // The AI disclosure shows on first run only. The dismissed flag is read
  // lazily so a repeat visit never flashes it on the first paint (and SSR,
  // which has no localStorage, paints the undisclosed state).
  const [disclosureDismissed, setDisclosureDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DISCLOSURE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const showDisclosure = variant === 'first-run' && !disclosureDismissed;
  const dismissDisclosure = () => {
    try {
      window.localStorage.setItem(DISCLOSURE_DISMISSED_KEY, '1');
    } catch {
      // Storage unavailable (private mode): the note just hides for this visit.
    }
    setDisclosureDismissed(true);
  };

  return (
    <div
      data-slot="empty-state-onboarding"
      className="flex flex-col items-center gap-5 px-6 py-10 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-accent text-[var(--ax-text-accent)] [&_svg]:size-6">
        <Sparkles aria-hidden="true" />
      </span>
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{heading}</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{copy.sub}</p>
      </div>
      <Button type="button" size="lg" onClick={primary}>
        <Play size={16} aria-hidden="true" />
        {copy.primaryLabel}
      </Button>
      {variant === 'first-run' && !chips && (
        <>
          {/* On phones the three cards become a compact 2-column grid (the
              third spans both columns) so the first screen stays close to one
              screen tall instead of a 2-screen stack. */}
          <div
            className="grid w-full max-w-2xl grid-cols-2 gap-2 text-left sm:grid-cols-3 sm:gap-3"
            role="group"
            aria-label="Specialists"
          >
            {cards.map((card, index) => {
              const CardIcon = card.icon;
              return (
                <div
                  key={card.name}
                  className={
                    'flex flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:p-4' +
                    (index === 2 ? ' col-span-2 sm:col-span-1' : '')
                  }
                >
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CardIcon
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-[var(--ax-text-accent)]"
                    />
                    {card.name}
                  </p>
                  <p className="text-xs text-muted-foreground">{card.outcome}</p>
                  <div className="flex flex-col gap-1.5">
                    {card.starters.map((starter) => (
                      <Button
                        key={starter.label}
                        type="button"
                        variant="outline"
                        size="sm"
                        /* h-10: these are the first-run's thumb targets; h-8
                           (32px) was below the 40px mobile bar (Jev bump-40,
                           mobile audit 2026-09-29). */
                        className="h-10 justify-start rounded-full px-3 text-xs"
                        onClick={() => onPick(starter.prompt)}
                      >
                        {starter.label}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* The free tier is slower and queued; a plan buys fast models. The
              upgrade path lives here too, one quiet line — never a gate. */}
          <p className="text-xs text-muted-foreground">
            Need faster answers?{' '}
            <a
              href="/pricing"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              See plans →
            </a>
          </p>
        </>
      )}
      {shown.length > 0 && (
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
      )}
      {showDisclosure && (
        <p className="flex max-w-xl items-start justify-center gap-2 text-xs text-muted-foreground">
          <span>You’re chatting with an AI — it can make mistakes.</span>
          <button
            type="button"
            aria-label="Dismiss AI disclosure"
            onClick={dismissDisclosure}
            className="flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-[var(--focus-ring)] focus-visible:outline-none"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  );
}
