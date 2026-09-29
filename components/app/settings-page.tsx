'use client';
import Link from 'next/link';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Plug,
  CreditCard,
  Wrench,
  TerminalSquare,
  Cpu,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import styles from './sections.module.css';

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
        blurb: 'Services the assistant can use — AI providers and servers.',
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
 * lives one tap deeper instead of competing for attention. */
export function SettingsPage() {
  return (
    <div className={styles.page}>
      <div className={styles.pageInner} style={{ maxWidth: 800 }}>
        <header className={styles.header}>
          <SidebarTrigger className="size-9" />
          <div className={styles.headerText}>
            <h1>Settings</h1>
            <p className={styles.headerSub}>Your workspace, your services, your plan.</p>
          </div>
        </header>
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title} className={styles.settingGroup}>
            <h2 className={styles.groupLabel}>{group.title}</h2>
            <ul className={styles.settingList}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link href={item.href} className={styles.settingCard}>
                      <span className={styles.settingIcon}>
                        <Icon size={20} aria-hidden="true" />
                      </span>
                      <span className={styles.settingText}>
                        <span className={styles.settingLabel}>{item.label}</span>
                        <span className={styles.settingBlurb}>{item.blurb}</span>
                      </span>
                      <ChevronRight
                        size={20}
                        className={styles.settingChevron}
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
