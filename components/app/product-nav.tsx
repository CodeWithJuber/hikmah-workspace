'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  MessageSquare,
  Bot,
  BookOpen,
  GraduationCap,
  FlaskConical,
  Settings2,
  CreditCard,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useKernel } from '@/components/kernel/context';
import { clientFetch } from '@/lib/client/request';

type NavItem = { href: string; label: string; icon: LucideIcon };
export type { NavItem as ProductNavItem };

/** Active when the pathname is the destination or beneath it. Shared with the
 * mobile bottom bar so both navs agree on what "here" means. */
export function isNavActive(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(href + '/');
}

/** The whole product in plain words.
 *
 * Billing sits in the nav because a plan page nobody can find is a plan
 * nobody buys. Everything else (compare mode, integrations, terminal, tool
 * switches, the local model) lives one tap deeper — linked from inside Chat
 * or from Settings — instead of competing for attention in the nav. Old
 * addresses keep working; they just aren't destinations anymore. */
export const primaryNavItems: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Assistants', icon: Bot },
  { href: '/knowledge', label: 'Memory', icon: BookOpen },
  { href: '/learning', label: 'Teach', icon: GraduationCap },
  { href: '/labs', label: 'Playground', icon: FlaskConical },
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

const staffNavItem: NavItem = { href: '/staff', label: 'Staff console', icon: Shield };
export { staffNavItem as staffConsoleNavItem };
const superadminNavItem: NavItem = { href: '/superadmin', label: 'Superadmin', icon: ShieldCheck };

/** Owner-only destinations. `/admin` used to be listed here; it was per-user
 * workspace settings, not an admin console, and now lives at `/settings`. */
export const adminNavItems: NavItem[] = [superadminNavItem];

/** Whether the signed-in account may open the staff console. The server
 * re-checks on every API call — this only decides whether the link exists. */
export function useStaffAccess(): boolean {
  const [staff, setStaff] = useState(false);
  useEffect(() => {
    let live = true;
    void clientFetch('/api/authz/me', {})
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { permissions?: string[] } | null) => {
        if (live) setStaff(Boolean(payload?.permissions?.includes('users:read')));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return staff;
}

/** THE single nav implementation for the whole product. Grouped link lists,
 * all real Next.js routes — no hash routing, no page state. */
export function ProductNav({
  onNavigate,
  className,
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();
  const kernel = useKernel();
  // Same server-verified owner check as OwnerAccess: the kernel reports the
  // role the server assigned, so a provider key alone never opens this.
  const isOwner = kernel.ready && kernel.role === 'super_admin';
  const staffAccess = useStaffAccess();

  const link = (item: NavItem) => {
    const active = isNavActive(item.href, pathname ?? '');
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => onNavigate?.()}
        className={'knowledge-nav' + (active ? ' selected' : '')}
        aria-current={active ? 'page' : undefined}
      >
        <Icon size={20} />
        {item.label}
      </Link>
    );
  };

  return (
    <nav className={'product-nav' + (className ? ' ' + className : '')} aria-label="Product">
      <div className="nav-group">{primaryNavItems.map(link)}</div>
      {(isOwner || staffAccess) && (
        <div className="nav-group">
          <span className="nav-group-label">Administration</span>
          {/* The staff console link is permission-gated: support staff see it,
              plain accounts never do. The owner-only superadmin console keeps
              the kernel's server-verified owner check. */}
          {staffAccess && link(staffNavItem)}
          {isOwner && link(superadminNavItem)}
        </div>
      )}
    </nav>
  );
}
