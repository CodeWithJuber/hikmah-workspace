import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth.mjs';
// Compatibility names keep the host adapter separate from application policy.
export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const session = await (await getAuth()).api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user = session.user;
  return { userId: user.id, displayName: user.name || user.email, email: user.email, fullName: user.name || null };
}
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(_returnTo = '/') { return '/sign-in'; }
export function chatGPTSignOutPath(_returnTo = '/') { return '/sign-out'; }
