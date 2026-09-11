import { createHash } from 'node:crypto';
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
  const user = await requireChatGPTUser('/chat');
  // One conversation per owner until the conversation list lands, and derived
  // rather than fixed: a shared id would put two owners in one another's
  // conversation, which the runs route now refuses — leaving the second owner
  // with a chat that could never start. Hashed so the id in the markup is not
  // the account id.
  const conversationId =
    'conv_ws_' + createHash('sha256').update(user.userId).digest('hex').slice(0, 32);
  return <ChatPreview conversationId={conversationId} />;
}
