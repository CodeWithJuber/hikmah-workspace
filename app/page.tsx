import { redirect } from 'next/navigation';
import { requireChatGPTUser } from './chatgpt-auth';

export const dynamic = 'force-dynamic';

/**
 * The durable chat is what opens by default now.
 *
 * A redirect rather than a copy of the /chat entry point: conversations keep
 * their own URLs under /chat/<id>, so every link and bookmark already made
 * still resolves, and there is one place that decides which conversation to
 * open rather than two that can disagree.
 *
 * The workspace that used to be here is at /workspace, linked from the header.
 */
export default async function Home() {
  await requireChatGPTUser('/');
  redirect('/chat');
}
