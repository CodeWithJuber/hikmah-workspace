'use client';
import Link from 'next/link';
import {
  Plug,
  CreditCard,
  Wrench,
  TerminalSquare,
  Cpu,
  BookOpen,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';

type SettingLink = {
  href: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
};

const groups: { title: string; items: SettingLink[] }[] = [
  {
    title: 'Workspace',
    items: [
      {
        href: '/connections',
        label: 'Integrations',
        blurb: 'MCP servers the assistant can call.',
        icon: Plug,
      },
      {
        href: '/billing',
        label: 'Plan & billing',
        blurb: 'Your plan, usage and invoices.',
        icon: CreditCard,
      },
      {
        href: '/tools',
        label: 'Assistant tools',
        blurb: 'On/off switches and runtimes for what the assistant may do.',
        icon: Wrench,
      },
    ],
  },
  {
    title: 'Memory',
    items: [
      {
        href: '/knowledge',
        label: 'Memory',
        blurb: 'What the assistant remembers about you — review, edit or switch it off.',
        icon: BookOpen,
      },
    ],
  },
  {
    title: 'Advanced',
    items: [
      {
        href: '/terminal',
        label: 'Developer terminal',
        blurb: 'A shell in your workspace, for developers.',
        icon: TerminalSquare,
      },
      {
        href: '/kernel',
        label: 'Local model',
        blurb: 'The on-device model: training, principles and probes.',
        icon: Cpu,
      },
    ],
  },
];

/** One settings hub. The nav stays at six items because everything here —
 * integrations, billing, tool switches, the terminal, the local model —
 * lives one tap deeper instead of competing for attention.
 *
 * Native treatment: sticky header, section signposts, and 68px rows with an
 * icon tile, a two-line body and a chevron — the same row grammar as Chats. */
export function SettingsPage() {
  let i = 0;
  return (
    <div className="n-page n-screen-in">
      <header className="n-header">
        <h1>Settings</h1>
      </header>
      <p className="n-note">Your workspace, your services, your plan.</p>
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2 className="n-section-title">{group.title}</h2>
          <ul className="n-list n-stagger">
            {group.items.map((item) => {
              const Icon = item.icon;
              const index = i++;
              return (
                <li key={item.href} style={{ '--i': index } as CSSProperties}>
                  <Link
                    href={item.href}
                    className="n-row n-press-tint"
                    aria-label={`${item.label} — ${item.blurb}`}
                  >
                    <span className="n-row-avatar" aria-hidden="true">
                      <Icon size={20} />
                    </span>
                    <span className="n-row-body">
                      <span className="n-row-title">{item.label}</span>
                      <span className="n-row-snippet">{item.blurb}</span>
                    </span>
                    <span className="n-row-side" aria-hidden="true">
                      <ChevronRight size={20} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
