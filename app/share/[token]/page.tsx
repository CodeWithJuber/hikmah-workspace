import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStorage } from '@/server/storage.mjs';
import { createSharesStore } from '@/lib/chat/shares-store';
import { runService } from '@/lib/runs/service';
import { sharedMessageText } from '@/lib/chat/share-text';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Shared conversation · Hikmah',
  description: 'A conversation shared from a private workspace. Read-only.',
  robots: { index: false, follow: false },
};

/** The label the role badge wears. Anything that is not a plain turn of
 * speech is filed under "Note" rather than leaked as tool chatter. */
function roleLabel(role: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  return 'Note';
}

/** A public, read-only rendering of a shared conversation.
 *
 * No auth here: the token in the URL is the authorization. What renders is the
 * title and the message prose only — no owner id, no model name, no run
 * metadata, and nothing interactive. Client chat components stay out on
 * purpose: this page must not depend on the workspace's client bundle.
 */
export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = createSharesStore(getStorage().raw).resolveToken(token);
  if (!resolved) notFound();

  const raw = getStorage().raw;
  const row = raw
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .get(resolved.conversation_id) as { title?: string } | undefined;
  if (!row) notFound();

  const messages = runService()
    .store.listMessages(resolved.conversation_id)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: sharedMessageText(message.parts),
    }))
    .filter((message) => message.text.length > 0);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-5 py-10">
      <header className="border-b border-neutral-200 pb-6 dark:border-neutral-800">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#17664f] dark:text-emerald-300">
          Shared conversation
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
          {row.title || 'Untitled conversation'}
        </h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Read-only. The owner can revoke this link at any time.
        </p>
      </header>

      <ol className="flex flex-col gap-5">
        {messages.map((message) => (
          <li
            key={message.id}
            className={
              'rounded-2xl border px-5 py-4 ' +
              (message.role === 'user'
                ? 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60'
                : 'border-[#17664f]/15 bg-white dark:border-emerald-900/40 dark:bg-neutral-950')
            }
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-500">
              {roleLabel(message.role)}
            </p>
            {/* Pre-wrap keeps line breaks without trusting any markup the
                conversation may contain: the text is escaped by React. */}
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-800 dark:text-neutral-200">
              {message.text}
            </p>
          </li>
        ))}
      </ol>

      {messages.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          This shared conversation has no messages to show.
        </p>
      )}

      <footer className="mt-auto border-t border-neutral-200 pt-6 text-center text-xs text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
        Shared from a private Hikmah workspace
      </footer>
    </main>
  );
}
