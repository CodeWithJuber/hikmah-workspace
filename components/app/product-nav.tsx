'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare,
  Bot,
  BookOpen,
  GraduationCap,
  FlaskConical,
  Settings2,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useKernel } from '@/components/kernel/context';

type NavItem = { href: string; label: string; icon: LucideIcon };
export type { NavItem as ProductNavItem };

/** Active when the pathname is the destination or beneath it. Shared with the
 * mobile bottom bar so both navs agree on what "here" means. */
export function isNavActive(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(href + '/');
}

/** The whole product in six plain words.
 *
 * Everything else (compare mode, integrations, billing, terminal, tool
 * switches, the local model) lives one tap deeper — linked from inside Chat
 * or from Settings — instead of competing for attention in the nav. Old
 * addresses keep working; they just aren't destinations anymore. */
export const primaryNavItems: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Assistants', icon: Bot },
  { href: '/knowledge', label: 'Memory', icon: BookOpen },
  { href: '/learning', label: 'Teach', icon: GraduationCap },
  { href: '/labs', label: 'Playground', icon: FlaskConical },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

export const adminNavItems: NavItem[] = [
  { href: '/admin', label: 'Admin', icon: Shield },
  { href: '/superadmin', label: 'Superadmin', icon: ShieldCheck },
];

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
      {isOwner && (
        <div className="nav-group">
          <span className="nav-group-label">Administration</span>
          {adminNavItems.map(link)}
        </div>
      )}
    </nav>
  );
}
