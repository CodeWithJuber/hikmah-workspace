import { redirect } from 'next/navigation';
import { requireChatGPTUser } from '../chatgpt-auth';
import { newConversationId, runService } from '@/lib/runs/service';
import { ChatEntry } from './chat-entry';

export const dynamic = 'force-dynamic';

/**
 * The chat surface's entry point.
 *
 * Auth stays on the server; the form-factor split is the client's: a phone
 * gets the native Chats list full-screen, a desktop keeps the old behaviour
 * and lands in the latest conversation (the drawer owns the list there).
 *
 * Mounted on its own route rather than replacing the workspace outright,
 * because the existing surface still carries media generation, comparison,
 * artifacts, agents and the research labs. Swapping it out before those move
 * across would remove working features, so this route is where the new surface
 * earns its place first.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireChatGPTUser('/chat');
  // The most recent chat, never a background task: a task finishing is not a
  // reason for the next visit to open on its report instead of the chat.
  const latest = runService().store.latestChat(user.userId);
  const requested = await searchParams;
  // Learning has its own route now; the chat's embedded ?view=learning mode is
  // gone.
  if (requested.view === 'learning') redirect('/learning');
  const query = new URLSearchParams();
  if (requested.settings === 'connection') query.set('settings', 'connection');
  const suffix = query.size ? `?${query}` : '';
  return <ChatEntry latestId={latest?.id ?? newConversationId()} suffix={suffix} />;
}
