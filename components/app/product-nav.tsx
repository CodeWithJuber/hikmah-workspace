'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare,
  Bot,
  TerminalSquare,
  Wrench,
  BookOpen,
  BrainCircuit,
  Cpu,
  FlaskConical,
  Plug,
  FileText,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useKernel } from '@/components/kernel/context';

type NavItem = { href: string; label: string; icon: LucideIcon };

const primary: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/terminal', label: 'Terminal', icon: TerminalSquare },
  { href: '/tools', label: 'Tools', icon: Wrench },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/learning', label: 'Learning', icon: BrainCircuit },
  { href: '/kernel', label: 'Kernel', icon: Cpu },
  { href: '/labs', label: 'Labs', icon: FlaskConical },
];

const secondary: NavItem[] = [
  { href: '/connections', label: 'Connections', icon: Plug },
  { href: '/typeform', label: 'Typeform', icon: FileText },
];

const admin: NavItem[] = [
  { href: '/admin', label: 'Admin', icon: Settings2 },
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
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const link = (item: NavItem) => {
    const active = isActive(item.href);
    const Icon = item.icon;
    // The kernel keeps its co-model styling: name, caption and the live dot,
    // same as the old shell.
    if (item.href === '/kernel')
      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => onNavigate?.()}
          className={'co-model-nav' + (active ? ' selected' : '')}
          aria-current={active ? 'page' : undefined}
        >
          <Icon size={20} />
          <span>
            {item.label}
            <small>
              {kernel.ready ? 'Understand documents locally' : '5 released language models'}
            </small>
          </span>
          <span className={kernel.ready ? 'live-dot' : 'pending-dot'} />
        </Link>
      );
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
      <div className="nav-group">{primary.map(link)}</div>
      <div className="nav-group">
        <span className="nav-group-label">Services</span>
        {secondary.map(link)}
      </div>
      {isOwner && (
        <div className="nav-group">
          <span className="nav-group-label">Administration</span>
          {admin.map(link)}
        </div>
      )}
    </nav>
  );
}
