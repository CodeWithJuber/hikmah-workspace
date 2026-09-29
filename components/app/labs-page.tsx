'use client';
import { useRouter } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { labs } from './labs-data';
import type { CSSProperties } from 'react';

/** The labs directory. Each lab is its own route (/labs/<id>).
 *
 * Native treatment: one sticky header, an intro note, and the lab cards in
 * the shared .n-card-grid (container queries) with press + stagger. The five
 * entries are a fixed catalogue, so there is no search and no empty state —
 * the loading route carries the skeleton instead. */
export function LabsPage() {
  const router = useRouter();
  return (
    <div className="n-page n-screen-in">
      <header className="n-header">
        <h1>Research labs</h1>
      </header>
      <p className="n-note">
        Explore the ideas behind the workspace. These are local experiments — they work without a
        provider connection.
      </p>
      <div className="n-card-grid n-stagger">
        {labs.map((l, i) => {
          const Icon = l.icon;
          return (
            <button
              key={l.id}
              type="button"
              className="n-card n-press"
              style={{ '--i': i } as CSSProperties}
              onClick={() => router.push('/labs/' + l.id)}
              aria-label={`${l.name} — ${l.description}`}
            >
              <span className="n-card-icon" aria-hidden="true">
                <Icon size={24} />
              </span>
              <span className="n-row-body">
                <span className="n-card-title">{l.name}</span>
                <span className="n-card-sub">{l.description}</span>
              </span>
              <ArrowUpRight size={20} aria-hidden="true" style={{ flex: 'none' }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
