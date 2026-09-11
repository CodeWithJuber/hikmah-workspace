import { requireChatGPTUser } from '../chatgpt-auth';
import { ChatPreview } from '@/components/chat/chat-preview';

export const dynamic = 'force-dynamic';

/**
 * The rebuilt chat surface, running the server-side agent loop.
 *
 * Mounted on its own route rather than replacing the workspace outright,
 * because the existing surface still carries media generation, comparison,
 * artifacts, agents and the research labs. Swapping it out before those move
 * across would remove working features, so this route is where the new surface
 * earns its place first.
 */
export default async function ChatPage() {
  await requireChatGPTUser('/chat');
  return <ChatPreview />;
}
