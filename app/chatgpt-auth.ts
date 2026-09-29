import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth.mjs';
import { getStorage } from '@/server/storage.mjs';
import { createAuthzStore } from '@/lib/authz/store';
// Compatibility names keep the host adapter separate from application policy.
export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};
/** Whether the account is banned. One row in `banned_users` locks every route
 * that requires a user, because they all go through getChatGPTUser.
 *
 * Read straight from the store rather than through lib/authz/server.ts: that
 * module resolves roles via lib/kernel/server.ts, which imports this file —
 * routing the check through it would be a cycle. A storage hiccup fails open
 * here; the ban is a moderation tool, not a security boundary for data. */
function banned(userId: string): boolean {
  try {
    return createAuthzStore(getStorage().raw).isBanned(userId);
  } catch {
    return false;
  }
}
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const session = await (await getAuth()).api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user = session.user;
  if (banned(user.id)) return null;
  return {
    userId: user.id,
    displayName: user.name || user.email,
    email: user.email,
    fullName: user.name || null,
  };
}
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}
export function chatGPTSignInPath(_returnTo = '/') {
  return '/sign-in';
}
export function chatGPTSignOutPath(_returnTo = '/') {
  return '/sign-out';
}
