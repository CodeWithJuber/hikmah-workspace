import { redirect } from 'next/navigation';
import { getChatGPTUser } from './chatgpt-auth';
import { Landing } from '@/components/marketing/landing';
import { publicAuthConfig } from '@/lib/auth/public-config';
import { PLANS } from '@/lib/billing/plans';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * Signed in, this is still a redirect to the durable chat: conversations keep
 * their own URLs under /chat/<id>, so every link already made resolves, and one
 * place decides which conversation opens rather than two that can disagree.
 *
 * Signed out, it used to bounce to the sign-in form, so a visitor was asked for
 * a password before being told what the thing was. Now they get a page.
 */
export default async function Home() {
  if (await getChatGPTUser()) redirect('/chat');
  return <Landing config={publicAuthConfig()} plans={PLANS} />;
}
