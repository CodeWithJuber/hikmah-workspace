'use client';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

/** One-line orientation trail for the admin consoles.
 *
 * Rendered by the admin route pages — never by the shared WorkspaceAdmin,
 * KernelCenter or LearningHome components — so those components stay unaware
 * of routes and their non-admin surfaces are untouched.
 */
export function AdminBreadcrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav className="admin-crumb" aria-label="Breadcrumb">
      <ol>
        {trail.map((item, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={item.label}>
              {i > 0 && <ChevronRight size={12} aria-hidden="true" />}
              {item.href && !last ? (
                <Link href={item.href}>{item.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
