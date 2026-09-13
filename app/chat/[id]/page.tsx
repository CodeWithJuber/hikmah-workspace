import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '../../chatgpt-auth';
import { ChatShell } from '@/components/chat/chat-shell';
import { runService } from '@/lib/runs/service';

export const dynamic = 'force-dynamic';

/** One conversation, with the rest of them listed beside it. */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireChatGPTUser(`/chat/${id}`);

  // A conversation that exists must belong to this owner. One that does not
  // exist yet is fine and stays: /chat sends people here with an id before
  // anything is written, and the first message is what creates the row.
  const conversation = runService().store.getConversation(id);
  if (conversation && conversation.user_id !== user.userId) notFound();

  return <ChatShell conversationId={id} task={conversation?.mode === 'task'} />;
}
