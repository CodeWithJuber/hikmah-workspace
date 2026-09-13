import { redirect } from 'next/navigation';
import { requireChatGPTUser } from '../chatgpt-auth';
import { newConversationId, runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

/**
 * The chat surface, running the server-side agent loop.
 *
 * Mounted on its own route rather than replacing the workspace outright,
 * because the existing surface still carries media generation, comparison,
 * artifacts, agents and the research labs. Swapping it out before those move
 * across would remove working features, so this route is where the new surface
 * earns its place first.
 *
 * This entry point only chooses which conversation to open — the most recent,
 * or a new one — and redirects, so that every conversation has its own URL and
 * a reload lands back where the owner was rather than somewhere else.
 */
export default async function ChatPage() {
  const user = await requireChatGPTUser('/chat');
  // The most recent chat, never a background task: a task finishing is not a
  // reason for the next visit to open on its report instead of the chat.
  const latest = runService().store.latestChat(user.userId);
  redirect(`/chat/${latest?.id ?? newConversationId()}`);
}
