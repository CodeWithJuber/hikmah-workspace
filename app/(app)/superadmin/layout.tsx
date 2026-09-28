import type { ReactNode } from 'react';

/** Scoping hook for the admin polish stylesheet.
 *
 * Every rule in app/styles/admin-polish.css is written under `.admin-polish`,
 * so the shared components these pages render (KernelCenter, LearningHome)
 * never restyle on their non-admin surfaces (/kernel, /learning). */
export default function SuperadminLayout({ children }: { children: ReactNode }) {
  return <div className="admin-polish">{children}</div>;
}
