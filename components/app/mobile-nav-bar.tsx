'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, LogOut, Moon, Plus, Sun } from 'lucide-react';
import { useKernel } from '@/components/kernel/context';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  adminNavItems,
  isNavActive,
  primaryNavItems,
  staffConsoleNavItem,
  useStaffAccess,
  type ProductNavItem,
} from './product-nav';

/** Thumb-primary destinations on the bottom bar; the rest live in More. */
const MOBILE_TAB_COUNT = 4;

/** The four bottom-bar destinations. Pure, so the split is unit-testable. */
export function mobileNavTabs(): ProductNavItem[] {
  return primaryNavItems.slice(0, MOBILE_TAB_COUNT);
}

/** Everything the bar does not fit: the More sheet's link list. */
export function mobileNavOverflow(): ProductNavItem[] {
  return primaryNavItems.slice(MOBILE_TAB_COUNT);
}

/** The single product-nav idiom below 900px: four destinations + a More
 * sheet. The desktop sidebar/rail is untouched; this component only renders
 * visibly under the mobile breakpoint (see workspace-experience.css).
 *
 * Chat pages pass the actions that used to live in the drawer's footer so no
 * capability is lost when the hamburger drawer goes away: new conversation
 * (reachable from the composer zone via this bar), run settings, theme.
 * Other shells get the plain link version. */
export function MobileNavBar({
  onNewChat,
  onOpenSettings,
  onToggleTheme,
  theme = 'light',
}: {
  onNewChat?: () => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  theme?: 'light' | 'dark';
}) {
  const pathname = usePathname() ?? '';
  const kernel = useKernel();
  const [moreOpen, setMoreOpen] = useState(false);
  const isOwner = kernel.ready && kernel.role === 'super_admin';
  const staffAccess = useStaffAccess();
  const close = () => setMoreOpen(false);

  const tab = (item: ProductNavItem) => {
    const active = isNavActive(item.href, pathname);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={'mobile-nav-tab n-press' + (active ? ' is-active' : '')}
        aria-current={active ? 'page' : undefined}
      >
        <Icon size={20} aria-hidden="true" />
        <span>{item.label}</span>
      </Link>
    );
  };

  const sheetLink = (item: ProductNavItem) => {
    const active = isNavActive(item.href, pathname);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={close}
        className={'mobile-nav-sheet-link n-press' + (active ? ' is-active' : '')}
        aria-current={active ? 'page' : undefined}
      >
        <Icon size={20} aria-hidden="true" />
        {item.label}
      </Link>
    );
  };

  return (
    <>
      <nav className="mobile-nav-bar" aria-label="Product">
        {mobileNavTabs().map(tab)}
        <button
          type="button"
          className={'mobile-nav-tab n-press' + (moreOpen ? ' is-active' : '')}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <Ellipsis size={20} aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="mobile-nav-sheet">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <div className="mobile-nav-sheet-list">
            {mobileNavOverflow().map((item) =>
              item.label === 'Settings' && onOpenSettings ? (
                <button
                  key={item.href}
                  type="button"
                  className="mobile-nav-sheet-link"
                  onClick={() => {
                    close();
                    onOpenSettings();
                  }}
                >
                  <item.icon size={20} aria-hidden="true" />
                  {item.label}
                </button>
              ) : (
                sheetLink(item)
              ),
            )}
            {(isOwner || staffAccess) && (
              <>
                <p className="mobile-nav-sheet-group" aria-hidden="true">
                  Administration
                </p>
                {staffAccess && sheetLink(staffConsoleNavItem)}
                {isOwner && adminNavItems.map(sheetLink)}
              </>
            )}
            {onNewChat && (
              <button
                type="button"
                className="mobile-nav-sheet-link"
                onClick={() => {
                  close();
                  onNewChat();
                }}
              >
                <Plus size={20} aria-hidden="true" />
                New conversation
              </button>
            )}
            {onToggleTheme && (
              <button
                type="button"
                className="mobile-nav-sheet-link"
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick={() => {
                  close();
                  onToggleTheme();
                }}
              >
                {theme === 'dark' ? (
                  <Sun size={20} aria-hidden="true" />
                ) : (
                  <Moon size={20} aria-hidden="true" />
                )}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
            )}
            <Link href="/sign-out" onClick={close} className="mobile-nav-sheet-link">
              <LogOut size={20} aria-hidden="true" />
              Sign out
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
