'use client';
import { useRouter } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { labs } from './labs-data';
import styles from './sections.module.css';

/** The labs directory. Each lab is its own route (/labs/<id>); the entries
 * navigate with the router because the directory styling targets button
 * elements, and an anchor would lose the layout. */
export function LabsPage() {
  const router = useRouter();
  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          <SidebarTrigger className="size-9" />
          <div className={styles.headerText}>
            <h1>Research labs</h1>
            <p className={styles.headerSub}>Explore the ideas behind the workspace.</p>
          </div>
        </header>
        <p className={styles.introLine}>
          These are local experiments. They work without a provider connection.
        </p>
        <div className={styles.directory}>
          {labs.map((l) => (
            <button
              key={l.id}
              className={styles.dirCard}
              onClick={() => router.push('/labs/' + l.id)}
            >
              <span className={styles.dirIcon}>
                <l.icon size={24} aria-hidden="true" />
              </span>
              <span className={styles.dirCardBody}>
                <h2>{l.name}</h2>
                <p>{l.description}</p>
              </span>
              <ArrowUpRight size={20} className={styles.dirArrow} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
