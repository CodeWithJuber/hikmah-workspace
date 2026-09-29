'use client';
/** The /chat entry point, split by form factor.
 *
 * Phone: the native Chats list, full-screen, with the bottom tab bar — the
 * Chat tab's home. Desktop: the drawer owns the list, so this route keeps
 * its old job and sends the owner to the latest conversation (or a fresh
 * one). The width is a client fact, so the desktop redirect happens after
 * hydration; until then the page is blank rather than wrong.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlaygroundProvider } from '@/components/playground/context';
import { KernelProvider } from '@/components/kernel/context';
import { MobileNavBar } from '@/components/app/mobile-nav-bar';
import { ChatsScreen } from '@/components/chat/chats-screen';
import { useNarrow } from '@/lib/ui/use-narrow';

export function ChatEntry({ latestId, suffix }: { latestId: string; suffix: string }) {
  const router = useRouter();
  const narrow = useNarrow();
  // True on the client, false on the server: hydration is the mount signal,
  // with no setState-in-effect.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    if (mounted && !narrow) router.replace(`/chat/${encodeURIComponent(latestId)}${suffix}`);
  }, [mounted, narrow, router, latestId, suffix]);

  // Blank until hydration: a desktop must never flash the phone list, and a
  // phone must never start the desktop redirect.
  if (!mounted || !narrow) return null;

  // The same provider stack the conversation view renders the tab bar in, so
  // the More sheet behaves identically here and there. onSettings is a no-op
  // here: this screen has no settings panel — the More sheet's Settings item
  // falls back to its link when onOpenSettings is unset.
  const noop = () => {};
  return (
    <TooltipProvider>
      <PlaygroundProvider onSettings={noop}>
        <KernelProvider>
          <ChatsScreen />
          <MobileNavBar />
        </KernelProvider>
      </PlaygroundProvider>
    </TooltipProvider>
  );
}
