import type { ReactNode } from 'react';
import { AppShell } from '@/components/app/app-shell';

/** Every product route renders inside the one AppShell. The group is only
 * organisational — it does not change URLs. */
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
